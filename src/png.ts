/**
 * Minimal PNG codec for sprite cards.
 *
 * The plugin deliberately has no image dependency: ComfyUI already writes 8-bit PNGs, and packing a
 * sprite card only needs decode, alpha-box translation, box downsampling and encode. This supports
 * non-interlaced 8-bit greyscale, RGB, grey+alpha and RGBA PNGs. It rejects palette/16-bit images
 * with an actionable error rather than silently mangling them.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { ImagePluginError } from './errors.js'

export interface DecodedPng {
  width: number
  height: number
  rgba: Buffer
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function channelsFor(colorType: number): number {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  throw new ImagePluginError(
    `Unsupported PNG color type ${colorType}; expected greyscale, RGB, grey+alpha or RGBA.`,
    'Save the sprite as 8-bit RGBA PNG.'
  )
}

/** Decode a non-interlaced 8-bit PNG into RGBA. */
export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new ImagePluginError('Not a PNG file (signature mismatch).', 'Provide an 8-bit PNG sprite.')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) break
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (length < 13) throw new ImagePluginError('PNG IHDR chunk is truncated.')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[10] !== 0 || data[11] !== 0) {
        throw new ImagePluginError('Unsupported PNG compression/filter method.', 'Re-save the sprite as a standard PNG.')
      }
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (!width || !height || idat.length === 0) {
    throw new ImagePluginError('PNG is missing IHDR or IDAT data.', 'Re-save the sprite as a standard PNG.')
  }
  if (bitDepth !== 8) {
    throw new ImagePluginError(`Unsupported PNG bit depth ${bitDepth}; expected 8-bit.`)
  }
  if (interlace !== 0) {
    throw new ImagePluginError('Interlaced PNGs are not supported.', 'Re-save the sprite as a non-interlaced PNG.')
  }
  const channels = channelsFor(colorType)
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const expected = (stride + 1) * height
  if (raw.length < expected) {
    throw new ImagePluginError(`PNG pixel data is truncated (${raw.length} < ${expected} bytes).`)
  }
  const pixels = Buffer.alloc(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const rowStart = y * stride
    const priorStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= channels ? pixels[rowStart + x - channels] : 0
      const above = y > 0 ? pixels[priorStart + x] : 0
      const aboveLeft = y > 0 && x >= channels ? pixels[priorStart + x - channels] : 0
      let decoded: number
      if (filter === 0) decoded = value
      else if (filter === 1) decoded = value + left
      else if (filter === 2) decoded = value + above
      else if (filter === 3) decoded = value + Math.floor((left + above) / 2)
      else if (filter === 4) decoded = value + paeth(left, above, aboveLeft)
      else throw new ImagePluginError(`Unsupported PNG row filter ${filter}.`)
      pixels[rowStart + x] = decoded & 0xff
    }
    source += stride
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels
    const d = i * 4
    if (colorType === 6) {
      rgba[d] = pixels[s]
      rgba[d + 1] = pixels[s + 1]
      rgba[d + 2] = pixels[s + 2]
      rgba[d + 3] = pixels[s + 3]
    } else if (colorType === 2) {
      rgba[d] = pixels[s]
      rgba[d + 1] = pixels[s + 1]
      rgba[d + 2] = pixels[s + 2]
      rgba[d + 3] = 255
    } else if (colorType === 4) {
      rgba[d] = pixels[s]
      rgba[d + 1] = pixels[s]
      rgba[d + 2] = pixels[s]
      rgba[d + 3] = pixels[s + 1]
    } else {
      rgba[d] = pixels[s]
      rgba[d + 1] = pixels[s]
      rgba[d + 2] = pixels[s]
      rgba[d + 3] = 255
    }
  }
  return { width, height, rgba }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/** Encode RGBA pixels as a non-interlaced 8-bit PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new ImagePluginError('PNG encode received the wrong number of RGBA bytes.')
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Alpha-weighted box downsample by an integer factor. */
export function downsampleBox(rgba: Buffer, width: number, height: number, factor: number): { width: number; height: number; rgba: Buffer } {
  if (factor <= 1) return { width, height, rgba }
  if (width % factor !== 0 || height % factor !== 0) {
    throw new ImagePluginError(`Cannot box-downsample ${width}x${height} by ${factor}.`)
  }
  const outWidth = width / factor
  const outHeight = height / factor
  const out = Buffer.alloc(outWidth * outHeight * 4)
  const area = factor * factor
  for (let oy = 0; oy < outHeight; oy += 1) {
    for (let ox = 0; ox < outWidth; ox += 1) {
      let sa = 0
      let sr = 0
      let sg = 0
      let sb = 0
      for (let y = oy * factor; y < (oy + 1) * factor; y += 1) {
        for (let x = ox * factor; x < (ox + 1) * factor; x += 1) {
          const i = (y * width + x) * 4
          const a = rgba[i + 3]
          if (a === 0) continue
          sa += a
          sr += rgba[i] * a
          sg += rgba[i + 1] * a
          sb += rgba[i + 2] * a
        }
      }
      const d = (oy * outWidth + ox) * 4
      const alpha = Math.floor(sa / area)
      if (alpha < 8 || sa === 0) continue
      out[d] = Math.min(255, Math.floor(sr / sa))
      out[d + 1] = Math.min(255, Math.floor(sg / sa))
      out[d + 2] = Math.min(255, Math.floor(sb / sa))
      out[d + 3] = alpha
    }
  }
  return { width: outWidth, height: outHeight, rgba: out }
}

