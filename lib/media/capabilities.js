import { declaredInputs, enumChoices } from '../comfy/nodes.js';
function valuesFor(all, node, input) {
    const info = all[node];
    if (!info)
        return [];
    return enumChoices(declaredInputs(info)[input]) ?? [];
}
function hasNodes(all, names) {
    return names.filter((name) => !(name in all));
}
function prefix(folder, name) {
    return `${folder}/${name}`;
}
function unique(values) {
    return [...new Set(values)];
}
function isAudioModelName(name) {
    return /ace|audio|music|stable[_-]?audio|minimax|yue|hunyuan.*audio/i.test(name);
}
function isVideoModelName(name) {
    return /wan|hunyuan.*video|ltx|mochi|svd|cosmos|seedance|kling|cogvideo|animatediff/i.test(name);
}
/**
 * Detect whether the installed ComfyUI can run the supported ACE-Step 1.5 audio workflow.
 * AIO is preferred because it needs one checkpoint and no DualCLIPLoader.
 */
export async function detectAudioSupport(client, options = {}) {
    const all = await client.objectInfo(options.signal, 0);
    const checkpoints = valuesFor(all, 'CheckpointLoaderSimple', 'ckpt_name');
    const diffusion = valuesFor(all, 'UNETLoader', 'unet_name');
    const clip1 = valuesFor(all, 'DualCLIPLoader', 'clip_name1');
    const clip2 = valuesFor(all, 'DualCLIPLoader', 'clip_name2');
    const clipTypes = valuesFor(all, 'DualCLIPLoader', 'type');
    const vae = valuesFor(all, 'VAELoader', 'vae_name');
    const aio = checkpoints.find((name) => /ace[_ -]?step/i.test(name) && /aio/i.test(name)) ?? undefined;
    const splitDiffusion = diffusion.find((name) => /ace[_ -]?step/i.test(name) &&
        /1[._-]?5|xl/i.test(name) &&
        !/aio/i.test(name)) ?? undefined;
    const splitClip1 = clip1.find((name) => /qwen.*0[._]?6.*ace/i.test(name)) ?? undefined;
    const splitClip2 = clip2.find((name) => /qwen.*4.*ace/i.test(name)) ?? undefined;
    const splitVae = vae.find((name) => /ace.*1[._-]?5.*vae|ace[_ -]?1\.5[_ -]?vae/i.test(name)) ?? undefined;
    const saveNode = 'SaveAudioMP3' in all ? 'SaveAudioMP3' : 'SaveAudio' in all ? 'SaveAudio' : undefined;
    const baseNodes = [
        'TextEncodeAceStepAudio1.5',
        'EmptyAceStep1.5LatentAudio',
        'KSampler',
        'ModelSamplingAuraFlow',
        'ConditioningZeroOut',
        'VAEDecodeAudio'
    ];
    const aioMissing = hasNodes(all, ['CheckpointLoaderSimple', ...baseNodes]);
    const splitMissing = hasNodes(all, ['UNETLoader', 'DualCLIPLoader', 'VAELoader', ...baseNodes]);
    const detected = unique([
        ...checkpoints.filter(isAudioModelName).map((name) => prefix('checkpoints', name)),
        ...diffusion.filter(isAudioModelName).map((name) => prefix('diffusion_models', name)),
        ...clip1.filter(isAudioModelName).map((name) => prefix('text_encoders', name)),
        ...clip2.filter(isAudioModelName).map((name) => prefix('text_encoders', name)),
        ...vae.filter(isAudioModelName).map((name) => prefix('vae', name))
    ]);
    const notes = [];
    if (aio)
        notes.push(`AIO checkpoint: ${aio}`);
    if (splitDiffusion)
        notes.push(`Split diffusion model: ${splitDiffusion}`);
    const canAio = aio !== undefined && aioMissing.length === 0 && saveNode !== undefined;
    const canSplit = splitDiffusion !== undefined &&
        splitClip1 !== undefined &&
        splitClip2 !== undefined &&
        splitVae !== undefined &&
        clipTypes.includes('ace') &&
        splitMissing.length === 0 &&
        saveNode !== undefined;
    let family;
    if (options.model) {
        if (options.model === aio && canAio) {
            family = 'ace-step-1.5-aio';
        }
        else if (options.model === splitDiffusion && canSplit) {
            family = 'ace-step-1.5-split';
        }
        else {
            return {
                supported: false,
                models: {},
                detected,
                missing: [
                    `Requested audio model ${JSON.stringify(options.model)} is not a supported ACE-Step 1.5 model.`,
                    ...(aio ? [`AIO checkpoint available: ${aio}`] : []),
                    ...(splitDiffusion ? [`Split diffusion model available: ${splitDiffusion}`] : [])
                ],
                notes
            };
        }
    }
    else if (canAio) {
        family = 'ace-step-1.5-aio';
    }
    else if (canSplit) {
        family = 'ace-step-1.5-split';
    }
    const missing = [];
    if (!aio && !splitDiffusion) {
        missing.push('No ACE-Step 1.5 audio model found. Put ace_step_1.5_turbo_aio.safetensors in models/checkpoints, or the split ACE-Step 1.5 files in diffusion_models/text_encoders/vae.');
    }
    else if (!aio && splitDiffusion && !canSplit) {
        if (!splitClip1 || !splitClip2)
            missing.push('Both ACE-Step 1.5 text encoders (qwen_0.6b_ace15, qwen_4b_ace15) are required for the split workflow.');
        if (!splitVae)
            missing.push('ACE-Step 1.5 VAE (ace_1.5_vae.safetensors) is required for the split workflow.');
        if (!clipTypes.includes('ace'))
            missing.push('This ComfyUI DualCLIPLoader does not expose the "ace" type required by the split workflow.');
        if (splitMissing.length > 0)
            missing.push(`Missing nodes: ${splitMissing.join(', ')}`);
    }
    else if (aio && !canAio) {
        if (aioMissing.length > 0)
            missing.push(`Missing nodes: ${aioMissing.join(', ')}`);
    }
    if (!saveNode)
        missing.push('Neither SaveAudioMP3 nor SaveAudio is available.');
    if (family === 'ace-step-1.5-split' && splitMissing.length > 0) {
        missing.push(`Missing nodes: ${splitMissing.join(', ')}`);
    }
    return {
        supported: family !== undefined,
        ...(family ? { family } : {}),
        ...(family === 'ace-step-1.5-aio'
            ? { label: 'ACE-Step 1.5 AIO' }
            : family === 'ace-step-1.5-split'
                ? { label: 'ACE-Step 1.5 split' }
                : {}),
        models: {
            ...(present(aio) ? { checkpoint: aio } : {}),
            ...(present(splitDiffusion) ? { diffusion: splitDiffusion } : {}),
            ...(present(splitClip1) ? { clip1: splitClip1 } : {}),
            ...(present(splitClip2) ? { clip2: splitClip2 } : {}),
            ...(present(splitVae) ? { vae: splitVae } : {}),
            ...(saveNode ? { saveNode } : {})
        },
        detected,
        missing: unique(missing),
        notes
    };
}
function present(value) {
    return typeof value === 'string' && value !== '';
}
/**
 * Detect whether the installed ComfyUI can run the supported Wan 2.1 text-to-video workflow.
 * Wan 2.2 GGUF I2V files are reported as detected but not enabled for the high-level tool.
 */
