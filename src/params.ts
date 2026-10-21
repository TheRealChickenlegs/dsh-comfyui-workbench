/**
 * The unified parameter layer.
 *
 * This does three things:
 *   1. **Infer the mode** — only predictable checks like "there is an input, so img2img";
 *      any ambiguity or conflict is a **clear error**, never a black-box guess.
 *   2. **Fill in defaults** — size, seed, steps, CFG, output path, checkpoint... all decided here,
 *      so the Agent can produce an image from a single prompt.
 *   3. **Produce a `NormalizedRequest`** — downstream modules (workflow building, execution,
 *      writing to disk) depend only on it.
 */
import type { GenerateImageArgs, GenerateMode, NormalizedRequest, ResolvedConfig } from './types.js'
import { isGenerateMode } from './types.js'
import { argConflict } from './errors.js'
import { suggestSizeForCheckpoint } from './config.js'
import { isFile, planOutputFile, randomSeed, resolveUserPath } from './files.js'

/** Modes that need a prompt. */
const NEEDS_PROMPT: readonly GenerateMode[] = ['text2img', 'img2img', 'inpaint']
/** Modes that need an input image. */
const NEEDS_INPUT: readonly GenerateMode[] = ['img2img', 'inpaint', 'remove_background']

export interface NormalizeOptions {
  /** Current working directory (project root). Default output lands here. */
  cwd: string
  config: ResolvedConfig
}

export interface NormalizeResult {
  request: NormalizedRequest
  /** Whether the mode was inferred, or explicitly supplied by the user. */
  modeInferred: boolean
}

/**
 * Mode inference — exactly three rules, hard-coded below and copied into the README.
 * Defaults to text2img when nothing can be inferred.
 */
export function inferMode(args: GenerateImageArgs): GenerateMode {
  const hasInput = typeof args.input_image === 'string' && args.input_image.trim() !== ''
  const hasMask = typeof args.mask_image === 'string' && args.mask_image.trim() !== ''
  if (hasInput && hasMask) return 'inpaint'
  if (hasInput) return 'img2img'
  return 'text2img'
}

function requirePositiveInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw argConflict(`${name} must be a number, received ${JSON.stringify(value)}.`)
  }
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) {
    throw argConflict(`${name} is outside the allowed range ${min}-${max}, received ${value}.`)
  }
  return rounded
}

function requireRangeNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw argConflict(`${name} must be a number, received ${JSON.stringify(value)}.`)
  }
  if (value < min || value > max) {
    throw argConflict(`${name} is outside the allowed range ${min}-${max}, received ${value}.`)
  }
  return value
}

/** Align a dimension to a multiple of 8 (a hard ComfyUI requirement), and say so when it changes. */
function alignTo8(value: number, notes: string[], label: string): number {
  const aligned = Math.max(64, Math.round(value / 8) * 8)
  if (aligned !== value) {
    notes.push(`${label} was aligned from ${value} to a multiple of 8: ${aligned} (ComfyUI requirement)`)
  }
  return aligned
}

/**
 * Main entry point: turn the loose arguments from the Agent into a strict, executable request
 * with defaults filled in.
 *
 * @throws ImagePluginError on argument conflicts, out-of-range values, or missing input files.
 */
