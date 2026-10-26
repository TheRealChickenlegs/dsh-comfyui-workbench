/**
 * One-call sprite animation pipeline: base sprite -> W2 video(s) -> W3 frames -> card.
 *
 * This is the reusable form of the Draconid W2/W3 process:
 *   - a front sprite can turn left/right/up with a short W2 clip;
 *   - each turn's last frame is reused as the keyframe for that facing;
 *   - each animation is a W2 clip at 384x384 with the 4-step Wan 2.2 lightx2v graph;
 *   - W3/BiRefNet turns each clip into transparent RGBA frames;
 *   - eight frames per row are aligned by feet/centre, boxed to 64 px and packed into an 8xN card.
 *
 * The tool defaults to the full ten-row card. A single animation can be requested by name.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveConfig } from './config.js'
import { ImagePluginError, formatError } from './errors.js'
import { resolveCwd } from './tool.js'
import { ComfyUIClient } from './comfy/client.js'
import { historyIssues, waitForPrompt } from './comfy/workflow-runner.js'
import { ensureDir, readFileBytes, resolveUserPath } from './files.js'
import { decodePng, encodePng, alphaBox, downsampleBox, translateRgba } from './png.js'
import type { ResolvedConfig } from './types.js'

export const SPRITE_TOOL_NAME = 'generate_sprite_animation'

interface ToolExecLike {
  signal?: AbortSignal
  agent?: unknown
}

type AnimationName =
  | 'idle'
  | 'walk_down'
  | 'walk_left'
  | 'walk_right'
  | 'walk_up'
  | 'attack_down'
  | 'attack_left'
  | 'attack_right'
  | 'attack_up'
  | 'death'

interface AnimationDefinition {
  name: AnimationName
  key: 'front' | 'left' | 'right' | 'up'
  loop: boolean
  prompt: string
  negative: string
}

const ANIMATION_NAMES: AnimationName[] = [
  'idle',
  'walk_down',
  'walk_left',
  'walk_right',
  'walk_up',
  'attack_down',
  'attack_left',
  'attack_right',
  'attack_up',
  'death'
]

const FACE_NEGATIVE =
  'full side profile, face hidden, hood covering the face, faceless, blank face, no face, mask, ' +
  'staff replacing the head, staff head near the face, green head, featureless head, missing face'

const POSITIVE_BASE =
  'pixel art RPG character, full body, clean pixel-art edges, flat colours, pure white background, ' +
  'fixed camera, consistent lighting'

const NEGATIVE_BASE =
  'background, floor, horizon, ground shadow, drop shadow, cast shadow, extra limbs, extra arms, ' +
  'extra legs, warped anatomy, distorted, jitter, flicker, colour shift, text, watermark, blurry, ' +
  'different character, different clothes, camera movement, zoom, pan, changing size'

const ANIMATIONS: AnimationDefinition[] = [
  {
    name: 'idle', key: 'front', loop: true,
    prompt:
      'standing still facing the camera, breathing gently, chest rising and falling slowly, ' +
      'shoulders moving subtly, feet planted, arms relaxed at the sides, the same character in every frame',
    negative:
      'walking, stepping, turning, attacking, falling, bobbing, swaying, faceless, hood covering the face, blank face'
  },
  {
    name: 'walk_down', key: 'front', loop: true,
    prompt:
      'walking toward the viewer in a front view, walking cycle, legs stepping alternately, ' +
      'arms swinging naturally, body bobbing slightly, facing the camera, the same character in every frame',
    negative:
      'standing still, running, turning away, side view, faceless, hood covering the face, blank face'
  },
  {
    name: 'walk_left', key: 'left', loop: true,
    prompt:
      'walking to the left in a three-quarter view, the face remains visible in three-quarter profile, ' +
      'the hood stays behind the face, walking cycle, legs stepping one after the other, arms swinging naturally, ' +
      'tail swaying, the same character in every frame',
    negative: 'standing still, running, facing the camera, front view, turning, ' + FACE_NEGATIVE
  },
  {
    name: 'walk_right', key: 'right', loop: true,
    prompt:
      'walking to the right in a three-quarter view, the face remains visible in three-quarter profile, ' +
      'the hood stays behind the face, walking cycle, legs stepping one after the other, arms swinging naturally, ' +
      'tail swaying, the same character in every frame',
    negative: 'standing still, running, facing the camera, front view, turning, ' + FACE_NEGATIVE
  },
  {
    name: 'walk_up', key: 'up', loop: true,
    prompt:
      'walking away from the viewer in a back view, facing away, walking cycle, legs stepping alternately, ' +
      'tail swaying, back of the character visible, the same character in every frame',
    negative: 'standing still, running, facing the camera, front view, turning'
  },
  {
    name: 'attack_down', key: 'front', loop: false,
    prompt:
      'attacking toward the viewer, swinging a weapon forward in a strike, lunging forward, front view, ' +
      'the blow landing, the same character in every frame',
    negative:
      'standing still, walking, idle, side view, turning, faceless, hood covering the face, blank face'
  },
  {
    name: 'attack_left', key: 'left', loop: false,
    prompt:
      'attacking to the left, swinging a weapon to the left in a strike, lunging left, three-quarter view facing left, ' +
      'the face remains visible, the blow landing, the same character in every frame',
    negative: 'standing still, walking, idle, front view, turning, ' + FACE_NEGATIVE
  },
  {
    name: 'attack_right', key: 'right', loop: false,
    prompt:
      'attacking to the right, swinging a weapon to the right in a strike, lunging right, three-quarter view facing right, ' +
      'the face remains visible, the blow landing, the same character in every frame',
    negative: 'standing still, walking, idle, front view, turning, ' + FACE_NEGATIVE
  },
  {
    name: 'attack_up', key: 'up', loop: false,
    prompt:
      'attacking away from the viewer, striking backward and upward, back view, lunging away, ' +
      'the blow landing, the same character in every frame',
    negative: 'standing still, walking, idle, front view, turning'
  },
  {
    name: 'death', key: 'front', loop: false,
    prompt:
      'collapsing and falling to the ground, dying, sinking down, losing strength, the body dropping, ' +
      'front view, the same character in every frame',
    negative:
      'standing, walking, attacking, idle, side view, turning, faceless, hood covering the face, blank face'
  }
]

const TURNS: Record<'left' | 'right' | 'up', { prompt: string; negative: string }> = {
  left: {
    prompt:
      'turning only three-quarters to the left, the face remains visible in three-quarter profile, ' +
      'the hood stays behind the head rather than over the face, then standing still with the left side toward the viewer',
    negative: 'walking, stepping, ' + FACE_NEGATIVE
  },
  right: {
    prompt:
      'turning only three-quarters to the right, the face remains visible in three-quarter profile, ' +
      'the hood stays behind the head rather than over the face, then standing still with the right side toward the viewer',
    negative: 'walking, stepping, ' + FACE_NEGATIVE
  },
  up: {
    prompt:
      'turn around to face away from the camera, then stand still in a back view, ' +
      'the character turns its back to the viewer and settles',
    negative: 'walking, stepping'
  }
}

const ROW_FPS: Record<AnimationName, number> = {
  idle: 6,
  walk_down: 12,
  walk_left: 12,
  walk_right: 12,
  walk_up: 12,
  attack_down: 22,
  attack_left: 22,
  attack_right: 22,
  attack_up: 22,
  death: 8
}

const SHORT_ANIMATIONS = new Set<AnimationName>(['idle', 'walk_down', 'walk_left', 'walk_right', 'walk_up'])
const TURN_FRAMES = 13
const SHORT_FRAMES = 9
const LONG_FRAMES = 13
const W3_CELL = 128
const COLUMNS = 8
const SEED_BASE = 771000

export const SPRITE_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    sprite_path: { type: 'string', description: 'Local PNG of the base/front sprite (required).' },
    animation: {
      type: 'string',
      enum: ['all', ...ANIMATION_NAMES],
      description: 'Animation to generate. all produces the full 8x10 card (default all).'
    },
    character: { type: 'string', description: 'Name used in output paths and metadata (default: sprite filename).' },
    output_dir: { type: 'string', description: 'Output directory (default: <cwd>/sprite_animation/<character>).' },
    prompt: { type: 'string', description: 'Override the positive prompt for every selected animation.' },
    negative_prompt: { type: 'string', description: 'Override the negative prompt for every selected animation.' },
    seed: { type: 'integer', description: 'Seed for all W2 clips; omit for the deterministic per-character/per-animation seed.' },
    frames: { type: 'integer', description: 'Frame count override (must satisfy 4n+1); default 9 for idle/walks, 13 for attacks/death and turns.' },
    cell_size: { type: 'integer', enum: [32, 64, 128], description: 'Final card cell size (default 64).' },
    width: { type: 'integer', description: 'W2 width (default 384).' },
    height: { type: 'integer', description: 'W2 height (default 384).' },
    fps: { type: 'number', description: 'W2 video fps (default 16).' },
    steps: { type: 'integer', description: 'W2 sampling steps (default 4).' },
    high_noise_model: { type: 'string', description: 'WAN 2.2 high-noise GGUF (default Q4_K_M).' },
    low_noise_model: { type: 'string', description: 'WAN 2.2 low-noise GGUF (default Q4_K_M).' },
    clip_model: { type: 'string', description: 'UMT5 GGUF encoder (default Q5_K_M).' },
    vae_model: { type: 'string', description: 'WAN 2.1 VAE (default wan_2.1_vae.safetensors).' },
    rmbg_model: { type: 'string', description: 'BiRefNet model for W3 (default BiRefNet_lite).' },
    job_timeout_ms: { type: 'integer', description: 'Per-ComfyUI-job timeout, 60000-3600000 (default 600000).' }
  },
  required: ['sprite_path'],
  additionalProperties: false
} as const

export const SPRITE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Readable summary' },
    success: { type: 'boolean', description: 'Whether the pipeline completed' },
    action: { type: 'string', description: 'Action name' },
    character: { type: 'string', description: 'Character name' },
    animations: { type: 'array', items: { type: 'string' }, description: 'Generated animation names' },
    videos: { type: 'array', items: { type: 'string' }, description: 'Generated video paths' },
    spritesheet: { type: 'string', description: 'Final sprite card path' },
    manifest: { type: 'string', description: 'Manifest path' },
    report: { type: 'string', description: 'Timing report path' },
    columns: { type: 'integer', description: 'Card columns' },
    rows: { type: 'integer', description: 'Card rows' },
    cell_size: { type: 'integer', description: 'Cell size' },
    sheet_width: { type: 'integer', description: 'Card width' },
    sheet_height: { type: 'integer', description: 'Card height' },
    seconds: { type: 'number', description: 'Total wall time' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal warnings' }
  },
  required: ['text', 'success', 'action'],
  additionalProperties: false
} as const

/* ─────────────────────────────── helpers ─────────────────────────────── */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, asInt(value, fallback)))
}

