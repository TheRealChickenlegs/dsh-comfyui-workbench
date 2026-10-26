import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { SPRITE_OUTPUT_SCHEMA, createSpriteAnimationTool, decodePng, encodePng } from '../lib/index.js'
import { assertDeclaredKeys, assertLosslessJson, tempDir } from './helpers.mjs'

test('generate_sprite_animation: missing sprite_path is a clear tool result', async () => {
  const tool = createSpriteAnimationTool({ baseUrl: 'http://127.0.0.1:1' })
  const result = await tool.execute({}, { agent: { meta: { cwd: tempDir('sprite') } } })
  assertDeclaredKeys(result, SPRITE_OUTPUT_SCHEMA, 'sprite tool error')
  assert.equal(result.success, false)
  assert.match(result.text, /sprite_path/)
  assertLosslessJson(result)
})

test('generate_sprite_animation: unknown animation is rejected before any ComfyUI call', async () => {
  const tool = createSpriteAnimationTool({ baseUrl: 'http://127.0.0.1:1' })
  const result = await tool.execute({ sprite_path: '/tmp/does-not-exist.png', animation: 'moonwalk' }, { agent: { meta: { cwd: tempDir('sprite') } } })
  assert.equal(result.success, false)
  assert.match(result.text, /sprite_path|ENOENT|exist/i)
  assertLosslessJson(result)
})


function cellPng() {
  const size = 128
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 24; y < 104; y += 1) {
    for (let x = 44; x < 84; x += 1) {
      const i = (y * size + x) * 4
      rgba[i] = 200
      rgba[i + 1] = 120
      rgba[i + 2] = 40
      rgba[i + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

const PNG = cellPng()
const VIDEO = Buffer.from('fake mp4')
let promptCount = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/upload/image') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'input.png', subfolder: 'sprite_animation/test', type: 'input' }))
    return
  }
  if (url.pathname === '/prompt') {
    promptCount += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ prompt_id: `p${promptCount}` }))
    return
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.slice('/history/'.length)
    const n = Number(id.slice(1))
    const outputs = n === 1
      ? { '18': { images: [{ filename: 'idle.mp4', subfolder: 'sprite_animation/test', type: 'output' }] } }
      : { '26': { images: Array.from({ length: 9 }, (_, i) => ({ filename: `frame_${String(i + 1).padStart(5, '0')}_.png`, subfolder: 'sprite_animation/test', type: 'output' })) } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ [id]: { status: { status_str: 'success', completed: true }, outputs } }))
    return
  }
  if (url.pathname === '/view') {
    const filename = url.searchParams.get('filename') ?? ''
    const body = filename.endsWith('.mp4') ? VIDEO : PNG
    res.writeHead(200, { 'content-type': filename.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'content-length': String(body.length) })
    res.end(body)
    return
  }
  res.writeHead(404)
  res.end('not found')
})
let baseUrl
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  baseUrl = `http://127.0.0.1:${server.address().port}`
  resolve()
}))
after(async () => { await new Promise((resolve) => server.close(resolve)) })

test('generate_sprite_animation: one idle row runs W2 + W3 and packs a card', async () => {
  const cwd = tempDir('sprite')
  const tool = createSpriteAnimationTool({ baseUrl, requestTimeoutMs: 3000, timeoutMs: 5000, pollIntervalMs: 100 })
  const sprite = path.join(cwd, 'hero.png')
  fs.writeFileSync(sprite, PNG)
  const result = await tool.execute({ sprite_path: sprite, animation: 'idle', output_dir: path.join(cwd, 'out') }, { agent: { meta: { cwd } } })
  assertDeclaredKeys(result, SPRITE_OUTPUT_SCHEMA, 'sprite execution')
  assertLosslessJson(result)
  assert.equal(result.success, true)
  assert.equal(result.rows, 1)
  assert.equal(result.sheet_width, 512)
  assert.equal(result.sheet_height, 64)
  const decoded = decodePng(fs.readFileSync(result.spritesheet))
  assert.equal(decoded.width, 512)
  assert.equal(decoded.height, 64)
  const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'))
  assert.equal(manifest.animations[0].name, 'idle')
  assert.ok(fs.existsSync(path.join(cwd, 'out', 'videos', 'idle.mp4')))
})
