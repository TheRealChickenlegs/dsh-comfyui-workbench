/**
 * Capability probing: find out what the local ComfyUI actually has, and translate the result into
 * **facts** the workflow builder can use directly.
 *
 * Why a separate layer: all network access is concentrated here, which keeps `workflows.ts` a pure
 * function that can be unit-tested offline. That boundary is deliberate.
 *
 * Three things are probed:
 *   1. Checkpoint   — pick one automatically when unspecified, and report what is available
 *   2. Samplers     — verify sampler_name / scheduler really exist, fall back with an explanation if not
 *   3. Background removal — core ComfyUI has no removal node, so pick one of the third-party options
 */
import type { ResolvedConfig } from '../types.js'
import { ImagePluginError } from '../errors.js'
import { logDebug } from '../log.js'
import type { ComfyNodeInfo, ComfyUIClient } from './client.js'
import type { ComfyNode, ComfyWorkflow } from '../types.js'

/* ────────────────────────── small /object_info helpers ────────────────────────── */

/**
 * ComfyUI's input format (observed in /object_info):
 *   ["INT",   { default: 20, min: 1, max: 10000 }]
 *   ["FLOAT", { default: 7.0, min: 0, max: 100 }]
 *   [["euler","dpmpp_2m"], { default: "euler" }]      ← enum: the first item is a string array
 *   ["IMAGE"], ["MASK"], ["MODEL"]                    ← link types
 */
export function declaredInputs(info: ComfyNodeInfo | undefined): Record<string, unknown> {
  return { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) }
}

export function requiredInputs(info: ComfyNodeInfo | undefined): Record<string, unknown> {
  return { ...(info?.input?.required ?? {}) }
}

/** The choices of an enum input; undefined when it is not an enum. */
export function enumChoices(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined
  const first = spec[0]
  if (Array.isArray(first) && first.length > 0 && first.every((v) => typeof v === 'string')) {
    return first as string[]
  }
  return undefined
}

/** The declared type name of an input ("INT" / "STRING" / "IMAGE" / ...). */
export function inputTypeName(spec: unknown): string | undefined {
  if (Array.isArray(spec) && typeof spec[0] === 'string') return spec[0]
  return undefined
}

/** The declared default value of an input. */
export function specDefault(spec: unknown): unknown {
  if (!Array.isArray(spec)) return undefined
  const meta = spec[1]
  if (meta && typeof meta === 'object' && 'default' in (meta as Record<string, unknown>)) {
    return (meta as Record<string, unknown>).default
  }
  return undefined
}

/** Pick the first candidate name that is actually declared. */
export function pickDeclaredKey(
  declared: Record<string, unknown>,
  candidates: readonly string[]
): string | undefined {
  for (const candidate of candidates) {
    if (candidate in declared) return candidate
  }
  return undefined
}

/** Only fill keys the node really declares, so we never inject a non-existent input and get /prompt rejected. */
export function fillInputs(
  info: ComfyNodeInfo | undefined,
  wanted: Record<string, unknown>
): Record<string, unknown> {
  const declared = declaredInputs(info)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && key in declared) out[key] = value
  }
  return out
}

/**
 * On top of `fillInputs`, fill **required enum inputs we did not provide** with the node's own default.
 *
 * This is the key trick for third-party nodes with varying parameter names: for example, a
 * background-removal node may have an extra required `model`; we do not need to know its name, as
 * long as it is an enum we can fill it from the node's own default.
 * Only enums are filled (never link inputs such as IMAGE).
 */
export function autoFillRequired(
  info: ComfyNodeInfo | undefined,
  wanted: Record<string, unknown>
): Record<string, unknown> {
  const out = fillInputs(info, wanted)
  const required = requiredInputs(info)
  for (const [key, spec] of Object.entries(required)) {
    if (key in out) continue
    const choices = enumChoices(spec)
    const fallback = specDefault(spec) ?? choices?.[0]
    if (fallback !== undefined) out[key] = fallback
  }
  return out
}

/* ────────────────────────────── checkpoint selection ────────────────────────────── */

export interface CheckpointChoice {
  checkpoint: string
  available: string[]
}

/**
 * Pick a checkpoint:
 *   1. the user/config specified one and it exists → use it
 *   2. nothing specified → prefer a name containing "xl" (more general), otherwise the first
 *   3. specified but missing → **error and list the options** (more predictable than silently swapping)
 */