export async function detectVideoSupport(client, options = {}) {
    const all = await client.objectInfo(options.signal, 0);
    const unet = valuesFor(all, 'UNETLoader', 'unet_name');
    const gguf = valuesFor(all, 'UnetLoaderGGUF', 'unet_name');
    const clips = valuesFor(all, 'CLIPLoader', 'clip_name');
    const clipGguf = valuesFor(all, 'CLIPLoaderGGUF', 'clip_name');
    const clipTypes = valuesFor(all, 'CLIPLoader', 'type');
    const vaes = valuesFor(all, 'VAELoader', 'vae_name');
    const t2v = unet.find((name) => /wan2[._-]?1.*t2v|wan.*1\.3b.*t2v/i.test(name)) ?? undefined;
    const clip = clips.find((name) => /umt5.*\.safetensors$/i.test(name)) ?? undefined;
    const vae = vaes.find((name) => /wan.*vae|wan_2\.1_vae/i.test(name)) ?? undefined;
    const requiredNodes = [
        'UNETLoader',
        'CLIPLoader',
        'VAELoader',
        'CLIPTextEncode',
        'EmptyHunyuanLatentVideo',
        'ModelSamplingSD3',
        'KSampler',
        'VAEDecode',
        'CreateVideo',
        'SaveVideo'
    ];
    const missingNodes = hasNodes(all, requiredNodes);
    const detected = unique([
        ...unet.filter(isVideoModelName).map((name) => prefix('diffusion_models', name)),
        ...gguf.filter(isVideoModelName).map((name) => prefix('unet_gguf', name)),
        ...clips.filter((name) => /umt5/i.test(name)).map((name) => prefix('text_encoders', name)),
        ...clipGguf.filter((name) => /umt5/i.test(name)).map((name) => prefix('clip_gguf', name)),
        ...vaes.filter((name) => /wan|ltx|hunyuan/i.test(name)).map((name) => prefix('vae', name))
    ]);
    const notes = [];
    if (gguf.some((name) => /wan2[._-]?2/i.test(name))) {
        notes.push('Wan 2.2 I2V GGUF models were detected but are not enabled for this high-level tool; use comfyui_workflow with a Wan 2.2 template.');
    }
    let model = t2v;
    if (options.model) {
        if (options.model === t2v) {
            model = options.model;
        }
        else {
            return {
                supported: false,
                models: {},
                detected,
                missing: [
                    `Requested video model ${JSON.stringify(options.model)} is not a supported Wan 2.1 text-to-video model.`,
                    ...(t2v ? [`Available: ${t2v}`] : [])
                ],
                notes
            };
        }
    }
    const missing = [];
    if (!model) {
        missing.push('No Wan 2.1 text-to-video diffusion model found (expected a wan2.1_t2v_*.safetensors file in models/diffusion_models).');
    }
    if (!clip) {
        const gguf = clipGguf.find((name) => /umt5/i.test(name));
        missing.push(gguf
            ? `No UMT5 safetensors text encoder in models/text_encoders (found GGUF ${gguf}; the high-level Wan 2.1 workflow needs the safetensors encoder, or use comfyui_workflow).`
            : 'No UMT5 text encoder in models/text_encoders (expected umt5_xxl_fp8_e4m3fn_scaled.safetensors or similar).');
    }
    if (!clipTypes.includes('wan')) {
        missing.push('This ComfyUI CLIPLoader does not expose the "wan" text-encoder type.');
    }
    if (!vae) {
        missing.push('No Wan VAE in models/vae (expected wan_2.1_vae.safetensors).');
    }
    if (missingNodes.length > 0) {
        missing.push(`Missing nodes: ${missingNodes.join(', ')}`);
    }
    const supported = model !== undefined &&
        clip !== undefined &&
        vae !== undefined &&
        clipTypes.includes('wan') &&
        missingNodes.length === 0;
    return {
        supported,
        ...(supported ? { family: 'wan2.1-t2v', label: 'Wan 2.1 text-to-video' } : {}),
        models: {
            ...(model ? { diffusion: model } : {}),
            ...(clip ? { clip } : {}),
            ...(vae ? { vae } : {})
        },
        detected,
        missing: unique(missing),
        notes
    };
}
/** Human-readable unsupported-audio message. */
export function formatAudioCapabilityError(support) {
    const lines = ['Audio generation is not available on this ComfyUI.'];
    if (support.detected.length > 0) {
        lines.push('', 'Detected audio-related models:');
        for (const item of support.detected)
            lines.push(`  - ${item}`);
    }
    if (support.missing.length > 0) {
        lines.push('', 'Missing:');
        for (const item of support.missing)
            lines.push(`  - ${item}`);
    }
    lines.push('', 'Supported setups:', '  - ACE-Step 1.5 AIO: checkpoints/ace_step_1.5_turbo_aio.safetensors (simplest), or', '  - ACE-Step 1.5 split: diffusion_models/acestep_v1.5_xl_base_bf16.safetensors + text_encoders/qwen_0.6b_ace15 + qwen_4b_ace15 + vae/ace_1.5_vae.safetensors.', 'The advanced comfyui_workflow tool can run a custom audio workflow for other model families.');
    return lines.join('\n');
}
/** Human-readable unsupported-video message. */
export function formatVideoCapabilityError(support) {
    const lines = ['Video generation is not available on this ComfyUI.'];
    if (support.detected.length > 0) {
        lines.push('', 'Detected video-related models:');
        for (const item of support.detected)
            lines.push(`  - ${item}`);
    }
    if (support.missing.length > 0) {
        lines.push('', 'Missing:');
        for (const item of support.missing)
            lines.push(`  - ${item}`);
    }
    lines.push('', 'Supported setup for this tool: Wan 2.1 text-to-video', '  - diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', '  - text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', '  - vae/wan_2.1_vae.safetensors', 'For Wan 2.2 I2V/VACE or other video families, use comfyui_workflow with a matching custom workflow.');
    return lines.join('\n');
}
