/**
 * Shared type definitions for the whole plugin.
 *
 * Design principles (the "unified parameter layer" section of the spec):
 *   - `GenerateImageArgs`   = the **public** contract: exactly the arguments the Agent sees.
 *                             Keep it small and easy to understand.
 *   - `NormalizedRequest`   = the **internal** contract: defaults filled in, mode decided,
 *                             paths resolved. Every downstream module (workflow building /
 *                             execution / writing results) depends only on this.
 *   Keeping the two apart means: changes to ComfyUI internals only touch the workflow module,
 *   while new public arguments only touch args + params.
 */

/** The four operation modes V1 exposes to the Agent. */
export type GenerateMode = 'text2img' | 'img2img' | 'inpaint' | 'remove_background'

/** The order here is the precedence used by mode inference. Do not change it casually. */
export const GENERATE_MODES: readonly GenerateMode[] = [
  'text2img',
  'img2img',
  'inpaint',
  'remove_background'
]

export function isGenerateMode(value: unknown): value is GenerateMode {
  return typeof value === 'string' && (GENERATE_MODES as readonly string[]).includes(value)
}

/**
 * The unified public argument layer.
 *
 * It deliberately does **not** expose ComfyUI's low-level parameters verbatim; only the knobs
 * that genuinely need tuning are kept. Everything else (batch_size, vae, clip skip, node ids, ...)
 * is decided by the plugin.
 *
 * `style_reference` / `character_reference` / `extra_options` are **reserved slots**:
 * V1 accepts them and records them in the metadata, but they do not change the generated result
 * (see the "consistency" section of the README).
 */
export interface GenerateImageArgs {
  /** Operation mode. If omitted, it is inferred from input_image / mask_image (see README). */
  mode?: GenerateMode
  /** Positive prompt. Required for text2img / img2img / inpaint; ignored by remove_background. */
  prompt?: string
  /** Negative prompt. Optional; the plugin default is used when omitted. */
  negative_prompt?: string
  /** Local path of the input image (required for img2img / inpaint / remove_background). */
  input_image?: string
  /** Local path of the mask image (required for inpaint). White/bright = the region to repaint. */
  mask_image?: string
  /** Output width. Only effective for text2img (other modes take their canvas from the input image). */
  width?: number
  /** Output height. Only effective for text2img. */
  height?: number
  /** Random seed. Generated automatically when omitted; same seed + same prompt reproduces the image. */
  seed?: number
  /** Output directory or output file path. Defaults to the current project root. */
  output_path?: string
  /** [Reserved] Path to a style reference image. */
  style_reference?: string
  /** [Reserved] Path to a character reference image. */
  character_reference?: string
  /** img2img strength / denoise amount (0~1). Defaults to 0.6 for img2img and 1.0 for inpaint. */
  strength?: number
  /** Sampling steps. Default 20. */
  steps?: number
  /** CFG scale. Default 7. */
  cfg_scale?: number
  /** Checkpoint file name (the name under models/checkpoints in ComfyUI). One is picked automatically when omitted. */
  model?: string
  /** Sampler name (optional). Uses the plugin default when omitted. */
  sampler_name?: string
  /** Scheduler name (optional). Uses the plugin default when omitted. */
  scheduler?: string
  /** [Reserved] Extension fields. `workflow_path` can hand this generation over to a custom API-format workflow. */
  extra_options?: Record<string, unknown>
}

/**
 * A normalized request: defaults filled in, mode decided, paths resolved.
 * All downstream modules depend only on this structure.
 */
export interface NormalizedRequest {
  mode: GenerateMode
  prompt: string
  negativePrompt: string
  /** Already resolved to an absolute path; only present in modes that take an input image. */
  inputImage?: string
  maskImage?: string
  styleReference?: string
  characterReference?: string
  /** Used by text2img; ignored by other modes. */
  width: number
  height: number
  /**
   * Whether this dimension was given **explicitly** by the caller (the width / height arguments).
   * false means "not decided yet" — once the checkpoint is chosen it can adapt to it,
   * see applyModelAwareSize.
   */
  widthFromArgs: boolean
  heightFromArgs: boolean
  seed: number
  strength: number
  steps: number
  cfgScale: number
  /** An empty string means "let the workflow module pick one automatically". */
  checkpoint: string
  samplerName: string
  scheduler: string
  /** The final output file, already resolved to an absolute path. */
  outputPath: string
  /** User-readable notes for this request (for example "width/height are ignored for inpaint"). */
  notes: string[]
  /** Extension fields preserved verbatim. */
  extra: Record<string, unknown>
}

/** One node in a ComfyUI API-format workflow. */
export interface ComfyNode {
  class_type: string
  /** Key/value pairs: literals, or links of the form `[upstream_node_id, output_index]`. */
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

/** A ComfyUI API-format workflow: node id → node. */
export type ComfyWorkflow = Record<string, ComfyNode>

/** The structure ComfyUI's `/history` uses to describe one produced image. */
export interface ComfyImageRef {
  filename: string
  subfolder: string
  type: string
}

/** One successful generation result. */
export interface GenerationOutcome {
  /** Absolute paths of the output files written to disk (currently always 1). */
  outputPaths: string[]
  /** Path to the metadata sidecar (only present when metadata is written). */
  metadataPath?: string
  /** The image reference inside ComfyUI, so users can find it there themselves. */
  comfyImage: ComfyImageRef
  /** The prompt_id returned by ComfyUI. */
  promptId: string
  /** The ComfyUI address actually used. */
  comfyUrl: string
  /** Time from submission to fetching the image (milliseconds). */
  durationMs: number
  /** The actual parameters used for this generation (for metadata). */
  request: NormalizedRequest
}

/** Plugin configuration: everything optional; sources are described in config.ts. */
export interface PluginConfigInput {
  baseUrl?: string
  outputDir?: string
  checkpoint?: string
  negativePrompt?: string
  steps?: number
  cfgScale?: number
  samplerName?: string
  scheduler?: string
  width?: number
  height?: number
  strength?: number
  inpaintGrowMask?: number
  timeoutMs?: number
  pollIntervalMs?: number
  requestTimeoutMs?: number
  rembgNode?: string
  saveToComfyUI?: boolean
  writeMetadata?: boolean
}

/**
 * A fully resolved configuration that is safe to use.
 *
 * Every key is deliberately listed **explicitly** instead of using
 * `Required<Omit<PluginConfigInput, ...>>`: once the source interface has an index signature,
 * TypeScript collapses all named properties into that index signature, so `config.width`
 * becomes `unknown` (learned the hard way; the compiler reports it immediately).
 */
export interface ResolvedConfig {
  baseUrl: string
  outputDir?: string
  checkpoint?: string
  negativePrompt: string
  steps: number
  cfgScale: number
  samplerName: string
  scheduler: string
  width: number
  height: number
  strength: number
  inpaintGrowMask: number
  timeoutMs: number
  pollIntervalMs: number
  requestTimeoutMs: number
  rembgNode?: string
  saveToComfyUI: boolean
  writeMetadata: boolean
}
