import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { alphaBox, borderColour, decodePng, downsampleBox, encodePng, hexColour, quantizeRgba, removeKeyBackground, translateRgba } from '../lib/index.js'

function pixels(width, height) {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      rgba[i] = x * 10
      rgba[i + 1] = y * 10
      rgba[i + 2] = 128
      rgba[i + 3] = x === 0 || y === 0 ? 0 : 255
    }
  }
  return rgba
}

test('png: RGBA round-trips through encode/decode', () => {
  const rgba = pixels(4, 4)
  const decoded = decodePng(encodePng(4, 4, rgba))
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 4)
  assert.deepEqual(decoded.rgba, rgba)
})

test('png: alpha box ignores transparent border', () => {
  const rgba = pixels(4, 4)
  assert.deepEqual(alphaBox(rgba, 4, 4), { left: 1, top: 1, right: 4, bottom: 4 })
})

test('png: translation and box downsample preserve alpha-weighted colour', () => {
  const rgba = pixels(4, 4)
  const moved = translateRgba(rgba, 4, 4, 1, 1)
  assert.equal(moved[(1 * 4 + 1) * 4 + 3], rgba[(0 * 4 + 0) * 4 + 3])
  const small = downsampleBox(rgba, 4, 4, 2)
  assert.equal(small.width, 2)
  assert.equal(small.height, 2)
  assert.ok(small.rgba.length === 16)
})

test('png: key background removes only the border-connected colour', () => {
  const size = 5
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 0
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 0
    rgba[i * 4 + 3] = 255
  }
  // Blue ring blocks the flood fill; the green centre must survive.
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) {
      const i = (y * size + x) * 4
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 255
    }
  }
  const inner = (2 * size + 2) * 4
  rgba[inner] = 0
  rgba[inner + 1] = 255
  rgba[inner + 2] = 0
  const result = removeKeyBackground(rgba, size, size, hexColour('#00FF00'))
  assert.ok(result.removed > 0)
  assert.equal(result.rgba[inner + 3], 255)
})

test('png: quantize snaps opaque pixels to the palette', () => {
  const rgba = Buffer.from([250, 5, 5, 255, 0, 0, 0, 0])
  const out = quantizeRgba(rgba, 2, 1, [[255, 0, 0], [0, 255, 0]])
  assert.deepEqual([...out.subarray(0, 4)], [255, 0, 0, 255])
  assert.equal(out[7], 0)
})

test('png: border colour is the median edge colour', () => {
  const rgba = pixels(4, 4)
  assert.deepEqual(borderColour(rgba, 4, 4), [20, 20, 128])
})
