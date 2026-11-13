/**
 * The public tool contract: the **only** tool exposed to the Agent, `generate_image`
 * (the "single tool" requirement).
 *
 * This file does exactly three things: tool name/description, argument JSON Schema, and output
 * contract. Execution itself lives in runner.ts. Keeping the contract separate is deliberate:
 * "the public interface must stay stable" — swapping backends or adding modes should barely
 * touch this file.
 *
 * ⚠️ Two hard constraints (verified against the actual @deepseek-ai/dsh-tools type definitions,
 * not guessed):
 *   1. `parameters` must be a **raw JSON Schema**, not a DSL style such as `required: true`.
 *   2. DSH's JSON Schema subset is **enforced**: unsupported keys such as `minimum` / `maximum` /
 *      `format` are **rejected outright** (see assertSupportedJsonSchema in json-schema.d.ts).
 *      Ranges therefore live in `description` only, backed by runtime validation.
 */
import { resolveConfig } from './config.js'
import { formatError } from './errors.js'
import { logDebug } from './log.js'
import { GENERATE_MODES, type GenerateImageArgs, type ResolvedConfig } from './types.js'
import { runGeneration } from './runner.js'
import { formatResult, renderFailureText, type ImageToolResult } from './result.js'

/** The tool name. */
export const TOOL_NAME = 'generate_image'

/** Concise model-facing summary; argument-specific guidance lives in the schema. */
export const TOOL_DESCRIPTION =
  'Generate images with ComfyUI: text2img, img2img, inpaint, or remove_background. The mode is inferred from supplied images when omitted; use comfyui_inspect/workflow for custom pipelines.'

/** The raw JSON Schema for the arguments (only the subset DSH supports). */
export const PARAMETERS_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [...GENERATE_MODES],
      description: 'Mode; inferred from input_image/mask_image when omitted.'
    },
    prompt: {
      type: 'string',
      description: 'Required except for remove_background.'
    },
    negative_prompt: {
      type: 'string',
      description: 'Negative prompt (what should not appear). Uses the plugin default when omitted.'
    },
    input_image: {
      type: 'string',
      description: 'Input image; required for img2img, inpaint, and background removal.'
    },
    mask_image: {
      type: 'string',
      description: 'Inpaint mask; bright areas are repainted. Match input_image dimensions.'
    },
    width: {
      type: 'integer',
      description:
        'Text2img width (64-8192, rounded to multiple of 8; default follows checkpoint).'
    },
    height: {
      type: 'integer',
      description:
        'Text2img height (64-8192, rounded to multiple of 8; default follows checkpoint).'
    },
    seed: {
      type: 'integer',
      description:
        'Seed (0-4294967295); random if omitted, reuse to reproduce.'
    },
    output_path: {
      type: 'string',
      description:
        'Output directory or image file; defaults to project root. Existing names get a numeric suffix.'
    },
    style_reference: {
      type: 'string',
      description:
        'Reserved; recorded in metadata only, not used for generation.'
    },
    character_reference: {
      type: 'string',
      description:
        'Reserved; recorded in metadata only, not used for generation.'
    },
    strength: {
      type: 'number',
      description:
        'Change amount, 0-1. Defaults to 0.6 for img2img (lower stays closer to the input) and 1.0 for inpaint.'
    },
    steps: {
      type: 'integer',
      description: 'Sampling steps (1-500), default 20. More steps = finer and slower.'
    },
    cfg_scale: { type: 'number', description: 'Prompt adherence, CFG (0-100), default 7.' },
    model: {
      type: 'string',
      description:
        'Checkpoint file name (the name under ComfyUI models/checkpoints). Picks an available one automatically when omitted.'
    },
    sampler_name: {
      type: 'string',
      description: 'Sampler, for example euler / dpmpp_2m. Uses the default when omitted.'
    },
    scheduler: {
      type: 'string',
      description: 'Scheduler, for example normal / karras. Uses the default when omitted.'
    },
    extra_options: {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional workflow_path to run a local API-format workflow JSON with prompt/seed/image placeholders.'
    }
  },
  required: [],
  additionalProperties: false
} as const

