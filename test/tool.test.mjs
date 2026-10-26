/**
 * Tool contract tests.
 *
 * The most important one is "execute's return value must not have extra fields":
 * OUTPUT_SCHEMA declares `additionalProperties: false`, and DSH validates that schema
 * **strictly** (not as a hint) — one extra key and the whole result is rejected.
 * So the schema itself is used here to check execute's return value in reverse.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  OUTPUT_SCHEMA,
  PARAMETERS_SCHEMA,
  TOOL_NAME,
  apply,
  createGenerateImageTool,
  resolveCwd
} from '../lib/index.js'
import { createMockComfyUI, readPngSize } from './mock-comfyui.mjs'
import { fakeExec, isolatePluginConfig, tempDir, writePng } from './helpers.mjs'

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

const pluginConfigFor = (baseUrl, extra = {}) => ({
  baseUrl,
  pollIntervalMs: 100,
  timeoutMs: 5000,
  requestTimeoutMs: 3000,
  width: 256,
  height: 256,
  ...extra
})

/* ─────────────────────────── definition shape ─────────────────────────── */

test('tool identity: named generate_image, with parameters/output attached', async () => {
  const { baseUrl } = await startMock()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  assert.equal(tool.name, TOOL_NAME)
  assert.equal(tool.name, 'generate_image')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 40, 'the description must be long enough for the model to decide whether to call it')
  assert.match(tool.description, /ComfyUI/)
  for (const mode of ['text2img', 'img2img', 'inpaint', 'remove_background']) {
    assert.ok(tool.description.includes(mode), `the description should mention mode=${mode}`)
  }
  assert.equal(tool.parameters, PARAMETERS_SCHEMA)
  assert.equal(tool.output.schema, OUTPUT_SCHEMA)
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.presentationMeta, 'function')
  assert.equal(typeof tool.execute, 'function')
})

test('render returns exactly one text block; presentationMeta carries path and mode', async () => {
  const { baseUrl } = await startMock()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const blocks = tool.output.render({}, { text: 'hello', path: 'D:\\a.png', mode: 'text2img', seed: 9 })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }], 'render must return an array of ContentBlocks')

  const meta = tool.output.presentationMeta({}, { path: 'D:\\a.png', mode: 'inpaint', seed: 9 })
  assert.equal(meta.kind, 'image-generation')
  assert.equal(meta.path, 'D:\\a.png')
  assert.equal(meta.mode, 'inpaint')
  assert.equal(meta.seed, 9)

  // Must not blow up on dirty values (presentationMeta is a pure function and should not throw).
  assert.deepEqual(tool.output.render({}, undefined), [{ type: 'text', text: '' }])
})

/* ─────────────────────────── cwd resolution ─────────────────────────── */

test('resolveCwd: works for several host shapes, falls back to the process cwd only when nothing is found', () => {
  assert.equal(resolveCwd({ agent: { cwd: 'C:\\one' } }), 'C:\\one')
  assert.equal(resolveCwd({ agent: { meta: { cwd: 'C:\\two' } } }), 'C:\\two')
  assert.equal(resolveCwd({ agent: { session: { cwd: 'C:\\three' } } }), 'C:\\three')
  assert.equal(resolveCwd({ agent: { session: { header: { cwd: 'C:\\four' } } } }), 'C:\\four')
  assert.equal(resolveCwd({ agent: { cwd: '   ' } }), process.cwd(), 'a blank string is not a valid cwd')
  assert.equal(resolveCwd({}), process.cwd())
  assert.equal(resolveCwd(undefined), process.cwd())
})

/* ─────────────────────────── success path ─────────────────────────── */

