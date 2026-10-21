/**
 * Offline tests for workflow building (pure functions, no network).
 *
 * Besides asserting the key wiring per mode, there is a **generic structural check**,
 * `assertNoDanglingRefs`: it walks every `[node_id, slot]` link in the graph and confirms the
 * referenced node really exists. That way, even if node ids change later, it cannot silently
 * produce a broken workflow that "links to thin air".
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  applyCustomWorkflow,
  buildImg2Img,
  buildInpaint,
  buildRemoveBackground,
  buildText2Img,
  filenamePrefixFor,
  normalizeRequest
} from '../lib/index.js'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const cwd = tempDir('wf')
const config = testConfig()

// These must be real files: the parameter layer validates that input images exist, so fake paths
// would be rejected by it (correctly).
const inputFile = writePng(path.join(cwd, 'x.png'), 64, 64)
const maskFile = writePng(path.join(cwd, 'm.png'), 64, 64)

function factsFor(args, extra = {}) {
  const { request } = normalizeRequest(args, { cwd, config })
  return {
    request,
    config,
    checkpoint: 'sd_xl_base_1.0.safetensors',
    samplerName: 'euler',
    scheduler: 'normal',
    filenamePrefix: 'dsh-comfyui-workbench/test-prefix',
    ...extra
  }
}

/** A fake background-removal plan: unit tests do not depend on a real node table. */
function fakeRembgPlan() {
  return {
    key: 'fake',
    label: 'Fake background-removal node',
    requiredNodes: ['FakeRembg'],
    installHint: '',
    build: (input) => ({ nodes: { rb1: { class_type: 'FakeRembg', inputs: { image: input, model: 'u2net' } } }, output: ['rb1', 0] })
  }
}

/** Every link in the graph must point at a node that really exists. */
function assertNoDanglingRefs(workflow) {
  const ids = new Set(Object.keys(workflow))
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(value) || value.length !== 2) continue
      const [target, slot] = value
      if (typeof target !== 'string' || typeof slot !== 'number') continue
      assert.ok(
        ids.has(target),
        `node ${nodeId}'s input ${inputName} links to a non-existent node ${target} (available: ${[...ids].join(',')})`
      )
    }
  }
}