export function normalizeRequest(args: GenerateImageArgs, options: NormalizeOptions): NormalizeResult {
  const { cwd, config } = options
  const notes: string[] = []

  // ── 1. Decide the mode ───────────────────────────────────────
  const explicit = args.mode
  if (explicit !== undefined && !isGenerateMode(explicit)) {
    throw argConflict(
      `Unknown mode: ${JSON.stringify(explicit)}`,
      'V1 supports text2img / img2img / inpaint / remove_background.'
    )
  }
  const modeInferred = explicit === undefined
  const mode: GenerateMode = explicit ?? inferMode(args)

  // ── 2. Input files: resolve first, then check existence (fail early, before running a workflow) ──
  const trimOrUndefined = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

  const rawInput = trimOrUndefined(args.input_image)
  const rawMask = trimOrUndefined(args.mask_image)
  const rawStyle = trimOrUndefined(args.style_reference)
  const rawCharacter = trimOrUndefined(args.character_reference)

  const inputImage = rawInput ? resolveUserPath(rawInput, cwd) : undefined
  const maskImage = rawMask ? resolveUserPath(rawMask, cwd) : undefined
  const styleReference = rawStyle ? resolveUserPath(rawStyle, cwd) : undefined
  const characterReference = rawCharacter ? resolveUserPath(rawCharacter, cwd) : undefined

  // ── 3. Conflict checks: an error beats a guess ───────────────
  if (maskImage !== undefined && inputImage === undefined) {
    throw argConflict(
      'mask_image was provided without input_image.',
      'Inpainting needs two images, the source and the mask: pass both input_image and mask_image.'
    )
  }
  if (mode === 'text2img' && inputImage !== undefined) {
    throw argConflict(
      `mode=text2img does not accept input_image (received ${inputImage}).`,
      'To edit that image, pass mode="img2img" explicitly (for a local edit, also pass mask_image and use mode="inpaint").'
    )
  }
  if (mode === 'text2img' && maskImage !== undefined) {
    throw argConflict('mode=text2img does not accept mask_image.', 'Pass mode="inpaint" explicitly.')
  }
  if (mode === 'img2img' && maskImage !== undefined) {
    throw argConflict(
      'mode=img2img does not accept mask_image (a mask means inpainting).',
      'Use mode="inpaint" instead; if you really want a full redraw, do not pass mask_image.'
    )
  }
  if (NEEDS_INPUT.includes(mode) && inputImage === undefined) {
    throw argConflict(
      `mode=${mode} requires input_image, but it was not provided.`,
      'Pass input_image="path/to/image" (absolute, or relative to the current working directory).'
    )
  }
  if (mode === 'inpaint' && maskImage === undefined) {
    throw argConflict(
      'mode=inpaint requires mask_image, but it was not provided.',
      'V1 requires an explicit mask: white/bright areas = the region to repaint, and its dimensions must match input_image.'
    )
  }

  if (inputImage !== undefined && !isFile(inputImage)) {
    throw argConflict(`input_image points to a file that does not exist: ${inputImage}`, 'Check that the path is correct.')
  }
  if (maskImage !== undefined && !isFile(maskImage)) {
    throw argConflict(`mask_image points to a file that does not exist: ${maskImage}`, 'Check that the path is correct.')
  }
  if (styleReference !== undefined && !isFile(styleReference)) {
    throw argConflict(`style_reference points to a file that does not exist: ${styleReference}`, 'Check that the path is correct.')
  }
  if (characterReference !== undefined && !isFile(characterReference)) {
    throw argConflict(
      `character_reference points to a file that does not exist: ${characterReference}`,
      'Check that the path is correct.'
    )
  }
  if (styleReference !== undefined || characterReference !== undefined) {
    notes.push(
      'style_reference / character_reference are only recorded in V1 (written to metadata); they do not affect generation yet.'
    )
  }

  // ── 4. Prompt ────────────────────────────────────────────────
  const promptRaw = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (NEEDS_PROMPT.includes(mode) && promptRaw === '') {
    throw argConflict(
      `mode=${mode} requires prompt, but it was not provided.`,
      mode === 'text2img'
        ? 'Describe the image you want, for example prompt="a corgi astronaut, digital art".'
        : 'Image-to-image / inpainting also need a prompt describing what it should become.'
    )
  }
  if (mode === 'remove_background' && promptRaw !== '') {
    notes.push('remove_background does not use prompt; it was ignored.')
  }
  const prompt = NEEDS_PROMPT.includes(mode) ? promptRaw : ''
  const negativePrompt =
    typeof args.negative_prompt === 'string' && args.negative_prompt.trim() !== ''
      ? args.negative_prompt.trim()
      : config.negativePrompt

  // ── 5. Checkpoint: if unspecified, the workflow module picks one; the choice also sets the default size ──
  const checkpoint =
    typeof args.model === 'string' && args.model.trim() !== ''
      ? args.model.trim()
      : (config.checkpoint ?? '')

  const sizeHint = suggestSizeForCheckpoint(checkpoint, config)
  // These two flags are for runner: the checkpoint may not be decided yet (when the user did not
  // pass model and the config has no checkpoint, chooseCheckpoint picks one later), so dimensions
  // that were "not explicitly given" must be adapted again once the checkpoint is known.
  const widthFromArgs = args.width !== undefined && args.width !== null
  const heightFromArgs = args.height !== undefined && args.height !== null
  let width = Math.round(requirePositiveInt(args.width, 'width', 64, 8192) ?? sizeHint.width)
  let height = Math.round(requirePositiveInt(args.height, 'height', 64, 8192) ?? sizeHint.height)

  // Only text2img controls its own size; the other three modes take their canvas from the input image.
  if (mode !== 'text2img' && (args.width !== undefined || args.height !== undefined)) {
    notes.push(
      `${mode} takes its output size from the input image; width/height were ignored` +
        ` (you passed ${args.width ?? '-'}x${args.height ?? '-'}).`
    )
  }

  const seed = requirePositiveInt(args.seed, 'seed', 0, 4_294_967_295) ?? randomSeed()
  const steps = requirePositiveInt(args.steps, 'steps', 1, 500) ?? config.steps
  const cfgScale = requireRangeNumber(args.cfg_scale, 'cfg_scale', 0, 100) ?? config.cfgScale

  const defaultStrength = mode === 'inpaint' ? 1.0 : config.strength
  const strength = requireRangeNumber(args.strength, 'strength', 0, 1) ?? defaultStrength
  if (mode === 'remove_background' && args.strength !== undefined) {
    notes.push('remove_background does not use strength; it was ignored.')
  }

  const samplerName =
    typeof args.sampler_name === 'string' && args.sampler_name.trim() !== ''
      ? args.sampler_name.trim()
      : config.samplerName
  const scheduler =
    typeof args.scheduler === 'string' && args.scheduler.trim() !== ''
      ? args.scheduler.trim()
      : config.scheduler

  // Size only matters for text2img; also align to a multiple of 8.
  if (mode === 'text2img') {
    width = alignTo8(width, notes, 'width')
    height = alignTo8(height, notes, 'height')
  }

  // ── 6. Output location ──────────────────────────────────────
  const outputHint =
    typeof args.output_path === 'string' && args.output_path.trim() !== ''
      ? args.output_path.trim()
      : config.outputDir
  const planned = planOutputFile(outputHint, cwd)

  const extra =
    args.extra_options && typeof args.extra_options === 'object' && !Array.isArray(args.extra_options)
      ? (args.extra_options as Record<string, unknown>)
      : {}

  const request: NormalizedRequest = {
    mode,
    prompt,
    negativePrompt,
    width,
    height,
    widthFromArgs,
    heightFromArgs,
    seed,
    strength,
    steps,
    cfgScale,
    checkpoint,
    samplerName,
    scheduler,
    outputPath: planned.filePath,
    notes,
    extra
  }
  if (inputImage !== undefined) request.inputImage = inputImage
  if (maskImage !== undefined) request.maskImage = maskImage
  if (styleReference !== undefined) request.styleReference = styleReference
  if (characterReference !== undefined) request.characterReference = characterReference

  return { request, modeInferred }
}

