#!/usr/bin/env node
/**
 * dsh-comfyui-workbench self-check (doctor) — a health report answering "can this machine generate images?".
 *
 * Usage:
 *   npm run doctor                      # check with the current configuration
 *   npm run doctor -- --base-url http://192.168.1.9:8188
 *   npm run doctor -- --json            # machine-readable output (for scripts/CI)
 *
 * It does four things:
 *   1. prints the **effective configuration** (after merging all four sources) and the config file location
 *   2. checks ComfyUI is alive (/system_stats) and prints its version and devices
 *   3. lists the **real available values** for checkpoints / samplers / schedulers (from /object_info, not guesses)
 *   4. decides per mode whether text2img / img2img / inpaint / remove_background can run, and what is missing
 *
 * Exit codes: 0 = all four modes available; 1 = cannot reach ComfyUI; 2 = connected but some mode cannot run.
 * It deliberately does not throw stack traces: this is a human-readable health report, not a test.
 */
import { existsSync } from 'node:fs'
import process from 'node:process'
import { ComfyUIClient } from '../lib/comfy/client.js'
import { checkModeSupport, chooseCheckpoint, chooseRembgPlan, chooseSampler } from '../lib/comfy/nodes.js'
import { CONFIG_FILE, LEGACY_CONFIG_FILE, resolveConfig } from '../lib/config.js'
import { PLUGIN_VERSION } from '../lib/runner.js'
import { PLUGIN_ID } from '../lib/identity.js'
import { GENERATE_MODES } from '../lib/types.js'

/** The **core** nodes used by the built-in workflows (they ship with ComfyUI; missing ones mean a wrong address or an old version). */
const CORE_NODES = [
  'CheckpointLoaderSimple',
  'CLIPTextEncode',
  'KSampler',
  'EmptyLatentImage',
  'VAEDecode',
  'VAEEncode',
  'VAEEncodeForInpaint',
  'LoadImage',
  'LoadImageMask',
  'SaveImage',
  'PreviewImage'
]

