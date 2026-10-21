/**
 * File and path utilities.
 *
 * Spec requirements: save to the "project root" by default, generate file names automatically and
 * never overwrite, and report a clear error when an input file is missing. These helpers do that.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileMissing, ImagePluginError } from './errors.js'

/** User home directory (prefers USERPROFILE on Windows). */
export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || process.cwd()
}

/** Expand a leading `~` / `~/` (Windows users write it that way too). */
export function expandHome(input: string): string {
  if (input === '~') return homeDir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir(), input.slice(2))
  }
  return input
}

/** Resolve a relative path against `cwd` into an absolute path; absolute paths are just normalized. */
export function resolveUserPath(input: string, cwd: string): string {
  const expanded = expandHome(input)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

/** Make sure a directory exists. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Read image bytes; throws an error with a suggestion when the file is missing. */
export function readImageBytes(filePath: string, kind: string): Buffer {
  if (!fs.existsSync(filePath)) throw fileMissing(kind, filePath)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw new ImagePluginError(
      `${kind} is not a file: ${filePath}`,
      'Provide the path of an image file, not a directory.'
    )
  }
  // Catch empty files early: handing one to ComfyUI only yields a harder-to-understand error.
  if (stat.size === 0) {
    throw new ImagePluginError(
      `${kind} is an empty file (0 bytes): ${filePath}`,
      'This file contains no image data. Common causes: an interrupted download, a truncated file, or a path that actually points at a placeholder.'
    )
  }
  return fs.readFileSync(filePath)
}

/** Read arbitrary file bytes; throws an error with a suggestion when missing or empty. */
export function readFileBytes(filePath: string, kind = 'file'): Buffer {
  if (!fs.existsSync(filePath)) throw fileMissing(kind, filePath)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw new ImagePluginError(`${kind} is not a file: ${filePath}`, 'Provide a file path, not a directory.')
  }
  if (stat.size === 0) {
    throw new ImagePluginError(
      `${kind} is an empty file (0 bytes): ${filePath}`,
      'The file contains no data. Common causes: an interrupted download or a placeholder file.'
    )
  }
  return fs.readFileSync(filePath)
}

/** Whether the path exists and is a file. */
export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'])

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.safetensors': 'application/octet-stream',
  '.ckpt': 'application/octet-stream',
  '.pt': 'application/octet-stream',
  '.pth': 'application/octet-stream',
  '.bin': 'application/octet-stream'
}

/** Guess a MIME type from the extension, for uploading arbitrary files to ComfyUI. */
export function guessMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** Guess a MIME type from the extension, for uploading images to ComfyUI. */
export function guessImageMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'image/png'
}

/** Map a response content type to a reasonable file extension. */
export function extensionForMime(contentType: string, fallback = '.bin'): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const mapping: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/html': '.html'
  }
  return mapping[type] ?? fallback
}

/** Return a path that does not exist yet, appending -1 / -2 ... when needed. */
export function uniqueFilePath(target: string): string {
  if (!fs.existsSync(target)) return target
  const ext = path.extname(target)
  const base = ext ? target.slice(0, target.length - ext.length) : target
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base}-${i}${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new ImagePluginError(
    `No free file name left for: ${target}`,
    'Choose another output directory, or remove the files with the same name first.'
  )
}

/** Get the extension from the filename ComfyUI returned (fall back to .png). */
export function extensionOf(filename: string, fallback = '.png'): string {
  const ext = path.extname(filename).toLowerCase()
  return IMAGE_EXTS.has(ext) ? ext : fallback
}

/** Timestamp fragment: 20260928-153012. */
export function timestampSlug(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/** Random seed (0 ~ 2^32-1; ComfyUI's seed is an int). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 4_294_967_295)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

/**
 * Decide the final file to write.
 *
 * Rules (matching "default save location" and "avoid overwriting"):
 *   - `outputPath` with an image extension → treat it as a file path; if it exists, insert a `-1` / `-2`
 *     suffix, **never overwrite**
 *   - everything else (not passed / a directory / ends with a separator) → treat it as a directory,
 *     with the file name `comfyui-<timestamp>-<4 random chars><extension>`
 */
export function planOutputFile(
  outputPath: string | undefined,
  cwd: string,
  extension = '.png'
): { filePath: string; directory: string } {
  const ext = extension.startsWith('.') ? extension : `.${extension}`
  const fallbackName = `comfyui-${timestampSlug()}-${randomSuffix()}${ext}`

  if (!outputPath || outputPath.trim() === '') {
    const directory = cwd
    ensureDir(directory)
    return { filePath: path.join(directory, fallbackName), directory }
  }

  const resolved = resolveUserPath(outputPath, cwd)
  const treatAsFile =
    IMAGE_EXTS.has(path.extname(resolved).toLowerCase()) && !/[/\\]$/.test(outputPath)

  if (!treatAsFile) {
    ensureDir(resolved)
    return { filePath: path.join(resolved, fallbackName), directory: resolved }
  }

  const directory = path.dirname(resolved)
  ensureDir(directory)
  if (!fs.existsSync(resolved)) return { filePath: resolved, directory }

  // The target already exists: insert -1, -2... at the first free slot
  const base = path.basename(resolved, path.extname(resolved))
  const dir = path.dirname(resolved)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${path.extname(resolved)}`)
    if (!fs.existsSync(candidate)) return { filePath: candidate, directory }
  }
  throw new ImagePluginError(
    `No free output path left: ${resolved}`,
    'Choose another output directory, or delete the files with the same name first.'
  )
}

/**
 * Read the **real** pixel dimensions from the image bytes.
 *
 * Why it is needed: img2img / inpaint / remove_background take their canvas from the input image,
 * so the requested width/height do not apply. Copying the requested values into the report produced
 * contradictions like "metadata says 1024×1024 while the actual image is 512×512" (seen on a real
 * machine). The reported size therefore always comes from the produced bytes.
 *
 * Only the two formats ComfyUI emits are recognised: PNG (the SaveImage default) and JPEG
 * (custom workflows may use it). Returns undefined when unrecognised; callers fall back to the
 * requested values.
 */
export function imageSizeOf(bytes: Buffer): { width: number; height: number } | undefined {
  // PNG: signature 89 50 4E 47 0D 0A 1A 0A; IHDR width/height are at offsets 16 / 20 (big-endian 4 bytes).
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  // JPEG: after FF D8, scan segments for SOF (FFC0~FFCF, skipping the non-SOF FFC4/FFC8/FFCC markers).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1] ?? 0
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const segmentSize = bytes.readUInt16BE(offset + 2)
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      if (segmentSize < 2) return undefined
      offset += 2 + segmentSize
    }
  }
  return undefined
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
