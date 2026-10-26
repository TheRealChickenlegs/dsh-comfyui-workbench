/**
 * Configuration resolution.
 *
 * Priority (**higher wins**):
 *   1. Plugin config   — the `config:` of the entry in the profile's cordis.patch.yml (injected into `apply(ctx, config)`)
 *   2. Config file     — `~/.dsh-comfyui-workbench/config.json` (no DSH restart, no profile edit; the most convenient)
 *   3. Environment     — `COMFYUI_URL` etc. (handy in containers or for temporary overrides)
 *   4. Built-in defaults — DEFAULTS in this file
 *
 * Why plugin config ranks highest: DSH's config tree is the authoritative source for the host/operator,
 * so an explicit config should win; the config file is a convenience layer for people who "just want
 * to change an address without touching YAML".
 *
 * No third-party schema library: when a plugin does not export a `Config` schema, Cordis hands the
 * raw config object to `apply` **as-is** (see the resolveConfig docs of @deepseek-ai/cordis), so
 * hand-written validation is enough and avoids dependency resolution issues under link installs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PluginConfigInput, ResolvedConfig } from './types.js'
import { logDebug, logWarn } from './log.js'
import { ENV_CONFIG, ENV_OUTPUT, LEGACY_ENV_CONFIG, LEGACY_ENV_OUTPUT, LEGACY_PLUGIN_ID, PLUGIN_ID } from './identity.js'

/** Plugin id re-exported for callers that need the identity without importing identity.ts. */
export { PLUGIN_ID }

/** Default ComfyUI address. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'

/** Config file location; tests can point `DSH_COMFYUI_WORKBENCH_CONFIG` at a temp directory. */
export const CONFIG_FILE =
  process.env[ENV_CONFIG] || process.env[LEGACY_ENV_CONFIG] || path.join(os.homedir(), `.${PLUGIN_ID}`, 'config.json')

/** Previous config location, read only when the new config file is absent (0.5.x migration). */
export const LEGACY_CONFIG_FILE =
  process.env[LEGACY_ENV_CONFIG] || path.join(os.homedir(), `.${LEGACY_PLUGIN_ID}`, 'config.json')

/** Built-in defaults. */
export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  negativePrompt:
    'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry',
  steps: 20,
  cfgScale: 7,
  samplerName: 'euler',
  scheduler: 'normal',
  width: 1024,
  height: 1024,
  strength: 0.6,
  inpaintGrowMask: 6,
  timeoutMs: 300_000,
  pollIntervalMs: 700,
  requestTimeoutMs: 30_000,
  saveToComfyUI: true,
  writeMetadata: true,
  huggingFaceEndpoint: 'https://huggingface.co',
  maxDownloadBytes: 50 * 1024 * 1024 * 1024
} as const

/** Environment variable name → plugin config key. */
const ENV_KEYS: Record<string, keyof PluginConfigInput> = {
  COMFYUI_URL: 'baseUrl',
  COMFYUI_BASE_URL: 'baseUrl',
  COMFYUI_CHECKPOINT: 'checkpoint',
  COMFYUI_STEPS: 'steps',
  COMFYUI_CFG_SCALE: 'cfgScale',
  COMFYUI_SAMPLER: 'samplerName',
  COMFYUI_SCHEDULER: 'scheduler',
  COMFYUI_TIMEOUT_MS: 'timeoutMs',
  COMFYUI_REMBG_NODE: 'rembgNode',
  HF_TOKEN: 'huggingFaceToken',
  HUGGING_FACE_TOKEN: 'huggingFaceToken',
  HF_ENDPOINT: 'huggingFaceEndpoint',
  DSH_COMFYUI_WORKBENCH_MODELS_DIR: 'comfyuiModelsDir',
  DSH_COMFYUI_WORKBENCH_DOWNLOAD_DIR: 'modelDownloadDir',
  [ENV_OUTPUT]: 'outputDir'
}