test('text2img: complete wiring + dimensions go into EmptyLatentImage', () => {
  const built = buildText2Img(factsFor({ prompt: 'a corgi astronaut', width: 768, height: 512 }))
  const wf = built.workflow

  assert.equal(built.mode, 'text2img')
  assert.equal(built.outputNodeId, '7')
  assertNoDanglingRefs(wf)

  assert.equal(wf['1'].class_type, 'CheckpointLoaderSimple')
  assert.equal(wf['1'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors')
  assert.equal(wf['2'].class_type, 'CLIPTextEncode')
  assert.equal(wf['2'].inputs.text, 'a corgi astronaut')
  assert.equal(wf['3'].class_type, 'CLIPTextEncode')
  assert.equal(wf['4'].class_type, 'EmptyLatentImage')
  assert.equal(wf['4'].inputs.width, 768)
  assert.equal(wf['4'].inputs.height, 512)
  assert.equal(wf['6'].class_type, 'VAEDecode')
  assert.equal(wf['7'].class_type, 'SaveImage')
  assert.equal(wf['7'].inputs.filename_prefix, 'dsh-comfyui-workbench/test-prefix')

  const sampler = wf['5']
  assert.equal(sampler.class_type, 'KSampler')
  assert.equal(sampler.inputs.denoise, 1, 'text2img should generate the whole image')
  assert.deepEqual(sampler.inputs.latent_image, ['4', 0])
  assert.deepEqual(sampler.inputs.model, ['1', 0])
  assert.deepEqual(sampler.inputs.positive, ['2', 0])
  assert.deepEqual(sampler.inputs.negative, ['3', 0])
  assert.deepEqual(wf['7'].inputs.images, ['6', 0])
  assert.deepEqual(wf['6'].inputs.samples, ['5', 0])
})

test('img2img: LoadImage → VAEEncode → KSampler, denoise=strength', () => {
  const built = buildImg2Img(
    factsFor(
      { mode: 'img2img', prompt: 'make it snowy', input_image: inputFile, strength: 0.35 },
      { uploadedInput: 'x.png' }
    )
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  assert.equal(wf['8'].class_type, 'LoadImage')
  assert.equal(wf['8'].inputs.image, 'x.png')
  assert.equal(wf['10'].class_type, 'VAEEncode')
  assert.deepEqual(wf['10'].inputs.pixels, ['8', 0])
  assert.deepEqual(wf['5'].inputs.latent_image, ['10', 0])
  assert.equal(wf['5'].inputs.denoise, 0.35)
})

test('inpaint: LoadImageMask (red channel) → VAEEncodeForInpaint, denoise=1', () => {
  const built = buildInpaint(
    factsFor(
      {
        mode: 'inpaint',
        prompt: 'replace with a hat',
        input_image: inputFile,
        mask_image: maskFile
      },
      { uploadedInput: 'x.png', uploadedMask: 'm.png' }
    )
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  assert.equal(wf['9'].class_type, 'LoadImageMask')
  assert.equal(wf['9'].inputs.image, 'm.png')
  assert.equal(wf['9'].inputs.channel, 'red')
  assert.equal(wf['10'].class_type, 'VAEEncodeForInpaint')
  assert.deepEqual(wf['10'].inputs.pixels, ['8', 0])
  assert.deepEqual(wf['10'].inputs.mask, ['9', 0])
  assert.equal(wf['10'].inputs.grow_mask_by, config.inpaintGrowMask)
  assert.equal(wf['5'].inputs.denoise, 1)
})

test('remove_background: the removal node output goes into SaveImage', () => {
  const built = buildRemoveBackground(
    factsFor({ mode: 'remove_background', input_image: inputFile }, {
      uploadedInput: 'x.png',
      rembg: fakeRembgPlan()
    })
  )
  const wf = built.workflow
  assertNoDanglingRefs(wf)

  const rembgNode = Object.values(wf).find((node) => node.class_type === 'FakeRembg')
  assert.ok(rembgNode, 'it should contain the removal node')
  assert.equal(wf['7'].class_type, 'SaveImage')
  const [sourceId] = wf['7'].inputs.images
  assert.ok(wf[sourceId], "SaveImage's input must be a node that really exists in the graph")
  assert.equal(wf[sourceId].class_type, 'FakeRembg', 'the removal result should go straight into SaveImage, without a sampler')
  assert.ok(!Object.values(wf).some((node) => node.class_type === 'KSampler'), 'background removal should have no sampler')
})

test('remove_background without a plan → errors immediately instead of producing a broken workflow', () => {
  assert.throws(() =>
    buildRemoveBackground(factsFor({ mode: 'remove_background', input_image: path.join(cwd, 'x.png') }, { uploadedInput: 'x.png' }))
  )
})

test('img2img / inpaint missing uploaded files → internal error, no silent degradation', () => {
  assert.throws(
    () => buildImg2Img(factsFor({ mode: 'img2img', prompt: 'x', input_image: inputFile })),
    /Internal error/
  )
  assert.throws(
    () =>
      buildInpaint(
        factsFor(
          { mode: 'inpaint', prompt: 'x', input_image: inputFile, mask_image: maskFile },
          { uploadedInput: 'x.png' }
        )
      ),
    /Internal error/
  )
})

test('saveToComfyUI=false → uses PreviewImage (does not pollute ComfyUI output)', () => {
  const noSave = { ...config, saveToComfyUI: false }
  const { request } = normalizeRequest({ prompt: 'x' }, { cwd, config: noSave })
  const built = buildText2Img({
    request,
    config: noSave,
    checkpoint: 'sd_xl_base_1.0.safetensors',
    samplerName: 'euler',
    scheduler: 'normal',
    filenamePrefix: 'p'
  })
  const classes = Object.values(built.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('PreviewImage'))
  assert.ok(!classes.includes('SaveImage'))
})

test('filenamePrefixFor: includes date/time and seed, and lives in a subdirectory', () => {
  const { request } = normalizeRequest({ prompt: 'x', seed: 12345 }, { cwd, config })
  const prefix = filenamePrefixFor(request, new Date(2026, 8, 28, 15, 30, 12))
  assert.equal(prefix, 'dsh-comfyui-workbench/20260928-153012-12345')
})

test('token substitution: numbers become numbers, strings are restored verbatim, unknown placeholders stay as-is', () => {
  const template = {
    '1': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '3': { class_type: 'X', inputs: { keep: '{{unknown_placeholder}}' } }
  }
  const result = applyCustomWorkflow(template, {
    width: 512,
    height: 768,
    prompt: 'quotes "inside" and \\ backslash'
  })

  assert.strictEqual(result['1'].inputs.width, 512, 'a numeric placeholder must become a number')
  assert.strictEqual(result['1'].inputs.height, 768)
  assert.strictEqual(
    result['2'].inputs.text,
    'quotes "inside" and \\ backslash',
    'strings must be restored verbatim'
  )
  assert.equal(result['3'].inputs.keep, '{{unknown_placeholder}}', 'a misspelled placeholder should stay put so it is noticeable')
})

test('token substitution: a template that is not an object → error', () => {
  assert.throws(() => applyCustomWorkflow([1, 2, 3], {}), /must be a JSON object/)
  assert.throws(() => applyCustomWorkflow(null, {}), /must be a JSON object/)
})