/** The raw JSON Schema for the output. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Complete result description for the model' },
    path: { type: 'string', description: 'Absolute path of the produced image' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'All file paths produced by this call'
    },
    mode: { type: 'string', description: 'The mode actually used' },
    seed: { type: 'integer', description: 'The seed used' },
    width: { type: 'integer', description: 'Output width' },
    height: { type: 'integer', description: 'Output height' },
    steps: { type: 'integer', description: 'Sampling steps' },
    cfg_scale: { type: 'number', description: 'CFG' },
    strength: { type: 'number', description: 'Change amount' },
    model: { type: 'string', description: 'The checkpoint actually used' },
    sampler: { type: 'string', description: 'Sampler' },
    scheduler: { type: 'string', description: 'Scheduler' },
    prompt_id: { type: 'string', description: 'ComfyUI prompt_id, handy for looking it up in the ComfyUI UI' },
    comfy_url: { type: 'string', description: 'The ComfyUI address used' },
    duration_ms: { type: 'integer', description: 'Elapsed time (milliseconds)' },
    success: { type: 'boolean', description: 'Whether it succeeded' },
    mode_inferred: { type: 'boolean', description: 'Whether the mode was inferred automatically' },
    metadata_path: {
      type: 'string',
      description: 'Path to the metadata sidecar (.json), containing the full parameters and workflow'
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Notes/caveats for this call'
    }
  },
  required: [
    'text',
    'path',
    'files',
    'mode',
    'seed',
    'width',
    'height',
    'steps',
    'cfg_scale',
    'strength',
    'model',
    'sampler',
    'scheduler',
    'prompt_id',
    'comfy_url',
    'duration_ms',
    'success',
    'mode_inferred',
    'notes'
  ],
  additionalProperties: false
} as const

/** The minimal surface of the execution context we use (no host type imports, to avoid resolution problems under link installs). */
export interface ToolExecLike {
  signal?: AbortSignal
  agent?: unknown
}

/**
 * Dig the "current working directory" out of the execution context.
 *
 * The spec wants output to default to the "project root". DSH attaches cwd to the agent, but
 * which layer it sits on is a host implementation detail, so we probe candidates **defensively**
 * in order, falling back to the process cwd — never failing because it could not be found.
 */
export function resolveCwd(exec: unknown): string {
  const agent = (exec as { agent?: unknown } | undefined)?.agent as
    | Record<string, unknown>
    | undefined
  if (agent) {
    const candidates: unknown[] = [
      agent.cwd,
      (agent.meta as Record<string, unknown> | undefined)?.cwd,
      (agent.session as Record<string, unknown> | undefined)?.cwd,
      ((agent.session as Record<string, unknown> | undefined)?.header as Record<string, unknown> | undefined)?.cwd
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return process.cwd()
}

/** Guess what this call wanted to do — used only in failure text, never affects execution. */
function guessMode(args: unknown): string {
  const value = (args as GenerateImageArgs | undefined)?.mode
  return typeof value === 'string' ? value : 'text2img'
}

/**
 * Build the tool definition.
 *
 * @param pluginConfig Plugin config injected by the host (the config of the entry in cordis.patch.yml).
 *        Note: config is resolved **on every call**, so a changed
 *        `~/.dsh-comfyui-workbench/config.json` takes effect immediately without restarting DSH.
 */
export function createGenerateImageTool(pluginConfig?: unknown): Record<string, unknown> {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): unknown[] => [
        { type: 'text', text: String((value as ImageToolResult | undefined)?.text ?? '') }
      ],
      presentationMeta: (_args: unknown, value: unknown): Record<string, unknown> => {
        const result = value as ImageToolResult | undefined
        return {
          kind: 'image-generation',
          mode: result?.mode ?? 'unknown',
          path: result?.path ?? '',
          seed: result?.seed ?? 0
        }
      }
    },
    async execute(args: unknown, exec: ToolExecLike): Promise<ImageToolResult> {
      const config: ResolvedConfig = resolveConfig(pluginConfig)
      const cwd = resolveCwd(exec)
      logDebug('execute', { cwd, baseUrl: config.baseUrl })
      try {
        const run = await runGeneration({
          args: (args ?? {}) as GenerateImageArgs,
          cwd,
          config,
          ...(exec?.signal ? { signal: exec.signal } : {})
        })
        return formatResult(run)
      } catch (error) {
        // On failure, hand "why + what to do" to the model verbatim — far more useful than a bare fetch failed.
        const text = renderFailureText(error, guessMode(args))
        logDebug('generation failed', formatError(error))
        throw new Error(text)
      }
    }
  }
}