/** Legacy environment variables, applied only when the new equivalent is unset. */
const LEGACY_ENV_KEYS: Record<string, keyof PluginConfigInput> = {
  [LEGACY_ENV_OUTPUT]: 'outputDir'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unwrap Schemastery volatile references so plugin config reads as plain values. */
function unwrapVolatile(value: unknown): unknown {
  if (isPlainObject(value) && typeof (value as { get?: unknown }).get === 'function') {
    return unwrapVolatile((value as { get: () => unknown }).get())
  }
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]))
  }
  return value
}

/** Read the config file; a broken file counts as absent and never takes the plugin down. */
let legacyConfigWarningShown = false

export function readConfigFile(): PluginConfigInput {
  const useLegacy = !fs.existsSync(CONFIG_FILE) && LEGACY_CONFIG_FILE !== CONFIG_FILE && fs.existsSync(LEGACY_CONFIG_FILE)
  const target = useLegacy ? LEGACY_CONFIG_FILE : CONFIG_FILE
  if (useLegacy && !legacyConfigWarningShown) {
    logWarn(
      `Using the legacy config file ${LEGACY_CONFIG_FILE}. Move it to ${CONFIG_FILE}; legacy support ends in 0.6.0.`
    )
    legacyConfigWarningShown = true
  }
  try {
    if (!fs.existsSync(target)) return {}
    const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? (parsed as PluginConfigInput) : {}
  } catch (error) {
    logWarn(
      `Cannot read the config file, ignoring it: ${target} (${error instanceof Error ? error.message : String(error)})`
    )
    return {}
  }
}

