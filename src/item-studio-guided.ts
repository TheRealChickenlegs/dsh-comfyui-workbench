/**
 * Original Item Studio guided SDXL graph:
 * SDXL + pixel-art LoRA -> IPAdapter Plus style reference -> ControlNet Union silhouette.
 */
export interface GuidedWorkflowOptions {
  prompt: string
  negative: string
  seed: number
  checkpoint: string
  lora: string
  controlnetModel: string
  ipadapterModel: string
  guideImage?: string
  styleImage?: string
  controlnetStrength: number
  controlnetEnd: number
  styleStrength: number
  styleEnd: number
  steps: number
  cfg: number
  width: number
  height: number
  filenamePrefix: string
}

export const CONTROLNET_UNION =
  'SDXL/controlnet-union-sdxl-1.0/diffusion_pytorch_model.safetensors'
export const IPADAPTER_PLUS = 'ip-adapter-plus_sdxl_vit-h.safetensors'

export function buildGuidedWorkflow(options: GuidedWorkflowOptions): Record<string, unknown> {
  const graph: Record<string, unknown> = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: options.checkpoint } },
    '2': {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: options.lora,
        strength_model: 0.9,
        strength_clip: 0.9,
        model: ['1', 0],
        clip: ['1', 1]
      }
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: options.prompt, clip: ['2', 1] }
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { text: options.negative, clip: ['2', 1] }
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width: options.width, height: options.height, batch_size: 1 }
    }
  }
  let modelLink: [string, number] = ['2', 0]
  let positiveLink: [string, number] = ['3', 0]
  let negativeLink: [string, number] = ['4', 0]
  if (options.styleImage) {
    graph['20'] = {
      class_type: 'IPAdapterUnifiedLoader',
      inputs: { model: modelLink, preset: 'PLUS (high strength)' }
    }
    graph['21'] = { class_type: 'LoadImage', inputs: { image: options.styleImage } }
    graph['22'] = {
      class_type: 'IPAdapterAdvanced',
      inputs: {
        model: ['20', 0],
        ipadapter: ['20', 1],
        image: ['21', 0],
        weight: options.styleStrength,
        weight_type: 'style transfer',
        combine_embeds: 'concat',
        start_at: 0,
        end_at: options.styleEnd,
        embeds_scaling: 'V only'
      }
    }
    modelLink = ['22', 0]
  }
  if (options.guideImage) {
    graph['30'] = {
      class_type: 'ControlNetLoader',
      inputs: { control_net_name: options.controlnetModel }
    }
    graph['31'] = { class_type: 'LoadImage', inputs: { image: options.guideImage } }
    graph['32'] = {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        positive: positiveLink,
        negative: negativeLink,
        control_net: ['30', 0],
        image: ['31', 0],
        strength: options.controlnetStrength,
        start_percent: 0,
        end_percent: options.controlnetEnd
      }
    }
    positiveLink = ['32', 0]
    negativeLink = ['32', 1]
  }
  graph['6'] = {
    class_type: 'KSampler',
    inputs: {
      seed: options.seed,
      steps: options.steps,
      cfg: options.cfg,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: modelLink,
      positive: positiveLink,
      negative: negativeLink,
      latent_image: ['5', 0]
    }
  }
  graph['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } }
  graph['8'] = {
    class_type: 'SaveImage',
    inputs: { images: ['7', 0], filename_prefix: options.filenamePrefix }
  }
  return graph
}