export async function chooseCheckpoint(
  client: ComfyUIClient,
  preferred: string,
  signal?: AbortSignal
): Promise<CheckpointChoice> {
  const info = await client.nodeInfo('CheckpointLoaderSimple', signal)
  if (!info) {
    throw new ImagePluginError(
      'ComfyUI has no CheckpointLoaderSimple node.',
      'That node ships with core ComfyUI. Confirm that baseUrl points at real ComfyUI and that the version is not too old.'
    )
  }
  const spec = requiredInputs(info).ckpt_name
  const available = enumChoices(spec) ?? []

  if (available.length === 0) {
    throw new ImagePluginError(
      'ComfyUI reports no available checkpoints (models/checkpoints is empty).',
      'Put a .safetensors / .ckpt checkpoint (for example SDXL or SD1.5) into ComfyUI/models/checkpoints, ' +
        'then refresh in the ComfyUI UI.'
    )
  }

  if (preferred) {
    if (available.includes(preferred)) return { checkpoint: preferred, available }
    throw new ImagePluginError(
      `The specified checkpoint does not exist: ${preferred}`,
      `Checkpoints available on this machine: ${available.slice(0, 12).join(', ')}${
        available.length > 12 ? ` and ${available.length} in total` : ''
      }. ` + 'Change model to one of them, or clear that config setting to let the plugin pick automatically.'
    )
  }

  const preferredDefault = available.find((name) => /xl/i.test(name)) ?? available[0]
  if (!preferredDefault) {
    throw new ImagePluginError('ComfyUI returned an empty checkpoint list.', 'Put a checkpoint into models/checkpoints.')
  }
  logDebug(`Auto-selected checkpoint: ${preferredDefault} (${available.length} available)`)
  return { checkpoint: preferredDefault, available }
}

/* ────────────────────────────── sampler validation ────────────────────────────── */

export interface SamplerChoice {
  samplerName: string
  scheduler: string
  notes: string[]
}

/** Validate sampler/scheduler: a bad explicit value is an error; a stale config default falls back with a note. */
export async function chooseSampler(
  client: ComfyUIClient,
  request: { samplerName: string; scheduler: string },
  config: ResolvedConfig,
  signal?: AbortSignal
): Promise<SamplerChoice> {
  const info = await client.nodeInfo('KSampler', signal)
  const notes: string[] = []
  if (!info) {
    throw new ImagePluginError(
      'ComfyUI has no KSampler node.',
      'KSampler is a core ComfyUI node; if it is missing, the address is probably not a ComfyUI service.'
    )
  }
  const required = requiredInputs(info)
  const samplerOptions = enumChoices(required.sampler_name) ?? []
  const schedulerOptions = enumChoices(required.scheduler) ?? []

  const userPickedSampler = request.samplerName !== config.samplerName
  const userPickedScheduler = request.scheduler !== config.scheduler

  let samplerName = request.samplerName
  if (samplerOptions.length > 0 && !samplerOptions.includes(samplerName)) {
    const fallback = samplerOptions.includes(config.samplerName) ? config.samplerName : (samplerOptions[0] as string)
    if (userPickedSampler) {
      throw new ImagePluginError(
        `Sampler does not exist: ${samplerName}`,
        `Available on this machine: ${samplerOptions.join(', ')}`
      )
    }
    notes.push(`Sampler ${samplerName} does not exist on this machine; switched to ${fallback}.`)
    samplerName = fallback
  }

  let scheduler = request.scheduler
  if (schedulerOptions.length > 0 && !schedulerOptions.includes(scheduler)) {
    const fallback = schedulerOptions.includes(config.scheduler) ? config.scheduler : (schedulerOptions[0] as string)
    if (userPickedScheduler) {
      throw new ImagePluginError(
        `Scheduler does not exist: ${scheduler}`,
        `Available on this machine: ${schedulerOptions.join(', ')}`
      )
    }
    notes.push(`Scheduler ${scheduler} does not exist on this machine; switched to ${fallback}.`)
    scheduler = fallback
  }

  return { samplerName, scheduler, notes }
}

/* ────────────────────────── background-removal strategy probing ────────────────────────── */

/** The build result of one background-removal plan: the node table + where the final IMAGE output is. */
export interface RembgBuildResult {
  nodes: ComfyWorkflow
  output: [string, number]
}

/** One background-removal plan. `build` closes over the node definitions at probe time, then behaves as a pure function. */
export interface RembgPlan {
  key: string
  label: string
  requiredNodes: string[]
  installHint: string
  build: (input: [string, number]) => RembgBuildResult
}

