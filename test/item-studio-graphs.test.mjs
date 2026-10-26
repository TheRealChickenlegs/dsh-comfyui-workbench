import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFlux2Workflow,
  buildGuidedWorkflow,
  CONTROLNET_UNION,
  IPADAPTER_PLUS
} from '../lib/index.js'

function links(graph) {
  const out = []
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') out.push([id, key, value])
    }
  }
  return out
}

test('Flux.2 graph uses the local text-to-image nodes and wiring', () => {
  const graph = buildFlux2Workflow({
    prompt: 'potion', seed: 1,
    model: 'flux-2-klein-9b-fp8.safetensors',
    textEncoder: 'qwen_3_8b_fp8mixed.safetensors',
    vae: 'full_encoder_small_decoder.safetensors',
    steps: 4, cfg: 1, width: 1024, height: 1024,
    filenamePrefix: 'item_studio/test'
  })
  assert.equal(graph['1'].class_type, 'UNETLoader')
  assert.equal(graph['2'].class_type, 'CLIPLoader')
  assert.equal(graph['2'].inputs.type, 'flux2')
  assert.equal(graph['3'].class_type, 'VAELoader')
  assert.equal(graph['5'].class_type, 'ConditioningZeroOut')
  assert.equal(graph['6'].class_type, 'CFGGuider')
  assert.equal(graph['6'].inputs.cfg, 1)
  assert.equal(graph['7'].class_type, 'Flux2Scheduler')
  assert.equal(graph['7'].inputs.steps, 4)
  assert.equal(graph['10'].class_type, 'EmptyFlux2LatentImage')
  assert.equal(graph['11'].class_type, 'SamplerCustomAdvanced')
  assert.deepEqual(graph['11'].inputs.latent_image, ['10', 0])
  assert.equal(graph['13'].class_type, 'SaveImage')
  for (const [id, key, [target]] of links(graph)) {
    assert.ok(graph[target], `${id}.${key} links to missing node ${target}`)
  }
})

test('guided graph composes IPAdapter and ControlNet with the original weights', () => {
  const graph = buildGuidedWorkflow({
    prompt: 'a sword', negative: 'blurry', seed: 1,
    checkpoint: 'sd_xl_base_1.0.safetensors', lora: 'pixel-art-xl.safetensors',
    controlnetModel: CONTROLNET_UNION, ipadapterModel: IPADAPTER_PLUS,
    guideImage: 'guide.png', styleImage: 'style.png',
    controlnetStrength: 0.75, controlnetEnd: 0.85,
    styleStrength: 0.45, styleEnd: 0.8,
    steps: 26, cfg: 7, width: 1024, height: 1024,
    filenamePrefix: 'item_studio/guided'
  })
  assert.equal(graph['20'].class_type, 'IPAdapterUnifiedLoader')
  assert.equal(graph['20'].inputs.preset, 'PLUS (high strength)')
  assert.equal(graph['22'].class_type, 'IPAdapterAdvanced')
  assert.equal(graph['22'].inputs.weight, 0.45)
  assert.equal(graph['22'].inputs.weight_type, 'style transfer')
  assert.equal(graph['22'].inputs.end_at, 0.8)
  assert.equal(graph['30'].class_type, 'ControlNetLoader')
  assert.equal(graph['32'].class_type, 'ControlNetApplyAdvanced')
  assert.equal(graph['32'].inputs.strength, 0.75)
  assert.equal(graph['32'].inputs.end_percent, 0.85)
  assert.deepEqual(graph['6'].inputs.model, ['22', 0])
  assert.deepEqual(graph['6'].inputs.positive, ['32', 0])
  assert.deepEqual(graph['6'].inputs.negative, ['32', 1])
  assert.equal(graph['6'].inputs.steps, 26)
  assert.equal(graph['6'].inputs.cfg, 7)
  for (const [id, key, [target]] of links(graph)) {
    assert.ok(graph[target], `${id}.${key} links to missing node ${target}`)
  }
})

test('guided graph can omit style or guide without dangling links', () => {
  const noStyle = buildGuidedWorkflow({
    prompt: 'x', negative: 'y', seed: 1,
    checkpoint: 'c', lora: 'l', controlnetModel: CONTROLNET_UNION, ipadapterModel: IPADAPTER_PLUS,
    guideImage: 'guide.png', controlnetStrength: 0.75, controlnetEnd: 0.85,
    styleStrength: 0.45, styleEnd: 0.8, steps: 26, cfg: 7,
    width: 1024, height: 1024, filenamePrefix: 'x'
  })
  assert.equal(noStyle['20'], undefined)
  assert.deepEqual(noStyle['6'].inputs.model, ['2', 0])
  assert.deepEqual(noStyle['6'].inputs.positive, ['32', 0])
  const noGuide = buildGuidedWorkflow({
    prompt: 'x', negative: 'y', seed: 1,
    checkpoint: 'c', lora: 'l', controlnetModel: CONTROLNET_UNION, ipadapterModel: IPADAPTER_PLUS,
    styleImage: 'style.png', controlnetStrength: 0.75, controlnetEnd: 0.85,
    styleStrength: 0.45, styleEnd: 0.8, steps: 26, cfg: 7,
    width: 1024, height: 1024, filenamePrefix: 'x'
  })
  assert.equal(noGuide['30'], undefined)
  assert.deepEqual(noGuide['6'].inputs.model, ['22', 0])
  assert.deepEqual(noGuide['6'].inputs.positive, ['3', 0])
})