/** Translate an RGBA image, clipping at the edges. */
export function translateRgba(rgba: Buffer, width: number, height: number, dx: number, dy: number): Buffer {
  if (dx === 0 && dy === 0) return rgba
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = y - dy
    if (sourceY < 0 || sourceY >= height) continue
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - dx
      if (sourceX < 0 || sourceX >= width) continue
      rgba.copy(out, (y * width + x) * 4, (sourceY * width + sourceX) * 4, (sourceY * width + sourceX) * 4 + 4)
    }
  }
  return out
}

export interface AlphaBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** Subject bounds, ignoring the near-transparent fringe BiRefNet leaves. */
export function alphaBox(rgba: Buffer, width: number, height: number, threshold = 8): AlphaBox | undefined {
  let left = width
  let top = height
  let right = 0
  let bottom = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue
      if (x < left) left = x
      if (x >= right) right = x + 1
      if (y < top) top = y
      if (y >= bottom) bottom = y + 1
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : undefined
}

/** Crop an RGBA image to an explicit box. */
export function cropRgba(
  rgba: Buffer,
  width: number,
  height: number,
  box: AlphaBox
): { width: number; height: number; rgba: Buffer } {
  const outWidth = box.right - box.left
  const outHeight = box.bottom - box.top
  if (outWidth <= 0 || outHeight <= 0) throw new ImagePluginError('Cannot crop an empty image region.')
  const out = Buffer.alloc(outWidth * outHeight * 4)
  for (let y = 0; y < outHeight; y += 1) {
    const sourceStart = ((box.top + y) * width + box.left) * 4
    rgba.copy(out, y * outWidth * 4, sourceStart, sourceStart + outWidth * 4)
  }
  return { width: outWidth, height: outHeight, rgba: out }
}

/**
 * Resize RGBA.
 *
 * Downscaling uses an alpha-weighted area average (no dark fringe around transparent edges).
 * Upscaling uses nearest-neighbour, which is what pixel art wants.
 */
export function resizeRgba(
  rgba: Buffer,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): { width: number; height: number; rgba: Buffer } {
  const dw = Math.max(1, Math.round(targetWidth))
  const dh = Math.max(1, Math.round(targetHeight))
  const out = Buffer.alloc(dw * dh * 4)
  if (dw === width && dh === height) return { width, height, rgba }
  if (dw > width || dh > height) {
    for (let y = 0; y < dh; y += 1) {
      const sy = Math.min(height - 1, Math.floor((y * height) / dh))
      for (let x = 0; x < dw; x += 1) {
        const sx = Math.min(width - 1, Math.floor((x * width) / dw))
        rgba.copy(out, (y * dw + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4)
      }
    }
    return { width: dw, height: dh, rgba: out }
  }
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor((dy * height) / dh)
    const y1 = Math.max(y0 + 1, Math.ceil(((dy + 1) * height) / dh))
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor((dx * width) / dw)
      const x1 = Math.max(x0 + 1, Math.ceil(((dx + 1) * width) / dw))
      let sa = 0
      let sr = 0
      let sg = 0
      let sb = 0
      let count = 0
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const i = (sy * width + sx) * 4
          const a = rgba[i + 3]
          count += 1
          if (a === 0) continue
          sa += a
          sr += rgba[i] * a
          sg += rgba[i + 1] * a
          sb += rgba[i + 2] * a
        }
      }
      const d = (dy * dw + dx) * 4
      if (sa === 0) continue
      out[d] = Math.round(sr / sa)
      out[d + 1] = Math.round(sg / sa)
      out[d + 2] = Math.round(sb / sa)
      out[d + 3] = Math.round(sa / Math.max(1, count))
    }
  }
  return { width: dw, height: dh, rgba: out }
}

/** Add a one-pixel dark outline around opaque pixels. */
export function outlineRgba(rgba: Buffer, width: number, height: number, colour: [number, number, number] = [0, 0, 0]): Buffer {
  const out = Buffer.from(rgba)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (rgba[i + 3] > 8) continue
      let neighbour = false
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1) && !neighbour; ny += 1) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
          if (rgba[(ny * width + nx) * 4 + 3] > 64) {
            neighbour = true
            break
          }
        }
      }
      if (neighbour) {
        out[i] = colour[0]
        out[i + 1] = colour[1]
        out[i + 2] = colour[2]
        out[i + 3] = 255
      }
    }
  }
  return out
}

/**
 * Keep only the largest 8-connected opaque component.
 *
 * The simple SDXL item template can paint a sheet of variants despite the prompt. The portable pack
 * is review-gated; this is a safety net so the final 64px candidate contains one object, not three.
 * The raw render and BiRefNet cutout are still written for inspection.
 */
export function keepLargestComponent(rgba: Buffer, width: number, height: number, threshold = 8): Buffer {
  const labels = new Int32Array(width * height).fill(-1)
  const areas: number[] = []
  let next = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (labels[start] !== -1 || rgba[start * 4 + 3] <= threshold) continue
      const label = next
      next += 1
      let area = 0
      const queue = [start]
      labels[start] = label
      for (let head = 0; head < queue.length; head += 1) {
        const index = queue[head]
        area += 1
        const px = index % width
        const py = Math.floor(index / width)
        for (let ny = Math.max(0, py - 1); ny <= Math.min(height - 1, py + 1); ny += 1) {
          for (let nx = Math.max(0, px - 1); nx <= Math.min(width - 1, px + 1); nx += 1) {
            const ni = ny * width + nx
            if (labels[ni] !== -1 || rgba[ni * 4 + 3] <= threshold) continue
            labels[ni] = label
            queue.push(ni)
          }
        }
      }
      areas.push(area)
    }
  }
  if (areas.length === 0) return rgba
  let best = 0
  for (let i = 1; i < areas.length; i += 1) if (areas[i] > areas[best]) best = i
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    if (labels[i] === best) rgba.copy(out, i * 4, i * 4, i * 4 + 4)
  }
  return out
}
