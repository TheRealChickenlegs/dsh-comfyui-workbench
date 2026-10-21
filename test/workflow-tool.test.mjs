/**
 * Tests for comfyui_workflow: validation, execution, output collection, uploads and job control.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  buildText2Img,
  WORKFLOW_OUTPUT_SCHEMA,
  createComfyUIWorkflowTool,
  normalizeRequest,
  resolveConfig
} from '../lib/index.js'
import { createMockComfyUI, readPngSize } from './mock-comfyui.mjs'
import { assertDeclaredKeys, tempDir, writePng } from './helpers.mjs'

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

function setup(baseUrl, overrides = {}) {
  const pluginConfig = {
    baseUrl,
    pollIntervalMs: 100,
    timeoutMs: 5000,
    requestTimeoutMs: 3000,
    width: 256,
    height: 256,
    ...overrides
  }
  const tool = createComfyUIWorkflowTool(pluginConfig)
  const config = resolveConfig(pluginConfig)
  const cwd = tempDir('workflow-tool')
  const { request } = normalizeRequest({ prompt: 'a corgi astronaut', seed: 42, width: 256, height: 256 }, { cwd, config })
  const workflow = buildText2Img({
    request,
    config,
    checkpoint: 'sd_xl_base_1.0.safetensors',
    samplerName: 'euler',
    scheduler: 'normal',
    filenamePrefix: 'test'
  }).workflow
  return { tool, config, cwd, workflow, exec: { agent: { meta: { cwd } } } }
}

test('validate: a complete workflow passes and reports node/output counts', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, exec } = setup(baseUrl)
  const result = await tool.execute({ action: 'validate', workflow }, exec)

  assert.equal(result.success, true)
  assertDeclaredKeys(result, WORKFLOW_OUTPUT_SCHEMA, 'workflow validate')
  assert.equal(result.valid, true)
  assert.equal(result.data.validation.node_count, 7)
  assert.equal(result.data.validation.output_node_count, 1)
  assert.match(result.text, /Workflow is valid/)
})

test('validate: unknown node, missing required input, unknown input and dangling links are clear', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, exec } = setup(baseUrl)

  const unknownNode = structuredClone(workflow)
  unknownNode['5'].class_type = 'KSamplr'
  const unknownResult = await tool.execute({ action: 'validate', workflow: unknownNode }, exec)
  assert.equal(unknownResult.success, false)
  assert.match(unknownResult.text, /Unknown node type "KSamplr"/)
  assert.match(unknownResult.text, /KSampler/)

  const missingInput = structuredClone(workflow)
  delete missingInput['5'].inputs.steps
  const missingResult = await tool.execute({ action: 'validate', workflow: missingInput }, exec)
  assert.equal(missingResult.success, false)
  assert.match(missingResult.text, /Missing required input "steps"/)

  const unknownInput = structuredClone(workflow)
  unknownInput['5'].inputs.samplr_name = 'euler'
  const inputResult = await tool.execute({ action: 'validate', workflow: unknownInput }, exec)
  assert.equal(inputResult.success, false)
  assert.match(inputResult.text, /Unknown input "samplr_name"/)
  assert.match(inputResult.text, /sampler_name/)

  const dangling = structuredClone(workflow)
  dangling['5'].inputs.model = ['99', 0]
  const danglingResult = await tool.execute({ action: 'validate', workflow: dangling }, exec)
  assert.equal(danglingResult.success, false)
  assert.match(danglingResult.text, /does not exist in this workflow/)
})

test('validate: bad enum value and out-of-range number are rejected with suggestions', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, exec } = setup(baseUrl)

  const badEnum = structuredClone(workflow)
  badEnum['5'].inputs.sampler_name = 'eular'
  const enumResult = await tool.execute({ action: 'validate', workflow: badEnum }, exec)
  assert.equal(enumResult.success, false)
  assert.match(enumResult.text, /does not accept "eular"/)
  assert.match(enumResult.text, /Did you mean:/)

  const badRange = structuredClone(workflow)
  badRange['5'].inputs.steps = 99999
  const rangeResult = await tool.execute({ action: 'validate', workflow: badRange }, exec)
  assert.equal(rangeResult.success, false)
  assert.match(rangeResult.text, /above the maximum/)
})

test('run: validates, submits, waits, downloads the image and writes metadata', async () => {
  const { mock, baseUrl } = await startMock()
  const { tool, workflow, cwd, exec } = setup(baseUrl)
  const outputDir = path.join(cwd, 'outputs')

  const result = await tool.execute(
    { action: 'run', workflow, output_path: outputDir, include_history: true },
    exec
  )

  assert.equal(result.success, true)
  assertDeclaredKeys(result, WORKFLOW_OUTPUT_SCHEMA, 'workflow run')
  assert.equal(result.status, 'success')
  assert.ok(result.prompt_id)
  assert.equal(result.files.length, 1)
  assert.ok(fs.existsSync(result.files[0]))
  assert.equal(path.dirname(result.files[0]), outputDir)
  assert.deepEqual(readPngSize(fs.readFileSync(result.files[0])), { width: 256, height: 256 })
  assert.ok(result.metadata_path && fs.existsSync(result.metadata_path))
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.kind, 'workflow-run')
  assert.equal(metadata.promptId, result.prompt_id)
  assert.ok(metadata.workflow)
  assert.ok(result.data.history, 'include_history should include the history entry')
  assert.ok(mock.state.stats.prompt >= 1)
})

test('run with wait=false then wait: collect an existing prompt id', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, cwd, exec } = setup(baseUrl)
  const submitted = await tool.execute({ action: 'run', workflow, wait: false }, exec)

  assert.equal(submitted.success, true)
  assert.equal(submitted.status, 'queued')
  assert.ok(submitted.prompt_id)

  const collected = await tool.execute(
    { action: 'wait', prompt_id: submitted.prompt_id, output_path: path.join(cwd, 'wait-out') },
    exec
  )
  assert.equal(collected.success, true)
  assert.equal(collected.status, 'success')
  assert.equal(collected.files.length, 1)
  assert.ok(fs.existsSync(collected.files[0]))
})

test('run: execution errors are returned with node details, not thrown', async () => {
  const { baseUrl } = await startMock({ failMode: 'execution_error' })
  const { tool, workflow, exec } = setup(baseUrl)
  const result = await tool.execute({ action: 'run', workflow }, exec)

  assert.equal(result.success, false)
  assert.equal(result.status, 'error')
  assert.ok(result.issues.some((issue) => issue.includes('CUDA out of memory')))
  assert.match(result.text, /CUDA out of memory/)
})

test('validate: workflow_path is loaded from disk', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, cwd, exec } = setup(baseUrl)
  const file = path.join(cwd, 'workflow.json')
  fs.writeFileSync(file, JSON.stringify(workflow), 'utf8')
  const result = await tool.execute({ action: 'validate', workflow_path: file }, exec)
  assert.equal(result.success, true)
  assert.equal(result.data.source, 'file')
})

test('upload: image and mask files use the right endpoints and return usable names', async () => {
  const { mock, baseUrl } = await startMock()
  const { tool, cwd, exec } = setup(baseUrl)
  const image = writePng(path.join(cwd, 'input.png'), 64, 64)
  const mask = writePng(path.join(cwd, 'mask.png'), 64, 64)

  const imageResult = await tool.execute({ action: 'upload', file_path: image }, exec)
  assert.equal(imageResult.success, true)
  assertDeclaredKeys(imageResult, WORKFLOW_OUTPUT_SCHEMA, 'workflow upload')
  assert.equal(imageResult.data.upload.name, 'input.png')
  assert.equal(mock.state.stats.upload, 1)

  const maskResult = await tool.execute({ action: 'upload', file_path: mask, kind: 'mask' }, exec)
  assert.equal(maskResult.success, true)
  assert.equal(maskResult.data.upload.name, 'mask.png')
  assert.equal(mock.state.stats.upload, 2)
})

test('job control: queue, queue_clear, queue_delete, interrupt and free', async () => {
  const { mock, baseUrl } = await startMock()
  const { tool, exec } = setup(baseUrl)

  mock.state.queue.queue_pending = [
    [1, 'pending-1', { 1: { class_type: 'KSampler', inputs: {} } }, {}, []],
    [2, 'pending-2', { 1: { class_type: 'KSampler', inputs: {} } }, {}, []]
  ]
  const queue = await tool.execute({ action: 'queue' }, exec)
  assert.equal(queue.success, true)
  assert.equal(queue.data.pending, 2)

  const removed = await tool.execute({ action: 'queue_delete', queue_ids: ['pending-1'] }, exec)
  assert.equal(removed.success, true)
  assert.equal(mock.state.queue.queue_pending.length, 1)

  const cleared = await tool.execute({ action: 'queue_clear' }, exec)
  assert.equal(cleared.success, true)
  assert.equal(mock.state.queue.queue_pending.length, 0)

  const interrupted = await tool.execute({ action: 'interrupt' }, exec)
  assert.equal(interrupted.success, true)
  assert.equal(mock.state.stats.interrupt, 1)

  const freed = await tool.execute({ action: 'free', unload_models: true, free_memory: true }, exec)
  assert.equal(freed.success, true)
  assert.equal(mock.state.stats.free, 1)
})

test('comfyui_workflow: a timeout is reported with the prompt id and a wait hint', async () => {
  const { baseUrl } = await startMock({ failMode: 'hang' })
  const { tool, workflow, exec } = setup(baseUrl, { timeoutMs: 1200 })
  const result = await tool.execute({ action: 'run', workflow, timeout_ms: 1200, poll_interval_ms: 100 }, exec)

  assert.equal(result.success, false)
  assert.equal(result.status, 'timeout')
  assert.ok(result.prompt_id)
  assert.match(result.text, /still running/)
  assert.match(result.text, /action=wait|comfyui_inspect/)
})

test('run: a single output can be saved to an exact file path', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, cwd, exec } = setup(baseUrl)
  const target = path.join(cwd, 'exact-name.png')

  const result = await tool.execute({ action: 'run', workflow, output_path: target }, exec)

  assert.equal(result.success, true)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0], target)
  assert.ok(fs.existsSync(target))
})

test('run: multiple output nodes are all downloaded', async () => {
  const { baseUrl } = await startMock()
  const { tool, workflow, cwd, exec } = setup(baseUrl)
  const multi = structuredClone(workflow)
  multi['8'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'second', images: ['6', 0] } }

  const result = await tool.execute({ action: 'run', workflow: multi, output_path: path.join(cwd, 'multi') }, exec)

  assert.equal(result.success, true)
  assert.equal(result.files.length, 2)
  for (const file of result.files) assert.ok(fs.existsSync(file))
})
