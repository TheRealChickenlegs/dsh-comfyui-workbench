/**
 * High-level audio and video tools.
 *
 * generate_image stays the curated image path. These tools add the same convenience layer for
 * ACE-Step audio and Wan video, but only when the local ComfyUI has the required models and nodes.
 * When it does not, the tool explains exactly what was detected and what is missing.
 */
import { resolveConfig } from './config.js'
import { ImagePluginError, formatError } from './errors.js'
import { resolveCwd } from './tool.js'
import { ComfyUIClient } from './comfy/client.js'
import { randomSeed } from './files.js'
import type { ResolvedConfig } from './types.js'
import {
  detectAudioSupport,
  detectVideoSupport,
  formatAudioCapabilityError,
  formatVideoCapabilityError,
  type AudioSupport,
  type VideoSupport
} from './media/capabilities.js'
import { buildAudioWorkflow, buildVideoWorkflow } from './media/workflows.js'
import { runMediaWorkflow, type MediaRunResult } from './media/runner.js'

export const AUDIO_TOOL_NAME = 'generate_audio'
export const VIDEO_TOOL_NAME = 'generate_video'

interface ToolExecLike {
  signal?: AbortSignal
  agent?: unknown
}

function context(pluginConfig: unknown, exec: ToolExecLike): { config: ResolvedConfig; cwd: string } {
  return { config: resolveConfig(pluginConfig), cwd: resolveCwd(exec) }
}

function clientFor(config: ResolvedConfig): ComfyUIClient {
  return new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function align(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step)
}

function alignFrameLength(value: number): number {
  // Wan lengths are 1 + 4k; 33 is the standard 2-second clip at 16 fps.
  return Math.max(1, 1 + Math.round((value - 1) / 4) * 4)
}

export interface MediaToolResult {
  text: string
  path: string
  files: string[]
  mode: 'audio' | 'video'
  seed: number
  model: string
  duration_ms: number
  prompt_id: string
  comfy_url: string
  notes: string[]
  success: boolean
  metadata_path?: string
  width?: number
  height?: number
  duration_seconds?: number
  fps?: number
  family?: string
}

/* ────────────────────────────── schemas ────────────────────────────── */

export const AUDIO_DESCRIPTION = [
  'Generate music or audio from a text prompt using a local ComfyUI ACE-Step 1.5 setup.',
  '',
  'The tool detects whether a supported ACE-Step 1.5 model set is installed before submitting. It supports:',
  '  - the AIO checkpoint ace_step_1.5_turbo_aio.safetensors in models/checkpoints (simplest), or',
  '  - the split ACE-Step 1.5 diffusion model + qwen text encoders + ace VAE.',
  '',
  'If the required models or nodes are missing, the error lists what was detected and what to install.',
  'Use lyrics for vocal music; omit it for instrumental output. duration_seconds controls clip length.',
  'For other audio model families, use comfyui_workflow with a matching custom workflow.'
].join('\n')

export const AUDIO_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Style/tags prompt describing the music or audio (required).'
    },
    lyrics: {
      type: 'string',
      description: 'Optional lyrics with section tags such as [Verse] / [Chorus]. Omit for instrumental music.'
    },
    duration_seconds: {
      type: 'number',
      description: 'Clip length in seconds (1-600, default 30). Both the text encoder and latent node use it.'
    },
    bpm: {
      type: 'integer',
      description: 'Tempo in BPM (10-300, default 120).'
    },
    timesignature: {
      type: 'string',
      enum: ['2', '3', '4', '6'],
      description: 'Time signature (default 4).'
    },
    language: {
      type: 'string',
      description: 'Lyrics language code (default en; ACE-Step supports many language codes).'
    },
    keyscale: {
      type: 'string',
      description: 'Musical key, for example "C major" or "E minor" (default C major).'
    },
    seed: {
      type: 'integer',
      description: 'Random seed. Omit for a random seed; reuse it to reproduce the track.'
    },
    steps: {
      type: 'integer',
      description: 'Sampling steps. Defaults to 8 for the AIO turbo model and 50 for the split base model.'
    },
    cfg_scale: {
      type: 'number',
      description: 'KSampler CFG. Defaults to 1 for AIO turbo and 6 for the split base model.'
    },
    sampler_name: {
      type: 'string',
      description: 'Sampler name (default euler).'
    },
    scheduler: {
      type: 'string',
      description: 'Scheduler name (default simple).'
    },
    model: {
      type: 'string',
      description: 'Optional specific ACE-Step model file name. Detected automatically when omitted.'
    },
    output_path: {
      type: 'string',
      description: 'Directory or exact file path for the generated audio. Defaults to the current project root.'
    },
    timeout_ms: {
      type: 'integer',
      description: 'Total wait timeout in milliseconds (default: timeoutMs from config; max 3600000).'
    },
    write_metadata: {
      type: 'boolean',
      description: 'Write a .json metadata sidecar next to the audio (default true).'
    }
  },
  required: ['prompt'],
  additionalProperties: false
} as const