/** Candidate names for the image input key (different authors name things differently). */
const IMAGE_KEY_CANDIDATES = ['image', 'images', 'input_image', 'img', 'pixels', 'image_in'] as const
/** Candidate names for the model input key. */
const MODEL_KEY_CANDIDATES = [
  'model',
  'bria_rmbg_model',
  'rmbg_model',
  'bria_model',
  'session',
  'rembg_session'
] as const

interface RembgPreset {
  key: string
  label: string
  /** Node combinations tried in order; all must exist for the preset to be usable. */
  chains: string[][]
  installHint: string
  /** Single-node plan: wire the input image straight into this node. */
  single?: string
  /** Two-node plan: [loader, consumer]. */
  pair?: [string, string]
}

/**
 * Verified third-party background-removal options (highest precedence first).
 * Core ComfyUI **has no** background-removal node, so this section necessarily depends on custom_nodes —
 * and when a dependency is missing it gives "what to install and how", not a dry error.
 *
 * The repository/class-name mapping comes from ComfyUI-Manager's extension-node-map.json (the
 * authoritative index). **Do not change it from memory**: there is no node called `RemBG` in the
 * index, and no repository called `Limbicnation/ComfyUI_RemBG-U2Net` — plausible-sounding names like
 * that were the source of errors in early versions of this file. Check the index, or the target
 * repository's NODE_CLASS_MAPPINGS, before editing this.
 */
const REMBG_PRESETS: RembgPreset[] = [
  {
    key: 'essentials',
    label: 'ComfyUI_essentials (RemBGSession+ → ImageRemoveBackground+)',
    chains: [['RemBGSession+', 'ImageRemoveBackground+']],
    pair: ['RemBGSession+', 'ImageRemoveBackground+'],
    installHint:
      'Install the background-removal nodes: git clone https://github.com/cubiq/ComfyUI_essentials into ComfyUI/custom_nodes/, ' +
      'then use ComfyUI\'s own Python to run pip install "rembg[cpu]" (without [cpu] there is no onnxruntime backend, and ' +
      'import rembg fails outright), then restart ComfyUI. The first removal downloads the u2net weights (about 176 MB).'
  },
  {
    key: 'bria',
    label: 'ComfyUI-BRIA_AI-RMBG (BRIA_RMBG_ModelLoader_Zho → BRIA_RMBG_Zho)',
    chains: [['BRIA_RMBG_ModelLoader_Zho', 'BRIA_RMBG_Zho']],
    pair: ['BRIA_RMBG_ModelLoader_Zho', 'BRIA_RMBG_Zho'],
    installHint:
      'Install the background-removal nodes: git clone https://github.com/ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG into ComfyUI/custom_nodes/, ' +
      'restart ComfyUI; the first use downloads the BRIA weights automatically.'
  },
  {
    key: 'layerstyle',
    label: 'ComfyUI-LayerStyle (LayerMask: RemBgUltra node)',
    chains: [['LayerMask: RemBgUltra']],
    single: 'LayerMask: RemBgUltra',
    installHint:
      'Install the background-removal nodes: git clone https://github.com/chflame163/ComfyUI_LayerStyle into ComfyUI/custom_nodes/, ' +
      'install its dependencies (rembg / onnxruntime) following its README, then restart ComfyUI.'
  },
  {
    key: 'was',
    label: 'WAS Node Suite (Image Rembg (Remove Background) node)',
    chains: [['Image Rembg (Remove Background)']],
    single: 'Image Rembg (Remove Background)',
    installHint:
      'Install the background-removal nodes: git clone https://github.com/ltdrdata/was-node-suite-comfyui into ComfyUI/custom_nodes/, ' +
      'install its requirements (including rembg / onnxruntime), then restart ComfyUI.'
  }
]

function buildSingle(className: string, info: ComfyNodeInfo | undefined, input: [string, number]): RembgBuildResult {
  const declared = declaredInputs(info)
  const imageKey = pickDeclaredKey(declared, IMAGE_KEY_CANDIDATES)
  if (!imageKey) {
    throw new ImagePluginError(
      `Node ${className} has no recognisable image input.`,
      `Its declared inputs are: ${Object.keys(declared).join(', ') || '(none)'}. Tell me the input name for that node, or use a different background-removal node.`
    )
  }
  const inputs = autoFillRequired(info, { [imageKey]: input })
  const node: ComfyNode = { class_type: className, inputs }
  return { nodes: { rb1: node }, output: ['rb1', 0] }
}