/**
 * Once the checkpoint is finally chosen, fill in the "adapt to the checkpoint" default size.
 *
 * Why not decide it once in the parameter layer: when resolving arguments the user may have
 * passed neither model nor a configured checkpoint, so the checkpoint has to be auto-picked by
 * `chooseCheckpoint` in runner (later); the parameter layer can only use the config default.
 * Without this step, "size follows the checkpoint (1024 for SDXL-family, 512 for SD1.5-family)"
 * from the tool description would be empty on the most common path — which is exactly what
 * happened on a real machine: with only an SD1.5 checkpoint it still produced 1024×1024.
 *
 * Only affects text2img: the other three modes take their canvas from the input image.
 */
export function applyModelAwareSize(
  request: NormalizedRequest,
  checkpoint: string,
  config: ResolvedConfig,
  notes: string[]
): void {
  if (request.mode !== 'text2img') return
  if (request.widthFromArgs && request.heightFromArgs) return
  const hint = suggestSizeForCheckpoint(checkpoint, config)
  const before = `${request.width}x${request.height}`
  if (!request.widthFromArgs) request.width = alignTo8(hint.width, notes, 'width')
  if (!request.heightFromArgs) request.height = alignTo8(hint.height, notes, 'height')
  const after = `${request.width}x${request.height}`
  if (before !== after) {
    notes.push(
      `No size specified: adapted to ${after} for checkpoint ${checkpoint} (was ${before} before adaptation; override with width/height).`
    )
  }
}
