/**
 * High-level audio/video workflow builders.
 *
 * Audio: the official ACE-Step 1.5 graphs (AIO checkpoint or split files).
 * Video: the core Wan 2.1 text-to-video graph.
 *
 * Both builders only run after capabilities.ts has verified the models and nodes, so a missing
 * dependency is reported before submission instead of becoming a cryptic ComfyUI node error.
 */
import type { ComfyWorkflow } from '../types.js'
import { PLUGIN_ID } from '../identity.js'
import { timestampSlug } from '../files.js'
import type { AudioSupport, VideoSupport } from './capabilities.js'

export interface AudioBuildArgs {
  prompt: string
  lyrics: string
  durationSeconds: number
  bpm: number
  timesignature: string
  language: string
  keyscale: string
  seed: number
  steps: number
  cfgScale: number
  samplerName: string
  scheduler: string
}

export interface AudioWorkflowResult {
  workflow: ComfyWorkflow
  notes: string[]
}

/** Build an ACE-Step 1.5 workflow for the detected AIO or split setup. */
export function buildAudioWorkflow(
  support: AudioSupport,
  args: AudioBuildArgs
): AudioWorkflowResult {
  const prefix = `audio/${PLUGIN_ID}/${timestampSlug()}-${args.seed}`
  const notes: string[] = []
  const saveNode = support.models.saveNode
  if (!saveNode) throw new Error('Internal error: no SaveAudio node was detected.')

  const saveInputs: Record<string, unknown> = {
    audio: [support.family === 'ace-step-1.5-aio' ? '7' : '9', 0],
    filename_prefix: prefix
  }
  if (saveNode === 'SaveAudioMP3') saveInputs.quality = 'V0'

  const textEncode = {
    class_type: 'TextEncodeAceStepAudio1.5',
    inputs: {
      clip: [support.family === 'ace-step-1.5-aio' ? '1' : '2', support.family === 'ace-step-1.5-aio' ? 1 : 0],
      tags: args.prompt,
      lyrics: args.lyrics,
      seed: args.seed,
      bpm: args.bpm,
      duration: args.durationSeconds,
      timesignature: args.timesignature,
      language: args.language,
      keyscale: args.keyscale,
      generate_audio_codes: true,
      cfg_scale: 2.0,
      temperature: 0.85,
      top_p: 0.9,
      top_k: 0,
      min_p: 0
    },
    _meta: { title: 'ACE-Step tags and lyrics' }
  }

  if (support.family === 'ace-step-1.5-aio') {
    if (!support.models.checkpoint) throw new Error('Internal error: missing ACE-Step AIO checkpoint.')
    notes.push(`AIO checkpoint: ${support.models.checkpoint}`)
    const workflow: ComfyWorkflow = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: support.models.checkpoint },
        _meta: { title: 'ACE-Step checkpoint' }
      },
      '2': {
        class_type: 'ModelSamplingAuraFlow',
        inputs: { model: ['1', 0], shift: 3 },
        _meta: { title: 'Model sampling (AuraFlow)' }
      },
      '3': textEncode,
      '4': {
        class_type: 'ConditioningZeroOut',
        inputs: { conditioning: ['3', 0] },
        _meta: { title: 'Negative conditioning' }
      },
      '5': {
        class_type: 'EmptyAceStep1.5LatentAudio',
        inputs: { seconds: args.durationSeconds, batch_size: 1 },
        _meta: { title: 'Empty audio latent' }
      },
      '6': {
        class_type: 'KSampler',
        inputs: {
          seed: args.seed,
          steps: args.steps,
          cfg: args.cfgScale,
          sampler_name: args.samplerName,
          scheduler: args.scheduler,
          denoise: 1,
          model: ['2', 0],
          positive: ['3', 0],
          negative: ['4', 0],
          latent_image: ['5', 0]
        },
        _meta: { title: 'Audio sampler' }
      },
      '7': {
        class_type: 'VAEDecodeAudio',
        inputs: { samples: ['6', 0], vae: ['1', 2] },
        _meta: { title: 'Audio VAE decode' }
      },
      '8': {
        class_type: saveNode,
        inputs: saveInputs,
        _meta: { title: 'Save audio' }
      }
    }
    return { workflow, notes }
  }

  // Split ACE-Step 1.5 graph.
  if (!support.models.diffusion || !support.models.clip1 || !support.models.clip2 || !support.models.vae) {
    throw new Error('Internal error: missing split ACE-Step model files.')
  }
  notes.push(`Split diffusion model: ${support.models.diffusion}`)
  const workflow: ComfyWorkflow = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: support.models.diffusion, weight_dtype: 'default' },
      _meta: { title: 'ACE-Step diffusion model' }
    },
    '2': {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: support.models.clip1,
        clip_name2: support.models.clip2,
        type: 'ace',
        device: 'default'
      },
      _meta: { title: 'ACE-Step text encoders' }
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: support.models.vae },
      _meta: { title: 'ACE-Step VAE' }
    },
    '4': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['1', 0], shift: 3 },
      _meta: { title: 'Model sampling (AuraFlow)' }
    },
    '5': textEncode,
    '6': {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['5', 0] },
      _meta: { title: 'Negative conditioning' }
    },
    '7': {
      class_type: 'EmptyAceStep1.5LatentAudio',
      inputs: { seconds: args.durationSeconds, batch_size: 1 },
      _meta: { title: 'Empty audio latent' }
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed: args.seed,
        steps: args.steps,
        cfg: args.cfgScale,
        sampler_name: args.samplerName,
        scheduler: args.scheduler,
        denoise: 1,
        model: ['4', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['7', 0]
      },
      _meta: { title: 'Audio sampler' }
    },
    '9': {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['8', 0], vae: ['3', 0] },
      _meta: { title: 'Audio VAE decode' }
    },
    '10': {
      class_type: saveNode,
      inputs: {
        audio: ['9', 0],
        filename_prefix: prefix,
        ...(saveNode === 'SaveAudioMP3' ? { quality: 'V0' } : {})
      },
      _meta: { title: 'Save audio' }
    }
  }
  return { workflow, notes }
}

