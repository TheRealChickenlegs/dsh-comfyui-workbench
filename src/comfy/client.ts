/**
 * ComfyUI HTTP client (only Node built-ins: fetch / FormData / Blob; zero third-party dependencies).
 *
 * Covers every endpoint V1 needs:
 *   GET  /system_stats          health check
 *   GET  /object_info           node catalogue (for capability probing and checkpoint discovery)
 *   POST /upload/image          upload a local image into ComfyUI's input directory
 *   POST /prompt                submit a workflow
 *   GET  /history/{prompt_id}   poll for the execution result
 *   GET  /view                  fetch the produced image bytes
 *   POST /interrupt             cancel execution
 *
 * Every network error is translated into an ImagePluginError that is "understandable + actionable".
 */
import type { ComfyImageRef, ComfyWorkflow } from '../types.js'
import { comfyUnreachable, executionFailed, ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'

/** The description of one node in `/object_info` (only the fields we use). */
export interface ComfyNodeInfo {
  name?: string
  display_name?: string
  category?: string
  description?: string
  python_module?: string
  output?: unknown[]
  output_name?: unknown[]
  output_node?: boolean
  input?: {
    required?: Record<string, unknown>
    optional?: Record<string, unknown>
  }
  input_order?: {
    required?: string[]
    optional?: string[]
  }
}

/** One entry in `/history/{id}` (only the fields we use). */
export interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[]; [key: string]: unknown }>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
}

export interface ComfyClientOptions {
  baseUrl: string
  requestTimeoutMs: number
}

export interface UploadResult {
  name: string
  subfolder: string
  type: string
}

/** A queue entry as returned by ComfyUI: [number, prompt_id, prompt, extra_data, outputs_to_execute]. */
export type ComfyQueueEntry = unknown[]

export interface ComfyQueue {
  queue_running: ComfyQueueEntry[]
  queue_pending: ComfyQueueEntry[]
}

/** Options for a raw request against the configured ComfyUI base URL. */
export interface RawRequestOptions {
  method: string
  pathname: string
  query?: Record<string, unknown>
  body?: unknown
  bodyText?: string
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

/** A raw HTTP response, with bytes kept intact (decode `text` only for textual content). */
export interface RawResponse {
  status: number
  ok: boolean
  contentType: string
  headers: Record<string, string>
  bytes: Buffer
  text?: string
}

/** Combine an external AbortSignal with a timeout, preserving "who triggered it" information. */
function linkSignal(
  external: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    },
    timedOut: () => timedOut
  }
}

export class ComfyUIClient {
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number
  /** `/object_info` cache: the response can be several MB, no point refetching it within one process. */
  private objectInfoCache?: { fetchedAt: number; data: Record<string, ComfyNodeInfo> }

  constructor(options: ComfyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.requestTimeoutMs = options.requestTimeoutMs
  }

  get url(): string {
    return this.baseUrl
  }

  private async request(
    pathname: string,
    init: RequestInit,
    external?: AbortSignal,
    timeoutMs = this.requestTimeoutMs
  ): Promise<Response> {
    const linked = linkSignal(external, timeoutMs)
    const target = `${this.baseUrl}${pathname}`
    try {
      logDebug(`HTTP ${init.method ?? 'GET'} ${target}`)
      const response = await fetch(target, { ...init, signal: linked.signal })
      return response
    } catch (error) {
      if (linked.timedOut()) {
        throw new ImagePluginError(
          `ComfyUI request timed out: ${target} (exceeded ${timeoutMs} ms)`,
          'ComfyUI may be busy or stuck; try again later, or increase requestTimeoutMs in the configuration.'
        )
      }
      if (external?.aborted) {
        throw new ImagePluginError('Cancelled: the caller aborted this generation.')
      }
      throw comfyUnreachable(this.baseUrl, error)
    } finally {
      linked.dispose()
    }
  }

  private async json<T>(pathname: string, init: RequestInit, external?: AbortSignal, timeoutMs?: number): Promise<T> {
    const response = await this.request(pathname, init, external, timeoutMs)
    const text = await response.text()
    if (!response.ok) {
      throw this.httpError(pathname, response.status, text)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ImagePluginError(
        `ComfyUI returned invalid JSON (${pathname}): ${text.slice(0, 300)}`,
        'This usually means the address points at a different service (for example a plain web server). Confirm that baseUrl really is ComfyUI.'
      )
    }
  }

  /**
   * Like `json`, but treats a 404 as "endpoint not supported by this ComfyUI version"
   * and returns undefined. Used for optional discovery endpoints such as /models.
   */
  private async optionalJson<T>(
    pathname: string,
    init: RequestInit,
    external?: AbortSignal,
    timeoutMs?: number
  ): Promise<T | undefined> {
    const response = await this.request(pathname, init, external, timeoutMs)
    if (response.status === 404) return undefined
    const text = await response.text()
    if (!response.ok) throw this.httpError(pathname, response.status, text)
    try {
      return JSON.parse(text) as T
    } catch {
      return undefined
    }
  }

