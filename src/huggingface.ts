/**
 * Hugging Face Hub access for model downloads.
 *
 * The host plugin runs next to DSH, not necessarily next to ComfyUI. A download therefore goes to
 * `comfyuiModelsDir/<folder>` when the user configured a local ComfyUI models path, and to a local
 * staging directory otherwise. Remote ComfyUI installs cannot be written through the ComfyUI HTTP API;
 * the tool reports the saved path so the operator can copy it to the server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ImagePluginError } from './errors.js'
import { ensureDir, resolveUserPath } from './files.js'
import { PLUGIN_ID } from './identity.js'
import type { ResolvedConfig } from './types.js'

export interface HuggingFaceSearchItem {
  id: string
  downloads?: number
  likes?: number
  pipeline_tag?: string
  gated?: boolean | string
  tags?: string[]
  lastModified?: string
}

export interface HuggingFaceFile {
  path: string
  size?: number
  lfs_sha256?: string
}

export interface HuggingFaceFiles {
  repo_id: string
  revision: string
  gated?: boolean | string
  files: HuggingFaceFile[]
}

export interface HuggingFaceDownloadOptions {
  repoId: string
  filename: string
  revision?: string
  destination: { target: string; base: string; folder: string; installed: boolean }
  maxBytes: number
  overwrite?: boolean
  dryRun?: boolean
  signal?: AbortSignal
}

export interface HuggingFaceDownloadResult {
  repo_id: string
  filename: string
  revision: string
  path?: string
  bytes?: number
  size?: number
  folder: string
  installed: boolean
  dry_run?: boolean
}

const DEFAULT_REVISION = 'main'
const MAX_REDIRECTS = 5

function requestError(status: number, repo: string, filename?: string): ImagePluginError {
  const target = filename ? `${repo}/${filename}` : repo
  if (status === 401 || status === 403) {
    return new ImagePluginError(
      `Hugging Face denied access to ${target} (HTTP ${status}).`,
      'Set a Hugging Face token in the plugin page or HF_TOKEN, make sure it has read access, and accept the model license on huggingface.co if the repository is gated.'
    )
  }
  if (status === 404) {
    return new ImagePluginError(
      `Hugging Face could not find ${target} (HTTP 404).`,
      'Check the repository id, revision, and exact file path with action=files. A gated repository may also hide files until its license is accepted.'
    )
  }
  return new ImagePluginError(
    `Hugging Face request failed for ${target} (HTTP ${status}).`,
    'Check the Hugging Face status page and the repository settings, then retry.'
  )
}

function validateRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ImagePluginError(
      `Invalid Hugging Face repo id: ${JSON.stringify(repo)}.`,
      'Use the form owner/repository, for example Comfy-Org/Wan_2.2_ComfyUI_Repackaged.'
    )
  }
  return repo.split('/').map(encodeURIComponent).join('/')
}

function validateRevision(revision: string): string {
  if (!revision || revision.length > 200 || revision.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ImagePluginError(`Invalid Hugging Face revision: ${JSON.stringify(revision)}.`)
  }
  return revision.split('/').map(encodeURIComponent).join('/')
}

function validateFilename(filename: string): string {
  const parts = filename.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new ImagePluginError(`Invalid file path in repository: ${JSON.stringify(filename)}.`)
  }
  return parts.map(encodeURIComponent).join('/')
}

function safeTargetName(filename: string): string {
  const base = path.basename(filename)
  if (!base || base === '.' || base === '..' || /[\\/]/.test(base)) {
    throw new ImagePluginError(`Invalid target filename: ${JSON.stringify(filename)}.`)
  }
  return base
}

function validateFolder(folder: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(folder) || folder === '.' || folder === '..') {
    throw new ImagePluginError(
      `Invalid ComfyUI model folder: ${JSON.stringify(folder)}.`,
      'Use a single folder name such as checkpoints, diffusion_models, text_encoders, vae or loras.'
    )
  }
  return folder
}

/** Resolve a destination and classify whether it is directly inside a configured ComfyUI models directory. */
export function resolveDownloadDestination(
  config: ResolvedConfig,
  cwd: string,
  options: { filename: string; folder?: string; targetFilename?: string; outputDir?: string }
): { target: string; base: string; folder: string; installed: boolean } {
  const folder = validateFolder(options.folder ?? 'checkpoints')
  const targetName = safeTargetName(options.targetFilename ?? options.filename)
  let base: string
  let installed = false

  if (options.outputDir) {
    base = resolveUserPath(options.outputDir, cwd)
  } else if (config.comfyuiModelsDir) {
    base = path.join(resolveUserPath(config.comfyuiModelsDir, cwd), folder)
    installed = true
  } else {
    const root = config.modelDownloadDir
      ? resolveUserPath(config.modelDownloadDir, cwd)
      : path.join(os.homedir(), `.${PLUGIN_ID}`, 'downloads')
    base = path.join(root, folder)
  }

  ensureDir(base)
  const resolvedBase = path.resolve(base)
  const target = path.resolve(resolvedBase, targetName)
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new ImagePluginError('Refusing to write outside the configured model directory.')
  }
  return { target, base: resolvedBase, folder, installed }
}