function slug(value: string, fallback = 'sprite'): string {
  const cleaned = value.trim().replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || fallback
}

function frameCountFor(definition: AnimationDefinition, override: unknown): number {
  const requested = typeof override === 'number' && Number.isFinite(override) ? Math.round(override) : undefined
  if (requested !== undefined) {
    if (requested < 5 || requested > 81 || (requested - 1) % 4 !== 0) {
      throw new ImagePluginError(
        `Invalid frame count ${requested}: Wan Image-to-Video requires 4n+1 frames (9, 13, 17, 21, 25, 33, 49, 81).`
      )
    }
    return requested
  }
  return SHORT_ANIMATIONS.has(definition.name) ? SHORT_FRAMES : LONG_FRAMES
}

function flattenWhite(decoded: { width: number; height: number; rgba: Buffer }): Buffer {
  const out = Buffer.alloc(decoded.width * decoded.height * 4)
  for (let i = 0; i < decoded.width * decoded.height; i += 1) {
    const a = decoded.rgba[i * 4 + 3]
    const d = i * 4
    out[d] = Math.round((decoded.rgba[d] * a + 255 * (255 - a)) / 255)
    out[d + 1] = Math.round((decoded.rgba[d + 1] * a + 255 * (255 - a)) / 255)
    out[d + 2] = Math.round((decoded.rgba[d + 2] * a + 255 * (255 - a)) / 255)
    out[d + 3] = 255
  }
  return out
}

