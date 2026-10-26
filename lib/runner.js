/**
 * Execution engine: runs one `generate_image` call from start to finish.
 *
 * Flow (every step throws an ImagePluginError carrying advice):
 *   normalize arguments → probe capabilities → upload inputs → build workflow → submit → poll →
 *   fetch image → write to disk → write the metadata sidecar
 *
 * Deliberately separate from tool.ts:
 *   - tool.ts owns only the "public contract" (schema / description / render), which must stay stable;
 *   - runner.ts owns "how to run it"; adding outpaint / upscale / multiple backends happens here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extensionOf, guessImageMime, humanBytes, imageSizeOf, isFile, planOutputFile, readImageBytes } from './files.js';
import { ImagePluginError } from './errors.js';
import { logDebug } from './log.js';
import { PLUGIN_ID } from './identity.js';
import { applyModelAwareSize, normalizeRequest } from './params.js';
import { ComfyUIClient, describeHistoryError } from './comfy/client.js';
import { chooseCheckpoint, chooseRembgPlan, chooseSampler } from './comfy/nodes.js';
import { applyCustomWorkflow, buildWorkflow, filenamePrefixFor } from './comfy/workflows.js';
/** Plugin version (written into metadata, to make later troubleshooting easier). */
export const PLUGIN_VERSION = '0.6.0';
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        function cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
        function onAbort() {
            cleanup();
            reject(new ImagePluginError('Cancelled: the caller aborted this generation.', 'The job on the ComfyUI side may still finish.'));
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort);
    });
}
/** Find the produced image in the history: prefer the expected node, otherwise scan all of them. */
export function pickImageRef(entry, preferredNodeId) {
    const outputs = entry.outputs ?? {};
    const preferred = preferredNodeId ? outputs[preferredNodeId] : undefined;
    if (preferred?.images && preferred.images.length > 0) {
        return preferred.images[preferred.images.length - 1];
    }
    for (const [nodeId, node] of Object.entries(outputs)) {
        if (node.images && node.images.length > 0) {
            logDebug(`Produced image came from node ${nodeId} (not the expected ${preferredNodeId ?? 'unspecified'})`);
            return node.images[node.images.length - 1];
        }
    }
    return undefined;
}
/** Replace the planned output path with one carrying the correct extension (ComfyUI usually gives .png). */
function withCorrectExtension(filePath, extension) {
    const currentExt = path.extname(filePath);
    if (currentExt.toLowerCase() === extension.toLowerCase())
        return filePath;
    return filePath.slice(0, filePath.length - currentExt.length) + extension;
}
/** Read a custom workflow template file and return the parsed object (the escape hatch). */
function readCustomWorkflowFile(templatePath, cwd) {
    const resolved = path.isAbsolute(templatePath) ? templatePath : path.resolve(cwd, templatePath);
    if (!isFile(resolved)) {
        throw new ImagePluginError(`extra_options.workflow_path points to a file that does not exist: ${resolved}`, 'Provide the path to an API-format workflow JSON (exported with "Save (API Format)" in the ComfyUI UI).');
    }
    try {
        return { resolved, parsed: JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '')) };
    }
    catch (error) {
        throw new ImagePluginError(`The custom workflow is not valid JSON: ${resolved}`, error instanceof Error ? error.message : String(error));
    }
}
/** Substitute placeholders to obtain a submittable workflow (the escape hatch). */
function applyCustomWorkflowTemplate(options) {
    const { template, templatePath, request } = options;
    const values = {
        prompt: request.prompt,
        negative_prompt: request.negativePrompt,
        width: request.width,
        height: request.height,
        seed: request.seed,
        steps: request.steps,
        cfg_scale: request.cfgScale,
        strength: request.strength,
        checkpoint: options.checkpoint,
        mode: request.mode
    };
    if (options.uploadedInput)
        values.input_image = options.uploadedInput;
    if (options.uploadedMask)
        values.mask_image = options.uploadedMask;
    logDebug('Using a custom workflow', { template: templatePath, values: Object.keys(values) });
    return applyCustomWorkflow(template, values);
}
/** The main flow. */
export async function runGeneration(options) {
    const { args, cwd, config, signal } = options;
    const startedAt = Date.now();
    // ── 1. Normalize arguments (mode inference, defaults, conflict checks) ──
    const { request, modeInferred } = normalizeRequest(args, { cwd, config });
    const notes = [...request.notes];
    logDebug('Normalized request', {
        mode: request.mode,
        seed: request.seed,
        size: `${request.width}x${request.height}`,
        output: request.outputPath
    });
    const client = options.client ?? new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
    // Health check first: no point wasting time if it cannot connect.
    await client.systemStats(signal);
    // Escape hatch: the API-format workflow pointed at by extra_options.workflow_path. Read it once and reuse it for placeholder detection and building.
    const customTemplatePath = typeof request.extra.workflow_path === 'string' && request.extra.workflow_path.trim() !== ''
        ? request.extra.workflow_path.trim()
        : undefined;
    const customTemplate = customTemplatePath ? readCustomWorkflowFile(customTemplatePath, cwd) : undefined;
    const customTemplateText = customTemplate ? JSON.stringify(customTemplate.parsed) : undefined;
    // ── 2. Capability probing (a custom workflow only probes what it actually uses) ──
    const needsGeneration = request.mode !== 'remove_background';
    let checkpoint = request.checkpoint;
    if (needsGeneration) {
        const templateNeedsCheckpoint = customTemplateText?.includes('{{checkpoint}}') ?? false;
        if (!customTemplate || templateNeedsCheckpoint) {
            const choice = await chooseCheckpoint(client, request.checkpoint, signal);
            checkpoint = choice.checkpoint;
            if (!request.checkpoint) {
                notes.push(`Checkpoint chosen automatically: ${checkpoint} (${choice.available.length} available on this machine; use the model argument to specify one).`);
            }
        }
    }
    // The default size can only be decided once the checkpoint is known: when the user passed no model
    // and the config has no checkpoint, the parameter layer only had the config default at that moment.
    // Adapt once more here for the final checkpoint (which may have just been auto-picked).
    applyModelAwareSize(request, checkpoint, config, notes);
    let samplerName = request.samplerName;
    let scheduler = request.scheduler;
    if (needsGeneration && !customTemplate) {
        const sampler = await chooseSampler(client, request, config, signal);
        samplerName = sampler.samplerName;
        scheduler = sampler.scheduler;
        notes.push(...sampler.notes);
    }
    let rembg;
    if (request.mode === 'remove_background' && !customTemplate) {
        rembg = await chooseRembgPlan(client, config.rembgNode, signal);
        notes.push(`Background removal plan: ${rembg.label}`);
    }
    // ── 3. Upload the input image / mask ──
    // The parameter layer already guarantees: only img2img / inpaint / remove_background have inputImage,
    // and only inpaint has maskImage, so there is no need to check by mode again here.
    let uploadedInput;
    let uploadedMask;
    const uploadIfNeeded = async (filePath, kind) => {
        const bytes = readImageBytes(filePath, kind);
        const result = await client.uploadImage({ filename: path.basename(filePath), bytes, mime: guessImageMime(filePath) }, signal);
        logDebug(`Uploaded ${kind}`, { local: filePath, comfy: result });
        return result;
    };
    if (request.inputImage) {
        uploadedInput = (await uploadIfNeeded(request.inputImage, 'input_image')).name;
    }
    if (request.maskImage) {
        uploadedMask = (await uploadIfNeeded(request.maskImage, 'mask_image')).name;
    }
    // ── 4. Build the workflow ──
    const filenamePrefix = filenamePrefixFor(request);
    let built;
    if (customTemplate) {
        const custom = applyCustomWorkflowTemplate({
            template: customTemplate.parsed,
            templatePath: customTemplate.resolved,
            request,
            checkpoint,
            ...(uploadedInput ? { uploadedInput } : {}),
            ...(uploadedMask ? { uploadedMask } : {})
        });
        // We do not know the custom workflow's output node, so leave it empty and let pickImageRef scan everything.
        built = { workflow: custom, mode: request.mode, outputNodeId: '' };
        notes.push('This run used the custom workflow specified by extra_options.workflow_path.');
    }
    else {
        built = buildWorkflow({
            request,
            config,
            checkpoint,
            samplerName,
            scheduler,
            filenamePrefix,
            ...(uploadedInput ? { uploadedInput } : {}),
            ...(uploadedMask ? { uploadedMask } : {}),
            ...(rembg ? { rembg } : {})
        });
    }
    // ── 5. Submit ──
    const clientId = `${PLUGIN_ID}-${Date.now().toString(36)}`;
    const { promptId } = await client.queuePrompt(built.workflow, clientId, signal);
    // ── 6. Poll until there is a result (or timeout / error / cancellation) ──
    const deadline = Date.now() + config.timeoutMs;
    let entry;
    for (;;) {
        if (signal?.aborted) {
            throw new ImagePluginError('Cancelled: the caller aborted this generation.', 'The job on the ComfyUI side may still finish.');
        }
        if (Date.now() > deadline) {
            // Timed out: cancel on a best-effort basis so it does not keep occupying VRAM.
            await client.interrupt(signal);
            throw new ImagePluginError(`Timed out waiting for ComfyUI to produce an image (waited ${Math.round(config.timeoutMs / 1000)} s, prompt_id=${promptId}).`, `Tried to cancel the job. Check whether ComfyUI is stuck or busy running other queued jobs; you can also increase timeoutMs in ~/.${PLUGIN_ID}/config.json.`);
        }
        entry = await client.historyEntry(promptId, signal);
        if (entry)
            break;
        await sleep(config.pollIntervalMs, signal);
    }
    const statusStr = entry.status?.status_str;
    if (statusStr === 'error' || statusStr === 'cancelled') {
        throw describeHistoryError(entry, promptId);
    }
    const comfyImage = pickImageRef(entry, built.outputNodeId);
    if (!comfyImage) {
        // Reaching here means the job reported no error, yet the history has no image output.
        // That is different from "execution failed", and must not be described as "no more details".
        throw new ImagePluginError(`ComfyUI reports the job finished (status ${statusStr ?? 'unknown'}) but produced no images (prompt_id=${promptId}).`, 'The most common cause is a workflow that does not end in a SaveImage / PreviewImage node — this happens ' +
            'easily with a custom workflow passed via extra_options.workflow_path. The workflow might also only ' +
            'output non-image results such as mask / latent. ' +
            `Open ${config.baseUrl} and find this prompt_id in the queue to inspect the graph.`);
    }
    // ── 7. Fetch the image and write it to disk ──
    const bytes = await client.viewImage(comfyImage, signal);
    // Report the size from the **produced bytes**: the img2img / inpaint canvas follows the input image,
    // so the requested values do not apply (on a real machine a 512×512 input produced a 512 image
    // while the report said 1024). Writing back into request keeps metadata and return values
    // (formatResult reads request) consistent automatically.
    const actualSize = imageSizeOf(bytes);
    if (actualSize && (actualSize.width !== request.width || actualSize.height !== request.height)) {
        notes.push(request.mode === 'text2img'
            ? `Output size is ${actualSize.width}x${actualSize.height}, different from the requested ${request.width}x${request.height}.`
            : `Output size is ${actualSize.width}x${actualSize.height} (the canvas for ${request.mode} is determined by the input image; the requested ${request.width}x${request.height} does not apply).`);
        request.width = actualSize.width;
        request.height = actualSize.height;
    }
    const extension = extensionOf(comfyImage.filename, '.png');
    const finalFile = planOutputFile(withCorrectExtension(request.outputPath, extension), cwd, extension);
    fs.writeFileSync(finalFile.filePath, bytes);
    logDebug(`Wrote ${finalFile.filePath} (${humanBytes(bytes.length)})`);
    const durationMs = Date.now() - startedAt;
    // ── 8. Metadata sidecar (reproducible / groundwork for consistency later) ──
    let metadataPath;
    if (config.writeMetadata) {
        metadataPath = `${finalFile.filePath}.json`;
        const metadata = {
            plugin: PLUGIN_ID,
            pluginVersion: PLUGIN_VERSION,
            createdAt: new Date().toISOString(),
            mode: request.mode,
            modeInferred,
            prompt: request.prompt,
            negativePrompt: request.negativePrompt,
            seed: request.seed,
            width: request.width,
            height: request.height,
            steps: request.steps,
            cfgScale: request.cfgScale,
            strength: request.strength,
            checkpoint,
            samplerName,
            scheduler,
            /** Reserved consistency fields: V1 only records them, they do not affect generation. */
            styleReference: request.styleReference,
            characterReference: request.characterReference,
            inputs: { inputImage: request.inputImage, maskImage: request.maskImage },
            comfy: { url: config.baseUrl, promptId, image: comfyImage, filenamePrefix, rembg: rembg?.label },
            durationMs,
            outputFile: finalFile.filePath,
            notes,
            extra: request.extra,
            workflow: built.workflow
        };
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    }
    return {
        request,
        mode: request.mode,
        modeInferred,
        outputPaths: [finalFile.filePath],
        ...(metadataPath ? { metadataPath } : {}),
        comfyImage,
        promptId,
        comfyUrl: config.baseUrl,
        durationMs,
        checkpoint,
        samplerName,
        scheduler,
        ...(rembg ? { rembgLabel: rembg.label } : {}),
        notes,
        workflow: built.workflow
    };
}
