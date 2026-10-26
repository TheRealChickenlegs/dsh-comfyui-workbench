export function buildFlux2Workflow(options) {
    return {
        '1': {
            class_type: 'UNETLoader',
            inputs: { unet_name: options.model, weight_dtype: options.weightDtype ?? 'default' }
        },
        '2': {
            class_type: 'CLIPLoader',
            inputs: { clip_name: options.textEncoder, type: 'flux2' }
        },
        '3': { class_type: 'VAELoader', inputs: { vae_name: options.vae } },
        '4': {
            class_type: 'CLIPTextEncode',
            inputs: { text: options.prompt, clip: ['2', 0] }
        },
        '5': {
            class_type: 'ConditioningZeroOut',
            inputs: { conditioning: ['4', 0] }
        },
        '6': {
            class_type: 'CFGGuider',
            inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], cfg: options.cfg }
        },
        '7': {
            class_type: 'Flux2Scheduler',
            inputs: { steps: options.steps, width: options.width, height: options.height }
        },
        '8': {
            class_type: 'KSamplerSelect',
            inputs: { sampler_name: 'euler' }
        },
        '9': {
            class_type: 'RandomNoise',
            inputs: { noise_seed: options.seed }
        },
        '10': {
            class_type: 'EmptyFlux2LatentImage',
            inputs: { width: options.width, height: options.height, batch_size: 1 }
        },
        '11': {
            class_type: 'SamplerCustomAdvanced',
            inputs: {
                noise: ['9', 0],
                guider: ['6', 0],
                sampler: ['8', 0],
                sigmas: ['7', 0],
                latent_image: ['10', 0]
            }
        },
        '12': {
            class_type: 'VAEDecode',
            inputs: { samples: ['11', 0], vae: ['3', 0] }
        },
        '13': {
            class_type: 'SaveImage',
            inputs: { images: ['12', 0], filename_prefix: options.filenamePrefix }
        }
    };
}
export const FLUX2_MODEL_CANDIDATES = [
    'flux-2-klein-9b-fp8.safetensors',
    'flux-2-klein-4b.safetensors',
    'flux-2-klein-base-9b-fp8.safetensors'
];
export const FLUX2_TEXT_ENCODER = 'qwen_3_8b_fp8mixed.safetensors';
export const FLUX2_VAE_CANDIDATES = ['full_encoder_small_decoder.safetensors', 'flux2-vae.safetensors'];