test('execute success: the return value strictly matches OUTPUT_SCHEMA and serializes losslessly to JSON', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-ok')
  isolatePluginConfig()
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const value = await tool.execute({ prompt: 'a red panda' }, fakeExec(cwd))

  // 1) No required key is missing
  for (const key of OUTPUT_SCHEMA.required) {
    assert.ok(key in value, `missing required field ${key}`)
  }
  // 2) No extra key is allowed (additionalProperties:false is enforced)
  const allowed = new Set(Object.keys(OUTPUT_SCHEMA.properties))
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `a field not declared in OUTPUT_SCHEMA appeared: ${key} — DSH would reject the whole result`)
  }
  // 3) Types are correct
  assert.equal(typeof value.success, 'boolean')
  assert.equal(value.success, true)
  assert.equal(typeof value.path, 'string')
  assert.equal(typeof value.seed, 'number')
  assert.equal(typeof value.mode_inferred, 'boolean')
  assert.ok(Array.isArray(value.files) && value.files.length === 1)
  assert.ok(Array.isArray(value.notes))

  // 4) The output location is decided by the exec cwd (= the project root)
  assert.ok(path.isAbsolute(value.path))
  assert.equal(path.dirname(value.path), cwd)
  assert.ok(fs.existsSync(value.path))
  assert.deepEqual(readPngSize(fs.readFileSync(value.path)), { width: 256, height: 256 })

  // 5) The absolute path in the text must occupy a line of its own (the frontend turns that into a clickable link)
  const lines = value.text.split('\n')
  assert.ok(
    lines.includes(`Image: ${value.path}`),
    `the text should contain a whole line "Image: <absolute path>"; actual text:\n${value.text}`
  )
  if (value.metadata_path) {
    assert.ok(lines.includes(`Metadata: ${value.metadata_path}`))
    assert.ok(fs.existsSync(value.metadata_path))
  }

  // 6) Lossless JSON: DSH transports this value as JSON
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('execute success: the text rendered by render is value.text', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-render')
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))

  const value = await tool.execute({ prompt: 'x' }, fakeExec(cwd))
  const blocks = tool.output.render({ prompt: 'x' }, value)
  assert.deepEqual(blocks, [{ type: 'text', text: value.text }])
})

test('execute: every mode writes into the output directory from the exec cwd', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('tool-modes')
  const tool = createGenerateImageTool(pluginConfigFor(baseUrl))
  const input = writePng(path.join(cwd, 'src.png'), 128, 128)

  const value = await tool.execute(
    { mode: 'img2img', prompt: 'make it winter', input_image: input },
    fakeExec(cwd)
  )
  assert.equal(value.mode, 'img2img')
  assert.equal(path.dirname(value.path), cwd)
  assert.ok(fs.existsSync(value.path))
})

/* ─────────────────────────── failure path ─────────────────────────── */

test('execute failure: the error carries "why + what to do", not a bare fetch failed', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-fail')
  const tool = createGenerateImageTool(pluginConfigFor('http://127.0.0.1:1'))

  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, fakeExec(cwd)),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /❌ Image generation failed/)
      assert.match(error.message, /127\.0\.0\.1:1/)
      assert.match(error.message, /ComfyUI/)
      // The suggestion (hint) must be included
      assert.ok(error.message.split('\n').length >= 4, `the failure text should include a cause and a suggestion:\n${error.message}`)
      return true
    }
  )
})

test('execute failure: argument conflicts go through the same error path (with a suggestion)', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-conflict')
  const input = writePng(path.join(cwd, 'x.png'))
  const tool = createGenerateImageTool(pluginConfigFor('http://127.0.0.1:1'))

  await assert.rejects(
    () => tool.execute({ mode: 'text2img', prompt: 'x', input_image: input }, fakeExec(cwd)),
    /text2img does not accept input_image/
  )
})

test('execute: a dirty plugin config does not crash (falls back to the defaults)', async () => {
  isolatePluginConfig()
  const cwd = tempDir('tool-badcfg')
  const tool = createGenerateImageTool('this is not a config object')
  // This test exercises the "no config at all" default address, and the default is the machine's
  // 8188: on a dev machine with a real ComfyUI it would connect and succeed, making the
  // "must be rejected" assertion environment-dependent (green in CI, red locally).
  // Following helpers.mjs's established principle, pin the default address to a port that can never
  // connect, so the test proves only what it should: the dirty config is ignored, the defaults are
  // used, and the error is the plugin's own readable message.
  const savedUrl = process.env.COMFYUI_URL
  process.env.COMFYUI_URL = 'http://127.0.0.1:1'
  try {
    await assert.rejects(() => tool.execute({ prompt: 'x' }, fakeExec(cwd)), /❌ Image generation failed/)
  } finally {
    if (savedUrl === undefined) delete process.env.COMFYUI_URL
    else process.env.COMFYUI_URL = savedUrl
  }
})

test('apply: registers image/audio/video tools plus the three advanced ComfyUI tools', () => {
  const registered = []
  const registry = { register: (definition) => registered.push(definition.name) }
  apply({ reflect: { get: () => registry } }, { baseUrl: 'http://127.0.0.1:1' })
  assert.deepEqual(registered.sort(), [
    'comfyui_api',
    'comfyui_inspect',
    'comfyui_workflow',
    'generate_audio',
    'generate_image',
    'generate_sprite_animation',
    'generate_video',
    'huggingface_models'
  ])
})
