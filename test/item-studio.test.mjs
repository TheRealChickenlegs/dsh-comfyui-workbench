import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import { ITEM_STUDIO_OUTPUT_SCHEMA, createItemStudioTool, decodePng, encodePng } from '../lib/index.js'
import { assertDeclaredKeys, assertLosslessJson, tempDir } from './helpers.mjs'

function image(size, inset = 0) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = inset; y < size - inset; y += 1) {
    for (let x = inset; x < size - inset; x += 1) {
      const i = (y * size + x) * 4
      rgba[i] = 160
      rgba[i + 1] = 90
      rgba[i + 2] = 30
      rgba[i + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}
const RAW = image(1024, 0)
const CUTOUT = image(1024, 300)
let promptCount = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/upload/image') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'raw.png', subfolder: 'item_studio/test', type: 'input' }))
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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ [id]: { status: { status_str: 'success', completed: true }, outputs: { '8': { images: [{ filename: 'out.png', subfolder: 'item_studio/test', type: 'output' }] } } } }))
    return
  }
  if (url.pathname === '/view') {
    const body = url.searchParams.get('filename') === 'out.png' && promptCount >= 2 ? CUTOUT : RAW
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) })
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

test('item_studio: list exposes the bundled 108-item catalogue', async () => {
  const tool = createItemStudioTool({ baseUrl: 'http://127.0.0.1:1' })
  const result = await tool.execute({ action: 'list' }, { agent: { meta: { cwd: tempDir('items') } } })
  assertDeclaredKeys(result, ITEM_STUDIO_OUTPUT_SCHEMA, 'item list')
  assert.equal(result.success, true)
  assert.equal(result.count, 108)
  assert.equal(result.items[0].id, 'dagger')
})

test('item_studio: one generated item gets raw, cutout, 64px sprite and 32px icon', async () => {
  const cwd = tempDir('items')
  const tool = createItemStudioTool({ baseUrl, requestTimeoutMs: 3000, timeoutMs: 5000, pollIntervalMs: 100 })
  const result = await tool.execute({
    action: 'generate',
    item_id: 'potion_cure_light',
    output_dir: path.join(cwd, 'out')
  }, { agent: { meta: { cwd } } })
  assertDeclaredKeys(result, ITEM_STUDIO_OUTPUT_SCHEMA, 'item generate')
  assertLosslessJson(result)
  assert.equal(result.success, true)
  assert.equal(result.count, 1)
  const item = result.items[0]
  assert.ok(fs.existsSync(item.raw))
  assert.ok(fs.existsSync(item.cutout))
  const sprite = decodePng(fs.readFileSync(item.sprite))
  const icon = decodePng(fs.readFileSync(item.icon))
  assert.equal(sprite.width, 64)
  assert.equal(sprite.height, 64)
  assert.equal(icon.width, 32)
  assert.equal(icon.height, 32)
})
