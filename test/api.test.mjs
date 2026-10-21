/**
 * Tests for comfyui_api: JSON/text/binary responses, query/body handling and request guardrails.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { API_OUTPUT_SCHEMA, createComfyUIApiTool } from '../lib/index.js'
import { createMockComfyUI, readPngSize } from './mock-comfyui.mjs'
import { assertDeclaredKeys, tempDir } from './helpers.mjs'

const running = []

async function startMock(options = {}) {
  const mock = createMockComfyUI(options)
  const baseUrl = await mock.listen()
  running.push(mock)
  return { mock, baseUrl }
}

after(async () => {
  for (const mock of running) await mock.close()
})

function setup(baseUrl) {
  const tool = createComfyUIApiTool({ baseUrl, requestTimeoutMs: 3000 })
  const cwd = tempDir('api')
  return { tool, cwd, exec: { agent: { meta: { cwd } } } }
}

test('api: JSON responses are parsed and query/body are forwarded', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  const result = await tool.execute(
    {
      method: 'POST',
      path: '/api/echo',
      query: { a: '1', b: 'two' },
      body: { hello: 'world' }
    },
    exec
  )

  assert.equal(result.success, true)
  assertDeclaredKeys(result, API_OUTPUT_SCHEMA, 'api json')
  assert.equal(result.status, 200)
  assert.match(result.content_type, /application\/json/)
  assert.equal(result.data.json.method, 'POST')
  assert.deepEqual(result.data.json.query, { a: '1', b: 'two' })
  assert.deepEqual(result.data.json.body, { hello: 'world' })
  assert.match(result.text, /HTTP 200 OK/)
})

test('api: binary responses are saved to disk when requested', async () => {
  const { baseUrl } = await startMock()
  const { tool, cwd, exec } = setup(baseUrl)
  const result = await tool.execute(
    { path: '/api/binary', save_path: path.join(cwd, 'images', 'out.png') },
    exec
  )

  assert.equal(result.success, true)
  assertDeclaredKeys(result, API_OUTPUT_SCHEMA, 'api binary')
  assert.equal(result.content_type, 'image/png')
  assert.ok(result.path.endsWith('.png'))
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(readPngSize(fs.readFileSync(result.path)), { width: 32, height: 24 })
  assert.equal(result.bytes, fs.statSync(result.path).size)
})

test('api: binary responses without save_path go to the current working directory', async () => {
  const { baseUrl } = await startMock()
  const { tool, cwd, exec } = setup(baseUrl)
  const result = await tool.execute({ path: '/api/binary' }, exec)

  assert.equal(result.success, true)
  assert.equal(path.dirname(result.path), cwd)
  assert.ok(fs.existsSync(result.path))
})

test('api: 404 is reported with status and does not throw', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  const result = await tool.execute({ path: '/not-an-endpoint' }, exec)

  assert.equal(result.success, false)
  assertDeclaredKeys(result, API_OUTPUT_SCHEMA, 'api 404')
  assert.equal(result.status, 404)
  assert.match(result.text, /HTTP 404/)
})

test('api: absolute URLs, traversal, websockets and multipart uploads are rejected before sending', async () => {
  const { mock, baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)

  const absolute = await tool.execute({ path: 'http://example.com/models' }, exec)
  assert.equal(absolute.success, false)
  assert.equal(absolute.status, 0)
  assert.match(absolute.text, /must start with|not an absolute URL/)

  const traversal = await tool.execute({ path: '/models/../../etc/passwd' }, exec)
  assert.equal(traversal.success, false)
  assert.equal(traversal.status, 0)

  const websocket = await tool.execute({ path: '/ws' }, exec)
  assert.equal(websocket.success, false)
  assert.equal(websocket.status, 0)

  const upload = await tool.execute({ path: '/upload/image' }, exec)
  assert.equal(upload.success, false)
  assert.equal(upload.status, 0)
  assert.match(upload.text, /comfyui_workflow action=upload/)
  assert.equal(mock.state.stats.api, 0)
})

test('api: body and body_text are mutually exclusive', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  const result = await tool.execute(
    { method: 'POST', path: '/api/echo', body: { a: 1 }, body_text: 'hello' },
    exec
  )
  assert.equal(result.success, false)
  assert.equal(result.status, 0)
  assert.match(result.text, /either body or body_text/)
})

test('api: plain text responses are returned as text', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  // /api/echo returns JSON, so force text mode to exercise the text branch.
  const result = await tool.execute({ path: '/api/echo', response_type: 'text' }, exec)
  assert.equal(result.success, true)
  assert.match(result.text, /"method"\s*:\s*"GET"/)
})

test('api: large JSON is omitted from data when it exceeds max_bytes', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  const payload = { text: 'x'.repeat(5_000) }
  const result = await tool.execute(
    { method: 'POST', path: '/api/echo', body: payload, max_bytes: 200 },
    exec
  )

  assert.equal(result.success, true)
  assert.equal(result.truncated, true)
  assert.equal(result.data.json, undefined)
  assert.equal(result.data.json_omitted, true)
  assert.match(result.text, /JSON body omitted/)
})

test('api: redirects are not followed to another host', async () => {
  const { baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)
  const result = await tool.execute({ path: '/api/redirect' }, exec)

  assert.equal(result.success, false)
  assert.equal(result.status, 302)
  assert.match(result.data.headers.location ?? '', /example\.com/)
})