  private httpError(pathname: string, status: number, body: string): ImagePluginError {
    const snippet = body.slice(0, 500).replace(/\s+/g, ' ').trim()
    if (status === 404) {
      return new ImagePluginError(
        `ComfyUI has no endpoint ${pathname} (404).`,
        'Confirm that this address really is a ComfyUI service and that its version is not too old (/prompt and /history are standard endpoints).'
      )
    }
    return new ImagePluginError(
      `ComfyUI returned HTTP ${status} (${pathname}): ${snippet || '(empty response)'}`,
      'Take a look at the ComfyUI console output; it usually contains a more specific error.'
    )
  }

  /** Health check: are we really talking to ComfyUI? */
  async systemStats(external?: AbortSignal): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('/system_stats', { method: 'GET' }, external, 8_000)
  }

  /** Fetch the node catalogue (cached). */
  async objectInfo(external?: AbortSignal, maxAgeMs = 60_000): Promise<Record<string, ComfyNodeInfo>> {
    const now = Date.now()
    if (this.objectInfoCache && now - this.objectInfoCache.fetchedAt < maxAgeMs) {
      return this.objectInfoCache.data
    }
    const data = await this.json<Record<string, ComfyNodeInfo>>(
      '/object_info',
      { method: 'GET' },
      external,
      30_000
    )
    this.objectInfoCache = { fetchedAt: now, data }
    logDebug(`Fetched /object_info, ${Object.keys(data).length} nodes`)
    return data
  }

  /** The definition of a single node (tries /object_info/{node} first, falling back to the full table). */
  async nodeInfo(classType: string, external?: AbortSignal): Promise<ComfyNodeInfo | undefined> {
    try {
      const single = await this.json<Record<string, ComfyNodeInfo>>(
        `/object_info/${encodeURIComponent(classType)}`,
        { method: 'GET' },
        external,
        20_000
      )
      if (single && typeof single === 'object' && single[classType]) return single[classType]
      if (single && typeof single === 'object' && Object.keys(single).length > 0) {
        return Object.values(single)[0]
      }
    } catch (error) {
      logDebug(`/object_info/${classType} unavailable, falling back to the full table`, String(error))
    }
    const all = await this.objectInfo(external)
    return all[classType]
  }

  /** Whether a node exists (used for capability probing). */
  async hasNode(classType: string, external?: AbortSignal): Promise<boolean> {
    return (await this.nodeInfo(classType, external)) !== undefined
  }

  /**
   * Upload a local file into ComfyUI's input directory.
   *
   * `/upload/image` accepts images, masks and arbitrary input files; ComfyUI's `/upload/mask` is a
   * different endpoint (it rewrites a mask annotation over an existing output image via `original_ref`),
   * so it must not be used for ordinary workflow inputs.
   */
  async uploadFile(
    input: {
      filename: string
      bytes: Buffer
      mime: string
      subfolder?: string
      overwrite?: boolean
    },
    external?: AbortSignal
  ): Promise<UploadResult> {
    const form = new FormData()
    // Do not rely on a global File; Blob plus a third filename argument works on Node 20+ undici.
    const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mime })
    form.append('image', blob, input.filename)
    form.append('overwrite', input.overwrite === false ? 'false' : 'true')
    if (input.subfolder) form.append('subfolder', input.subfolder)
    form.append('type', 'input')

    const result = await this.json<UploadResult>('/upload/image', { method: 'POST', body: form }, external, 60_000)
    logDebug('Upload succeeded via /upload/image', result)
    return result
  }

  /** Upload a local image into ComfyUI's input directory. */
  async uploadImage(
    input: { filename: string; bytes: Buffer; mime: string; subfolder?: string; overwrite?: boolean },
    external?: AbortSignal
  ): Promise<UploadResult> {
    return this.uploadFile(input, external)
  }

  /** List installed model folder names (undefined when this ComfyUI version has no /models endpoint). */
  async modelFolders(external?: AbortSignal): Promise<string[] | undefined> {
    const data = await this.optionalJson<unknown>('/models', { method: 'GET' }, external, 20_000)
    if (data === undefined) return undefined
    if (Array.isArray(data)) return data.map((item) => String(item)).filter(Boolean)
    if (data && typeof data === 'object') {
      const value = (data as { folders?: unknown }).folders
      if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean)
    }
    return undefined
  }

  /** List the files in one model folder (undefined when the folder or endpoint does not exist). */
  async modelFiles(folder: string, external?: AbortSignal): Promise<string[] | undefined> {
    const pathname = `/models/${encodeURIComponent(folder)}`
    const data = await this.optionalJson<unknown>(pathname, { method: 'GET' }, external, 20_000)
    if (data === undefined) return undefined
    if (Array.isArray(data)) {
      return data
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object' && 'name' in item) return String((item as { name: unknown }).name)
          return ''
        })
        .filter(Boolean)
    }
    return undefined
  }

  /** List text embeddings reported by ComfyUI (undefined when unsupported). */
  async embeddings(external?: AbortSignal): Promise<string[] | undefined> {
    const data = await this.optionalJson<unknown>('/embeddings', { method: 'GET' }, external, 20_000)
    if (!Array.isArray(data)) return undefined
    return data.map((item) => String(item)).filter(Boolean)
  }

  /** Current running and pending queue entries. */
  async queue(external?: AbortSignal): Promise<ComfyQueue> {
    const data = await this.json<Partial<ComfyQueue>>('/queue', { method: 'GET' }, external, 15_000)
    return {
      queue_running: Array.isArray(data.queue_running) ? data.queue_running : [],
      queue_pending: Array.isArray(data.queue_pending) ? data.queue_pending : []
    }
  }

  /** All history entries (ComfyUI caps and ages this server-side). */
  async historyAll(external?: AbortSignal): Promise<Record<string, ComfyHistoryEntry>> {
    return this.json<Record<string, ComfyHistoryEntry>>('/history', { method: 'GET' }, external, 30_000)
  }

  /** Ask ComfyUI to unload models / free memory. */
  async free(options: { unloadModels?: boolean; freeMemory?: boolean }, external?: AbortSignal): Promise<void> {
    await this.json<unknown>(
      '/free',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          unload_models: Boolean(options.unloadModels),
          free_memory: Boolean(options.freeMemory)
        })
      },
      external,
      60_000
    )
  }

  /** Send a control body to /queue (clear the queue or delete specific prompt ids). */
  async queueAction(body: Record<string, unknown>, external?: AbortSignal): Promise<void> {
    await this.json<unknown>(
      '/queue',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      external,
      20_000
    )
  }

  /** Remove every pending item from the queue. */
  async clearQueue(external?: AbortSignal): Promise<void> {
    await this.queueAction({ clear: true }, external)
  }

  /** Remove specific pending items from the queue. */
  async deleteQueueItems(promptIds: string[], external?: AbortSignal): Promise<void> {
    await this.queueAction({ delete: promptIds }, external)
  }

  /**
   * Submit a workflow.
   * ComfyUI returns 400 + `node_errors` when node validation fails; translate that into a human-readable error.
   */
  async queuePrompt(
    workflow: ComfyWorkflow,
    clientId: string,
    external?: AbortSignal
  ): Promise<{ promptId: string }> {
    const response = await this.request(
      '/prompt',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: clientId })
      },
      external,
      60_000
    )
    const text = await response.text()
    let parsed: { prompt_id?: string; node_errors?: Record<string, unknown>; error?: unknown }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      throw new ImagePluginError(
        `Failed to submit the workflow: ComfyUI returned non-JSON (HTTP ${response.status}).`,
        text.slice(0, 300)
      )
    }

    const nodeErrors = parsed.node_errors && Object.keys(parsed.node_errors).length > 0 ? parsed.node_errors : undefined
    if (!response.ok || nodeErrors || !parsed.prompt_id) {
      const detail = nodeErrors
        ? Object.entries(nodeErrors)
            .map(([nodeId, value]) => {
              const errors =
                value && typeof value === 'object' && 'errors' in value
                  ? JSON.stringify((value as { errors: unknown }).errors)
                  : JSON.stringify(value)
              return `Node ${nodeId}: ${errors}`
            })
            .join('; ')
        : JSON.stringify(parsed.error ?? text.slice(0, 400))
      throw new ImagePluginError(
        `The workflow was rejected by ComfyUI (HTTP ${response.status}): ${detail}`,
        'The most common causes are a model/node referenced by the workflow that does not exist on this machine, ' +
          'or a parameter of the wrong type. Check that the model passed to generate_image (the checkpoint file ' +
          'name) matches a name under ComfyUI models/checkpoints.'
      )
    }
    logDebug(`Workflow submitted, prompt_id=${parsed.prompt_id}`)
    return { promptId: parsed.prompt_id }
  }

  /** Look up one history entry; undefined while it has not finished. */
  async historyEntry(promptId: string, external?: AbortSignal): Promise<ComfyHistoryEntry | undefined> {
    const data = await this.json<Record<string, ComfyHistoryEntry>>(
      `/history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      external
    )
    return data[promptId]
  }

  /** Fetch a produced file (image, gif, audio, ...) by its ComfyUI output reference. */
  async fetchFile(ref: ComfyImageRef, external?: AbortSignal): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type || 'output'
    })
    const response = await this.request(`/view?${params.toString()}`, { method: 'GET' }, external, 120_000)
    if (!response.ok) {
      const body = await response.text()
      throw this.httpError(`/view?${params.toString()}`, response.status, body)
    }
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  /** Fetch the produced image bytes (kept as an alias for existing callers). */
  async viewImage(ref: ComfyImageRef, external?: AbortSignal): Promise<Buffer> {
    return this.fetchFile(ref, external)
  }

  /** Cancel the currently running job, surfacing failures (used by the job-control tool). */
  async interruptNow(external?: AbortSignal): Promise<void> {
    await this.json<unknown>('/interrupt', { method: 'POST' }, external, 10_000)
  }

  /** Cancel the currently running job (best effort; a failure does not affect the main flow). */
  async interrupt(external?: AbortSignal): Promise<void> {
    try {
      await this.interruptNow(external)
    } catch (error) {
      logDebug('interrupt failed (ignored)', String(error))
    }
  }

  /**
   * Raw request against the configured ComfyUI base URL.
   *
   * This is the escape hatch behind the comfyui_api tool: it keeps the base URL fixed, supports query
   * parameters and JSON/text bodies, and returns the response bytes untouched. Callers decide whether
   * to parse JSON, show text, or save binary content.
   */
  async rawRequest(options: RawRequestOptions): Promise<RawResponse> {
    const method = options.method.toUpperCase()
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item))
      } else {
        params.append(key, String(value))
      }
    }
    const separator = options.pathname.includes('?') ? '&' : '?'
    const pathname = params.toString()
      ? `${options.pathname}${separator}${params.toString()}`
      : options.pathname

    const headers: Record<string, string> = { accept: '*/*', ...(options.headers ?? {}) }
    let body: string | undefined
    if (options.bodyText !== undefined && options.body !== undefined) {
      throw new ImagePluginError(
        'Provide either body or body_text, not both.',
        'Use body for JSON endpoints, or body_text for endpoints that expect plain text.'
      )
    }
    if (options.bodyText !== undefined) {
      if (method === 'GET' || method === 'HEAD') {
        throw new ImagePluginError(`A ${method} request cannot have a body.`, 'Use POST/PUT/PATCH for requests with a body.')
      }
      body = options.bodyText
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'text/plain; charset=utf-8'
      }
    } else if (options.body !== undefined) {
      if (method === 'GET' || method === 'HEAD') {
        throw new ImagePluginError(`A ${method} request cannot have a body.`, 'Use POST/PUT/PATCH for requests with a body.')
      }
      body = JSON.stringify(options.body)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json'
      }
    }

    const response = await this.request(
      pathname,
      { method, headers, redirect: 'manual', ...(body !== undefined ? { body } : {}) },
      options.signal,
      options.timeoutMs
    )
    const bytes = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? ''
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })
    const isText =
      contentType === '' ||
      /json|text|xml|javascript|html|x-www-form-urlencoded/i.test(contentType)
    return {
      status: response.status,
      ok: response.ok,
      contentType,
      headers: responseHeaders,
      bytes,
      ...(isText ? { text: bytes.toString('utf8') } : {})
    }
  }
}

/**
 * Extract "what exactly went wrong" from the history status and turn it into one readable sentence.
 * ComfyUI puts errors inside the `status.messages` array, shaped like:
 *   [["execution_start", {...}], ["execution_error", { node_id, node_type, exception_message, ... }]]
 */
export function describeHistoryError(entry: ComfyHistoryEntry, promptId: string): ImagePluginError {
  const messages = entry.status?.messages ?? []
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue
    const [kind, payload] = message as [unknown, unknown]
    if (kind === 'execution_error' && payload && typeof payload === 'object') {
      const info = payload as Record<string, unknown>
      const parts = [
        info.node_type ? `Node type ${String(info.node_type)}` : '',
        info.node_id ? `(id=${String(info.node_id)})` : '',
        info.exception_type ? `Exception ${String(info.exception_type)}` : '',
        info.exception_message ? `: ${String(info.exception_message)}` : ''
      ].filter(Boolean)
      return executionFailed(parts.join(' ') || 'unknown execution error', promptId)
    }
    if (kind === 'execution_interrupted') {
      return new ImagePluginError(
        `ComfyUI execution was interrupted (prompt_id=${promptId}).`,
        'Someone may have clicked Cancel in the ComfyUI UI, or the plugin cancelled the job. Retry once.'
      )
    }
  }
  return executionFailed(`status was ${String(entry.status?.status_str ?? 'error')}, but there are no more details`, promptId)
}
