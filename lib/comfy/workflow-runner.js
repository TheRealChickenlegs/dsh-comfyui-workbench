/**
 * Arbitrary ComfyUI workflow support: validate a workflow against the live node catalogue, submit it,
 * wait for completion, and save every produced file.
 *
 * The high-level generate_image tool builds one of four known workflows. This module exists so the
 * Agent can use *any* node ComfyUI has installed, including custom nodes, by authoring the API-format
 * workflow itself and validating it before submission.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImagePluginError } from '../errors.js';
import { logDebug } from '../log.js';
import { declaredInputs, enumChoices, requiredInputs, specDefault } from './nodes.js';
import { ensureDir, isFile, resolveUserPath, timestampSlug, uniqueFilePath } from '../files.js';
import { PLUGIN_VERSION } from '../runner.js';
function isLink(value) {
    return (Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'string' &&
        typeof value[1] === 'number' &&
        Number.isInteger(value[1]) &&
        value[1] >= 0);
}
function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i += 1)
        matrix[i][0] = i;
    for (let j = 0; j < cols; j += 1)
        matrix[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
        }
    }
    return matrix[a.length][b.length];
}
function closest(value, candidates, count = 3) {
    const lower = value.toLowerCase();
    const scored = candidates.map((candidate) => ({
        candidate,
        score: candidate.toLowerCase() === lower ? 0 : levenshtein(value.toLowerCase(), candidate.toLowerCase())
    }));
    scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
    const limit = Math.max(2, Math.ceil(value.length / 3));
    return scored
        .filter((entry) => entry.score <= limit)
        .slice(0, count)
        .map((entry) => entry.candidate);
}
function suggestionText(candidates) {
    return candidates.length > 0 ? `Did you mean: ${candidates.join(', ')}?` : undefined;
}
function specMeta(spec) {
    if (!Array.isArray(spec) || !spec[1] || typeof spec[1] !== 'object')
        return {};
    return spec[1];
}
/**
 * Validate a workflow locally, before ComfyUI sees it.
 *
 * Catches the mistakes that otherwise produce opaque HTTP 400 responses: unknown node types, unknown
 * input names, missing required inputs, dangling links, wrong enum values, and out-of-range numbers.
 */