function writePng(filePath: string, width: number, height: number, rgba: Buffer): void {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, encodePng(width, height, rgba))
}

function imageSpecs(entry: { outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> }): Array<{ filename: string; subfolder?: string; type?: string }> {
  const specs: Array<{ filename: string; subfolder?: string; type?: string }> = []
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const spec of node.images ?? []) {
      if (spec && typeof spec.filename === 'string') specs.push(spec)
    }
  }
  return specs
}

function uniqueIds(workflow: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const mapping = new Map<string, string>()
  for (const id of Object.keys(workflow)) mapping.set(id, `${prefix}${id}`)
  const relink = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
        return [mapping.get(value[0]) ?? value[0], value[1]]
      }
      return value.map(relink)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relink(item)]))
    }
    return value
  }
  const result: Record<string, unknown> = {}
  for (const [id, node] of Object.entries(workflow)) {
    const copy = node && typeof node === 'object' ? { ...(node as Record<string, unknown>) } : {}
    copy.inputs = relink(copy.inputs ?? {})
    result[mapping.get(id) ?? id] = copy
  }
  return result
}

function w2Workflow(options: {
  keyframe: string
  positive: string
  negative: string
  seed: number
  frames: number
  prefix: string
  width: number
  height: number
  fps: number
  steps: number
  highNoiseModel: string
  lowNoiseModel: string
  clipModel: string
  vaeModel: string
}): Record<string, unknown> {
  return {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: options.highNoiseModel } },
    '3': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
    '4': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: options.lowNoiseModel } },
    '6': { class_type: 'ModelSamplingSD3', inputs: { model: ['4', 0], shift: 8 } },
    '7': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: options.clipModel, type: 'wan' } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: options.vaeModel } },
    '9': { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: options.positive } },
    '10': { class_type: 'CLIPTextEncode', inputs: { clip: ['7', 0], text: options.negative } },
    '11': { class_type: 'LoadImage', inputs: { image: options.keyframe } },
    '13': {
      class_type: 'WanImageToVideo',
      inputs: {
        positive: ['9', 0], negative: ['10', 0], vae: ['8', 0],
        width: options.width, height: options.height, length: options.frames,
        batch_size: 1, start_image: ['11', 0]
      }
    },
    '14': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['3', 0], add_noise: 'enable', noise_seed: options.seed,
        steps: options.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['13', 0], negative: ['13', 1], latent_image: ['13', 2],
        start_at_step: 0, end_at_step: 2, return_with_leftover_noise: 'enable'
      }
    },
    '19': { class_type: 'VRAMUnloadModel', inputs: { latent: ['14', 0], model: ['3', 0] } },
    '15': {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['6', 0], add_noise: 'disable', noise_seed: options.seed,
        steps: options.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['13', 0], negative: ['13', 1], latent_image: ['19', 0],
        start_at_step: 2, end_at_step: 10000, return_with_leftover_noise: 'disable'
      }
    },
    '20': { class_type: 'VRAMUnloadModel', inputs: { latent: ['15', 0], model: ['6', 0] } },
    '16': { class_type: 'VAEDecode', inputs: { samples: ['20', 0], vae: ['8', 0] } },
    '17': { class_type: 'CreateVideo', inputs: { images: ['16', 0], fps: options.fps } },
    '18': {
      class_type: 'SaveVideo',
      inputs: { video: ['17', 0], filename_prefix: options.prefix, format: 'auto', codec: 'auto' }
    }
  }
}