const MODE_LABELS = {
  text2img: 'text-to-image (text2img)',
  img2img: 'image-to-image (img2img)',
  inpaint: 'inpainting (inpaint)',
  remove_background: 'background removal (remove_background)'
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const baseUrlFlagIndex = argv.indexOf('--base-url')
const baseUrlFlag = baseUrlFlagIndex >= 0 ? argv[baseUrlFlagIndex + 1] : undefined
if (baseUrlFlag) process.env.COMFYUI_URL = baseUrlFlag

const report = {
  pluginVersion: PLUGIN_VERSION,
  configFile: CONFIG_FILE,
  reachable: false,
  comfyui: null,
  config: null,
  nodeCount: 0,
  missingCoreNodes: [],
  checkpoints: { available: [], chosen: null, error: null },
  sampler: { samplerName: null, scheduler: null, notes: [], error: null },
  rembg: { available: false, label: null, detail: null },
  modes: {},
  exitCode: 0
}

const lines = []
const say = (text = '') => {
  lines.push(text)
  if (!asJson) process.stdout.write(`${text}\n`)
}
const ok = (text) => say(`  \u2713 ${text}`)
const bad = (text) => say(`  \u2717 ${text}`)
const warn = (text) => say(`  ! ${text}`)

function fail(message, hint) {
  bad(message)
  if (hint) say(`    \u2192 ${hint}`)
}

async function main() {
  const config = resolveConfig()
  report.config = config

  const usingLegacyConfig =
    LEGACY_CONFIG_FILE !== CONFIG_FILE && !existsSync(CONFIG_FILE) && existsSync(LEGACY_CONFIG_FILE)
  const activeConfigFile = usingLegacyConfig ? LEGACY_CONFIG_FILE : CONFIG_FILE
  report.configFile = activeConfigFile

  say(`${PLUGIN_ID} v${PLUGIN_VERSION} self-check (doctor)`)
  say('')

  /* ── 1. Effective configuration ─────────────────────────── */
  say('[Configuration]')
  say(`  Config file: ${activeConfigFile}${usingLegacyConfig ? ' (legacy; move it to ' + CONFIG_FILE + ')' : ''}`)
  say(`  ComfyUI address: ${config.baseUrl}`)
  say(`  Checkpoint: ${config.checkpoint ?? '(not set, one will be picked automatically)'}`)
  say(`  Default sampling: ${config.samplerName} / ${config.scheduler}, steps=${config.steps}, cfg=${config.cfgScale}`)
  say(`  Default size: ${config.width}x${config.height} (SD1.5-family drops to 512 automatically)`)
  say(`  Output directory: ${config.outputDir ?? '(not set, defaults to the current project root)'}`)

  /* ── 2. Liveness check ─────────────────────────────────────────────── */
  say('')
  say('[Connection]')
  const client = new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })
  let stats
  try {
    stats = await client.systemStats()
    report.reachable = true
  } catch (error) {
    bad(
      error instanceof Error
        ? error.message
        : `Cannot reach ComfyUI at ${config.baseUrl}: ${String(error)}`
    )
    say('')
    say('  Start the local ComfyUI service first (default 127.0.0.1:8188), or fix the address:')
    say(`    change baseUrl in ${activeConfigFile}, or set the environment variable COMFYUI_URL`)
    report.exitCode = 1
    return
  }

  const system = stats.system ?? {}
  const devices = Array.isArray(stats.devices) ? stats.devices : []
  report.comfyui = {
    version: system.comfyui_version ?? null,
    python: system.python_version ?? null,
    devices: devices.map((device) => ({
      name: device?.name ?? 'unknown',
      type: device?.type ?? 'unknown',
      vramFreeGb: typeof device?.vram_free === 'number' ? +(device.vram_free / 1024 ** 3).toFixed(2) : null
    }))
  }
  ok(`ComfyUI is up: ${config.baseUrl}`)
  if (system.comfyui_version) ok(`Version: ${system.comfyui_version} (Python ${system.python_version ?? '?'})`)
  if (devices.length === 0) {
    warn('No devices reported (possibly CPU-only mode; generation will be slow).')
  } else {
    for (const device of report.comfyui.devices) {
      const vram = device.vramFreeGb === null ? '' : `, ${device.vramFreeGb} GB VRAM free`
      ok(`Device: ${device.name} (${device.type}${vram})`)
    }
  }

  /* ── 3. Node capabilities ─────────────────────────────────────────── */
  say('')
  say('[Capability probing]')
  let all
  try {
    all = await client.objectInfo()
    report.nodeCount = Object.keys(all).length
    ok(`${report.nodeCount} nodes reported`)
  } catch (error) {
    fail(`Failed to read /object_info: ${error instanceof Error ? error.message : String(error)}`)
    report.exitCode = 2
    return
  }

  report.missingCoreNodes = CORE_NODES.filter((name) => !(name in all))
  if (report.missingCoreNodes.length === 0) {
    ok('All core nodes required by the built-in workflows are present')
  } else {
    fail(
      `Missing core nodes: ${report.missingCoreNodes.join(', ')}`,
      'These are nodes bundled with ComfyUI: confirm the address really is ComfyUI and that the version is not too old.'
    )
  }

  try {
    const choice = await chooseCheckpoint(client, config.checkpoint ?? '')
    report.checkpoints.available = choice.available
    report.checkpoints.chosen = choice.checkpoint
    ok(`Checkpoints: ${choice.available.length} available, using "${choice.checkpoint}"`)
    const preview = choice.available.slice(0, 5).join(', ')
    say(`    ${preview}${choice.available.length > 5 ? ` ... ${choice.available.length} in total` : ''}`)
  } catch (error) {
    report.checkpoints.error = error instanceof Error ? error.message : String(error)
    fail(report.checkpoints.error, error?.hint)
  }

  try {
    const sampler = await chooseSampler(
      client,
      { samplerName: config.samplerName, scheduler: config.scheduler },
      config
    )
    report.sampler.samplerName = sampler.samplerName
    report.sampler.scheduler = sampler.scheduler
    report.sampler.notes = sampler.notes
    ok(`Sampling: ${sampler.samplerName} / ${sampler.scheduler}`)
    for (const note of sampler.notes) warn(note)
  } catch (error) {
    report.sampler.error = error instanceof Error ? error.message : String(error)
    fail(report.sampler.error, error?.hint)
  }

  try {
    const plan = await chooseRembgPlan(client, config.rembgNode)
    report.rembg.available = true
    report.rembg.label = plan.label
    ok(`Background-removal plan: ${plan.label} (nodes ${plan.requiredNodes.join(' \u2192 ')})`)
  } catch (error) {
    report.rembg.detail = error instanceof Error ? error.message : String(error)
    warn('remove_background is unavailable (core ComfyUI has no background-removal capability; a third-party node is required):')
    for (const hint of String(error?.hint ?? report.rembg.detail).split('\n')) say(`    ${hint}`)
  }

  /* ── 4. Per-mode verdict ───────────────────────────────────────── */
  say('')
  say('[Mode availability]')
  let unavailable = 0
  for (const mode of GENERATE_MODES) {
    const support = await checkModeSupport(client, mode)
    // The first three modes also need a checkpoint to really run.
    const hasCheckpoint = report.checkpoints.available.length > 0
    const usable = support.supported && (mode === 'remove_background' || hasCheckpoint)
    report.modes[mode] = { usable, detail: support.detail }
    if (usable) {
      ok(`${MODE_LABELS[mode]}: available`)
    } else {
      unavailable += 1
      fail(
        `${MODE_LABELS[mode]}: unavailable`,
        hasCheckpoint ? support.detail : 'No checkpoint available; put one into ComfyUI models/checkpoints first.'
      )
    }
  }

  say('')
  if (unavailable === 0) {
    say('Conclusion: all four modes are available; the Agent can call generate_image right away.')
  } else {
    say(`Conclusion: ${unavailable} mode(s) unavailable (details above); the other modes are unaffected.`)
    report.exitCode = 2
  }
}

try {
  await main()
} catch (error) {
  report.exitCode = report.exitCode || 1
  if (!asJson) {
    process.stderr.write(
      `The self-check itself failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    )
  }
}

if (asJson) {
  report.text = lines.join('\n')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
process.exit(report.exitCode)
