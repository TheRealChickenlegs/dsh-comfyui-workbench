/**
 * Config resolution tests: four-layer precedence + out-of-range fallbacks + default output directory semantics.
 *
 * Every case passes `env` explicitly and never reads the process environment, so it cannot be affected
 * by a real `COMFYUI_URL` or similar on the machine.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DEFAULTS, resolveConfig } from '../lib/index.js'
import { isolatePluginConfig, tempDir } from './helpers.mjs'

const configFile = isolatePluginConfig()

function clean() {
  try {
    fs.rmSync(configFile, { force: true })
  } catch {
    /* ignore */
  }
}

test('nothing configured → built-in defaults', () => {
  clean()
  const config = resolveConfig(undefined, {})
  assert.equal(config.baseUrl, DEFAULTS.baseUrl)
  assert.equal(config.steps, DEFAULTS.steps)
  assert.equal(config.cfgScale, DEFAULTS.cfgScale)
  assert.equal(config.samplerName, DEFAULTS.samplerName)
  assert.equal(config.scheduler, DEFAULTS.scheduler)
})

test('outputDir is unset by default — so default output lands in the "project root", not the DSH process directory', () => {
  clean()
  const config = resolveConfig(undefined, {})
  assert.equal(config.outputDir, undefined)
})

test('environment variables take effect', () => {
  clean()
  const config = resolveConfig(undefined, {
    COMFYUI_URL: 'http://10.0.0.5:8188/',
    COMFYUI_CHECKPOINT: 'env-model.safetensors',
    COMFYUI_STEPS: '30',
    DSH_COMFYUI_IMAGE_OUTPUT: 'D:\\env-out'
  })
  assert.equal(config.baseUrl, 'http://10.0.0.5:8188', 'the trailing slash should be removed')
  assert.equal(config.checkpoint, 'env-model.safetensors')
  assert.equal(config.steps, 30)
  assert.equal(config.outputDir, 'D:\\env-out')
})

test('priority: plugin config > config file > environment variables', () => {
  clean()
  const env = { COMFYUI_URL: 'http://from-env:8188' }

  // Environment variables only
  assert.equal(resolveConfig(undefined, env).baseUrl, 'http://from-env:8188')

  // The config file beats environment variables
  fs.writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://from-file:8188' }), 'utf8')
  assert.equal(resolveConfig(undefined, env).baseUrl, 'http://from-file:8188')

  // Plugin config (the config in cordis.patch.yml) beats everything
  assert.equal(resolveConfig({ baseUrl: 'http://from-plugin:8188' }, env).baseUrl, 'http://from-plugin:8188')

  clean()
})

test('out-of-range values are dropped and replaced with defaults (never passed to ComfyUI)', () => {
  clean()
  const config = resolveConfig(
    { steps: 9999, cfgScale: -5, pollIntervalMs: 5, timeoutMs: 10, width: 1, height: 999999 },
    {}
  )
  assert.equal(config.steps, DEFAULTS.steps)
  assert.equal(config.cfgScale, DEFAULTS.cfgScale)
  assert.equal(config.pollIntervalMs, DEFAULTS.pollIntervalMs)
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.width, DEFAULTS.width)
  assert.equal(config.height, DEFAULTS.height)
})

test('plugin config that is not an object → ignored, defaults used, no exception', () => {
  clean()
  const config = resolveConfig('this is not config', {})
  assert.equal(config.baseUrl, DEFAULTS.baseUrl)
})

test('broken config file (invalid JSON) → treated as absent, does not take the plugin down', () => {
  clean()
  fs.writeFileSync(configFile, '{ this is not valid json', 'utf8')
  try {
    const config = resolveConfig(undefined, {})
    assert.equal(config.baseUrl, DEFAULTS.baseUrl, 'the broken config should be ignored and fall back to defaults')
  } finally {
    clean()
  }
})
