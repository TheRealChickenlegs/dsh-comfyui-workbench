/**
 * Native Item Studio tool.
 *
 * Implements the portable Item Studio pack as one DSH tool:
 *   list      the bundled 108-item catalogue
 *   generate  one item/variant through the item workflow, then BiRefNet cutout, finalize and icon
 *   cutout    re-cut an existing raw render
 *   batch     generate a selected set (all 108 or a list) and write a candidate manifest
 *
 * The pack's actual workflows are bundled under data/item_studio/workflows; the catalogue is bundled
 * alongside them. Nothing is auto-adopted: output is candidate art for review.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.js';
import { ImagePluginError, formatError } from './errors.js';
import { resolveCwd } from './tool.js';
import { ComfyUIClient } from './comfy/client.js';
import { historyIssues, waitForPrompt } from './comfy/workflow-runner.js';
import { ensureDir, readFileBytes, resolveUserPath } from './files.js';
import { alphaBox, borderColour, cropRgba, decodePng, encodePng, keepLargestComponent, outlineRgba, quantizeRgba, removeKeyBackground, resizeRgba } from './png.js';
import { buildFlux2Workflow, FLUX2_MODEL_CANDIDATES, FLUX2_TEXT_ENCODER, FLUX2_VAE_CANDIDATES } from './item-studio-flux2.js';
import { buildGuidedWorkflow, CONTROLNET_UNION, IPADAPTER_PLUS } from './item-studio-guided.js';
export const ITEM_STUDIO_TOOL_NAME = 'item_studio';
const DATA_DIR = fileURLToPath(new URL('../data/item_studio', import.meta.url));
const CATALOG_PATH = path.join(DATA_DIR, 'item_catalog.json');
const WORKFLOW_DIR = path.join(DATA_DIR, 'workflows');
const GUIDES_DIR = path.join(DATA_DIR, 'guides');
const STYLE_REFERENCE = path.join(DATA_DIR, 'style_reference.png');
const PALETTE_PATH = path.join(DATA_DIR, 'palette.json');
const DEFAULT_NEGATIVE = 'background scenery, shadow, gradient, camera, text, watermark, blur, smooth shading, ' +
    'multiple objects, item sheet, grid, collage, characters, beige background, tan background, warm background';
/** Minimum subject fill by family, from tools/item_studio/ART-DIRECTION.md. */
const FAMILY_FILL = {
    ring: 0.58, amulet: 0.62, gem: 0.55, potion: 0.78, scroll: 0.82, food: 0.66,
    light: 0.78, lantern: 0.78, dagger: 0.66, short_sword: 0.78, long_sword: 0.9,
    great_sword: 0.96, axe: 0.92, mace: 0.86, hammer: 0.9, spear: 0.98, halberd: 1.0,
    staff: 0.98, bow: 0.94, shield: 0.92, helm: 0.78, armour: 0.9, robe: 0.9,
    cloak: 0.86, boots: 0.75, gloves: 0.65, wand: 0.76, book: 0.8, gold: 0.65,
    spike: 0.58, shovel: 0.92, pick: 0.88, oilflask: 0.62, lute: 0.84, pouch: 0.62,
    lockpicks: 0.56
};
const TARGETS = {
    small: { width: 64, height: 64 },
    tall: { width: 64, height: 128 }
};
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function asBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function asInt(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
function slug(value) {
    return value.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}
let paletteCache;
function loadPalette() {
    if (!paletteCache) {
        try {
            const data = JSON.parse(readFileSync(PALETTE_PATH, 'utf8'));
            paletteCache = Array.isArray(data.colours)
                ? data.colours.filter((row) => Array.isArray(row) && row.length === 3 && row.every((value) => typeof value === 'number'))
                : [];
            if (paletteCache.length === 0)
                paletteCache = undefined;
        }
        catch {
            paletteCache = undefined;
        }
    }
    return paletteCache ?? [];
}
function fileList(files) {
    return files ?? [];
}
async function probeFlux2(client, input) {
    const required = [
        'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut',
        'CFGGuider', 'Flux2Scheduler', 'KSamplerSelect', 'RandomNoise',
        'EmptyFlux2LatentImage', 'SamplerCustomAdvanced', 'VAEDecode', 'SaveImage'
    ];
    try {
        const info = await client.objectInfo();
        const missing = required.filter((name) => !info[name]);
        if (missing.length > 0)
            return { available: false, reason: `Missing ComfyUI nodes: ${missing.join(', ')}` };
        const diffusion = fileList(await client.modelFiles('diffusion_models'));
        const requested = asString(input.flux2_model);
        const model = requested ?? FLUX2_MODEL_CANDIDATES.find((candidate) => diffusion.includes(candidate));
        if (!model)
            return { available: false, reason: `No Flux.2 model found in models/diffusion_models (wanted ${FLUX2_MODEL_CANDIDATES.join(' or ')})` };
        if (!diffusion.includes(model))
            return { available: false, reason: `Flux.2 model not found: ${model}` };
        const encoders = fileList(await client.modelFiles('text_encoders'));
        const textEncoder = asString(input.flux2_text_encoder) ?? FLUX2_TEXT_ENCODER;
        if (!encoders.includes(textEncoder))
            return { available: false, reason: `Flux.2 text encoder not found: ${textEncoder}` };
        const vaes = fileList(await client.modelFiles('vae'));
        const vae = asString(input.flux2_vae) ?? FLUX2_VAE_CANDIDATES.find((candidate) => vaes.includes(candidate));
        if (!vae)
            return { available: false, reason: `No Flux.2 VAE found (wanted ${FLUX2_VAE_CANDIDATES.join(' or ')})` };
        const steps = clampInt(input.flux2_steps, 1, 100, model.includes('base') ? 20 : 4);
        const cfg = typeof input.flux2_cfg === 'number' && Number.isFinite(input.flux2_cfg) ? input.flux2_cfg : 1;
        return { available: true, model, textEncoder, vae, steps, cfg };
    }
    catch (error) {
        return { available: false, reason: `Flux.2 preflight failed: ${formatError(error)}` };
    }
}
async function probeGuided(client, input) {
    const required = ['CheckpointLoaderSimple', 'LoraLoader', 'IPAdapterUnifiedLoader', 'IPAdapterAdvanced', 'ControlNetLoader', 'ControlNetApplyAdvanced'];
    try {
        const info = await client.objectInfo();
        const missing = required.filter((name) => !info[name]);
        if (missing.length > 0)
            return { available: false, reason: `Missing guided nodes: ${missing.join(', ')}` };
        const controlnet = asString(input.controlnet_model) ?? CONTROLNET_UNION;
        const ipadapter = asString(input.ipadapter_model) ?? IPADAPTER_PLUS;
        const controlnets = fileList(await client.modelFiles('controlnet'));
        if (!controlnets.includes(controlnet))
            return { available: false, reason: `ControlNet not found: ${controlnet}` };
        const ipadapters = fileList(await client.modelFiles('ipadapter'));
        if (!ipadapters.includes(ipadapter))
            return { available: false, reason: `IPAdapter not found: ${ipadapter}` };
        const useStyle = asBool(input.use_style_reference, true);
        const styleReference = useStyle
            ? resolveUserPath(asString(input.style_reference_path) ?? STYLE_REFERENCE, process.cwd())
            : undefined;
        if (styleReference && !existsSync(styleReference))
            return { available: false, reason: `Style reference not found: ${styleReference}` };
        if (!existsSync(GUIDES_DIR))
            return { available: false, reason: `Guide directory missing: ${GUIDES_DIR}` };
        return { available: true, controlnet, ipadapter, ...(styleReference ? { styleReference } : {}), guidesDir: GUIDES_DIR };
    }
    catch (error) {
        return { available: false, reason: `Guided preflight failed: ${formatError(error)}` };
    }
}
function guideFor(entry, input, guided) {
    const archetype = asString(input.archetype) ?? entry.family;
    const explicit = asString(input.guide_path);
    const candidate = explicit ? resolveUserPath(explicit, process.cwd()) : path.join(guided.guidesDir ?? GUIDES_DIR, `${archetype}.png`);
    if (!existsSync(candidate)) {
        throw new ImagePluginError(`No silhouette guide for ${JSON.stringify(archetype)}: ${candidate}`, 'Use a catalogue family with a bundled guide, or pass archetype/guide_path.');
    }
    return candidate;
}
function chooseGenerator(requested, entry, flux2, guided, warnings) {
    if (requested === 'flux2') {
        if (!flux2.available)
            throw new ImagePluginError('Flux.2 was requested but is unavailable.', flux2.reason);
        return 'flux2';
    }
    if (requested === 'guided') {
        if (!guided.available)
            throw new ImagePluginError('Guided SDXL was requested but is unavailable.', guided.reason);
        if (entry.size === 'tall')
            throw new ImagePluginError('Guided SDXL does not support tall items in this version.', 'Use generator=flux2 or simple for tall items.');
        return 'guided';
    }
    if (requested === 'simple')
        return 'simple';
    if (flux2.available)
        return 'flux2';
    if (entry.size !== 'tall' && guided.available) {
        if (flux2.reason && !warnings.includes(flux2.reason))
            warnings.push(flux2.reason);
        return 'guided';
    }
    if (flux2.reason && !warnings.includes(flux2.reason))
        warnings.push(flux2.reason);
    return 'simple';
}
let catalogCache;
function loadCatalog() {
    if (!catalogCache) {
        try {
            catalogCache = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
        }
        catch (error) {
            throw new ImagePluginError(`Cannot read the bundled Item Studio catalogue at ${CATALOG_PATH}.`, 'Reinstall the plugin; data/item_studio/item_catalog.json is missing or invalid.');
        }
    }
    return catalogCache;
}
function loadTemplate(name) {
    const file = path.join(WORKFLOW_DIR, name);
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        throw new ImagePluginError(`Cannot read Item Studio workflow ${name}.`, 'Reinstall the plugin; data/item_studio/workflows is missing.');
    }
}
function substitute(value, values) {
    if (typeof value === 'string') {
        const exact = /^\{\{([a-z_]+)\}\}$/.exec(value);
        if (exact && exact[1] in values)
            return values[exact[1]];
        return value.replace(/\{\{([a-z_]+)\}\}/g, (match, key) => key in values ? String(values[key]) : match);
    }
    if (Array.isArray(value))
        return value.map((item) => substitute(item, values));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, values)]));
    }
    return value;
}
function setSavePrefix(workflow, prefix) {
    for (const node of Object.values(workflow)) {
        if (node && typeof node === 'object' && node.class_type === 'SaveImage') {
            const inputs = node.inputs;
            if (inputs)
                inputs.filename_prefix = prefix;
        }
    }
}
function imageSpecs(entry) {
    const specs = [];
    for (const node of Object.values(entry.outputs ?? {})) {
        for (const spec of node.images ?? []) {
            if (spec && typeof spec.filename === 'string' && spec.filename.toLowerCase().endsWith('.png'))
                specs.push(spec);
        }
    }
    return specs;
}
async function runComfy(client, workflow, label, timeoutMs, pollIntervalMs, signal) {
    const { promptId } = await client.queuePrompt(workflow, `item-studio-${Date.now().toString(36)}`, signal);
    const entry = await waitForPrompt(client, promptId, {
        timeoutMs, pollIntervalMs, ...(signal ? { signal } : {})
    });
    const issues = historyIssues(entry);
    if (issues.length > 0) {
        throw new ImagePluginError(`${label} failed in ComfyUI: ${issues.map((issue) => issue.message).join('; ')}`, 'Check the ComfyUI console. Verify SDXL, the pixel-art LoRA, BiRefNet_lite-matting and ComfyUI-RMBG are installed.');
    }
    return entry;
}
async function downloadFirstPng(client, entry, destination, signal) {
    const spec = imageSpecs(entry)[0];
    if (!spec)
        throw new ImagePluginError('ComfyUI produced no PNG output.');
    const bytes = await client.fetchFile({ filename: spec.filename, subfolder: spec.subfolder ?? '', type: spec.type ?? 'output' }, signal);
    ensureDir(path.dirname(destination));
    writeFileSync(destination, bytes);
    return destination;
}
function finalize(cutoutPath, target, fill, outline, palette) {
    const decoded = decodePng(readFileSync(cutoutPath));
    const isolated = keepLargestComponent(decoded.rgba, decoded.width, decoded.height);
    const box = alphaBox(isolated, decoded.width, decoded.height);
    if (!box)
        throw new ImagePluginError(`Cutout ${cutoutPath} is fully transparent.`);
    const cropped = cropRgba(isolated, decoded.width, decoded.height, box);
    const maxW = Math.max(1, Math.round(target.width * Math.min(0.98, Math.max(0.5, fill))));
    const maxH = Math.max(1, Math.round(target.height * Math.min(0.98, Math.max(0.5, fill))));
    const scale = Math.min(maxW / cropped.width, maxH / cropped.height);
    const contentW = Math.max(1, Math.round(cropped.width * scale));
    const contentH = Math.max(1, Math.round(cropped.height * scale));
    const resized = resizeRgba(cropped.rgba, cropped.width, cropped.height, contentW, contentH);
    const canvas = Buffer.alloc(target.width * target.height * 4);
    const x = Math.max(0, Math.floor((target.width - contentW) / 2));
    const y = Math.max(0, target.height - contentH);
    for (let row = 0; row < contentH; row += 1) {
        const destination = ((y + row) * target.width + x) * 4;
        resized.rgba.copy(canvas, destination, row * contentW * 4, (row + 1) * contentW * 4);
    }
    const quantised = palette && palette.length > 0 ? quantizeRgba(canvas, target.width, target.height, palette) : canvas;
    const spriteRgba = outline ? outlineRgba(quantised, target.width, target.height) : quantised;
    const iconScale = Math.min(32 / target.width, 32 / target.height);
    const iconW = Math.max(1, Math.round(target.width * iconScale));
    const iconH = Math.max(1, Math.round(target.height * iconScale));
    const iconResized = resizeRgba(spriteRgba, target.width, target.height, iconW, iconH);
    const iconCanvas = Buffer.alloc(32 * 32 * 4);
    const iconX = Math.floor((32 - iconW) / 2);
    const iconY = Math.floor((32 - iconH) / 2);
    for (let row = 0; row < iconH; row += 1) {
        iconResized.rgba.copy(iconCanvas, ((iconY + row) * 32 + iconX) * 4, row * iconW * 4, (row + 1) * iconW * 4);
    }
    return {
        sprite: { width: target.width, height: target.height, rgba: spriteRgba },
        icon: { width: 32, height: 32, rgba: iconCanvas }
    };
}
export const ITEM_STUDIO_PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['list', 'generate', 'cutout', 'batch'],
            description: 'Operation; inferred from item_id/raw_path/item_ids when omitted.'
        },
        item_id: { type: 'string', description: 'Catalogue item id, for example long_sword.' },
        variant: { type: 'string', description: 'Catalogue variant id: base, material, worn, runed, or family-specific.' },
        variants: {
            type: 'string',
            enum: ['base', 'all'],
            description: 'For batch: generate only the base variant or all four.'
        },
        item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'For batch: explicit item ids. Omit to select the whole catalogue.'
        },
        raw_path: { type: 'string', description: 'For cutout: an existing raw render.' },
        prompt: { type: 'string', description: 'For a custom item (not in the catalogue), or to override the catalogue prompt.' },
        negative_prompt: { type: 'string', description: 'Override the default negative prompt.' },
        name: { type: 'string', description: 'Custom item name.' },
        size: { type: 'string', enum: ['small', 'tall'], description: 'Custom item size (default small).' },
        output_dir: { type: 'string', description: 'Output root (default <cwd>/item_studio).' },
        seed: { type: 'integer', description: 'Seed override.' },
        generator: {
            type: 'string',
            enum: ['auto', 'flux2', 'guided', 'simple'],
            description: 'Generator: local Flux.2 (default when available), guided SDXL, or the simple pack.'
        },
        flux2_model: { type: 'string', description: 'Flux.2 diffusion model (default flux-2-klein-9b-fp8.safetensors).' },
        flux2_text_encoder: { type: 'string', description: 'Flux.2 text encoder (default qwen_3_8b_fp8mixed.safetensors).' },
        flux2_vae: { type: 'string', description: 'Flux.2 VAE (default full_encoder_small_decoder.safetensors).' },
        flux2_steps: { type: 'integer', description: 'Flux.2 steps (default 4; base model 20).' },
        flux2_cfg: { type: 'number', description: 'Flux.2 CFG (default 1).' },
        flux2_width: { type: 'integer', description: 'Flux.2 render width (default 256).' },
        flux2_height: { type: 'integer', description: 'Flux.2 render height (default 256).' },
        archetype: { type: 'string', description: 'Guided silhouette archetype (default catalogue family).' },
        guide_path: { type: 'string', description: 'Guided custom silhouette PNG.' },
        style_reference_path: { type: 'string', description: 'Guided IPAdapter style reference.' },
        use_style_reference: { type: 'boolean', description: 'Use IPAdapter in guided mode (default true).' },
        controlnet_model: { type: 'string', description: 'ControlNet Union model path.' },
        ipadapter_model: { type: 'string', description: 'IPAdapter Plus model path.' },
        controlnet_strength: { type: 'number', description: 'ControlNet strength (default 0.75).' },
        controlnet_end: { type: 'number', description: 'ControlNet end fraction (default 0.85).' },
        style_strength: { type: 'number', description: 'IPAdapter weight (default 0.45).' },
        style_end: { type: 'number', description: 'IPAdapter end fraction (default 0.8).' },
        guided_steps: { type: 'integer', description: 'Guided SDXL steps (default 26).' },
        guided_cfg: { type: 'number', description: 'Guided SDXL CFG (default 7).' },
        checkpoint: { type: 'string', description: 'SDXL checkpoint (default sd_xl_base_1.0.safetensors).' },
        lora: { type: 'string', description: 'Pixel-art LoRA (default pixel-art-xl.safetensors).' },
        rmbg_model: { type: 'string', description: 'BiRefNet model (default BiRefNet_lite-matting).' },
        outline: { type: 'boolean', description: 'Add a one-pixel dark outline (default false; the prompts already request an outline).' },
        force: { type: 'boolean', description: 'Regenerate existing raw/cutout outputs.' },
        limit: { type: 'integer', description: 'For batch/list: maximum rows.' },
        query: { type: 'string', description: 'For list: filter by id, name, family or category.' },
        category: { type: 'string', description: 'For list: filter by category.' },
        job_timeout_ms: { type: 'integer', description: 'Per-ComfyUI-job timeout (default 600000).' },
        catalog_path: { type: 'string', description: 'Optional custom Item Studio catalogue JSON.' }
    },
    required: [],
    additionalProperties: false
};
export const ITEM_STUDIO_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Readable result' },
        success: { type: 'boolean', description: 'Whether the action succeeded' },
        action: { type: 'string', description: 'Action performed' },
        count: { type: 'integer', description: 'Number of items returned/generated' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Catalogue rows or generated artifacts' },
        manifest: { type: 'string', description: 'Candidate manifest path' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal per-item failures' },
        seconds: { type: 'number', description: 'Wall time' }
    },
    required: ['text', 'success', 'action'],
    additionalProperties: false
};
function targetFor(size) {
    return size === 'tall' ? TARGETS.tall : TARGETS.small;
}
function catalogFor(catalogPath) {
    if (!catalogPath)
        return loadCatalog();
    try {
        return JSON.parse(readFileSync(resolveUserPath(catalogPath, process.cwd()), 'utf8'));
    }
    catch {
        throw new ImagePluginError(`Cannot read catalogue ${catalogPath}.`);
    }
}
function selectVariant(entry, variantId) {
    const wanted = variantId ?? 'base';
    const variant = entry.variants.find((row) => row.id === wanted);
    if (!variant) {
        throw new ImagePluginError(`Unknown variant ${JSON.stringify(wanted)} for ${entry.id}.`, `Use one of: ${entry.variants.map((row) => row.id).join(', ')}.`);
    }
    return variant;
}
async function generateSimpleRaw(options, entry, variant, prompt, negative, seed) {
    const tall = entry.size === 'tall';
    const templateName = tall ? 'item_tall.template.json' : 'item_64.template.json';
    const workflow = substitute(loadTemplate(templateName), {
        prompt,
        negative_prompt: negative,
        seed,
        width: tall ? 1024 : 1024,
        height: tall ? 2048 : 1024,
        input_image: ''
    });
    setSavePrefix(workflow, `item_studio/${slug(entry.id)}/${slug(variant.id)}`);
    for (const node of Object.values(workflow)) {
        if (!node || typeof node !== 'object')
            continue;
        const record = node;
        if (record.class_type === 'CheckpointLoaderSimple' && record.inputs)
            record.inputs.ckpt_name = options.checkpoint;
        if (record.class_type === 'LoraLoader' && record.inputs)
            record.inputs.lora_name = options.lora;
    }
    const entryHistory = await runComfy(options.client, workflow, `Item ${entry.id}/${variant.id}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal);
    const destination = path.join(options.outputDir, 'raw', `${slug(entry.id)}_${slug(variant.id)}.png`);
    return downloadFirstPng(options.client, entryHistory, destination, options.signal);
}
async function uploadCached(options, filePath, subfolder) {
    const existing = options.uploads.get(filePath);
    if (existing)
        return existing;
    const bytes = readFileBytes(filePath, 'asset');
    const uploaded = await options.client.uploadFile({
        filename: path.basename(filePath),
        bytes,
        mime: 'image/png',
        subfolder,
        overwrite: true
    }, options.signal);
    const remote = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    options.uploads.set(filePath, remote);
    return remote;
}
async function generateFlux2Raw(options, entry, variant, prompt, seed) {
    const flux = options.flux2;
    if (!flux.available || !flux.model || !flux.textEncoder || !flux.vae) {
        throw new ImagePluginError('Flux.2 is unavailable.', flux.reason);
    }
    const workflow = buildFlux2Workflow({
        prompt,
        seed,
        model: flux.model,
        textEncoder: flux.textEncoder,
        vae: flux.vae,
        steps: flux.steps ?? 4,
        cfg: flux.cfg ?? 1,
        width: clampInt(options.input.flux2_width, 64, 1024, 256),
        height: clampInt(options.input.flux2_height, 64, 1024, 256),
        filenamePrefix: `item_studio/${slug(entry.id)}/${slug(variant.id)}_flux2`
    });
    const entryHistory = await runComfy(options.client, workflow, `Flux.2 ${entry.id}/${variant.id}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal);
    const destination = path.join(options.outputDir, 'raw', `${slug(entry.id)}_${slug(variant.id)}_flux2.png`);
    return {
        path: await downloadFirstPng(options.client, entryHistory, destination, options.signal),
        generator: 'flux2',
        model: flux.model,
        steps: flux.steps,
        cfg: flux.cfg
    };
}
async function generateGuidedRaw(options, entry, variant, prompt, negative, seed) {
    if (entry.size === 'tall') {
        throw new ImagePluginError('Guided SDXL does not support tall items in this version.');
    }
    if (!options.guided.available) {
        throw new ImagePluginError('Guided SDXL is unavailable.', options.guided.reason);
    }
    const guidePath = guideFor(entry, options.input, options.guided);
    const stylePath = asBool(options.input.use_style_reference, true) ? options.guided.styleReference : undefined;
    const guide = await uploadCached(options, guidePath, `item_studio/${slug(entry.id)}/guides`);
    const style = stylePath ? await uploadCached(options, stylePath, `item_studio/${slug(entry.id)}/style`) : undefined;
    const workflow = buildGuidedWorkflow({
        prompt,
        negative,
        seed,
        checkpoint: options.checkpoint,
        lora: options.lora,
        controlnetModel: options.guided.controlnet ?? CONTROLNET_UNION,
        ipadapterModel: options.guided.ipadapter ?? IPADAPTER_PLUS,
        guideImage: guide,
        ...(style ? { styleImage: style } : {}),
        controlnetStrength: typeof options.input.controlnet_strength === 'number' ? options.input.controlnet_strength : 0.75,
        controlnetEnd: typeof options.input.controlnet_end === 'number' ? options.input.controlnet_end : 0.85,
        styleStrength: typeof options.input.style_strength === 'number' ? options.input.style_strength : 0.45,
        styleEnd: typeof options.input.style_end === 'number' ? options.input.style_end : 0.8,
        steps: clampInt(options.input.guided_steps, 1, 100, 26),
        cfg: typeof options.input.guided_cfg === 'number' ? options.input.guided_cfg : 7,
        width: 1024,
        height: 1024,
        filenamePrefix: `item_studio/${slug(entry.id)}/${slug(variant.id)}_guided`
    });
    const entryHistory = await runComfy(options.client, workflow, `Guided ${entry.id}/${variant.id}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal);
    const destination = path.join(options.outputDir, 'raw', `${slug(entry.id)}_${slug(variant.id)}_guided.png`);
    return {
        path: await downloadFirstPng(options.client, entryHistory, destination, options.signal),
        generator: 'guided',
        model: options.checkpoint,
        steps: clampInt(options.input.guided_steps, 1, 100, 26),
        cfg: typeof options.input.guided_cfg === 'number' ? options.input.guided_cfg : 7,
        guide: guidePath,
        ...(stylePath ? { styleReference: stylePath } : {})
    };
}
async function generateRaw(options, entry, variant, generator, prompt, negative, seed) {
    if (generator === 'flux2')
        return generateFlux2Raw(options, entry, variant, prompt, seed);
    if (generator === 'guided')
        return generateGuidedRaw(options, entry, variant, prompt, negative, seed);
    return {
        path: await generateSimpleRaw(options, entry, variant, prompt, negative, seed),
        generator: 'simple',
        model: options.checkpoint
    };
}
async function keyCutout(rawPath, destination, keyColour) {
    void keyColour;
    const decoded = decodePng(readFileBytes(rawPath, 'raw_path'));
    const actualBorder = borderColour(decoded.rgba, decoded.width, decoded.height);
    const result = removeKeyBackground(decoded.rgba, decoded.width, decoded.height, actualBorder, 64);
    if (result.removed < 0.02)
        return { removed: result.removed };
    ensureDir(path.dirname(destination));
    writeFileSync(destination, encodePng(decoded.width, decoded.height, result.rgba));
    return { removed: result.removed, path: destination };
}
async function cutoutRaw(options, rawPath, id, variant, rmbgModel, tall = false, destination) {
    const bytes = readFileBytes(rawPath, 'raw_path');
    const uploaded = await options.client.uploadFile({
        filename: `${slug(id)}_${slug(variant)}_raw.png`,
        bytes,
        mime: 'image/png',
        subfolder: `item_studio/${slug(id)}`,
        overwrite: true
    }, options.signal);
    const remote = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    const workflow = substitute(loadTemplate('cutout_birefnet.template.json'), {
        input_image: remote,
        prompt: '',
        negative_prompt: '',
        seed: 0,
        width: 1024,
        height: 1024
    });
    // Keep a tall render tall; the stock cutout template assumes a square image.
    for (const node of Object.values(workflow)) {
        if (!node || typeof node !== 'object')
            continue;
        const record = node;
        if (record.class_type === 'ImageScale' && record.inputs) {
            record.inputs.width = 1024;
            record.inputs.height = tall ? 2048 : 1024;
        }
    }
    setSavePrefix(workflow, `item_studio/${slug(id)}/${slug(variant)}_cutout`);
    for (const node of Object.values(workflow)) {
        if (node && typeof node === 'object' && node.class_type === 'LoadImage') {
            const inputs = node.inputs;
            if (inputs)
                inputs.image = remote;
            break;
        }
        // Also handle the template's LoadImage nested in the normal node shape.
    }
    const history = await runComfy(options.client, workflow, `Cutout ${id}/${variant}`, options.jobTimeoutMs, options.pollIntervalMs, options.signal);
    const target = destination ?? path.join(options.outputDir, 'cutout', `${slug(id)}_${slug(variant)}.png`);
    return downloadFirstPng(options.client, history, target, options.signal);
}
function writeArtifact(options, entry, variant, raw, cutout, seed, started, meta) {
    const target = targetFor(entry.size);
    const fill = FAMILY_FILL[entry.family] ?? 0.8;
    const result = finalize(cutout, target, fill, options.outline, meta.palette ? options.palette : undefined);
    const spritePath = path.join(options.outputDir, 'sprites', `${slug(entry.id)}_${slug(variant.id)}.png`);
    const iconPath = path.join(options.outputDir, 'icons', `${slug(entry.id)}_${slug(variant.id)}.png`);
    ensureDir(path.dirname(spritePath));
    ensureDir(path.dirname(iconPath));
    writeFileSync(spritePath, encodePng(result.sprite.width, result.sprite.height, result.sprite.rgba));
    writeFileSync(iconPath, encodePng(result.icon.width, result.icon.height, result.icon.rgba));
    return {
        id: entry.id,
        variant: variant.id,
        size: entry.size,
        seed,
        raw,
        cutout,
        sprite: spritePath,
        icon: iconPath,
        width: result.sprite.width,
        height: result.sprite.height,
        seconds: Math.round((Date.now() - started) / 10) / 100,
        generator: meta.generator,
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.steps !== undefined ? { steps: meta.steps } : {}),
        ...(meta.cfg !== undefined ? { cfg: meta.cfg } : {}),
        finish: meta.finish,
        ...(meta.guide ? { guide: meta.guide } : {}),
        ...(meta.styleReference ? { style_reference: meta.styleReference } : {}),
        palette: meta.palette
    };
}
async function generateItem(options, entry, variant, negative, seed, promptOverride) {
    const started = Date.now();
    const generator = chooseGenerator(options.requestedGenerator, entry, options.flux2, options.guided, options.warnings);
    const prompt = promptOverride ??
        `${entry.prompt}, ${variant.prompt_suffix}, one single object only, no other items, no characters, no grid, no collage, no beige background, bold readable silhouette, thick outline` +
            (generator === 'flux2' ? ', huge exaggerated game item, bold chunky shape, thick outline' : '');
    const suffix = generator === 'simple' ? '' : `_${generator}`;
    let rawPath = path.join(options.outputDir, 'raw', `${slug(entry.id)}_${slug(variant.id)}${suffix}.png`);
    const cutoutPath = path.join(options.outputDir, 'cutout', `${slug(entry.id)}_${slug(variant.id)}${suffix}.png`);
    let model = options.checkpoint;
    let steps;
    let cfg;
    let guide;
    let styleReference;
    if (options.force || !existsSync(rawPath)) {
        const rawResult = await generateRaw(options, entry, variant, generator, prompt, negative, seed);
        rawPath = rawResult.path;
        model = rawResult.model;
        steps = rawResult.steps;
        cfg = rawResult.cfg;
        guide = rawResult.guide;
        styleReference = rawResult.styleReference;
    }
    else {
        if (generator === 'flux2') {
            model = options.flux2.model;
            steps = options.flux2.steps;
            cfg = options.flux2.cfg;
        }
        else if (generator === 'guided') {
            steps = clampInt(options.input.guided_steps, 1, 100, 26);
            cfg = typeof options.input.guided_cfg === 'number' ? options.input.guided_cfg : 7;
        }
    }
    let finish = 'birefnet';
    if (options.force || !existsSync(cutoutPath)) {
        if (generator === 'flux2') {
            const key = await keyCutout(rawPath, cutoutPath, entry.key_colour);
            if (key.path) {
                finish = 'key';
            }
            else {
                options.warnings.push(`${entry.id}: key removal removed only ${(key.removed * 100).toFixed(1)}%; using BiRefNet`);
                await cutoutRaw(options, rawPath, entry.id, variant.id, options.rmbgModel, entry.size === 'tall', cutoutPath);
            }
        }
        else {
            await cutoutRaw(options, rawPath, entry.id, variant.id, options.rmbgModel, entry.size === 'tall', cutoutPath);
        }
    }
    return writeArtifact(options, entry, variant, rawPath, cutoutPath, seed, started, {
        generator,
        ...(model ? { model } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(cfg !== undefined ? { cfg } : {}),
        finish,
        ...(guide ? { guide } : {}),
        ...(styleReference ? { styleReference } : {}),
        palette: generator !== 'simple'
    });
}
function customEntry(input, seed) {
    const id = slug(asString(input.name) ?? 'custom');
    return {
        id,
        name: asString(input.name) ?? id,
        category: 'custom',
        group: 'items',
        family: 'custom',
        tier: 0,
        material: 'steel',
        size: asString(input.size) === 'tall' ? 'tall' : 'small',
        anchor: 'bottom_center',
        frame: `item_${id}`,
        icon_frame: `icon_${id}`,
        key_colour: '#00FF00',
        prompt: asString(input.prompt) ?? 'pixel art RPG inventory icon, a single object, centred',
        variants: [{ id: 'base', seed, prompt_suffix: 'plain, well-used, neutral colours' }]
    };
}
export function createItemStudioTool(pluginConfig) {
    return {
        name: ITEM_STUDIO_TOOL_NAME,
        description: [
            'Native Item Studio: the saved 108-item catalogue, prompt/orientation policy, local Flux.2 Klein',
            'preference, guided SDXL fallback, 64/tall sprite finalization and 32 px icons.',
            '',
            'Actions:',
            '  list      browse the bundled catalogue',
            '  generate  one item/variant through auto (local Flux.2 first) or an explicit generator',
            '  cutout    re-cut an existing raw render',
            '  batch     generate selected items/variants and write a candidate manifest',
            '',
            'Generators:',
            '  auto      Flux.2 Klein if local nodes/models are available, then guided SDXL, then simple',
            '  flux2     local Flux.2 Klein 9B FP8 native ComfyUI graph + key/palette finish',
            '  guided    original ControlNet Union + IPAdapter Plus SDXL graph (small items)',
            '  simple    the portable SDXL + pixel-LoRA pack templates',
            '',
            'Nothing is auto-adopted; sprites/icons are candidates for the review gate in ART-DIRECTION.md.',
            'Pass item_id and variant to test one item first.'
        ].join('\n'),
        parameters: ITEM_STUDIO_PARAMETERS_SCHEMA,
        output: {
            schema: ITEM_STUDIO_OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                const first = Array.isArray(result?.items) ? result.items[0] : undefined;
                return { kind: 'item-studio', action: result?.action ?? 'unknown', sprite: first?.sprite ?? '' };
            }
        },
        async execute(args, exec) {
            const started = Date.now();
            const input = (args ?? {});
            const action = asString(input.action) ??
                (asString(input.raw_path) ? 'cutout' : Array.isArray(input.item_ids) || asString(input.variants) === 'all' ? 'batch' : asString(input.item_id) || asString(input.prompt) ? 'generate' : 'list');
            const catalog = catalogFor(asString(input.catalog_path));
            const warnings = [];
            try {
                if (action === 'list') {
                    const query = asString(input.query)?.toLowerCase();
                    const category = asString(input.category)?.toLowerCase();
                    const size = asString(input.size);
                    let rows = catalog.items;
                    if (query) {
                        rows = rows.filter((entry) => `${entry.id} ${entry.name} ${entry.family} ${entry.category}`.toLowerCase().includes(query));
                    }
                    if (category)
                        rows = rows.filter((entry) => entry.category.toLowerCase() === category);
                    if (size)
                        rows = rows.filter((entry) => entry.size === size);
                    const limit = clampLimit(input.limit, 500);
                    rows = rows.slice(0, limit);
                    const text = rows.length
                        ? [`Item Studio catalogue: ${catalog.count} items`, ...rows.map((entry) => `- ${entry.id} · ${entry.family} · ${entry.size} · ${entry.variants.length} variants`)].join('\n')
                        : 'No catalogue items matched.';
                    return { text, success: true, action, count: rows.length, items: rows };
                }
                const cwd = resolveCwd(exec);
                const outputDir = resolveUserPath(asString(input.output_dir) ?? path.join('item_studio'), cwd);
                const config = resolveConfig(pluginConfig);
                const client = new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
                const requestedRaw = asString(input.generator) ?? 'auto';
                if (!['auto', 'flux2', 'guided', 'simple'].includes(requestedRaw)) {
                    throw new ImagePluginError(`Unknown generator ${JSON.stringify(requestedRaw)}.`, 'Use auto, flux2, guided or simple.');
                }
                const requestedGenerator = requestedRaw;
                const needsGeneration = action === 'generate' || action === 'batch';
                const flux2 = needsGeneration && requestedGenerator !== 'simple'
                    ? await probeFlux2(client, input)
                    : { available: false, reason: 'generator=simple' };
                const guided = needsGeneration && requestedGenerator !== 'simple' && requestedGenerator !== 'flux2' && !flux2.available
                    ? await probeGuided(client, input)
                    : needsGeneration && requestedGenerator === 'guided'
                        ? await probeGuided(client, input)
                        : { available: false, reason: 'not probed' };
                if (requestedGenerator === 'flux2' && !flux2.available) {
                    throw new ImagePluginError('Flux.2 was requested but is unavailable.', flux2.reason);
                }
                if (requestedGenerator === 'guided' && !guided.available) {
                    throw new ImagePluginError('Guided SDXL was requested but is unavailable.', guided.reason);
                }
                if (requestedGenerator === 'auto' && !flux2.available) {
                    if (flux2.reason && !warnings.includes(flux2.reason))
                        warnings.push(flux2.reason);
                }
                const options = {
                    cwd,
                    outputDir,
                    client,
                    config,
                    checkpoint: asString(input.checkpoint) ?? 'sd_xl_base_1.0.safetensors',
                    lora: asString(input.lora) ?? 'pixel-art-xl.safetensors',
                    rmbgModel: asString(input.rmbg_model) ?? 'BiRefNet_lite-matting',
                    outline: asBool(input.outline, false),
                    force: asBool(input.force, false),
                    ...(exec?.signal ? { signal: exec.signal } : {}),
                    jobTimeoutMs: clampInt(input.job_timeout_ms, 60_000, 3_600_000, Math.max(config.timeoutMs, 600_000)),
                    pollIntervalMs: config.pollIntervalMs,
                    requestedGenerator,
                    flux2,
                    guided,
                    palette: loadPalette(),
                    uploads: new Map(),
                    input,
                    warnings
                };
                if (action === 'cutout') {
                    const rawPath = asString(input.raw_path);
                    if (!rawPath)
                        throw new ImagePluginError('action=cutout requires raw_path.');
                    const resolved = resolveUserPath(rawPath, cwd);
                    const legacy = catalog.items.find((entry) => entry.id === asString(input.item_id));
                    const entry = legacy ?? customEntry(input, asInt(input.seed, 0));
                    const variant = legacy ? selectVariant(legacy, asString(input.variant)) : entry.variants[0];
                    const cutout = await cutoutRaw(options, resolved, entry.id, variant.id, options.rmbgModel, entry.size === 'tall');
                    const artifact = writeArtifact(options, entry, variant, resolved, cutout, asInt(input.seed, variant.seed), started, {
                        generator: 'cutout', finish: 'birefnet', palette: false
                    });
                    return {
                        text: `✅ Cutout and finalized ${entry.id}/${variant.id}\n\nSprite: ${artifact.sprite}\nIcon: ${artifact.icon}`,
                        success: true,
                        action,
                        count: 1,
                        items: [artifact],
                        warnings
                    };
                }
                if (action === 'batch') {
                    let rows = catalog.items;
                    if (Array.isArray(input.item_ids) && input.item_ids.length > 0) {
                        const wanted = new Set(input.item_ids.map(String));
                        rows = rows.filter((entry) => wanted.has(entry.id));
                    }
                    const variantMode = asString(input.variants) === 'all' ? 'all' : 'base';
                    const limit = clampLimit(input.limit, rows.length);
                    rows = rows.slice(0, limit);
                    if (rows.length === 0)
                        throw new ImagePluginError('No catalogue items selected.');
                    const manifestPath = path.join(outputDir, 'candidates.json');
                    ensureDir(outputDir);
                    const artifacts = [];
                    let failed = 0;
                    for (const entry of rows) {
                        const variants = variantMode === 'all' ? entry.variants : [selectVariant(entry, 'base')];
                        for (const variant of variants) {
                            try {
                                const artifact = await generateItem(options, entry, variant, asString(input.negative_prompt) ?? DEFAULT_NEGATIVE, asInt(input.seed, variant.seed), asString(input.prompt));
                                artifacts.push(artifact);
                            }
                            catch (error) {
                                failed += 1;
                                warnings.push(`${entry.id}/${variant.id}: ${formatError(error)}`);
                            }
                        }
                    }
                    writeFileSync(manifestPath, `${JSON.stringify({ generated_at: new Date().toISOString(), catalog: catalog.count, items: artifacts, warnings }, null, 1)}\n`);
                    return {
                        text: `Item Studio batch: ${artifacts.length} artifacts, ${failed} failed\n\nManifest: ${manifestPath}`,
                        success: artifacts.length > 0,
                        action,
                        count: artifacts.length,
                        items: artifacts,
                        manifest: manifestPath,
                        warnings,
                        seconds: Math.round((Date.now() - started) / 10) / 100
                    };
                }
                if (action !== 'generate') {
                    return { text: `Unknown action: ${action}.`, success: false, action, warnings };
                }
                const itemId = asString(input.item_id);
                let entry;
                let variant;
                if (itemId) {
                    const found = catalog.items.find((row) => row.id === itemId);
                    if (!found)
                        throw new ImagePluginError(`No catalogue item ${JSON.stringify(itemId)}.`, 'Use action=list to browse ids.');
                    entry = found;
                    variant = selectVariant(found, asString(input.variant));
                }
                else {
                    const seed = asInt(input.seed, 1000);
                    entry = customEntry(input, seed);
                    variant = entry.variants[0];
                }
                const artifact = await generateItem(options, entry, variant, asString(input.negative_prompt) ?? DEFAULT_NEGATIVE, asInt(input.seed, variant.seed), asString(input.prompt));
                const manifestPath = path.join(outputDir, 'manifest.json');
                writeFileSync(manifestPath, `${JSON.stringify({ generated_at: new Date().toISOString(), items: [artifact], warnings }, null, 1)}\n`);
                return {
                    text: `✅ Item Studio ${entry.id}/${variant.id} via ${artifact.generator ?? 'unknown'}\n\nRaw: ${artifact.raw}\nCutout: ${artifact.cutout}\nSprite: ${artifact.sprite}\nIcon: ${artifact.icon}\nSize: ${artifact.width}×${artifact.height}`,
                    success: true,
                    action,
                    count: 1,
                    items: [artifact],
                    manifest: manifestPath,
                    warnings,
                    seconds: Math.round((Date.now() - started) / 10) / 100
                };
            }
            catch (error) {
                return {
                    text: `❌ Item Studio failed\n\n${formatError(error)}`,
                    success: false,
                    action,
                    ...(warnings.length ? { warnings } : {})
                };
            }
        }
    };
}
function clampLimit(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.min(500, Math.round(value));
}
export const ITEM_STUDIO_DESCRIPTION = 'Native Item Studio catalogue, generation, cutout, sprite and icon pipeline.';
