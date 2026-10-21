/**
 * Error-path tests: the "error handling" requirement, and the "clear errors" acceptance criterion.
 *
 * These specifically verify that "what it says when things break is useful" — every message must
 * answer "why did it break" + "what should I do", instead of a bare fetch failed.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after } from 'node:test'
import { ImagePluginError, runGeneration } from '../lib/index.js'
import { createMockComfyUI } from './mock-comfyui.mjs'
import { tempDir, testConfig, writePng } from './helpers.mjs'

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

/** Capture an error; returns undefined when nothing was thrown. */
async function captureError(fn) {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

function assertUsefulError(error, pattern, label) {
  assert.ok(error, `${label}: expected an error, but it succeeded`)
  assert.ok(
    error instanceof ImagePluginError,
    `${label}: expected an ImagePluginError, got ${error?.constructor?.name}: ${error?.message}`
  )
  const text = `${error.message}\n${error.hint ?? ''}`
  assert.match(text, pattern, `${label}: the error text missed the point → ${text}`)
  assert.ok(
    typeof error.hint === 'string' && error.hint.trim().length > 0,
    `${label}: it must carry a "what to do" hint, but none was present`
  )
}

test('ComfyUI is not running → clearly unreachable, and names the address', async () => {
  const cwd = tempDir('err-down')
  const config = testConfig({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 2000 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /127\.0\.0\.1:1/, 'unreachable')
  assert.match(`${error.message}${error.hint}`, /ComfyUI/, 'it should name ComfyUI as the problem')
})

test('the address is not ComfyUI (returns HTML) → says "this is not ComfyUI"', async () => {
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>I am an ordinary web page</html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const cwd = tempDir('err-notcomfy')
    const config = testConfig({ baseUrl: `http://127.0.0.1:${port}` })
    const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
    assertUsefulError(error, /JSON|ComfyUI/, 'not ComfyUI')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("workflow execution fails → surfaces ComfyUI's original error", async () => {
  const { baseUrl } = await startMock({ failMode: 'execution_error' })
  const cwd = tempDir('err-exec')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /CUDA out of memory/, 'execution failed')
})

test('finished but no image → clearly says "produced no images" instead of silently succeeding', async () => {
  const { baseUrl } = await startMock({ failMode: 'no_images' })
  const cwd = tempDir('err-noimg')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /produced no images/, 'no output image')
})

test('workflow rejected by ComfyUI (400 + node_errors) → identifies which node is wrong', async () => {
  const { baseUrl } = await startMock({ failMode: 'reject' })
  const cwd = tempDir('err-reject')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /value_not_in_list|rejected/, 'workflow rejected')
})

test('timeout → reports the timeout, and tries to stop ComfyUI occupying the GPU', async () => {
  const { mock, baseUrl } = await startMock({ failMode: 'hang' })
  const cwd = tempDir('err-timeout')
  const config = testConfig({ baseUrl, timeoutMs: 1200, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /timed out/i, 'timeout')
  assert.ok(mock.state.stats.interrupt >= 1, 'after a timeout it should call /interrupt to cancel the job')
})

test('caller cancellation → reports "cancelled", never pretends to succeed', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-abort')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const controller = new AbortController()
  controller.abort()

  const error = await captureError(() =>
    runGeneration({ args: { prompt: 'x' }, cwd, config, signal: controller.signal })
  )
  assert.ok(error instanceof ImagePluginError, `expected an error, got ${error}`)
  assert.match(`${error.message}${error.hint}`, /Cancelled/)
})

test("ComfyUI reports no checkpoints → tells the user where to put models", async () => {
  const { baseUrl } = await startMock({ checkpoints: [] })
  const cwd = tempDir('err-nockpt')
  const config = testConfig({ baseUrl })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assertUsefulError(error, /checkpoint/i, 'no checkpoint')
  assert.match(error.hint, /models\/checkpoints/, 'it must name the model directory')
})

test('the specified checkpoint does not exist → errors and lists the options (instead of quietly swapping)', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-badckpt')
  const config = testConfig({ baseUrl })

  const error = await captureError(() =>
    runGeneration({ args: { prompt: 'x', model: 'not-a-real-model.safetensors' }, cwd, config })
  )
  assertUsefulError(error, /not-a-real-model/, 'checkpoint missing')
  assert.match(error.hint, /sd_xl_base_1\.0\.safetensors/, 'it must list the available checkpoints')
})

test('an explicitly specified sampler that does not exist → error; a stale config default → silently replaced with a note', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-sampler')

  const explicit = await captureError(() =>
    runGeneration({
      args: { prompt: 'x', sampler_name: 'no-such-sampler' },
      cwd,
      config: testConfig({ baseUrl })
    })
  )
  assertUsefulError(explicit, /Sampler does not exist/, 'sampler missing')
  assert.match(explicit.hint, /euler/, 'it must list the available samplers')

  const run = await runGeneration({
    args: { prompt: 'x' },
    cwd,
    config: testConfig({ baseUrl, samplerName: 'stale-sampler-name' })
  })
  assert.ok(
    run.notes.some((note) => note.includes('Sampler')),
    'when the default sampler does not exist on this machine it should be replaced with a note'
  )
})

test('fetching the image fails (/view 500) → error instead of writing an empty file', async () => {
  const { baseUrl } = await startMock({ failMode: 'view_500' })
  const cwd = tempDir('err-view')
  const config = testConfig({ baseUrl, pollIntervalMs: 100 })

  const error = await captureError(() => runGeneration({ args: { prompt: 'x' }, cwd, config }))
  assert.ok(error instanceof ImagePluginError, `expected an error, got: ${error}`)
  assert.match(`${error.message}${error.hint}`, /500|HTTP/)
})

test('an empty input image → also gets a clear explanation', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('err-emptyinput')
  const config = testConfig({ baseUrl })
  const emptyish = path.join(cwd, 'empty.png')
  const fs = await import('node:fs')
  fs.writeFileSync(emptyish, Buffer.alloc(0))

  const error = await captureError(() =>
    runGeneration({ args: { mode: 'img2img', prompt: 'x', input_image: emptyish }, cwd, config })
  )
  assert.ok(error, 'an empty image file must not be accepted as a normal input')
})