export const AUDIO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Readable result' },
    path: { type: 'string', description: 'Absolute path of the generated audio' },
    files: { type: 'array', items: { type: 'string' }, description: 'All files produced' },
    mode: { type: 'string', description: 'Media mode (audio)' },
    seed: { type: 'integer', description: 'Seed used' },
    model: { type: 'string', description: 'Model / family used' },
    duration_ms: { type: 'integer', description: 'Elapsed time' },
    prompt_id: { type: 'string', description: 'ComfyUI prompt id' },
    comfy_url: { type: 'string', description: 'ComfyUI address' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Notes' },
    success: { type: 'boolean', description: 'Whether generation succeeded' },
    metadata_path: { type: 'string', description: 'Metadata sidecar path' },
    duration_seconds: { type: 'number', description: 'Requested audio duration' },
    family: { type: 'string', description: 'Detected model family' }
  },
  required: [
    'text',
    'path',
    'files',
    'mode',
    'seed',
    'model',
    'duration_ms',
    'prompt_id',
    'comfy_url',
    'notes',
    'success'
  ],
  additionalProperties: false
} as const

export const VIDEO_DESCRIPTION = [
  'Generate a short video from a text prompt using a local ComfyUI Wan 2.1 text-to-video setup.',
  '',
  'The tool detects the required Wan 2.1 diffusion model, UMT5 text encoder, Wan VAE and core video nodes',
  'before submitting. If they are missing, the error lists detected video models and the exact missing pieces.',
  '',
  'Supported setup:',
  '  - diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors',
  '  - text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  '  - vae/wan_2.1_vae.safetensors',
  '',
  'Wan 2.2 I2V/VACE and other video families are not enabled here; use comfyui_workflow with a matching template.'
].join('\n')

export const VIDEO_PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Text prompt describing the video (required).'
    },
    negative_prompt: {
      type: 'string',
      description: 'Negative prompt. A sensible quality-focused default is used when omitted.'
    },
    width: {
      type: 'integer',
      description: 'Video width (default 832, aligned to 16).'
    },
    height: {
      type: 'integer',
      description: 'Video height (default 480, aligned to 16).'
    },
    length_frames: {
      type: 'integer',
      description: 'Number of frames (default 33, aligned to 1+4k). At 16 fps, 33 frames is about 2 seconds.'
    },
    fps: {
      type: 'number',
      description: 'Output frame rate (default 16).'
    },
    seed: {
      type: 'integer',
      description: 'Random seed. Omit for random; reuse to reproduce the clip.'
    },
    steps: {
      type: 'integer',
      description: 'Sampling steps (default 30).'
    },
    cfg_scale: {
      type: 'number',
      description: 'CFG scale (default 6).'
    },
    sampler_name: {
      type: 'string',
      description: 'Sampler name (default uni_pc).'
    },
    scheduler: {
      type: 'string',
      description: 'Scheduler name (default simple).'
    },
    model: {
      type: 'string',
      description: 'Optional specific Wan T2V diffusion model file. Detected automatically when omitted.'
    },
    output_path: {
      type: 'string',
      description: 'Directory or exact file path for the video. Defaults to the current project root.'
    },
    timeout_ms: {
      type: 'integer',
      description: 'Total wait timeout in milliseconds (default: timeoutMs from config; max 3600000).'
    },
    write_metadata: {
      type: 'boolean',
      description: 'Write a .json metadata sidecar next to the video (default true).'
    }
  },
  required: ['prompt'],
  additionalProperties: false
} as const

