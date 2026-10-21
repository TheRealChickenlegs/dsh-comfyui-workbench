/**
 * Tests for comfyui_inspect: model catalogue, node search/schema, embeddings, system, queue and history.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { INSPECT_OUTPUT_SCHEMA, createComfyUIInspectTool } from '../lib/index.js'
import { createMockComfyUI } from './mock-comfyui.mjs'
import { assertDeclaredKeys } from './helpers.mjs'

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

const pluginConfigFor = (baseUrl) => ({
  baseUrl,
  pollIntervalMs: 100,
  timeoutMs: 5000,
  requestTimeoutMs: 3000
})

const exec = { agent: { meta: { cwd: process.cwd() } } }

test('inspect overview: system, model/node counts and queue/history summary', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'overview' }, exec)

  assert.equal(result.success, true)
  assertDeclaredKeys(result, INSPECT_OUTPUT_SCHEMA, 'inspect overview')
  assert.equal(result.scope, 'overview')
  assert.match(result.text, /ComfyUI system:/)
  assert.match(result.text, /Models: \d+ file/)
  assert.match(result.text, /Nodes: \d+ available/)
  assert.ok(result.data.counts.nodes > 0)
  assert.ok(result.data.counts.models > 0)
  assert.ok(Array.isArray(result.data.model_folders))
})

test('inspect models: lists checkpoints and custom model folders from /models', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'models' }, exec)

  assert.equal(result.success, true)
  assertDeclaredKeys(result, INSPECT_OUTPUT_SCHEMA, 'inspect models')
  const folders = result.data.folders
  const checkpoints = folders.find((folder) => folder.folder === 'checkpoints')
  assert.ok(checkpoints, 'checkpoints folder should be present')
  assert.ok(checkpoints.files.includes('sd_xl_base_1.0.safetensors'))
  assert.ok(folders.some((folder) => folder.folder === 'loras'))
  assert.ok(folders.some((folder) => folder.folder === 'embeddings'))
  assert.ok(folders.every((folder) => folder.count > 0), 'empty model folders should be omitted')
  assert.match(result.text, /Main diffusion checkpoints/)
})

test('inspect models: folder/query filters and dynamic custom-node model enums', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))

  const filtered = await tool.execute({ scope: 'models', folder: 'checkpoints', query: 'xl' }, exec)
  assert.equal(filtered.success, true)
  assert.equal(filtered.data.folders.length, 1)
  assert.deepEqual(filtered.data.folders[0].files, ['sd_xl_base_1.0.safetensors'])

  const dynamic = await tool.execute({ scope: 'models' }, exec)
  assert.ok(
    dynamic.data.dynamic.some((entry) => entry.node === 'RemBGSession+' && entry.input === 'model'),
    'custom node model enums should appear under dynamic'
  )
})

test('inspect models: falls back to loader-node enums when /models is unavailable', async () => {
  const { baseUrl } = await startMock({ noModelsEndpoint: true })
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'models' }, exec)

  assert.equal(result.success, true)
  assert.equal(result.data.source, 'object_info')
  const checkpoints = result.data.folders.find((folder) => folder.folder === 'checkpoints')
  assert.ok(checkpoints)
  assert.ok(checkpoints.files.includes('sd_xl_base_1.0.safetensors'))
  assert.ok(result.data.folders.some((folder) => folder.folder === 'loras'))
})

test('inspect nodes: search by name/category and paginate', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))

  const search = await tool.execute({ scope: 'nodes', query: 'KSampler' }, exec)
  assert.equal(search.success, true)
  assert.equal(search.data.items[0].name, 'KSampler')
  assert.ok(search.total >= 1)

  const category = await tool.execute({ scope: 'nodes', category: 'loaders', limit: 2 }, exec)
  assert.equal(category.success, true)
  assert.ok(category.data.items.every((node) => node.category.includes('loaders')))
  assert.ok(category.count <= 2)
})

test('inspect node: full schema includes required inputs, enums and outputs', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'node', node: 'KSampler' }, exec)

  assert.equal(result.success, true)
  assertDeclaredKeys(result, INSPECT_OUTPUT_SCHEMA, 'inspect node')
  const detail = result.data.nodes[0]
  assert.equal(detail.name, 'KSampler')
  const sampler = detail.inputs.find((input) => input.name === 'sampler_name')
  assert.ok(sampler)
  assert.equal(sampler.type, 'ENUM')
  assert.ok(sampler.enum.includes('euler'))
  assert.equal(detail.outputs[0].type, 'LATENT')
  assert.match(result.text, /Inputs:/)
})

test('inspect node: missing node returns suggestions instead of throwing', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'node', node: 'KSamplr' }, exec)

  assert.equal(result.success, false)
  assert.match(result.text, /Not found/)
  assert.ok(result.data.suggestions.includes('KSampler'))
})

test('inspect embeddings, queue and history', async () => {
  const { mock, baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))

  const embeddings = await tool.execute({ scope: 'embeddings' }, exec)
  assert.equal(embeddings.success, true)
  assert.deepEqual(embeddings.data.embeddings, ['easynegative', 'detail_slider'])

  mock.state.queue.queue_pending = [[1, 'pending-1', { 1: { class_type: 'KSampler', inputs: {} } }, {}, []]]
  const queue = await tool.execute({ scope: 'queue' }, exec)
  assert.equal(queue.success, true)
  assert.equal(queue.data.pending, 1)
  assert.match(queue.text, /pending-1/)

  mock.state.history.set('done-1', {
    prompt: [Date.now(), 'done-1', { 1: { class_type: 'SaveImage', inputs: {} } }, {}, []],
    status: { status_str: 'success', completed: true, messages: [] },
    outputs: { 1: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } }
  })
  const history = await tool.execute({ scope: 'history' }, exec)
  assert.equal(history.success, true)
  assert.ok(history.data.entries.some((entry) => entry.prompt_id === 'done-1'))
  assert.match(history.text, /done-1/)
})

test('inspect reports unreachable ComfyUI as a structured failure', async () => {
  const tool = createComfyUIInspectTool({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 2000 })
  const result = await tool.execute({ scope: 'system' }, exec)
  assert.equal(result.success, false)
  assert.match(result.text, /inspection failed|Cannot reach ComfyUI/i)
})

test('inspect node: dynamic enum inputs are labelled ENUM with an empty value list', async () => {
  const { baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))
  const result = await tool.execute({ scope: 'node', node: 'LoadImage' }, exec)

  assert.equal(result.success, true)
  const image = result.data.nodes[0].inputs.find((input) => input.name === 'image')
  assert.equal(image.type, 'ENUM')
  assert.equal(image.enum_count, 0)
  assert.deepEqual(image.enum, [])
})

test('inspect node: object_info is cached across calls, and refresh refetches it', async () => {
  const { mock, baseUrl } = await startMock()
  const tool = createComfyUIInspectTool(pluginConfigFor(baseUrl))

  await tool.execute({ scope: 'node', node: 'KSampler' }, exec)
  const afterFirst = mock.state.stats.object_info
  await tool.execute({ scope: 'node', node: 'VAEDecode' }, exec)
  assert.equal(mock.state.stats.object_info, afterFirst, 'second call should use the cached catalogue')

  await tool.execute({ scope: 'node', node: 'VAEDecode', refresh: true }, exec)
  assert.equal(mock.state.stats.object_info, afterFirst + 1, 'refresh=true should refetch object_info')
})
