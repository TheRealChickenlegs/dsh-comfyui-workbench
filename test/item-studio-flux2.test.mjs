import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { ITEM_STUDIO_OUTPUT_SCHEMA, createItemStudioTool, decodePng, encodePng } from '../lib/index.js'
import { assertDeclaredKeys, assertLosslessJson, tempDir } from './helpers.mjs'

function rawItem() {
  const size = 1024
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = 0
    rgba[i * 4 + 1] = 255
    rgba[i * 4 + 2] = 0
    rgba[i * 4 + 3] = 255
  }
  for (let y = 180; y < 860; y += 1) {
    for (let x = 430; x < 600; x += 1) {
      const i = (y * size + x) * 4
      rgba[i] = 180
      rgba[i + 1] = 80
      rgba[i + 2] = 20
    }
  }
  return encodePng(size, size, rgba)
}
const RAW = rawItem()
let promptCount = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/object_info') {
    const nodes = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'CFGGuider', 'Flux2Scheduler', 'KSamplerSelect', 'RandomNoise', 'EmptyFlux2LatentImage', 'SamplerCustomAdvanced', 'VAEDecode', 'SaveImage']
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Object.fromEntries(nodes.map((name) => [name, { name }]))))
    return
  }
  if (url.pathname === '/models/diffusion_models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(['flux-2-klein-9b-fp8.safetensors']))
    return
  }
  if (url.pathname === '/models/text_encoders') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(['qwen_3_8b_fp8mixed.safetensors']))
    return
  }
  if (url.pathname === '/models/vae') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(['full_encoder_small_decoder.safetensors']))
    return
  }
  if (url.pathname === '/prompt') {
    promptCount += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ prompt_id: 'flux1' }))
    return
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.slice('/history/'.length)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ [id]: { status: { status_str: 'success', completed: true }, outputs: { '13': { images: [{ filename: 'raw.png', type: 'output' }] } } } }))
    return
  }
  if (url.pathname === '/view') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(RAW.length) })
    res.end(RAW)
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

test('item_studio: Flux.2 is preferred and key-cut/palette-finalized', async () => {
  const cwd = tempDir('items-flux2')
  const tool = createItemStudioTool({ baseUrl, requestTimeoutMs: 3000, timeoutMs: 5000, pollIntervalMs: 100 })
  const result = await tool.execute({
    action: 'generate',
    generator: 'auto',
    item_id: 'long_sword',
    output_dir: path.join(cwd, 'out')
  }, { agent: { meta: { cwd } } })
  assertDeclaredKeys(result, ITEM_STUDIO_OUTPUT_SCHEMA, 'flux2 item')
  assertLosslessJson(result)
  assert.equal(result.success, true)
  const item = result.items[0]
  assert.equal(item.generator, 'flux2')
  assert.equal(item.finish, 'key')
  assert.equal(item.width, 64)
  assert.equal(item.height, 128)
  const sprite = decodePng(fs.readFileSync(item.sprite))
  assert.equal(sprite.width, 64)
  assert.equal(sprite.height, 128)
  assert.equal(promptCount, 1)
})