function w3Workflow(options: {
  video: string
  frames: number
  prefix: string
  rmbgModel: string
}): Record<string, unknown> {
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: options.video } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'ImageFromBatch', inputs: { image: ['2', 0], batch_index: 0, length: options.frames } },
    '10': {
      class_type: 'BiRefNetRMBG',
      inputs: {
        image: ['3', 0], model: options.rmbgModel, sensitivity: 1, mask_blur: 0, mask_offset: 0,
        invert_output: false, refine_foreground: true, unload_model: false,
        background: 'Alpha', background_color: '#222222'
      }
    },
    '20': { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: W3_CELL, height: W3_CELL, crop: 'disabled' } },
    '21': { class_type: 'MaskToImage', inputs: { mask: ['10', 1] } },
    '22': { class_type: 'ImageScale', inputs: { image: ['21', 0], upscale_method: 'lanczos', width: W3_CELL, height: W3_CELL, crop: 'disabled' } },
    '23': { class_type: 'ImageToMask', inputs: { image: ['22', 0], channel: 'red' } },
    '24': { class_type: 'InvertMask', inputs: { mask: ['23', 0] } },
    '25': { class_type: 'JoinImageWithAlpha', inputs: { image: ['20', 0], alpha: ['24', 0] } },
    '26': { class_type: 'SaveImage', inputs: { images: ['25', 0], filename_prefix: options.prefix } }
  }
}

function lastFrameWorkflow(options: { video: string; frames: number; prefix: string }): Record<string, unknown> {
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: options.video } },
    '2': { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    '3': { class_type: 'ImageFromBatch', inputs: { image: ['2', 0], batch_index: Math.max(0, options.frames - 1), length: 1 } },
    '4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: options.prefix } }
  }
}

/* ─────────────────────────────── runner ─────────────────────────────── */

interface SpriteRunOptions {
  character: string
  outputDir: string
  client: ComfyUIClient
  config: ResolvedConfig
  signal?: AbortSignal
  jobTimeoutMs: number
  pollIntervalMs: number
  width: number
  height: number
  fps: number
  steps: number
  highNoiseModel: string
  lowNoiseModel: string
  clipModel: string
  vaeModel: string
  rmbgModel: string
  explicitPrompt?: string
  explicitNegative?: string
  explicitSeed?: number
  frameOverride?: number
}

interface ComfyHistoryLike {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] }
}

async function upload(client: ComfyUIClient, bytes: Buffer, filename: string, mime: string, subfolder: string, signal?: AbortSignal): Promise<string> {
  const uploaded = await client.uploadFile({ filename, bytes, mime, subfolder, overwrite: true }, signal)
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
}

async function runComfy(
  client: ComfyUIClient,
  workflow: Record<string, unknown>,
  label: string,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal
): Promise<ComfyHistoryLike> {
  const { promptId } = await client.queuePrompt(workflow as never, `sprite-animation-${Date.now().toString(36)}`, signal)
  const entry = (await waitForPrompt(client, promptId, {
    timeoutMs, pollIntervalMs, ...(signal ? { signal } : {})
  })) as unknown as ComfyHistoryLike
  const issues = historyIssues(entry as never)
  if (issues.length > 0) {
    throw new ImagePluginError(
      `${label} failed in ComfyUI: ${issues.map((issue) => issue.message).join('; ')}`,
      'Check the ComfyUI console for the failing node. Verify the W2/W3 models and custom nodes are installed.'
    )
  }
  return entry
}

