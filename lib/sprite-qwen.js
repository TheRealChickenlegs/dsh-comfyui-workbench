/**
 * Qwen-Image-Edit back-view keyframe graph for the Draconid walk_up rework.
 *
 * The old W2 "turn up" often left a front-facing keyframe. The reference session replaces it with a
 * Qwen-Image-Edit back-view edit of the front master, then runs W2 away from that keyframe.
 */
export const QWEN_UNET = 'Qwen-Image-Edit-2509-Q4_K_M.gguf';
export const QWEN_LORA = 'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors';
export const QWEN_CLIP = 'qwen_2.5_vl_7b_fp8_scaled.safetensors';
export const QWEN_VAE = 'qwen_image_vae.safetensors';
export function buildQwenBackWorkflow(options) {
    return {
        '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: options.model } },
        '2': {
            class_type: 'LoraLoaderModelOnly',
            inputs: { model: ['1', 0], lora_name: options.lora, strength_model: 1 }
        },
        '3': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3 } },
        '4': { class_type: 'CFGNorm', inputs: { model: ['3', 0], strength: 1 } },
        '5': { class_type: 'CLIPLoader', inputs: { clip_name: options.clip, type: 'qwen_image' } },
        '6': { class_type: 'VAELoader', inputs: { vae_name: options.vae } },
        '7': { class_type: 'LoadImage', inputs: { image: options.image } },
        '8': {
            class_type: 'ImageScale',
            inputs: { image: ['7', 0], upscale_method: 'lanczos', width: 512, height: 512, crop: 'disabled' }
        },
        '9': {
            class_type: 'TextEncodeQwenImageEditPlus',
            inputs: { clip: ['5', 0], prompt: options.positive, vae: ['6', 0], image1: ['8', 0] }
        },
        '10': {
            class_type: 'TextEncodeQwenImageEditPlus',
            inputs: { clip: ['5', 0], prompt: options.negative, vae: ['6', 0], image1: ['8', 0] }
        },
        '11': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['6', 0] } },
        '16': {
            class_type: 'VRAMUnloadClip',
            inputs: { positive: ['9', 0], negative: ['10', 0], clip: ['5', 0] }
        },
        '12': {
            class_type: 'KSampler',
            inputs: {
                model: ['4', 0],
                seed: options.seed,
                steps: options.steps ?? 4,
                cfg: options.cfg ?? 1,
                sampler_name: 'euler',
                scheduler: 'simple',
                positive: ['16', 0],
                negative: ['16', 1],
                latent_image: ['11', 0],
                denoise: 1
            }
        },
        '13': { class_type: 'VRAMUnloadModel', inputs: { latent: ['12', 0], model: ['4', 0] } },
        '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['6', 0] } },
        '15': {
            class_type: 'SaveImage',
            inputs: { images: ['14', 0], filename_prefix: options.filenamePrefix }
        }
    };
}
export function buildCutoutWorkflow(options) {
    return {
        '1': { class_type: 'LoadImage', inputs: { image: options.image } },
        '10': {
            class_type: 'BiRefNetRMBG',
            inputs: {
                image: ['1', 0],
                model: options.model,
                sensitivity: 1,
                mask_blur: 0,
                mask_offset: 0,
                invert_output: false,
                refine_foreground: true,
                unload_model: false,
                background: 'Alpha',
                background_color: '#222222'
            }
        },
        '20': {
            class_type: 'ImageScale',
            inputs: {
                image: ['1', 0], upscale_method: 'lanczos',
                width: options.size, height: options.size, crop: 'disabled'
            }
        },
        '21': { class_type: 'MaskToImage', inputs: { mask: ['10', 1] } },
        '22': {
            class_type: 'ImageScale',
            inputs: {
                image: ['21', 0], upscale_method: 'lanczos',
                width: options.size, height: options.size, crop: 'disabled'
            }
        },
        '23': { class_type: 'ImageToMask', inputs: { image: ['22', 0], channel: 'red' } },
        '24': { class_type: 'InvertMask', inputs: { mask: ['23', 0] } },
        '25': { class_type: 'JoinImageWithAlpha', inputs: { image: ['20', 0], alpha: ['24', 0] } },
        '26': {
            class_type: 'SaveImage',
            inputs: { images: ['25', 0], filename_prefix: options.filenamePrefix }
        }
    };
}
