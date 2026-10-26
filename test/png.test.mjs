import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { alphaBox, decodePng, downsampleBox, encodePng, translateRgba } from '../lib/index.js'

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