async function downloadSpec(client: ComfyUIClient, spec: { filename: string; subfolder?: string; type?: string }, destination: string, signal?: AbortSignal): Promise<string> {
  const bytes = await client.fetchFile({ filename: spec.filename, subfolder: spec.subfolder ?? '', type: spec.type ?? 'output' }, signal)
  ensureDir(path.dirname(destination))
  writeFileSync(destination, bytes)
  return destination
}

function firstPng(entry: ComfyHistoryLike): { filename: string; subfolder?: string; type?: string } | undefined {
  return imageSpecs(entry).find((spec) => spec.filename.toLowerCase().endsWith('.png'))
}

function firstVideo(entry: ComfyHistoryLike): { filename: string; subfolder?: string; type?: string } | undefined {
  return imageSpecs(entry).find((spec) => spec.filename.toLowerCase().endsWith('.mp4'))
}

async function runW2(
  options: SpriteRunOptions,
  keyframePath: string,
  positive: string,
  negative: string,
  frames: number,
  name: string
): Promise<{ videoPath: string; seed: number }> {
  const decoded = decodePng(readFileBytes(keyframePath, 'keyframe'))
  const flattened = encodePng(decoded.width, decoded.height, flattenWhite(decoded))
  const remote = await upload(options.client, flattened, `${name}.png`, 'image/png', `sprite_animation/${slug(options.character)}`, options.signal)
  const seed = options.explicitSeed ?? SEED_BASE + (parseInt(createHash('sha1').update(`${options.character}|${name}`).digest('hex').slice(0, 8), 16) % 100000)
  const workflow = w2Workflow({
    keyframe: remote,
    positive,
    negative,
    seed,
    frames,
    prefix: `sprite_animation/${slug(options.character)}/${name}`,
    width: options.width,
    height: options.height,
    fps: options.fps,
    steps: options.steps,
    highNoiseModel: options.highNoiseModel,
    lowNoiseModel: options.lowNoiseModel,
    clipModel: options.clipModel,
    vaeModel: options.vaeModel
  })
  const entry = await runComfy(options.client, workflow, `W2 ${name}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal)
  const video = firstVideo(entry)
  if (!video) throw new ImagePluginError(`W2 ${name} produced no mp4 output.`)
  const videoPath = path.join(options.outputDir, 'videos', `${name}.mp4`)
  await downloadSpec(options.client, video, videoPath, options.signal)
  return { videoPath, seed }
}

async function runW3(
  options: SpriteRunOptions,
  videoPath: string,
  frames: number,
  name: string
): Promise<string[]> {
  const bytes = readFileBytes(videoPath, 'video')
  const remote = await upload(options.client, bytes, `${name}.mp4`, 'video/mp4', `sprite_animation/${slug(options.character)}`, options.signal)
  const prefix = `sprite_animation/${slug(options.character)}/${name}_frames`
  const workflow = uniqueIds(
    w3Workflow({ video: remote, frames, prefix, rmbgModel: options.rmbgModel }),
    `w3_${Date.now().toString(36)}_`
  )
  const entry = await runComfy(options.client, workflow, `W3 ${name}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal)
  const specs = imageSpecs(entry).filter((spec) => spec.filename.toLowerCase().endsWith('.png'))
  if (specs.length < frames) {
    throw new ImagePluginError(`W3 ${name} returned ${specs.length} frames, expected ${frames}.`)
  }
  const directory = path.join(options.outputDir, 'frames', name)
  const paths: string[] = []
  for (let index = 0; index < frames; index += 1) {
    paths.push(await downloadSpec(options.client, specs[index], path.join(directory, `${String(index + 1).padStart(3, '0')}.png`), options.signal))
  }
  return paths
}

