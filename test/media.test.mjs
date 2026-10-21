/**
 * High-level audio/video tool tests: capability detection, missing-model feedback, workflow execution,
 * output schemas and metadata.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import {
  AUDIO_OUTPUT_SCHEMA,
  VIDEO_OUTPUT_SCHEMA,
  createGenerateAudioTool,
  createGenerateVideoTool,
  detectAudioSupport,
  detectVideoSupport
} from '../lib/index.js'
import { createMockComfyUI } from './mock-comfyui.mjs'
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
  const pluginConfig = { baseUrl, pollIntervalMs: 100, timeoutMs: 5000, requestTimeoutMs: 3000 }
  const cwd = tempDir('media')
  return {
    audio: createGenerateAudioTool(pluginConfig),
    video: createGenerateVideoTool(pluginConfig),
    pluginConfig,
    cwd,
    exec: { agent: { meta: { cwd } } }
  }
}

const AUDIO_MODELS = { checkpoints: ['ace_step_1.5_turbo_aio.safetensors'] }
const VIDEO_MODELS = {
  unetModels: ['wan2.1_t2v_1.3B_fp16.safetensors'],
  clipModels: ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'],
  vaeModels: ['wan_2.1_vae.safetensors']
}

/* ─────────────────────────── audio ─────────────────────────── */

test('audio detection: ACE-Step AIO is detected with its model and nodes', async () => {
  const { mock } = await startMock(AUDIO_MODELS)
  const client = { objectInfo: async () => mock.state.nodes }
  const support = await detectAudioSupport(client)
  assert.equal(support.supported, true)
  assert.equal(support.family, 'ace-step-1.5-aio')
  assert.equal(support.models.checkpoint, 'ace_step_1.5_turbo_aio.safetensors')
  assert.equal(support.missing.length, 0)
})

test('audio: missing models produce an actionable error listing ACE-Step and detected models', async () => {
  const { baseUrl } = await startMock()
  const { audio, cwd, exec } = setup(baseUrl)

  await assert.rejects(
    () => audio.execute({ prompt: 'ambient music' }, exec),
    (error) => {
      assert.match(error.message, /Audio generation is not available/)
      assert.match(error.message, /ACE-Step 1.5 AIO/)
      assert.match(error.message, /Missing:/)
      return true
    }
  )
})

test('audio: ACE-Step AIO workflow runs, saves audio and writes metadata', async () => {
  const { baseUrl } = await startMock(AUDIO_MODELS)
  const { audio, cwd, exec } = setup(baseUrl)
  const outputDir = path.join(cwd, 'audio-out')

  const result = await audio.execute(
    {
      prompt: 'warm ambient electronic music, 72 BPM, vinyl crackle',
      lyrics: '[Instrumental]',
      duration_seconds: 3,
      bpm: 72,
      seed: 31,
      steps: 2,
      output_path: outputDir
    },
    exec
  )

  assert.equal(result.success, true)
  assertDeclaredKeys(result, AUDIO_OUTPUT_SCHEMA, 'audio result')
  assert.equal(result.mode, 'audio')
  assert.equal(result.seed, 31)
  assert.equal(result.duration_seconds, 3)
  assert.ok(result.path.endsWith('.mp3'))
  assert.ok(fs.existsSync(result.path))
  assert.equal(path.dirname(result.path), outputDir)
  assert.ok(result.metadata_path && fs.existsSync(result.metadata_path))
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.kind, 'audio-generation')
  assert.equal(metadata.mediaType, 'audio')
  assert.equal(metadata.family, 'ace-step-1.5-aio')
  assert.equal(metadata.prompt, 'warm ambient electronic music, 72 BPM, vinyl crackle')
})

/* ─────────────────────────── video ─────────────────────────── */

test('video detection: Wan 2.1 T2V models and nodes are detected', async () => {
  const { mock } = await startMock(VIDEO_MODELS)
  const client = { objectInfo: async () => mock.state.nodes }
  const support = await detectVideoSupport(client)
  assert.equal(support.supported, true)
  assert.equal(support.family, 'wan2.1-t2v')
  assert.equal(support.models.diffusion, 'wan2.1_t2v_1.3B_fp16.safetensors')
  assert.equal(support.models.clip, 'umt5_xxl_fp8_e4m3fn_scaled.safetensors')
  assert.equal(support.models.vae, 'wan_2.1_vae.safetensors')
})

test('video: missing Wan setup produces an actionable error with detected models', async () => {
  const { baseUrl } = await startMock({ unetModels: ['Wan2.1_14B_VACE-Q4_K_M.gguf'] })
  const { video, exec } = setup(baseUrl)

  await assert.rejects(
    () => video.execute({ prompt: 'a fox running through snow' }, exec),
    (error) => {
      assert.match(error.message, /Video generation is not available/)
      assert.match(error.message, /Detected video-related models/)
      assert.match(error.message, /Wan 2\.1 text-to-video/)
      assert.match(error.message, /Missing:/)
      return true
    }
  )
})

test('video: Wan 2.1 T2V workflow runs, saves a video and writes metadata', async () => {
  const { baseUrl } = await startMock(VIDEO_MODELS)
  const { video, cwd, exec } = setup(baseUrl)
  const outputDir = path.join(cwd, 'video-out')

  const result = await video.execute(
    {
      prompt: 'a fox running through a snowy forest, tracking camera',
      width: 64,
      height: 64,
      length_frames: 5,
      fps: 8,
      seed: 9,
      steps: 2,
      output_path: outputDir
    },
    exec
  )

  assert.equal(result.success, true)
  assertDeclaredKeys(result, VIDEO_OUTPUT_SCHEMA, 'video result')
  assert.equal(result.mode, 'video')
  assert.equal(result.seed, 9)
  assert.equal(result.width, 64)
  assert.equal(result.height, 64)
  assert.equal(result.fps, 8)
  assert.ok(result.path.endsWith('.mp4'))
  assert.ok(fs.existsSync(result.path))
  assert.equal(path.dirname(result.path), outputDir)
  assert.ok(result.metadata_path && fs.existsSync(result.metadata_path))
  const metadata = JSON.parse(fs.readFileSync(result.metadata_path, 'utf8'))
  assert.equal(metadata.kind, 'video-generation')
  assert.equal(metadata.mediaType, 'video')
  assert.equal(metadata.family, 'wan2.1-t2v')
  assert.equal(metadata.lengthFrames, 5)
  assert.equal(metadata.fps, 8)
})