export interface VideoBuildArgs {
  prompt: string
  negativePrompt: string
  width: number
  height: number
  lengthFrames: number
  fps: number
  seed: number
  steps: number
  cfgScale: number
  samplerName: string
  scheduler: string
}

export interface VideoWorkflowResult {
  workflow: ComfyWorkflow
  notes: string[]
}

/** Build the core Wan 2.1 text-to-video graph. */
export function buildVideoWorkflow(
  support: VideoSupport,
  args: VideoBuildArgs
): VideoWorkflowResult {
  if (!support.models.diffusion || !support.models.clip || !support.models.vae) {
    throw new Error('Internal error: missing Wan video model files.')
  }
  const prefix = `video/${PLUGIN_ID}/${timestampSlug()}-${args.seed}`
  const workflow: ComfyWorkflow = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: support.models.diffusion, weight_dtype: 'default' },
      _meta: { title: 'Wan diffusion model' }
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: support.models.clip, type: 'wan', device: 'default' },
      _meta: { title: 'Wan text encoder' }
    },
    '3': {
      class_type: 'VAELoader',
      inputs: { vae_name: support.models.vae },
      _meta: { title: 'Wan VAE' }
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { text: args.prompt, clip: ['2', 0] },
      _meta: { title: 'Positive prompt' }
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { text: args.negativePrompt, clip: ['2', 0] },
      _meta: { title: 'Negative prompt' }
    },
    '6': {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: {
        width: args.width,
        height: args.height,
        length: args.lengthFrames,
        batch_size: 1
      },
      _meta: { title: 'Empty video latent' }
    },
    '7': {
      class_type: 'ModelSamplingSD3',
      inputs: { model: ['1', 0], shift: 8 },
      _meta: { title: 'Model sampling (SD3)' }
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed: args.seed,
        steps: args.steps,
        cfg: args.cfgScale,
        sampler_name: args.samplerName,
        scheduler: args.scheduler,
        denoise: 1,
        model: ['7', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0]
      },
      _meta: { title: 'Video sampler' }
    },
    '9': {
      class_type: 'VAEDecode',
      inputs: { samples: ['8', 0], vae: ['3', 0] },
      _meta: { title: 'Video VAE decode' }
    },
    '10': {
      class_type: 'CreateVideo',
      inputs: { images: ['9', 0], fps: args.fps },
      _meta: { title: 'Create video' }
    },
    '11': {
      class_type: 'SaveVideo',
      inputs: { video: ['10', 0], filename_prefix: prefix, format: 'auto' },
      _meta: { title: 'Save video' }
    }
  }
  return {
    workflow,
    notes: [
      `Wan model: ${support.models.diffusion}`,
      `Text encoder: ${support.models.clip}`,
      `VAE: ${support.models.vae}`
    ]
  }
}