export const VIDEO_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Readable result' },
    path: { type: 'string', description: 'Absolute path of the generated video' },
    files: { type: 'array', items: { type: 'string' }, description: 'All files produced' },
    mode: { type: 'string', description: 'Media mode (video)' },
    seed: { type: 'integer', description: 'Seed used' },
    model: { type: 'string', description: 'Model / family used' },
    duration_ms: { type: 'integer', description: 'Elapsed time' },
    prompt_id: { type: 'string', description: 'ComfyUI prompt id' },
    comfy_url: { type: 'string', description: 'ComfyUI address' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Notes' },
    success: { type: 'boolean', description: 'Whether generation succeeded' },
    metadata_path: { type: 'string', description: 'Metadata sidecar path' },
    width: { type: 'integer', description: 'Video width' },
    height: { type: 'integer', description: 'Video height' },
    fps: { type: 'number', description: 'Output frame rate' },
    family: { type: 'string', description: 'Detected model family' }
  },
  required: [
    'text',
    'path',
    'files',
    'mode',
    'seed',
    'model',
    'duration_ms',
    'prompt_id',
    'comfy_url',
    'notes',
    'success'
  ],
  additionalProperties: false
} as const

/* ────────────────────────────── helpers ────────────────────────────── */

function audioFailure(support: AudioSupport): never {
  throw new ImagePluginError(
    formatAudioCapabilityError(support),
    'Install one of the supported ACE-Step 1.5 setups, then retry. For a different audio family, use comfyui_workflow.'
  )
}

function videoFailure(support: VideoSupport): never {
  throw new ImagePluginError(
    formatVideoCapabilityError(support),
    'Install the Wan 2.1 text-to-video model set, then retry. For Wan 2.2 or another family, use comfyui_workflow.'
  )
}

function runFailure(result: MediaRunResult, kind: 'audio' | 'video'): never {
  const detail = result.issues.map((issue) => issue.message).join('; ')
  throw new ImagePluginError(
    detail
      ? `ComfyUI ${kind} workflow failed (prompt_id=${result.promptId}): ${detail}`
      : `ComfyUI ${kind} workflow finished with status "${result.status}" (prompt_id=${result.promptId}).`,
    result.issues.length > 0
      ? 'Open the ComfyUI console for the failing node, then retry. The metadata sidecar records the workflow for debugging.'
      : 'Check the ComfyUI console and the saved metadata for details.'
  )
}

function mediaFailure(tool: string, error: unknown): never {
  throw new ImagePluginError(
    `${tool} failed: ${formatError(error)}`,
    'Check the ComfyUI server, the detected models, and the tool arguments.'
  )
}

function audioText(input: {
  result: MediaRunResult
  support: AudioSupport
  seed: number
  durationSeconds: number
  bpm: number
  path: string
  comfyUrl: string
  notes: string[]
}): string {
  const family = input.support.label ?? 'ACE-Step'
  const lines = [
    `✅ Audio generated (${family}, ${input.durationSeconds.toFixed(1)} s)`,
    '',
    `Audio: ${input.path}`
  ]
  if (input.result.metadataPath) lines.push(`Metadata: ${input.result.metadataPath}`)
  lines.push(
    '',
    `Params: seed=${input.seed} bpm=${input.bpm} duration=${input.durationSeconds.toFixed(1)}s`,
    `Model: ${input.support.models.checkpoint ?? input.support.models.diffusion ?? '(unknown)'}`,
    `ComfyUI: ${input.comfyUrl} (prompt_id=${input.result.promptId})`
  )
  if (input.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of input.notes) lines.push(`  - ${note}`)
  }
  lines.push('', 'Tip: reuse the same seed, prompt and duration to reproduce the track.')
  return lines.join('\n')
}

function videoText(input: {
  result: MediaRunResult
  support: VideoSupport
  seed: number
  width: number
  height: number
  lengthFrames: number
  fps: number
  path: string
  comfyUrl: string
  notes: string[]
}): string {
  const lines = [
    `✅ Video generated (${input.support.label ?? 'Wan 2.1 T2V'}, ${input.width}x${input.height}, ${input.lengthFrames} frames @ ${input.fps} fps)`,
    '',
    `Video: ${input.path}`
  ]
  if (input.result.metadataPath) lines.push(`Metadata: ${input.result.metadataPath}`)
  lines.push(
    '',
    `Params: seed=${input.seed} size=${input.width}x${input.height} frames=${input.lengthFrames} fps=${input.fps}`,
    `Model: ${input.support.models.diffusion ?? '(unknown)'}`,
    `ComfyUI: ${input.comfyUrl} (prompt_id=${input.result.promptId})`
  )
  if (input.notes.length > 0) {
    lines.push('', 'Notes:')
    for (const note of input.notes) lines.push(`  - ${note}`)
  }
  lines.push('', 'Tip: reuse the same seed/prompt/size for a similar clip; lower width or frames for faster runs.')
  return lines.join('\n')
}