/** Merge a patch into the config file (reserved for a future panel/CLI). */
export function writeConfigFile(patch: PluginConfigInput): void {
  const next = { ...readConfigFile(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

/** Extract config from environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PluginConfigInput {
  const out: PluginConfigInput = {}
  for (const [envKey, configKey] of Object.entries(ENV_KEYS)) {
    const value = env[envKey]
    if (value !== undefined && value !== '') out[configKey] = value as never
  }
  for (const [envKey, configKey] of Object.entries(LEGACY_ENV_KEYS)) {
    const value = env[envKey]
    if (value !== undefined && value !== '' && out[configKey] === undefined) {
      out[configKey] = value as never
    }
  }
  return out
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function pickNumber(min: number, max: number, ...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? Number(candidate) : candidate
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      return value
    }
  }
  return undefined
}

function pickBoolean(...candidates: unknown[]): boolean | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') {
      if (candidate === '1' || candidate.toLowerCase() === 'true') return true
      if (candidate === '0' || candidate.toLowerCase() === 'false') return false
    }
  }
  return undefined
}

/**
 * Merge the four sources into a ready-to-use config.
 * Invalid values (negative steps, non-numeric timeout...) are **dropped and replaced with the default**,
 * with a trace in the debug log.
 */
export function resolveConfig(pluginConfig?: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const plainPluginConfig = unwrapVolatile(pluginConfig)
  const fromPlugin = isPlainObject(plainPluginConfig) ? (plainPluginConfig as PluginConfigInput) : {}
  const fromFile = readConfigFile()
  const fromEnv = configFromEnv(env)

  if (pluginConfig !== undefined && !isPlainObject(plainPluginConfig)) {
    logWarn('Plugin config is not an object, ignoring it (only a JSON object is accepted).')
  }

  const s = (...keys: (keyof PluginConfigInput)[]): unknown[] => [
    ...keys.map((key) => fromPlugin[key]),
    ...keys.map((key) => fromFile[key]),
    ...keys.map((key) => fromEnv[key])
  ]

  const baseUrl = pickString(...s('baseUrl')) ?? DEFAULTS.baseUrl
  const resolved: ResolvedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    negativePrompt: pickString(...s('negativePrompt')) ?? DEFAULTS.negativePrompt,
    steps: Math.round(pickNumber(1, 500, ...s('steps')) ?? DEFAULTS.steps),
    cfgScale: pickNumber(0, 100, ...s('cfgScale')) ?? DEFAULTS.cfgScale,
    samplerName: pickString(...s('samplerName')) ?? DEFAULTS.samplerName,
    scheduler: pickString(...s('scheduler')) ?? DEFAULTS.scheduler,
    width: Math.round(pickNumber(64, 8192, ...s('width')) ?? DEFAULTS.width),
    height: Math.round(pickNumber(64, 8192, ...s('height')) ?? DEFAULTS.height),
    strength: pickNumber(0, 1, ...s('strength')) ?? DEFAULTS.strength,
    inpaintGrowMask: Math.round(pickNumber(0, 256, ...s('inpaintGrowMask')) ?? DEFAULTS.inpaintGrowMask),
    timeoutMs: Math.round(pickNumber(1_000, 3_600_000, ...s('timeoutMs')) ?? DEFAULTS.timeoutMs),
    pollIntervalMs: Math.round(pickNumber(100, 10_000, ...s('pollIntervalMs')) ?? DEFAULTS.pollIntervalMs),
    requestTimeoutMs: Math.round(
      pickNumber(1_000, 600_000, ...s('requestTimeoutMs')) ?? DEFAULTS.requestTimeoutMs
    ),
    saveToComfyUI: pickBoolean(...s('saveToComfyUI')) ?? DEFAULTS.saveToComfyUI,
    writeMetadata: pickBoolean(...s('writeMetadata')) ?? DEFAULTS.writeMetadata,
    huggingFaceEndpoint: (pickString(...s('huggingFaceEndpoint')) ?? DEFAULTS.huggingFaceEndpoint).replace(/\/+$/, ''),
    maxDownloadBytes: Math.round(
      pickNumber(1_000_000, 500_000_000_000, ...s('maxDownloadBytes')) ?? DEFAULTS.maxDownloadBytes
    )
  }

  const outputDir = pickString(...s('outputDir'))
  if (outputDir !== undefined) resolved.outputDir = outputDir
  const checkpoint = pickString(...s('checkpoint'))
  if (checkpoint !== undefined) resolved.checkpoint = checkpoint
  const rembgNode = pickString(...s('rembgNode'))
  if (rembgNode !== undefined) resolved.rembgNode = rembgNode
  const huggingFaceToken = pickString(...s('huggingFaceToken'))
  if (huggingFaceToken !== undefined) resolved.huggingFaceToken = huggingFaceToken
  const comfyuiModelsDir = pickString(...s('comfyuiModelsDir'))
  if (comfyuiModelsDir !== undefined) resolved.comfyuiModelsDir = comfyuiModelsDir
  const modelDownloadDir = pickString(...s('modelDownloadDir'))
  if (modelDownloadDir !== undefined) resolved.modelDownloadDir = modelDownloadDir

  logDebug('Config resolved', {
    baseUrl: resolved.baseUrl,
    configFile: CONFIG_FILE,
    fileExists: fs.existsSync(CONFIG_FILE) || fs.existsSync(LEGACY_CONFIG_FILE),
    sources: { plugin: Object.keys(fromPlugin), file: Object.keys(fromFile), env: Object.keys(fromEnv) }
  })
  return resolved
}

/**
 * SD1.5-family checkpoints are happiest at 512, SDXL-family at 1024.
 * When the user did not specify width/height, pick a default based on the checkpoint name with a
 * **lightweight** rule — straightforward, written right here, with no deeper guessing.
 */
export function suggestSizeForCheckpoint(checkpoint: string, config: ResolvedConfig): { width: number; height: number } {
  const name = checkpoint.toLowerCase()
  const looksLikeLegacy = /(^|[^a-z0-9])(sd[_ ]?1[._-]?5|sd15|v1-5|sd_v1)/.test(name) && !name.includes('xl')
  if (looksLikeLegacy) return { width: 512, height: 512 }
  return { width: config.width, height: config.height }
}