/** Minimal Hugging Face Hub client. */
export class HuggingFaceClient {
  private readonly endpoint: string
  private readonly origin: string
  private readonly token?: string
  private readonly requestTimeoutMs: number

  constructor(options: { endpoint: string; token?: string; requestTimeoutMs: number }) {
    let parsed: URL
    try {
      parsed = new URL(options.endpoint)
    } catch {
      throw new ImagePluginError(`Invalid Hugging Face endpoint: ${options.endpoint}.`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ImagePluginError('The Hugging Face endpoint must use http or https.')
    }
    this.endpoint = parsed.toString().replace(/\/+$/, '')
    this.origin = parsed.origin
    this.token = options.token?.trim() || undefined
    this.requestTimeoutMs = options.requestTimeoutMs
  }

  private headers(withAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': `${PLUGIN_ID}/huggingface` }
    if (withAuth && this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    let response: Response
    try {
      // Use the same manual, origin-aware redirect handling as downloads: the token must not cross
      // an origin boundary just because an API request redirects.
      response = await this.follow(url, 'GET', signal ? AbortSignal.any([signal, timeout]) : timeout)
    } catch (error) {
      if (error instanceof ImagePluginError) throw error
      throw new ImagePluginError(
        `Cannot reach Hugging Face at ${this.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        'Check the network connection and the huggingFaceEndpoint setting.'
      )
    }
    if (!response.ok) throw requestError(response.status, url)
    try {
      return await response.json()
    } catch {
      throw new ImagePluginError('Hugging Face returned a non-JSON response.', 'Check the endpoint setting.')
    }
  }

  /** Search public/accessible model repositories. */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<HuggingFaceSearchItem[]> {
    const url = new URL(`${this.endpoint}/api/models`)
    url.searchParams.set('search', query)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sort', 'downloads')
    url.searchParams.set('direction', '-1')
    const data = await this.json(url.toString(), signal)
    if (!Array.isArray(data)) return []
    return data.slice(0, limit).map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const result: HuggingFaceSearchItem = { id: String(row.id ?? '') }
      if (typeof row.downloads === 'number') result.downloads = row.downloads
      if (typeof row.likes === 'number') result.likes = row.likes
      if (typeof row.pipeline_tag === 'string') result.pipeline_tag = row.pipeline_tag
      if (typeof row.gated === 'boolean' || typeof row.gated === 'string') result.gated = row.gated
      if (Array.isArray(row.tags)) result.tags = row.tags.filter((tag): tag is string => typeof tag === 'string')
      if (typeof row.lastModified === 'string') result.lastModified = row.lastModified
      return result
    })
  }

  /** List files in a repository. */
  async files(repoId: string, revision = DEFAULT_REVISION, signal?: AbortSignal): Promise<HuggingFaceFiles> {
    const repo = validateRepo(repoId)
    validateRevision(revision)
    const data = await this.json(`${this.endpoint}/api/models/${repo}?blobs=true&revision=${encodeURIComponent(revision)}`, signal)
    const row = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const siblings = Array.isArray(row.siblings) ? row.siblings : []
    const files: HuggingFaceFile[] = []
    for (const item of siblings) {
      const file = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      if (typeof file.rfilename !== 'string') continue
      const entry: HuggingFaceFile = { path: file.rfilename }
      if (typeof file.size === 'number') entry.size = file.size
      else if (file.lfs && typeof file.lfs === 'object' && typeof (file.lfs as Record<string, unknown>).size === 'number') {
        entry.size = (file.lfs as { size: number }).size
      }
      if (file.lfs && typeof file.lfs === 'object' && typeof (file.lfs as Record<string, unknown>).oid === 'string') {
        entry.lfs_sha256 = String((file.lfs as { oid: string }).oid)
      }
      files.push(entry)
    }
    const result: HuggingFaceFiles = { repo_id: repoId, revision, files }
    if (typeof row.gated === 'boolean' || typeof row.gated === 'string') result.gated = row.gated
    return result
  }

  private async follow(
    url: string,
    method: 'GET' | 'HEAD',
    signal?: AbortSignal
  ): Promise<Response> {
    let current = url
    let withAuth = true
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetch(current, {
        method,
        headers: this.headers(withAuth),
        redirect: 'manual',
        ...(signal ? { signal } : {})
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new ImagePluginError(`Hugging Face redirected without a Location header (HTTP ${response.status}).`)
        const next = new URL(location, current)
        withAuth = next.origin === this.origin
        current = next.toString()
        continue
      }
      return response
    }
    throw new ImagePluginError('Hugging Face redirected too many times.')
  }

  private downloadUrl(repoId: string, filename: string, revision: string): string {
    const repo = validateRepo(repoId)
    const file = validateFilename(filename)
    const ref = validateRevision(revision)
    return `${this.endpoint}/${repo}/resolve/${ref}/${file}?download=true`
  }

  /** Fetch metadata without downloading the file. */
  async head(
    repoId: string,
    filename: string,
    revision = DEFAULT_REVISION,
    signal?: AbortSignal
  ): Promise<{ size?: number; contentType?: string }> {
    const response = await this.follow(this.downloadUrl(repoId, filename, revision), 'HEAD', signal)
    if (!response.ok) throw requestError(response.status, repoId, filename)
    await response.body?.cancel().catch(() => {})
    const size = Number(response.headers.get('content-length'))
    const result: { size?: number; contentType?: string } = {}
    if (Number.isFinite(size) && size >= 0) result.size = size
    const contentType = response.headers.get('content-type')
    if (contentType) result.contentType = contentType
    return result
  }

  /** Download one file, write it atomically, and return its local path. */
  async download(
    options: HuggingFaceDownloadOptions
  ): Promise<HuggingFaceDownloadResult> {
    const revision = options.revision ?? DEFAULT_REVISION
    const destination = options.destination
    if (fs.existsSync(destination.target) && options.overwrite !== true) {
      throw new ImagePluginError(
        `File already exists: ${destination.target}`,
        'Pass overwrite=true or choose a different target_filename/output_dir. Existing models are never replaced by default.'
      )
    }

    const url = this.downloadUrl(options.repoId, options.filename, revision)
    const response = await this.follow(url, 'GET', options.signal)
    if (!response.ok) throw requestError(response.status, options.repoId, options.filename)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new ImagePluginError(
        `Model is larger than the configured maxDownloadBytes (${contentLength} > ${options.maxBytes}).`,
        'Raise maxDownloadBytes in the plugin page/config if you trust this download.'
      )
    }
    if (options.dryRun) {
      await response.body?.cancel().catch(() => {})
      const result: HuggingFaceDownloadResult = {
        repo_id: options.repoId,
        filename: options.filename,
        revision,
        folder: destination.folder,
        installed: destination.installed,
        dry_run: true
      }
      if (Number.isFinite(contentLength) && contentLength >= 0) result.size = contentLength
      return result
    }
    if (!response.body) throw new ImagePluginError('Hugging Face returned an empty response body.')

    const part = `${destination.target}.part-${process.pid}-${Date.now()}`
    let bytes = 0
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > options.maxBytes) {
            callback(new ImagePluginError('Download exceeded the configured maxDownloadBytes.'))
            return
          }
          callback(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(response.body as never), counter, fs.createWriteStream(part))
      if (options.overwrite === true) fs.rmSync(destination.target, { force: true })
      fs.renameSync(part, destination.target)
    } catch (error) {
      fs.rmSync(part, { force: true })
      if (error instanceof ImagePluginError) throw error
      throw new ImagePluginError(
        `Download failed while writing ${destination.target}: ${error instanceof Error ? error.message : String(error)}`,
        'Check free disk space and connectivity, then retry. Partial files are removed.'
      )
    }

    return {
      repo_id: options.repoId,
      filename: options.filename,
      revision,
      path: destination.target,
      bytes,
      folder: destination.folder,
      installed: destination.installed
    }
  }
}
