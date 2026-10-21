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
import { Config, DEFAULTS, LEGACY_CONFIG_FILE, PLUGIN_ID, PLUGIN_VERSION, resolveConfig } from '../lib/index.js'
import { isolatePluginConfig, tempDir } from './helpers.mjs'

const configFile = isolatePluginConfig()
const legacyConfigFile = LEGACY_CONFIG_FILE

function clean() {
  for (const file of [configFile, legacyConfigFile]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* ignore */
    }
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
    DSH_COMFYUI_WORKBENCH_OUTPUT: 'D:\\env-out'
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

test('migration: the legacy config file is used when the new one is absent', () => {
  clean()
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ baseUrl: 'http://from-legacy-file:8188' }), 'utf8')
  try {
    assert.equal(resolveConfig(undefined, {}).baseUrl, 'http://from-legacy-file:8188')
  } finally {
    clean()
  }
})

test('migration: the new config file wins when both exist', () => {
  clean()
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ baseUrl: 'http://from-legacy-file:8188' }), 'utf8')
  fs.writeFileSync(configFile, JSON.stringify({ baseUrl: 'http://from-new-file:8188' }), 'utf8')
  try {
    assert.equal(resolveConfig(undefined, {}).baseUrl, 'http://from-new-file:8188')
  } finally {
    clean()
  }
})

test('migration: the legacy output env var is accepted, and the new one wins', () => {
  clean()
  assert.equal(
    resolveConfig(undefined, { DSH_COMFYUI_IMAGE_OUTPUT: 'D:\\legacy-out' }).outputDir,
    'D:\\legacy-out'
  )
  assert.equal(
    resolveConfig(undefined, {
      DSH_COMFYUI_IMAGE_OUTPUT: 'D:\\legacy-out',
      DSH_COMFYUI_WORKBENCH_OUTPUT: 'D:\\new-out'
    }).outputDir,
    'D:\\new-out'
  )
})

test('identity: package name and version match the runtime constants', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(PLUGIN_ID, pkg.name)
  assert.equal(PLUGIN_VERSION, pkg.version)
})

const UI_CONFIG_KEYS = [
  'baseUrl',
  'outputDir',
  'requestTimeoutMs',
  'timeoutMs',
  'pollIntervalMs',
  'checkpoint',
  'negativePrompt',
  'steps',
  'cfgScale',
  'samplerName',
  'scheduler',
  'width',
  'height',
  'strength',
  'inpaintGrowMask',
  'saveToComfyUI',
  'writeMetadata',
  'rembgNode'
]

test('UI: the Config schema exposes every config key as a volatile field', () => {
  assert.deepEqual(Object.keys(Config.dict ?? {}).sort(), [...UI_CONFIG_KEYS].sort())
  for (const [key, field] of Object.entries(Config.dict ?? {})) {
    assert.equal(field.meta?.volatile, true, `${key} must be volatile`)
    assert.equal(field.meta?.default, undefined, `${key} must not inject a schema default`)
  }
})

test('UI: plugin-page values win, while unset fields still inherit file/env/defaults', () => {
  clean()
  const parsed = Config({ baseUrl: 'http://from-ui:8188', steps: 9 })
  const resolved = resolveConfig(parsed, { COMFYUI_URL: 'http://from-env:8188' })
  assert.equal(resolved.baseUrl, 'http://from-ui:8188')
  assert.equal(resolved.steps, 9)

  const empty = Config({})
  assert.equal(resolveConfig(empty, { COMFYUI_URL: 'http://from-env:8188' }).baseUrl, 'http://from-env:8188')
  assert.equal(resolveConfig(empty, { COMFYUI_STEPS: '33' }).steps, 33)
  assert.equal(resolveConfig(empty, {}).baseUrl, DEFAULTS.baseUrl)
})