function requirePrompt(value: unknown, tool: string): string {
  const prompt = asString(value)
  if (!prompt) throw new ImagePluginError(`${tool} requires prompt.`, 'Describe the audio or video you want.')
  return prompt
}

/* ────────────────────────────── tools ────────────────────────────── */

/** Build the generate_audio tool. */
export function createGenerateAudioTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: AUDIO_TOOL_NAME,
    description: AUDIO_DESCRIPTION,
    parameters: AUDIO_PARAMETERS_SCHEMA,
    output: {
      schema: AUDIO_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as { text?: unknown } | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as { path?: unknown; seed?: unknown } | undefined
        return { kind: 'audio-generation', path: result?.path ?? '', seed: result?.seed ?? 0 }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<MediaToolResult> {
      const input = (args ?? {}) as Record<string, unknown>
      const { config, cwd } = context(pluginConfig, exec)
      const client = clientFor(config)
      try {
        const support = await detectAudioSupport(client, {
          ...(asString(input.model) ? { model: asString(input.model) } : {}),
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        if (!support.supported) audioFailure(support)

        const prompt = requirePrompt(input.prompt, AUDIO_TOOL_NAME)
        const durationSeconds = clampNumber(input.duration_seconds, 1, 600, 30)
        const bpm = clampInt(input.bpm, 10, 300, 120)
        const seed = clampInt(input.seed, 0, 4_294_967_295, randomSeed())
        const split = support.family === 'ace-step-1.5-split'
        const built = buildAudioWorkflow(support, {
          prompt,
          lyrics: typeof input.lyrics === 'string' ? input.lyrics : '',
          durationSeconds,
          bpm,
          timesignature: asString(input.timesignature) ?? '4',
          language: asString(input.language) ?? 'en',
          keyscale: asString(input.keyscale) ?? 'C major',
          seed,
          steps: clampInt(input.steps, 1, 500, split ? 50 : 8),
          cfgScale: clampNumber(input.cfg_scale, 0, 100, split ? 6 : 1),
          samplerName: asString(input.sampler_name) ?? 'euler',
          scheduler: asString(input.scheduler) ?? 'simple'
        })

        const result = await runMediaWorkflow({
          client,
          config,
          cwd,
          workflow: built.workflow,
          ...(asString(input.output_path) ? { outputPath: asString(input.output_path) } : {}),
          ...(input.timeout_ms !== undefined ? { timeoutMs: clampInt(input.timeout_ms, 1_000, 3_600_000, config.timeoutMs) } : {}),
          writeMetadata: asBool(input.write_metadata, true),
          kind: 'audio-generation',
          extraMetadata: {
            mediaType: 'audio',
            family: support.family,
            prompt,
            lyrics: typeof input.lyrics === 'string' ? input.lyrics : '',
            durationSeconds,
            bpm,
            seed
          },
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        if (result.status !== 'success' || !result.completed || result.issues.length > 0) runFailure(result, 'audio')
        if (result.files.length === 0) {
          throw new ImagePluginError(
            `ComfyUI finished but produced no audio file (prompt_id=${result.promptId}).`,
            'Check that the workflow ends in SaveAudio/SaveAudioMP3 and inspect the ComfyUI console.'
          )
        }
        const path = result.files[0] as string
        const notes = [
          ...built.notes,
          ...(support.family ? [`Family: ${support.family}`] : []),
          ...result.warnings
        ]
        const value: MediaToolResult = {
          text: audioText({ result, support, seed, durationSeconds, bpm, path, comfyUrl: config.baseUrl, notes }),
          path,
          files: result.files,
          mode: 'audio',
          seed,
          model: support.models.checkpoint ?? support.models.diffusion ?? support.family ?? 'ACE-Step',
          duration_ms: result.durationMs,
          prompt_id: result.promptId,
          comfy_url: config.baseUrl,
          notes,
          success: true,
          ...(result.metadataPath ? { metadata_path: result.metadataPath } : {}),
          duration_seconds: durationSeconds,
          ...(support.family ? { family: support.family } : {})
        }
        return value
      } catch (error) {
        if (error instanceof ImagePluginError) throw error
        mediaFailure(AUDIO_TOOL_NAME, error)
      }
    }
  }
}

/** Build the generate_video tool. */
export function createGenerateVideoTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: VIDEO_TOOL_NAME,
    description: VIDEO_DESCRIPTION,
    parameters: VIDEO_PARAMETERS_SCHEMA,
    output: {
      schema: VIDEO_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as { text?: unknown } | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as { path?: unknown; seed?: unknown } | undefined
        return { kind: 'video-generation', path: result?.path ?? '', seed: result?.seed ?? 0 }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<MediaToolResult> {
      const input = (args ?? {}) as Record<string, unknown>
      const { config, cwd } = context(pluginConfig, exec)
      const client = clientFor(config)
      try {
        const support = await detectVideoSupport(client, {
          ...(asString(input.model) ? { model: asString(input.model) } : {}),
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        if (!support.supported) videoFailure(support)

        const prompt = requirePrompt(input.prompt, VIDEO_TOOL_NAME)
        const width = align(clampInt(input.width, 64, 16_384, 832), 16)
        const height = align(clampInt(input.height, 64, 16_384, 480), 16)
        const lengthFrames = alignFrameLength(clampInt(input.length_frames, 1, 4_096, 33))
        const fps = clampNumber(input.fps, 1, 120, 16)
        const seed = clampInt(input.seed, 0, 4_294_967_295, randomSeed())
        const negativePrompt =
          asString(input.negative_prompt) ??
          'low quality, blurry, static, overexposed, watermark, text, poorly drawn, deformed'
        const built = buildVideoWorkflow(support, {
          prompt,
          negativePrompt,
          width,
          height,
          lengthFrames,
          fps,
          seed,
          steps: clampInt(input.steps, 1, 10_000, 30),
          cfgScale: clampNumber(input.cfg_scale, 0, 100, 6),
          samplerName: asString(input.sampler_name) ?? 'uni_pc',
          scheduler: asString(input.scheduler) ?? 'simple'
        })

        const result = await runMediaWorkflow({
          client,
          config,
          cwd,
          workflow: built.workflow,
          ...(asString(input.output_path) ? { outputPath: asString(input.output_path) } : {}),
          ...(input.timeout_ms !== undefined ? { timeoutMs: clampInt(input.timeout_ms, 1_000, 3_600_000, config.timeoutMs) } : {}),
          writeMetadata: asBool(input.write_metadata, true),
          kind: 'video-generation',
          extraMetadata: {
            mediaType: 'video',
            family: support.family,
            prompt,
            negativePrompt,
            width,
            height,
            lengthFrames,
            fps,
            seed
          },
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        if (result.status !== 'success' || !result.completed || result.issues.length > 0) runFailure(result, 'video')
        if (result.files.length === 0) {
          throw new ImagePluginError(
            `ComfyUI finished but produced no video file (prompt_id=${result.promptId}).`,
            'Check that the workflow ends in SaveVideo and inspect the ComfyUI console.'
          )
        }
        const path = result.files[0] as string
        const notes = [
          ...built.notes,
          ...(support.family ? [`Family: ${support.family}`] : []),
          ...result.warnings
        ]
        const value: MediaToolResult = {
          text: videoText({ result, support, seed, width, height, lengthFrames, fps, path, comfyUrl: config.baseUrl, notes }),
          path,
          files: result.files,
          mode: 'video',
          seed,
          model: support.models.diffusion ?? support.family ?? 'Wan',
          duration_ms: result.durationMs,
          prompt_id: result.promptId,
          comfy_url: config.baseUrl,
          notes,
          success: true,
          ...(result.metadataPath ? { metadata_path: result.metadataPath } : {}),
          width,
          height,
          fps,
          ...(support.family ? { family: support.family } : {})
        }
        return value
      } catch (error) {
        if (error instanceof ImagePluginError) throw error
        mediaFailure(VIDEO_TOOL_NAME, error)
      }
    }
  }
}