function buildPair(
  loader: string,
  consumer: string,
  loaderInfo: ComfyNodeInfo | undefined,
  consumerInfo: ComfyNodeInfo | undefined,
  input: [string, number]
): RembgBuildResult {
  const declared = declaredInputs(consumerInfo)
  const imageKey = pickDeclaredKey(declared, IMAGE_KEY_CANDIDATES)
  const modelKey = pickDeclaredKey(declared, MODEL_KEY_CANDIDATES)
  if (!imageKey) {
    throw new ImagePluginError(
      `Node ${consumer} has no recognisable image input.`,
      `Its declared inputs are: ${Object.keys(declared).join(', ') || '(none)'}.`
    )
  }
  const wanted: Record<string, unknown> = { [imageKey]: input }
  if (modelKey) wanted[modelKey] = ['rb1', 0]
  const nodes: ComfyWorkflow = {
    rb1: { class_type: loader, inputs: autoFillRequired(loaderInfo, {}) },
    rb2: { class_type: consumer, inputs: autoFillRequired(consumerInfo, wanted) }
  }
  if (!modelKey) {
    throw new ImagePluginError(
      `Node ${consumer} has no recognisable model input.`,
      `Its declared inputs are: ${Object.keys(declared).join(', ') || '(none)'}.`
    )
  }
  return { nodes, output: ['rb2', 0] }
}

/**
 * Pick a usable background-removal plan.
 *
 * @param forced The plan key or node class name given by `rembgNode`; when set, only that one is used (a clear error if missing)
 * @throws ImagePluginError when no plan is usable, listing every option and how to install it
 */
export async function chooseRembgPlan(
  client: ComfyUIClient,
  forced: string | undefined,
  signal?: AbortSignal
): Promise<RembgPlan> {
  const all = await client.objectInfo(signal)
  const missing: RembgPreset[] = []

  const candidates = forced
    ? REMBG_PRESETS.filter(
        (preset) =>
          preset.key === forced ||
          preset.single === forced ||
          preset.chains.some((chain) => chain.includes(forced))
      )
    : REMBG_PRESETS

  if (forced && candidates.length === 0) {
    throw new ImagePluginError(
      `rembgNode=${forced} in the config is not a known plan.`,
      `Known: ${REMBG_PRESETS.map((p) => `${p.key} (${p.label})`).join('; ')}`
    )
  }

  for (const preset of candidates) {
    const chain = preset.chains.find((nodes) => nodes.every((node) => node in all))
    if (!chain) {
      missing.push(preset)
      continue
    }
    logDebug(`Background-removal plan selected: ${preset.key} (${chain.join(' → ')})`)
    const snapshot = all
    return {
      key: preset.key,
      label: preset.label,
      requiredNodes: chain,
      installHint: preset.installHint,
      build: (input: [string, number]): RembgBuildResult => {
        if (preset.single) return buildSingle(preset.single, snapshot[preset.single], input)
        const [loaderName, consumerName] = preset.pair as [string, string]
        return buildPair(loaderName, consumerName, snapshot[loaderName], snapshot[consumerName], input)
      }
    }
  }

  const tried = (forced ? candidates : missing)
    .map((p) => `${p.label} → requires nodes ${p.chains[0]?.join(' + ')}`)
    .join('\n  ')
  throw new ImagePluginError(
    'No usable background-removal node exists in the local ComfyUI.',
    'remove_background depends on third-party custom nodes (core ComfyUI 0.3x ships RemoveBackground, ' +
      'but it outputs a mask and needs a model under models/background_removal; this plugin does not wire ' +
      'it up yet). Tried:\n  ' +
      tried +
      `\nInstall any one of these:\n  ${missing.map((p) => p.installHint).join('\n  ')}`
  )
}

/** Whether a mode can actually run on this ComfyUI — used to give a clear "why not" answer. */
export async function checkModeSupport(
  client: ComfyUIClient,
  mode: string,
  signal?: AbortSignal
): Promise<{ supported: boolean; detail: string }> {
  if (mode !== 'remove_background') return { supported: true, detail: 'Core nodes; no extra installation needed.' }
  try {
    const plan = await chooseRembgPlan(client, undefined, signal)
    return { supported: true, detail: `Available plan: ${plan.label}` }
  } catch (error) {
    return {
      supported: false,
      detail: error instanceof ImagePluginError ? `${error.message}\n${error.hint ?? ''}`.trim() : String(error)
    }
  }
}
