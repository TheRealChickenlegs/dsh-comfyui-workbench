import { PLUGIN_ID } from '../identity.js';
/** Fixed node ids, for easier debugging. */
export const NODE_IDS = {
    checkpoint: '1',
    positive: '2',
    negative: '3',
    emptyLatent: '4',
    sampler: '5',
    decode: '6',
    save: '7',
    loadImage: '8',
    loadMask: '9',
    vaeEncode: '10',
    inpaintEncode: '10'
};
function checkpointLoader(checkpoint) {
    return {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: checkpoint },
        _meta: { title: 'Checkpoint' }
    };
}
function clipEncode(text, clipFrom, title) {
    return { class_type: 'CLIPTextEncode', inputs: { text, clip: clipFrom }, _meta: { title } };
}
function ksampler(facts, latentImage, denoise) {
    return {
        class_type: 'KSampler',
        inputs: {
            seed: facts.request.seed,
            steps: facts.request.steps,
            cfg: facts.request.cfgScale,
            sampler_name: facts.samplerName,
            scheduler: facts.scheduler,
            denoise,
            model: [NODE_IDS.checkpoint, 0],
            positive: [NODE_IDS.positive, 0],
            negative: [NODE_IDS.negative, 0],
            latent_image: latentImage
        },
        _meta: { title: 'Sampler' }
    };
}
function saveNode(facts) {
    if (facts.config.saveToComfyUI) {
        return {
            class_type: 'SaveImage',
            inputs: { filename_prefix: facts.filenamePrefix, images: [NODE_IDS.decode, 0] },
            _meta: { title: 'Save image' }
        };
    }
    // PreviewImage lands in ComfyUI's temp directory, so it does not pollute its output directory.
    return {
        class_type: 'PreviewImage',
        inputs: { images: [NODE_IDS.decode, 0] },
        _meta: { title: 'Preview image' }
    };
}
function assertUploaded(value, what, mode) {
    if (!value) {
        throw new Error(`Internal error: mode=${mode} needs the uploaded ${what}, but it was not available while building the workflow.`);
    }
    return value;
}
/** Build the text2img workflow. */
export function buildText2Img(facts) {
    const workflow = {
        [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
        [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], 'Positive prompt'),
        [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], 'Negative prompt'),
        [NODE_IDS.emptyLatent]: {
            class_type: 'EmptyLatentImage',
            inputs: { width: facts.request.width, height: facts.request.height, batch_size: 1 },
            _meta: { title: 'Empty latent' }
        },
        [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.emptyLatent, 0], 1.0),
        [NODE_IDS.decode]: {
            class_type: 'VAEDecode',
            inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
            _meta: { title: 'VAE decode' }
        },
        [NODE_IDS.save]: saveNode(facts)
    };
    return { workflow, mode: 'text2img', outputNodeId: NODE_IDS.save };
}
/** Build the img2img workflow (denoise = strength). */
export function buildImg2Img(facts) {
    const imageName = assertUploaded(facts.uploadedInput, 'input image', 'img2img');
    const workflow = {
        [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
        [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], 'Positive prompt'),
        [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], 'Negative prompt'),
        [NODE_IDS.loadImage]: {
            class_type: 'LoadImage',
            inputs: { image: imageName },
            _meta: { title: 'Input image' }
        },
        [NODE_IDS.vaeEncode]: {
            class_type: 'VAEEncode',
            inputs: { pixels: [NODE_IDS.loadImage, 0], vae: [NODE_IDS.checkpoint, 2] },
            _meta: { title: 'VAE encode' }
        },
        [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.vaeEncode, 0], facts.request.strength),
        [NODE_IDS.decode]: {
            class_type: 'VAEDecode',
            inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
            _meta: { title: 'VAE decode' }
        },
        [NODE_IDS.save]: saveNode(facts)
    };
    return { workflow, mode: 'img2img', outputNodeId: NODE_IDS.save };
}
/** Build the inpaint workflow (LoadImage + LoadImageMask → VAEEncodeForInpaint). */
export function buildInpaint(facts) {
    const imageName = assertUploaded(facts.uploadedInput, 'input image', 'inpaint');
    const maskName = assertUploaded(facts.uploadedMask, 'mask image', 'inpaint');
    const workflow = {
        [NODE_IDS.checkpoint]: checkpointLoader(facts.checkpoint),
        [NODE_IDS.positive]: clipEncode(facts.request.prompt, [NODE_IDS.checkpoint, 1], 'Positive prompt'),
        [NODE_IDS.negative]: clipEncode(facts.request.negativePrompt, [NODE_IDS.checkpoint, 1], 'Negative prompt'),
        [NODE_IDS.loadImage]: {
            class_type: 'LoadImage',
            inputs: { image: imageName },
            _meta: { title: 'Original image' }
        },
        [NODE_IDS.loadMask]: {
            class_type: 'LoadImageMask',
            inputs: { image: maskName, channel: facts.maskChannel ?? 'red' },
            _meta: { title: 'Mask (white = repaint area)' }
        },
        [NODE_IDS.inpaintEncode]: {
            class_type: 'VAEEncodeForInpaint',
            inputs: {
                pixels: [NODE_IDS.loadImage, 0],
                vae: [NODE_IDS.checkpoint, 2],
                mask: [NODE_IDS.loadMask, 0],
                grow_mask_by: facts.config.inpaintGrowMask
            },
            _meta: { title: 'Inpaint encode' }
        },
        [NODE_IDS.sampler]: ksampler(facts, [NODE_IDS.inpaintEncode, 0], facts.request.strength),
        [NODE_IDS.decode]: {
            class_type: 'VAEDecode',
            inputs: { samples: [NODE_IDS.sampler, 0], vae: [NODE_IDS.checkpoint, 2] },
            _meta: { title: 'VAE decode' }
        },
        [NODE_IDS.save]: saveNode(facts)
    };
    return { workflow, mode: 'inpaint', outputNodeId: NODE_IDS.save };
}
/** Build the background-removal workflow (LoadImage → third-party removal node → SaveImage). */
export function buildRemoveBackground(facts) {
    const imageName = assertUploaded(facts.uploadedInput, 'input image', 'remove_background');
    if (!facts.rembg) {
        throw new Error('Internal error: mode=remove_background needs a rembg plan, but none was available while building the workflow.');
    }
    const loadImage = {
        class_type: 'LoadImage',
        inputs: { image: imageName },
        _meta: { title: 'Input image' }
    };
    const built = facts.rembg.build([NODE_IDS.loadImage, 0]);
    // The background-removed result goes straight into the save node.
    const saver = facts.config.saveToComfyUI
        ? {
            class_type: 'SaveImage',
            inputs: { filename_prefix: facts.filenamePrefix, images: built.output },
            _meta: { title: 'Save image (background removed)' }
        }
        : {
            class_type: 'PreviewImage',
            inputs: { images: built.output },
            _meta: { title: 'Preview image (background removed)' }
        };
    const workflow = {
        [NODE_IDS.loadImage]: loadImage,
        ...built.nodes,
        [NODE_IDS.save]: saver
    };
    return { workflow, mode: 'remove_background', outputNodeId: NODE_IDS.save };
}
/** Dispatch by mode. */
export function buildWorkflow(facts) {
    switch (facts.request.mode) {
        case 'text2img':
            return buildText2Img(facts);
        case 'img2img':
            return buildImg2Img(facts);
        case 'inpaint':
            return buildInpaint(facts);
        case 'remove_background':
            return buildRemoveBackground(facts);
        default: {
            const exhaustive = facts.request.mode;
            throw new Error(`Internal error: unknown mode ${String(exhaustive)}`);
        }
    }
}
/** The output file name prefix on the ComfyUI side (inside a subdirectory, keeping its output tidy). */
export function filenamePrefixFor(request, now = new Date()) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${PLUGIN_ID}/${stamp}-${request.seed}`;
}
/**
 * The **token substitution** escape hatch for user-provided custom workflows (room for
 * outpaint / upscale and friends).
 *
 * Usage: `extra_options.workflow_path` points at an API-format workflow JSON containing
 * placeholders such as `{{prompt}}`, `{{negative_prompt}}`, `{{width}}`, `{{height}}`, `{{seed}}`,
 * `{{steps}}`, `{{cfg_scale}}`, `{{strength}}`, `{{checkpoint}}`, `{{input_image}}`,
 * `{{mask_image}}`; the plugin substitutes real values before submitting.
 *
 * This lets users wire in anything V1 does not cover (outpainting, upscaling, batching, special
 * nodes) without waiting for a new release.
 */
export function applyCustomWorkflow(template, values) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
        throw new Error('The custom workflow must be a JSON object (API format).');
    }
    /**
     * Recursive substitution.
     *
     * ⚠️ This must **not** be done by "JSON.stringify first, then string-replace" (my first version
     * did exactly that and the tests caught it): that turns `"{{width}}"` in the template into a
     * quoted `"256"`, silently degrading a number into a string, and ComfyUI rejects the whole
     * workflow because of the wrong type. Substituting by value preserves types: when the whole
     * string is one placeholder, return the value as-is (a number stays a number).
     */
    const substitute = (value) => {
        if (typeof value === 'string') {
            const exact = /^\{\{(\w+)\}\}$/.exec(value);
            if (exact) {
                const replacement = values[exact[1]];
                // Leave placeholders that were not provided as-is, so a typo is easy to spot.
                return replacement === undefined ? value : replacement;
            }
            // A placeholder embedded mid-sentence → can only be concatenated as a string.
            return value.replace(/\{\{(\w+)\}\}/g, (match, key) => {
                const replacement = values[key];
                return replacement === undefined ? match : String(replacement);
            });
        }
        if (Array.isArray(value))
            return value.map(substitute);
        if (value !== null && typeof value === 'object') {
            const result = {};
            for (const [key, child] of Object.entries(value))
                result[key] = substitute(child);
            return result;
        }
        return value;
    };
    return substitute(template);
}