async function extractLastFrame(options: SpriteRunOptions, videoPath: string, frames: number, name: string): Promise<string> {
  const bytes = readFileBytes(videoPath, 'video')
  const remote = await upload(options.client, bytes, `${name}.mp4`, 'video/mp4', `sprite_animation/${slug(options.character)}`, options.signal)
  const workflow = uniqueIds(
    lastFrameWorkflow({ video: remote, frames, prefix: `sprite_animation/${slug(options.character)}/${name}_keyframe` }),
    `w2_last_${Date.now().toString(36)}_`
  )
  const entry = await runComfy(options.client, workflow, `last frame ${name}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal)
  const spec = firstPng(entry)
  if (!spec) throw new ImagePluginError(`Last-frame extraction for ${name} produced no PNG.`)
  const destination = path.join(options.outputDir, 'keyframes', `${name}.png`)
  await downloadSpec(options.client, spec, destination, options.signal)
  return destination
}

function pickFrames(paths: string[], count: number): string[] {
  if (paths.length === 0) return []
  if (paths.length <= count) return [...paths, ...Array(count - paths.length).fill(paths[paths.length - 1])]
  if (count === 1) return [paths[0]]
  const selected: string[] = []
  for (let index = 0; index < count; index += 1) {
    selected.push(paths[Math.round((index * (paths.length - 1)) / (count - 1))])
  }
  return selected
}

function prepareCell(pathName: string, cellSize: number, fixed: { dx: number; dy: number } | undefined): { rgba: Buffer; offset: { dx: number; dy: number } } {
  const decoded = decodePng(readFileSync(pathName))
  if (decoded.width !== W3_CELL || decoded.height !== W3_CELL) {
    throw new ImagePluginError(`W3 frame ${pathName} is ${decoded.width}x${decoded.height}; expected ${W3_CELL}x${W3_CELL}.`)
  }
  const box = alphaBox(decoded.rgba, W3_CELL, W3_CELL)
  let dx = 0
  let dy = 0
  if (box) {
    dx = Math.floor(W3_CELL / 2) - Math.floor((box.left + box.right) / 2)
    dy = 120 - box.bottom
    if (box.top + dy < 2) dy = 2 - box.top
  }
  if (fixed) {
    dx = fixed.dx
    dy = fixed.dy
  }
  let rgba = translateRgba(decoded.rgba, W3_CELL, W3_CELL, dx, dy)
  if (cellSize !== W3_CELL) {
    rgba = downsampleBox(rgba, W3_CELL, W3_CELL, W3_CELL / cellSize).rgba
  }
  return { rgba, offset: { dx, dy } }
}

function packSheet(
  options: SpriteRunOptions,
  selected: AnimationDefinition[],
  cellSize: number
): {
  sheetPath: string
  manifestPath: string
  width: number
  height: number
  rowInfo: Array<{ name: string; row: number; fps: number; loop: boolean; frames: number; video: string }>
} {
  const width = COLUMNS * cellSize
  const height = selected.length * cellSize
  const sheet = Buffer.alloc(width * height * 4)
  const rowInfo: Array<{ name: string; row: number; fps: number; loop: boolean; frames: number; video: string }> = []
  selected.forEach((definition, row) => {
    const directory = path.join(options.outputDir, 'frames', definition.name)
    const files = existsSync(directory)
      ? readdirNames(directory).filter((name) => name.endsWith('.png')).sort().map((name) => path.join(directory, name))
      : []
    if (files.length === 0) throw new ImagePluginError(`No W3 frames found for ${definition.name}.`)
    const cells = definition.name.startsWith('attack') && files.length < 16
      ? [...pickFrames(files, COLUMNS - 1), files[0]]
      : pickFrames(files, COLUMNS)
    let fixedOffset: { dx: number; dy: number } | undefined
    cells.forEach((file, column) => {
      const first = prepareCell(file, cellSize, definition.name === 'death' ? fixedOffset : undefined)
      if (definition.name === 'death' && !fixedOffset) fixedOffset = first.offset
      const source = first.rgba
      for (let y = 0; y < cellSize; y += 1) {
        const sourceStart = y * cellSize * 4
        const destinationStart = ((row * cellSize + y) * width + column * cellSize) * 4
        source.copy(sheet, destinationStart, sourceStart, sourceStart + cellSize * 4)
      }
    })
    rowInfo.push({
      name: definition.name,
      row,
      fps: ROW_FPS[definition.name],
      loop: definition.loop,
      frames: COLUMNS,
      video: path.join(options.outputDir, 'videos', `${definition.name}.mp4`)
    })
  })
  ensureDir(options.outputDir)
  const sheetPath = path.join(options.outputDir, 'sprite_sheet.png')
  writeFileSync(sheetPath, encodePng(width, height, sheet))
  const manifestPath = path.join(options.outputDir, 'sprite_sheet.json')
  writeFileSync(manifestPath, `${JSON.stringify({
    character: options.character,
    sheet: path.basename(sheetPath),
    cell: cellSize,
    columns: COLUMNS,
    rows: selected.length,
    animations: rowInfo
  }, null, 1)}\n`)
  return { sheetPath, manifestPath, width, height, rowInfo }
}

function readdirNames(directory: string): string[] {
  return readdirSync(directory)
}

/** Build the one-call sprite animation tool. */
export function createSpriteAnimationTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: SPRITE_TOOL_NAME,
    description: [
      'Generate a complete animated sprite card from one base PNG.',
      '',
      'This is the reusable W2/W3 pipeline: it generates turn clips for left/right/back, reuses each',
      "turn's last frame as the keyframe for that facing, runs Wan 2.2 image-to-video for the selected",
      'animations, removes the background with W3/BiRefNet, aligns and downsamples each cell, and packs',
      'an 8-column sprite card.',
      '',
      'Default is the full ten-row card: idle, four walks, four attacks, death. It is slow (typically',
      '5-12 minutes per character on an RTX 5060 Ti) and needs the W2 GGUF models, the',
      'comfyui_vram_helpers custom node and ComfyUI-RMBG. Pass animation=idle (or any single row) for',
      'a faster test.',
      '',
      'The base sprite is flattened onto white before W2 sees it. W2 output is aligned by feet and',
      'centre, then box-downsampled to 64 px cells. The tool returns the card, manifest and videos.'
    ].join('\n'),
    parameters: SPRITE_PARAMETERS_SCHEMA,
    output: {
      schema: SPRITE_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as { text?: unknown } | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as { character?: unknown; spritesheet?: unknown } | undefined
        return { kind: 'sprite-animation', character: result?.character ?? '', spritesheet: result?.spritesheet ?? '' }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<Record<string, unknown>> {
      const started = Date.now()
      const input = (args ?? {}) as Record<string, unknown>
      const animationArg = asString(input.animation) ?? 'all'
      const warnings: string[] = []
      try {
        const spritePath = asString(input.sprite_path)
        if (!spritePath) throw new ImagePluginError('sprite_path is required.', 'Pass a local PNG of the base/front sprite.')
        const sourcePath = resolveUserPath(spritePath, resolveCwd(exec))
        const sourceBytes = readFileBytes(sourcePath, 'sprite_path')
        const source = decodePng(sourceBytes)
        const rawCharacter = asString(input.character) ?? path.basename(sourcePath, path.extname(sourcePath))
        const character = slug(rawCharacter.replace(/^player_draconid_/, ''))
        const outputDir = resolveUserPath(
          asString(input.output_dir) ?? path.join('sprite_animation', character),
          resolveCwd(exec)
        )
        ensureDir(outputDir)

        let selected: AnimationDefinition[]
        if (animationArg === 'all') {
          selected = [...ANIMATIONS]
        } else {
          const found = ANIMATIONS.find((definition) => definition.name === animationArg)
          if (!found) {
            throw new ImagePluginError(
              `Unknown animation ${JSON.stringify(animationArg)}.`,
              `Use all or one of: ${ANIMATION_NAMES.join(', ')}.`
            )
          }
          selected = [found]
        }

        const config = resolveConfig(pluginConfig)
        const client = new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })
        const cellSize = clampInt(input.cell_size, 32, 128, 64)
        if (![32, 64, 128].includes(cellSize)) throw new ImagePluginError('cell_size must be 32, 64 or 128.')
        const options: SpriteRunOptions = {
          character,
          outputDir,
          client,
          config,
          ...(exec?.signal ? { signal: exec.signal } : {}),
          jobTimeoutMs: clampInt(input.job_timeout_ms, 60_000, 3_600_000, Math.max(config.timeoutMs, 600_000)),
          pollIntervalMs: config.pollIntervalMs,
          width: clampInt(input.width, 128, 2048, 384),
          height: clampInt(input.height, 128, 2048, 384),
          fps: typeof input.fps === 'number' && Number.isFinite(input.fps) ? Math.min(60, Math.max(1, Math.round(input.fps))) : 16,
          steps: clampInt(input.steps, 1, 50, 4),
          highNoiseModel: asString(input.high_noise_model) ?? 'wan2.2_i2v_high_noise_lightx2v_Q4_K_M.gguf',
          lowNoiseModel: asString(input.low_noise_model) ?? 'wan2.2_i2v_low_noise_lightx2v_Q4_K_M.gguf',
          clipModel: asString(input.clip_model) ?? 'umt5-xxl-encoder-Q5_K_M.gguf',
          vaeModel: asString(input.vae_model) ?? 'wan_2.1_vae.safetensors',
          rmbgModel: asString(input.rmbg_model) ?? 'BiRefNet_lite',
          ...(asString(input.prompt) ? { explicitPrompt: asString(input.prompt) } : {}),
          ...(asString(input.negative_prompt) ? { explicitNegative: asString(input.negative_prompt) } : {}),
          ...(typeof input.seed === 'number' && Number.isFinite(input.seed) ? { explicitSeed: Math.round(input.seed) } : {}),
          ...(typeof input.frames === 'number' && Number.isFinite(input.frames) ? { frameOverride: Math.round(input.frames) } : {})
        }

        const keyframes: Record<string, string> = {}
        const keyframePath = path.join(outputDir, 'keyframes', 'front.png')
        // The reference pipeline normalises a 1024 master to 512 before W2. The smaller start image
        // gives the turn prompt room to move the body; feeding the 1024 master directly makes W2
        // much more likely to keep the character facing the camera.
        let baseWidth = source.width
        let baseHeight = source.height
        let baseRgba = flattenWhite(source)
        while (baseWidth > 512 && baseHeight > 512 && baseWidth % 2 === 0 && baseHeight % 2 === 0) {
          const smaller = downsampleBox(baseRgba, baseWidth, baseHeight, 2)
          baseWidth = smaller.width
          baseHeight = smaller.height
          baseRgba = smaller.rgba
        }
        writePng(keyframePath, baseWidth, baseHeight, baseRgba)
        keyframes.front = keyframePath

        const videos: string[] = []
        const timings: Array<{ stage: string; seconds: number; promptId?: string }> = []
        const neededFacings = [...new Set(selected.map((definition) => definition.key))]
        for (const facing of ['left', 'right', 'up'] as const) {
          if (!neededFacings.includes(facing)) continue
          const turn = TURNS[facing]
          const begin = Date.now()
          const { videoPath } = await runW2(
            options,
            keyframes.front,
            `${POSITIVE_BASE}, ${turn.prompt}`,
            `${NEGATIVE_BASE}, ${turn.negative}`,
            TURN_FRAMES,
            `turn_${facing}`
          )
          videos.push(videoPath)
          keyframes[facing] = await extractLastFrame(options, videoPath, TURN_FRAMES, `turn_${facing}`)
          timings.push({ stage: `turn_${facing}`, seconds: (Date.now() - begin) / 1000 })
        }

        const generated: AnimationDefinition[] = []
        for (const definition of selected) {
          const frames = frameCountFor(definition, options.frameOverride)
          const begin = Date.now()
          const positive = options.explicitPrompt ?? `${POSITIVE_BASE}, ${definition.prompt}`
          const negative = options.explicitNegative ?? `${NEGATIVE_BASE}, ${definition.negative}`
          const { videoPath } = await runW2(options, keyframes[definition.key], positive, negative, frames, definition.name)
          videos.push(videoPath)
          const framePaths = await runW3(options, videoPath, frames, definition.name)
          if (framePaths.length !== frames) warnings.push(`${definition.name}: received ${framePaths.length}/${frames} W3 frames`)
          generated.push(definition)
          timings.push({ stage: definition.name, seconds: (Date.now() - begin) / 1000 })
        }

        const packed = packSheet(options, generated, cellSize)
        const reportPath = path.join(outputDir, 'report.json')
        writeFileSync(reportPath, `${JSON.stringify({
          character,
          source: sourcePath,
          sheet: packed.sheetPath,
          manifest: packed.manifestPath,
          cell: cellSize,
          columns: COLUMNS,
          rows: generated.length,
          seed: options.explicitSeed ?? 'derived per animation',
          models: {
            high_noise: options.highNoiseModel,
            low_noise: options.lowNoiseModel,
            clip: options.clipModel,
            vae: options.vaeModel,
            rmbg: options.rmbgModel
          },
          timings,
          videos,
          warnings,
          seconds: Math.round((Date.now() - started) / 10) / 100
        }, null, 1)}\n`)

        const seconds = Math.round((Date.now() - started) / 10) / 100
        const text = [
          `✅ Sprite animation card for ${character}`,
          '',
          `Sheet: ${packed.sheetPath}`,
          `Manifest: ${packed.manifestPath}`,
          `Report: ${reportPath}`,
          `Rows: ${generated.length} · cell: ${cellSize}px · sheet: ${packed.width}×${packed.height}`,
          `Animations: ${generated.map((definition) => definition.name).join(', ')}`,
          `Videos: ${videos.length}`,
          `Time: ${seconds.toFixed(1)}s`,
          ...(warnings.length ? ['', ...warnings.map((warning) => `⚠️ ${warning}`)] : [])
        ].join('\n')
        return {
          text,
          success: true,
          action: 'sprite_animation',
          character,
          animations: generated.map((definition) => definition.name),
          videos,
          spritesheet: packed.sheetPath,
          manifest: packed.manifestPath,
          report: reportPath,
          columns: COLUMNS,
          rows: generated.length,
          cell_size: cellSize,
          sheet_width: packed.width,
          sheet_height: packed.height,
          seconds,
          warnings
        }
      } catch (error) {
        const message = formatError(error)
        return {
          text: `❌ Sprite animation failed\n\n${message}`,
          success: false,
          action: 'sprite_animation',
          ...(warnings.length ? { warnings } : {})
        }
      }
    }
  }
}

export const SPRITE_DESCRIPTION = 'Generate a W2/W3 animated sprite card from one base PNG.'
