import './env-setup.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCutoutWorkflow, buildQwenBackWorkflow, QWEN_UNET } from '../lib/sprite-qwen.js'

function assertLinks(graph) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
        assert.ok(graph[value[0]], `${id}.${key} links to missing ${value[0]}`)
      }
    }
  }
}

test('Qwen back-view graph is complete', () => {
  const graph = buildQwenBackWorkflow({
    image: 'front.png', positive: 'back view', negative: 'front view', seed: 1,
    model: QWEN_UNET, lora: 'qwen-lora.safetensors',
    clip: 'qwen_clip.safetensors', vae: 'qwen_vae.safetensors',
    filenamePrefix: 'sprite/qwen_back'
  })
  assert.equal(graph['1'].class_type, 'UnetLoaderGGUF')
  assert.equal(graph['5'].inputs.type, 'qwen_image')
  assert.equal(graph['9'].class_type, 'TextEncodeQwenImageEditPlus')
  assert.equal(graph['12'].inputs.steps, 4)
  assert.equal(graph['12'].inputs.cfg, 1)
  assert.equal(graph['16'].class_type, 'VRAMUnloadClip')
  assert.equal(graph['13'].class_type, 'VRAMUnloadModel')
  assertLinks(graph)
})

test('Qwen cutout graph is complete', () => {
  const graph = buildCutoutWorkflow({ image: 'raw.png', model: 'BiRefNet_lite', size: 512, filenamePrefix: 'sprite/cut' })
  assert.equal(graph['10'].class_type, 'BiRefNetRMBG')
  assert.equal(graph['25'].class_type, 'JoinImageWithAlpha')
  assert.equal(graph['26'].class_type, 'SaveImage')
  assertLinks(graph)
})