export function validateWorkflow(workflow, options) {
    const errors = [];
    const warnings = [];
    const objectInfo = options.objectInfo;
    const strictEnums = options.strictEnums !== false;
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
        return {
            valid: false,
            errors: [{ message: 'The workflow must be a JSON object mapping node ids to { class_type, inputs }.' }],
            warnings,
            node_count: 0,
            output_node_count: 0,
            class_types: []
        };
    }
    const nodes = workflow;
    const nodeIds = Object.keys(nodes);
    if (nodeIds.length === 0) {
        errors.push({ message: 'The workflow is empty; add at least one node.' });
    }
    const classTypes = [];
    let outputNodeCount = 0;
    for (const nodeId of nodeIds) {
        const node = nodes[nodeId];
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            errors.push({ node_id: nodeId, message: 'Node must be an object with class_type and inputs.' });
            continue;
        }
        const nodeObject = node;
        const classType = typeof nodeObject.class_type === 'string' ? nodeObject.class_type : '';
        if (!classType) {
            errors.push({ node_id: nodeId, message: 'Node is missing a string class_type.' });
            continue;
        }
        classTypes.push(classType);
        const info = objectInfo[classType];
        if (!info) {
            errors.push({
                node_id: nodeId,
                node_type: classType,
                message: `Unknown node type "${classType}" (not in ComfyUI's object_info).`,
                suggestion: suggestionText(closest(classType, Object.keys(objectInfo)))
            });
            continue;
        }
        if (info.output_node)
            outputNodeCount += 1;
        if (!nodeObject.inputs || typeof nodeObject.inputs !== 'object' || Array.isArray(nodeObject.inputs)) {
            errors.push({
                node_id: nodeId,
                node_type: classType,
                message: 'Node is missing an inputs object.'
            });
            continue;
        }
        const inputs = nodeObject.inputs;
        const required = requiredInputs(info);
        const declared = declaredInputs(info);
        for (const inputName of Object.keys(inputs)) {
            if (inputName in declared)
                continue;
            errors.push({
                node_id: nodeId,
                node_type: classType,
                input: inputName,
                message: `Unknown input "${inputName}" on node ${classType}.`,
                suggestion: suggestionText(closest(inputName, Object.keys(declared)))
            });
        }
        for (const [inputName, value] of Object.entries(inputs)) {
            if (!(inputName in declared))
                continue;
            if (isLink(value)) {
                const [targetId, slot] = value;
                const target = nodes[targetId];
                if (!target || typeof target !== 'object' || Array.isArray(target)) {
                    errors.push({
                        node_id: nodeId,
                        node_type: classType,
                        input: inputName,
                        message: `Input "${inputName}" links to node "${targetId}", which does not exist in this workflow.`
                    });
                    continue;
                }
                const targetType = target.class_type;
                const targetInfo = typeof targetType === 'string' ? objectInfo[targetType] : undefined;
                if (targetInfo && Array.isArray(targetInfo.output) && slot >= targetInfo.output.length) {
                    errors.push({
                        node_id: nodeId,
                        node_type: classType,
                        input: inputName,
                        message: `Input "${inputName}" reads output ${slot} of node "${targetId}" (${String(targetType)}), but that node has only ${targetInfo.output.length} output(s).`
                    });
                }
                continue;
            }
            const spec = declared[inputName];
            const choices = enumChoices(spec);
            if (choices && typeof value === 'string' && strictEnums && !choices.includes(value)) {
                errors.push({
                    node_id: nodeId,
                    node_type: classType,
                    input: inputName,
                    message: `Input "${inputName}" does not accept ${JSON.stringify(value)}.`,
                    suggestion: suggestionText(closest(value, choices))
                });
            }
            const meta = specMeta(spec);
            const min = typeof meta.min === 'number' ? meta.min : undefined;
            const max = typeof meta.max === 'number' ? meta.max : undefined;
            if (typeof value === 'number' && Number.isFinite(value)) {
                if (min !== undefined && value < min) {
                    errors.push({
                        node_id: nodeId,
                        node_type: classType,
                        input: inputName,
                        message: `Input "${inputName}" is below the minimum ${min} (received ${value}).`
                    });
                }
                if (max !== undefined && value > max) {
                    errors.push({
                        node_id: nodeId,
                        node_type: classType,
                        input: inputName,
                        message: `Input "${inputName}" is above the maximum ${max} (received ${value}).`
                    });
                }
            }
        }
        for (const [inputName, spec] of Object.entries(required)) {
            if (inputName in inputs)
                continue;
            const choices = enumChoices(spec);
            const fallback = specDefault(spec) ?? choices?.[0];
            errors.push({
                node_id: nodeId,
                node_type: classType,
                input: inputName,
                message: `Missing required input "${inputName}".` +
                    (fallback !== undefined ? ` A default exists (${JSON.stringify(fallback)}), but API workflows should provide it explicitly.` : '')
            });
        }
    }
    if (outputNodeCount === 0 && nodeIds.length > 0) {
        warnings.push({
            message: 'No output node (SaveImage, PreviewImage, SaveAudio, ...) was found. The workflow may run but produce nothing downloadable.'
        });
    }
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        node_count: nodeIds.length,
        output_node_count: outputNodeCount,
        class_types: classTypes
    };
}
/** Render validation issues as text. */
export function formatValidation(validation) {
    const lines = [
        validation.valid
            ? `Workflow is valid (${validation.node_count} node(s), ${validation.output_node_count} output node(s)).`
            : `Workflow has ${validation.errors.length} error(s) and ${validation.warnings.length} warning(s).`
    ];
    if (validation.class_types.length > 0)
        lines.push(`Node types: ${validation.class_types.join(', ')}`);
    for (const issue of validation.errors) {
        const where = issue.node_id ? ` [node ${issue.node_id}${issue.node_type ? ` ${issue.node_type}` : ''}${issue.input ? `.${issue.input}` : ''}]` : '';
        lines.push(`  ERROR${where}: ${issue.message}`);
        if (issue.suggestion)
            lines.push(`         ${issue.suggestion}`);
    }
    for (const issue of validation.warnings) {
        const where = issue.node_id ? ` [node ${issue.node_id}${issue.node_type ? ` ${issue.node_type}` : ''}]` : '';
        lines.push(`  WARN${where}: ${issue.message}`);
        if (issue.suggestion)
            lines.push(`        ${issue.suggestion}`);
    }
    return lines.join('\n');
}
/** Load a workflow from an inline object or a local JSON file. */
export function loadWorkflow(input) {
    const hasInline = input.workflow !== undefined && input.workflow !== null;
    const hasPath = typeof input.workflowPath === 'string' && input.workflowPath.trim() !== '';
    if (hasInline && hasPath) {
        throw new ImagePluginError('Provide either workflow or workflow_path, not both.', 'Use workflow for an inline API-format object, or workflow_path for a local JSON file.');
    }
    if (!hasInline && !hasPath) {
        throw new ImagePluginError('No workflow was provided.', 'Pass workflow (an API-format object) or workflow_path (a local JSON file); use comfyui_inspect to discover nodes and models first.');
    }
    if (hasPath) {
        const resolved = resolveUserPath(String(input.workflowPath).trim(), input.cwd);
        if (!isFile(resolved)) {
            throw new ImagePluginError(`workflow_path points to a file that does not exist: ${resolved}`, 'Export the workflow from ComfyUI with "Save (API Format)" and pass its path.');
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
        }
        catch (error) {
            throw new ImagePluginError(`workflow_path is not valid JSON: ${resolved}`, error instanceof Error ? error.message : String(error));
        }
        return { workflow: parsed, source: 'file', path: resolved };
    }
    if (!input.workflow || typeof input.workflow !== 'object' || Array.isArray(input.workflow)) {
        throw new ImagePluginError('workflow must be a JSON object mapping node ids to { class_type, inputs }.', 'Use the API format exported by ComfyUI, not the UI-format workflow.');
    }
    return { workflow: input.workflow, source: 'inline' };
}
/* ────────────────────────────── execution ────────────────────────────── */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(new ImagePluginError('Cancelled: the caller aborted waiting for the workflow.'));
        };
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
/** Wait for a prompt to appear in history, or throw a timeout error. */
export async function waitForPrompt(client, promptId, options) {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        if (options.signal?.aborted) {
            throw new ImagePluginError('Cancelled: the caller aborted waiting for the workflow.');
        }
        const entry = await client.historyEntry(promptId, options.signal);
        if (entry)
            return entry;
        if (Date.now() > deadline) {
            throw new ImagePluginError(`Timed out waiting for prompt ${promptId} after ${Math.round(options.timeoutMs / 1000)} s.`, 'The job may still be running. Check comfyui_inspect scope=queue or scope=history, or call comfyui_workflow action=wait with a larger timeout_ms.');
        }
        await sleep(options.pollIntervalMs, options.signal);
    }
}
/** Extract execution errors from a history entry without throwing. */
export function historyIssues(entry) {
    const issues = [];
    for (const message of entry.status?.messages ?? []) {
        if (!Array.isArray(message) || message.length < 2)
            continue;
        const [kind, payload] = message;
        if (kind === 'execution_error' && payload && typeof payload === 'object') {
            const info = payload;
            issues.push({
                ...(info.node_id !== undefined ? { node_id: String(info.node_id) } : {}),
                ...(info.node_type !== undefined ? { node_type: String(info.node_type) } : {}),
                message: `${info.exception_type ? `${String(info.exception_type)}: ` : ''}` +
                    `${info.exception_message ? String(info.exception_message) : 'Unknown execution error'}`
            });
        }
        else if (kind === 'execution_interrupted') {
            issues.push({ message: 'Execution was interrupted.' });
        }
    }
    const status = entry.status?.status_str;
    if (issues.length === 0 && (status === 'error' || status === 'cancelled')) {
        issues.push({ message: `ComfyUI reported status "${status}" without a detailed error message.` });
    }
    return issues;
}
function safeFilename(filename, fallback) {
    const base = path.basename(filename).replace(/[^\w.\- ()]+/g, '_').trim();
    return base || fallback;
}
function looksLikeFilePath(outputPath, resolved) {
    if (/[/\\]$/.test(outputPath))
        return false;
    if (path.extname(resolved) === '')
        return false;
    try {
        if (fs.statSync(resolved).isDirectory())
            return false;
    }
    catch {
        /* does not exist yet: extension decides */
    }
    return true;
}
function outputDirectoryFor(outputPath, cwd) {
    if (!outputPath || outputPath.trim() === '')
        return cwd;
    const resolved = resolveUserPath(outputPath.trim(), cwd);
    const directory = looksLikeFilePath(outputPath, resolved) ? path.dirname(resolved) : resolved;
    ensureDir(directory);
    return directory;
}
function countBinaryOutputs(entry) {
    let count = 0;
    for (const output of Object.values(entry.outputs ?? {})) {
        if (!output || typeof output !== 'object')
            continue;
        for (const value of Object.values(output)) {
            if (!Array.isArray(value))
                continue;
            for (const item of value) {
                if (item && typeof item === 'object' && 'filename' in item)
                    count += 1;
            }
        }
    }
    return count;
}
function binaryFallbackExtension(key) {
    if (key === 'images' || key === 'image')
        return '.png';
    if (key === 'gifs' || key === 'gif')
        return '.gif';
    if (key === 'audio')
        return '.wav';
    if (key === 'video')
        return '.mp4';
    return '.bin';
}
/** Save every file and collect every text result described by a completed history entry. */
export async function collectOutputs(client, entry, options) {
    const maxOutputs = Math.max(1, Math.min(100, Math.round(options.maxOutputs ?? 20)));
    const warnings = [];
    const outputs = [];
    const textOutputs = [];
    const files = [];
    const saveOutputs = options.saveOutputs !== false;
    const outputHint = options.outputPath?.trim() ?? '';
    const resolvedHint = outputHint ? resolveUserPath(outputHint, options.cwd) : undefined;
    const binaryCount = countBinaryOutputs(entry);
    const exactFile = resolvedHint && binaryCount === 1 && looksLikeFilePath(outputHint, resolvedHint)
        ? resolvedHint
        : undefined;
    const directory = exactFile ? path.dirname(exactFile) : outputDirectoryFor(options.outputPath, options.cwd);
    ensureDir(directory);
    let usedExactFile = false;
    const stamp = timestampSlug();
    const promptPart = options.promptId.slice(0, 8);
    for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
        if (!output || typeof output !== 'object')
            continue;
        for (const [key, value] of Object.entries(output)) {
            if (!Array.isArray(value)) {
                if (typeof value === 'string' || typeof value === 'number') {
                    textOutputs.push(`${nodeId}.${key}: ${String(value)}`);
                }
                continue;
            }
            for (const item of value) {
                if (item && typeof item === 'object' && 'filename' in item) {
                    const ref = item;
                    const filename = typeof ref.filename === 'string' ? ref.filename : '';
                    if (!filename)
                        continue;
                    if (outputs.length >= maxOutputs) {
                        warnings.push(`Output limit (${maxOutputs}) reached; remaining files were not downloaded.`);
                        break;
                    }
                    const record = {
                        node_id: nodeId,
                        key,
                        filename,
                        subfolder: typeof ref.subfolder === 'string' ? ref.subfolder : '',
                        type: typeof ref.type === 'string' ? ref.type : 'output'
                    };
                    if (!saveOutputs) {
                        outputs.push(record);
                        continue;
                    }
                    try {
                        const bytes = await client.fetchFile({ filename, subfolder: record.subfolder, type: record.type }, options.signal);
                        const extension = path.extname(filename) || binaryFallbackExtension(key);
                        const safe = safeFilename(filename, `output${extension}`);
                        const targetName = `comfyui-wf-${stamp}-${nodeId}-${safe}`;
                        const target = exactFile && !usedExactFile ? uniqueFilePath(exactFile) : uniqueFilePath(path.join(directory, targetName));
                        usedExactFile = true;
                        fs.writeFileSync(target, bytes);
                        record.path = target;
                        record.bytes = bytes.length;
                        files.push(target);
                    }
                    catch (error) {
                        warnings.push(`Could not fetch ${filename} from node ${nodeId}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    outputs.push(record);
                }
                else if (typeof item === 'string' || typeof item === 'number') {
                    textOutputs.push(`${nodeId}.${key}: ${String(item)}`);
                }
            }
        }
    }
    let metadataPath;
    if (options.writeMetadata !== false) {
        const metadata = {
            plugin: 'dsh-comfyui-image',
            pluginVersion: PLUGIN_VERSION,
            kind: 'workflow-run',
            createdAt: new Date().toISOString(),
            promptId: options.promptId,
            status: entry.status?.status_str ?? 'unknown',
            completed: Boolean(entry.status?.completed),
            outputDirectory: directory,
            files,
            outputs,
            textOutputs,
            warnings,
            workflow: options.workflow,
            history: options.history
        };
        const metadataName = `comfyui-workflow-${stamp}-${promptPart}.json`;
        metadataPath = uniqueFilePath(path.join(directory, metadataName));
        fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    }
    return { files, outputs, text_outputs: textOutputs, warnings, ...(metadataPath ? { metadata_path: metadataPath } : {}) };
}
/** Extract the workflow recorded in a history entry (used when waiting on someone else's prompt). */
export function workflowFromHistory(entry) {
    const prompt = entry.prompt;
    if (Array.isArray(prompt) && prompt[2] && typeof prompt[2] === 'object' && !Array.isArray(prompt[2])) {
        return prompt[2];
    }
    return undefined;
}
/** Render a completed workflow run as text. */
export function formatWorkflowRunText(input) {
    const lines = [
        `${input.status === 'success' && input.completed ? '✅' : '⚠️'} Workflow ${input.promptId}: ${input.status}`,
        ''
    ];
    if (input.files.length > 0) {
        lines.push('Files:');
        for (const file of input.files)
            lines.push(`  ${file}`);
    }
    else {
        lines.push('Files: none saved');
    }
    if (input.outputs.length > 0) {
        lines.push('', 'Outputs:');
        for (const output of input.outputs) {
            lines.push(`  - node ${output.node_id} (${output.key}): ${output.subfolder ? `${output.subfolder}/` : ''}${output.filename}`);
        }
    }
    if (input.text_outputs.length > 0) {
        lines.push('', 'Text outputs:');
        for (const text of input.text_outputs.slice(0, 20))
            lines.push(`  - ${text}`);
    }
    if (input.issues && input.issues.length > 0) {
        lines.push('', 'Errors:');
        for (const issue of input.issues) {
            lines.push(`  - ${issue.node_type ? `${issue.node_type}` : 'execution'}${issue.node_id ? ` (node ${issue.node_id})` : ''}: ${issue.message}`);
        }
    }
    if (input.warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of input.warnings)
            lines.push(`  - ${warning}`);
    }
    if (input.metadataPath)
        lines.push('', `Metadata: ${input.metadataPath}`);
    if (input.files.length === 0 && (!input.issues || input.issues.length === 0)) {
        lines.push('', 'Tip: if the job is still running, use action=wait with its prompt_id.');
    }
    return lines.join('\n');
}
/** Submit a workflow and return its prompt id. */
export async function submitWorkflow(client, workflow, signal) {
    const clientId = `dsh-comfyui-workflow-${Date.now().toString(36)}`;
    logDebug('Submitting arbitrary workflow', { nodes: Object.keys(workflow).length });
    const { promptId } = await client.queuePrompt(workflow, clientId, signal);
    return promptId;
}
