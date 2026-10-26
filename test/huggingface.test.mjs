/**
 * Hugging Face model discovery/download tests against a local Hub-like HTTP server.
 * No external network is used.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  HUGGINGFACE_OUTPUT_SCHEMA,
  createHuggingFaceTool
} from '../lib/index.js'
import { assertDeclaredKeys, assertLosslessJson, tempDir } from './helpers.mjs'

const BODY = Buffer.alloc(4096, 7)
const authSeen = []

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  authSeen.push({ path: url.pathname, auth: req.headers.authorization })
  if (url.pathname === '/api/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([
      { id: 'org/wan-model', downloads: 1234, likes: 56, pipeline_tag: 'text-to-video', gated: false, tags: ['wan', 'video'] },
      { id: 'org/other', downloads: 1, likes: 2, pipeline_tag: 'text-to-image', gated: 'auto' }
    ]))
    return
  }
  if (url.pathname === '/api/models/org/repo') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      gated: false,
      siblings: [
        { rfilename: 'nested/model.safetensors', size: BODY.length, lfs: { oid: 'a'.repeat(64), size: BODY.length } },
        { rfilename: 'README.md', size: 10 }
      ]
    }))
    return
  }
  if (url.pathname === '/org/repo/resolve/main/nested/model.safetensors') {
    if (req.headers.authorization !== 'Bearer hf_test') {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    res.writeHead(302, { location: `http://localhost:${server.address().port}/cdn/model.safetensors` })
    res.end()
    return
  }
  if (url.pathname === '/cdn/model.safetensors') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BODY.length) })
    res.end(req.method === 'HEAD' ? undefined : BODY)
    return
  }
  if (url.pathname === '/gated/repo/resolve/main/model.safetensors') {
    res.writeHead(401)
    res.end('accept the license')
    return
  }
  res.writeHead(404)
  res.end('not found')
})

let baseUrl
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
    resolve()
  })
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function toolConfig(extra = {}) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    huggingFaceEndpoint: baseUrl,
    huggingFaceToken: 'hf_test',
    requestTimeoutMs: 3000,
    timeoutMs: 5000,
    pollIntervalMs: 100,
    maxDownloadBytes: 1024 * 1024,
    ...extra
  }
}

function exec(cwd) {
  return { agent: { meta: { cwd } } }
}

test('huggingface search returns model candidates', async () => {
  const tool = createHuggingFaceTool(toolConfig())
  const result = await tool.execute({ action: 'search', query: 'wan' }, exec(tempDir('hf')))
  assertDeclaredKeys(result, HUGGINGFACE_OUTPUT_SCHEMA, 'hf search')
  assertLosslessJson(result, 'hf search')
  assert.equal(result.success, true)
  assert.equal(result.count, 2)
  assert.equal(result.models[0].id, 'org/wan-model')
})

test('huggingface files lists sizes and LFS hashes', async () => {
  const tool = createHuggingFaceTool(toolConfig())
  const result = await tool.execute({ action: 'files', repo_id: 'org/repo' }, exec(tempDir('hf')))
  assertDeclaredKeys(result, HUGGINGFACE_OUTPUT_SCHEMA, 'hf files')
  assertLosslessJson(result, 'hf files')
  assert.equal(result.success, true)
  assert.equal(result.files[0].path, 'nested/model.safetensors')
  assert.equal(result.files[0].size, BODY.length)
  assert.equal(result.files[0].lfs_sha256, 'a'.repeat(64))
})

test('huggingface download follows the CDN redirect without forwarding the token', async () => {
  const cwd = tempDir('hf')
  const tool = createHuggingFaceTool(toolConfig())
  const result = await tool.execute({
    action: 'download',
    repo_id: 'org/repo',
    filename: 'nested/model.safetensors',
    output_dir: path.join(cwd, 'downloads')
  }, exec(cwd))

  assertDeclaredKeys(result, HUGGINGFACE_OUTPUT_SCHEMA, 'hf download')
  assertLosslessJson(result, 'hf download')
  assert.equal(result.success, true)
  assert.equal(result.bytes, BODY.length)
  assert.ok(fs.existsSync(result.path))
  assert.deepEqual(fs.readFileSync(result.path), BODY)
  assert.equal(result.installed, false)
  assert.ok(!result.text.includes('hf_test'))

  const resolveCall = authSeen.find((entry) => entry.path === '/org/repo/resolve/main/nested/model.safetensors')
  const cdnCall = authSeen.find((entry) => entry.path === '/cdn/model.safetensors')
  assert.equal(resolveCall?.auth, 'Bearer hf_test')
  assert.equal(cdnCall?.auth, undefined)
})

test('huggingface dry run reports size without writing', async () => {
  const cwd = tempDir('hf')
  const tool = createHuggingFaceTool(toolConfig())
  const result = await tool.execute({
    action: 'download',
    repo_id: 'org/repo',
    filename: 'nested/model.safetensors',
    output_dir: path.join(cwd, 'dry'),
    dry_run: true
  }, exec(cwd))
  assert.equal(result.success, true)
  assert.equal(result.size, BODY.length)
  assert.equal(result.dry_run, true)
  assert.ok(!fs.existsSync(path.join(cwd, 'dry', 'model.safetensors')))
})

test('huggingface installs into a configured ComfyUI models folder', async () => {
  const cwd = tempDir('hf')
  const modelsDir = path.join(cwd, 'ComfyUI', 'models')
  const tool = createHuggingFaceTool(toolConfig({ comfyuiModelsDir: modelsDir }))
  const result = await tool.execute({
    action: 'download',
    repo_id: 'org/repo',
    filename: 'nested/model.safetensors',
    folder: 'vae'
  }, exec(cwd))
  assert.equal(result.success, true)
  assert.equal(result.installed, true)
  assert.equal(result.path, path.join(modelsDir, 'vae', 'model.safetensors'))
  assert.ok(fs.existsSync(result.path))
})

test('huggingface gated download without access returns a token/licence hint', async () => {
  const tool = createHuggingFaceTool(toolConfig({ huggingFaceToken: '' }))
  const result = await tool.execute({
    action: 'download',
    repo_id: 'gated/repo',
    filename: 'model.safetensors',
    output_dir: tempDir('hf')
  }, exec(tempDir('hf')))
  assert.equal(result.success, false)
  assert.match(result.text, /HTTP 401/)
  assert.match(result.text, /token|license|licence/i)
  assertLosslessJson(result)
})
