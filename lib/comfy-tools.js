/**
 * Advanced ComfyUI tools.
 *
 * generate_image stays the simple, high-level path. These tools expose the rest of ComfyUI:
 *
 *   comfyui_inspect   read-only discovery: models, every node and its schema, system, queue, history
 *   comfyui_workflow  validate / run / wait on arbitrary API-format workflows, upload assets, job control
 *   comfyui_api       raw HTTP escape hatch for any other ComfyUI endpoint
 *
 * All three resolve config per call (like generate_image) and only ever talk to the configured baseUrl.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from './config.js';
import { ImagePluginError, formatError } from './errors.js';
import { resolveCwd } from './tool.js';
import { ComfyUIClient } from './comfy/client.js';
import { describeNode, formatHistorySummary, formatModelCatalog, formatNodeDetail, formatNodeList, formatQueueSummary, formatSystemStats, listModels, searchNodes, suggestNames, summarizeHistory, summarizeQueue } from './comfy/introspect.js';
import { collectOutputs, formatValidation, formatWorkflowRunText, historyIssues, loadWorkflow, submitWorkflow, validateWorkflow, waitForPrompt, workflowFromHistory } from './comfy/workflow-runner.js';
import { ensureDir, extensionForMime, guessMime, readFileBytes, resolveUserPath, uniqueFilePath } from './files.js';
/* ────────────────────────────── shared helpers ────────────────────────────── */
export const INSPECT_TOOL_NAME = 'comfyui_inspect';
export const WORKFLOW_TOOL_NAME = 'comfyui_workflow';
export const API_TOOL_NAME = 'comfyui_api';
export const ADVANCED_TOOL_NAMES = [INSPECT_TOOL_NAME, WORKFLOW_TOOL_NAME, API_TOOL_NAME];
function context(pluginConfig, exec) {
    return { config: resolveConfig(pluginConfig), cwd: resolveCwd(exec) };
}
/**
 * Reuse one client per endpoint so its /object_info cache (and the `refresh` flag) works across calls.
 * The key includes the request timeout because that is baked into the client.
 */
const clientCache = new Map();
function clientFor(config) {
    const key = `${config.baseUrl}|${config.requestTimeoutMs}`;
    let client = clientCache.get(key);
    if (!client) {
        client = new ComfyUIClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs });
        clientCache.set(key, client);
    }
    return client;
}
function clampInt(value, min, max, fallback) {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, number));
}
function asBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function truncate(text, max = 20_000) {
    return text.length > max ? `${text.slice(0, max)}\n... (truncated, ${text.length - max} more characters)` : text;
}
function failureText(prefix, error) {
    const message = formatError(error);
    return `${prefix}: ${message}`;
}
function issueStrings(issues) {
    return issues.map((issue) => {
        const where = issue.node_id ? `node ${issue.node_id}${issue.input ? `.${issue.input}` : ''}: ` : '';
        return `${where}${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ''}`;
    });
}
/* ────────────────────────────── comfyui_inspect ────────────────────────────── */
export const INSPECT_DESCRIPTION = [
    'Inspect the connected ComfyUI server (read-only): installed models, every available node and its full input/output schema, embeddings, system status, queue and history.',
    '',
    'Use this before building a custom workflow:',
    '  scope=models   every model file grouped by ComfyUI model folder (checkpoints, loras, vae, controlnet, ...), including model enums added by custom nodes.',
    '  scope=nodes    search all node classes by name/category/description; returns compact summaries.',
    '  scope=node     full schema for specific node classes (pass node="KSampler" or a comma-separated list).',
    '  scope=overview counts + system summary in one call.',
    '',
    'Model files and node schemas are exactly what workflows reference; use scope=node to confirm required inputs, enum values and defaults before authoring a workflow.',
    'The generate_image tool remains the simplest path for text2img / img2img / inpaint / remove_background.'
].join('\n');
export const INSPECT_PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        scope: {
            type: 'string',
            enum: ['overview', 'system', 'models', 'nodes', 'node', 'embeddings', 'queue', 'history'],
            description: 'What to inspect (default overview). models=model files; nodes=node search; node=full schema for node; system=server stats; queue/history=jobs.'
        },
        query: {
            type: 'string',
            description: 'Case-insensitive filter. For nodes it searches name/display name/category/description; for models/history it filters names.'
        },
        category: {
            type: 'string',
            description: 'For scope=nodes: only include node categories containing this string (for example "sampling" or "loaders").'
        },
        folder: {
            type: 'string',
            description: 'For scope=models: only this model folder (for example checkpoints, loras, vae, controlnet, upscale_models).'
        },
        node: {
            type: 'string',
            description: 'For scope=node: exact node class name, or a comma-separated list (for example "KSampler,VAEDecode").'
        },
        limit: {
            type: 'integer',
            description: 'Page size for nodes/history, 1-500 (default 50 for nodes, 20 for history).'
        },
        offset: {
            type: 'integer',
            description: 'Pagination offset for nodes/history (default 0).'
        },
        max_enum_values: {
            type: 'integer',
            description: 'For scope=node: enum values shown per input, default 50. Use 0 for no limit.'
        },
        refresh: {
            type: 'boolean',
            description: 'Bypass the node-catalogue cache and refetch /object_info (use after installing custom nodes).'
        }
    },
    required: [],
    additionalProperties: false
};
export const INSPECT_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Readable inspection result' },
        success: { type: 'boolean', description: 'Whether the inspection completed' },
        scope: { type: 'string', description: 'The scope that was inspected' },
        count: { type: 'integer', description: 'Number of primary items returned' },
        total: { type: 'integer', description: 'Total items before pagination' },
        truncated: { type: 'boolean', description: 'Whether the result was paged or truncated' },
        data: {
            type: 'object',
            additionalProperties: true,
            description: 'Machine-readable result (models, node schemas, queue, history, ...)'
        }
    },
    required: ['text', 'success', 'scope'],
    additionalProperties: false
};
/** Build the comfyui_inspect tool definition. */
export function createComfyUIInspectTool(pluginConfig) {
    return {
        name: INSPECT_TOOL_NAME,
        description: INSPECT_DESCRIPTION,
        parameters: INSPECT_PARAMETERS_SCHEMA,
        output: {
            schema: INSPECT_OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return { kind: 'comfyui-inspection', scope: result?.scope ?? 'unknown', count: result?.count ?? 0 };
            }
        },
        async execute(args, exec) {
            const input = (args ?? {});
            const scope = typeof input.scope === 'string' ? input.scope : 'overview';
            const { config } = context(pluginConfig, exec);
            const client = clientFor(config);
            const refresh = asBool(input.refresh, false);
            try {
                switch (scope) {
                    case 'system': {
                        const stats = await client.systemStats(exec?.signal);
                        return {
                            text: formatSystemStats(stats),
                            success: true,
                            scope,
                            data: stats
                        };
                    }
                    case 'models': {
                        const catalog = await listModels(client, {
                            ...(asString(input.folder) ? { folder: asString(input.folder) } : {}),
                            ...(asString(input.query) ? { query: asString(input.query) } : {}),
                            objectInfo: await client.objectInfo(exec?.signal, refresh ? 0 : 60_000),
                            signal: exec?.signal
                        });
                        return {
                            text: formatModelCatalog(catalog),
                            success: true,
                            scope,
                            count: catalog.folders.reduce((sum, folder) => sum + folder.count, 0),
                            total: catalog.total_files,
                            truncated: false,
                            data: {
                                folders: catalog.folders,
                                dynamic: catalog.dynamic,
                                total_files: catalog.total_files,
                                source: catalog.source
                            }
                        };
                    }
                    case 'nodes': {
                        const all = await client.objectInfo(exec?.signal, refresh ? 0 : 60_000);
                        const result = searchNodes(all, {
                            ...(asString(input.query) ? { query: asString(input.query) } : {}),
                            ...(asString(input.category) ? { category: asString(input.category) } : {}),
                            ...(input.limit !== undefined ? { limit: input.limit } : {}),
                            ...(input.offset !== undefined ? { offset: input.offset } : {})
                        });
                        return {
                            text: truncate(formatNodeList(result)),
                            success: true,
                            scope,
                            count: result.items.length,
                            total: result.total,
                            truncated: result.truncated,
                            data: result
                        };
                    }
                    case 'node': {
                        const requested = (asString(input.node) ?? '')
                            .split(',')
                            .map((name) => name.trim())
                            .filter(Boolean);
                        if (requested.length === 0) {
                            return {
                                text: 'scope=node requires the node parameter, for example node="KSampler".',
                                success: false,
                                scope,
                                data: { error: 'missing node' }
                            };
                        }
                        const all = await client.objectInfo(exec?.signal, refresh ? 0 : 60_000);
                        const maxEnumValues = input.max_enum_values === 0 ? 0 : clampInt(input.max_enum_values, 1, 100_000, 50);
                        const details = [];
                        const missing = [];
                        for (const name of requested) {
                            const info = all[name];
                            if (info)
                                details.push(describeNode(name, info, maxEnumValues));
                            else
                                missing.push(name);
                        }
                        const suggestions = missing.flatMap((name) => suggestNames(name, Object.keys(all)));
                        const sections = details.map(formatNodeDetail);
                        if (missing.length > 0) {
                            sections.push(`Not found: ${missing.join(', ')}.` +
                                (suggestions.length > 0 ? ` Suggestions: ${[...new Set(suggestions)].slice(0, 10).join(', ')}` : ''));
                        }
                        return {
                            text: truncate(sections.join('\n\n')),
                            success: details.length > 0,
                            scope,
                            count: details.length,
                            data: { nodes: details, missing, suggestions: [...new Set(suggestions)] }
                        };
                    }
                    case 'embeddings': {
                        const embeddings = (await client.embeddings(exec?.signal)) ?? [];
                        const text = embeddings.length === 0
                            ? 'No embeddings reported. (ComfyUI /embeddings may be unavailable, or none are installed.)'
                            : `Embeddings (${embeddings.length}):\n${embeddings.map((name) => `  - ${name}`).join('\n')}\n\nReference them in prompts as embedding:<name>.`;
                        return { text, success: true, scope, count: embeddings.length, data: { embeddings } };
                    }
                    case 'queue': {
                        const summary = summarizeQueue(await client.queue(exec?.signal));
                        return {
                            text: formatQueueSummary(summary),
                            success: true,
                            scope,
                            count: summary.entries.length,
                            data: summary
                        };
                    }
                    case 'history': {
                        const summary = summarizeHistory(await client.historyAll(exec?.signal), {
                            ...(asString(input.query) ? { query: asString(input.query) } : {}),
                            ...(input.limit !== undefined ? { limit: input.limit } : {}),
                            ...(input.offset !== undefined ? { offset: input.offset } : {})
                        });
                        return {
                            text: truncate(formatHistorySummary(summary)),
                            success: true,
                            scope,
                            count: summary.entries.length,
                            total: summary.total,
                            truncated: summary.truncated,
                            data: summary
                        };
                    }
                    case 'overview':
                    default: {
                        const [stats, all, queue, history] = await Promise.all([
                            client.systemStats(exec?.signal),
                            client.objectInfo(exec?.signal, refresh ? 0 : 60_000),
                            client.queue(exec?.signal),
                            client.historyAll(exec?.signal)
                        ]);
                        const catalog = await listModels(client, { signal: exec?.signal, objectInfo: all });
                        const queueSummary = summarizeQueue(queue);
                        const historySummary = summarizeHistory(history, { limit: 5 });
                        const modelCount = catalog.total_files;
                        const folderCount = catalog.folders.length;
                        const text = [
                            formatSystemStats(stats),
                            '',
                            `Models: ${modelCount} file(s) in ${folderCount} folder(s)`,
                            `Nodes: ${Object.keys(all).length} available`,
                            `Queue: ${queueSummary.running} running, ${queueSummary.pending} pending`,
                            `History: ${Object.keys(history).length} ${Object.keys(history).length === 1 ? 'entry' : 'entries'} retained`,
                            '',
                            'Use scope=models for the model catalogue, scope=nodes to search nodes, or scope=node for a full node schema.'
                        ].join('\n');
                        const data = {
                            system: stats,
                            counts: {
                                models: modelCount,
                                model_folders: folderCount,
                                nodes: Object.keys(all).length,
                                queue_running: queueSummary.running,
                                queue_pending: queueSummary.pending,
                                history: Object.keys(history).length
                            },
                            model_folders: catalog.folders.map((folder) => ({ folder: folder.folder, count: folder.count })),
                            recent_history: historySummary.entries
                        };
                        return {
                            text,
                            success: true,
                            scope: 'overview',
                            count: Object.keys(all).length,
                            data
                        };
                    }
                }
            }
            catch (error) {
                return {
                    text: failureText('ComfyUI inspection failed', error),
                    success: false,
                    scope,
                    data: { error: formatError(error) }
                };
            }
        }
    };
}
/* ────────────────────────────── comfyui_workflow ────────────────────────────── */
export const WORKFLOW_DESCRIPTION = [
    'Validate, run, wait on, and manage arbitrary ComfyUI API-format workflows. Use comfyui_inspect first to discover node schemas and model file names.',
    '',
    'Workflow format: {"<node id>": {"class_type": "KSampler", "inputs": {"seed": 1, "model": ["4", 0], ...}}, ...}.',
    'Links are [upstream node id, output index]. Use comfyui_inspect scope=node to see required inputs, enum values and defaults.',
    '',
    'Actions:',
    '  validate      local validation against /object_info (unknown nodes/inputs, missing required inputs, dangling links, bad enum values).',
    '  run           validate (unless validate=false) then submit; with wait=true (default) poll until done and save outputs.',
    '  wait          collect an existing prompt_id (submit with wait=false first).',
    '  upload        upload a local file into ComfyUI input and return the name to use in LoadImage / LoadImageMask.',
    '  interrupt     cancel the currently running job.',
    '  free          unload models / free memory (unload_models, free_memory).',
    '  queue         show running and pending jobs.',
    '  queue_clear   clear all pending jobs.',
    '  queue_delete  delete specific pending prompt ids (queue_ids).',
    '',
    'Output files are saved next to output_path (default: current project root) and never overwrite. A .json metadata sidecar records the workflow and history.'
].join('\n');
export const WORKFLOW_PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['validate', 'run', 'wait', 'upload', 'interrupt', 'free', 'queue', 'queue_clear', 'queue_delete'],
            description: 'Operation to perform. Defaults to run when workflow/workflow_path is provided.'
        },
        workflow: {
            type: 'object',
            additionalProperties: true,
            description: 'API-format workflow object: node id -> { class_type, inputs }.'
        },
        workflow_path: {
            type: 'string',
            description: 'Local path to an API-format workflow JSON (alternative to workflow).'
        },
        file_path: {
            type: 'string',
            description: 'For action=upload: local file to upload (image, mask, audio, video or other input).'
        },
        kind: {
            type: 'string',
            enum: ['auto', 'image', 'mask', 'file'],
            description: 'For action=upload: label the file as a mask, image or generic file. All are uploaded to ComfyUI input. Default auto.'
        },
        subfolder: {
            type: 'string',
            description: 'For action=upload: optional subfolder inside ComfyUI input.'
        },
        overwrite: {
            type: 'boolean',
            description: 'For action=upload: overwrite an existing file with the same name (default true, matching ComfyUI).'
        },
        prompt_id: {
            type: 'string',
            description: 'For action=wait: the prompt id to collect.'
        },
        timeout_ms: {
            type: 'integer',
            description: 'Wait timeout in milliseconds (default: timeoutMs from config, 300000 out of the box; max 3600000).'
        },
        poll_interval_ms: {
            type: 'integer',
            description: 'History poll interval in milliseconds (default 700, min 100).'
        },
        output_path: {
            type: 'string',
            description: 'Directory for downloaded outputs (or a file path when a single output is expected). Default: current project root.'
        },
        save_outputs: {
            type: 'boolean',
            description: 'Download produced files to disk (default true).'
        },
        write_metadata: {
            type: 'boolean',
            description: 'Write a .json metadata sidecar for the run (default true).'
        },
        wait: {
            type: 'boolean',
            description: 'For action=run: wait for completion and save outputs (default true). Set false to only submit.'
        },
        validate: {
            type: 'boolean',
            description: 'For action=run: validate locally before submitting (default true).'
        },
        max_outputs: {
            type: 'integer',
            description: 'Maximum output files to download (default 20, max 100).'
        },
        queue_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'For action=queue_delete: prompt ids to remove from the pending queue.'
        },
        unload_models: {
            type: 'boolean',
            description: 'For action=free: unload models from VRAM.'
        },
        free_memory: {
            type: 'boolean',
            description: 'For action=free: release cached memory.'
        },
        include_history: {
            type: 'boolean',
            description: 'Include the full history entry in data (default false).'
        },
        refresh: {
            type: 'boolean',
            description: 'Bypass the node-catalogue cache during validation.'
        }
    },
    required: [],
    additionalProperties: false
};
export const WORKFLOW_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Readable result' },
        success: { type: 'boolean', description: 'Whether the action succeeded' },
        action: { type: 'string', description: 'The action performed' },
        prompt_id: { type: 'string', description: 'ComfyUI prompt id, when one exists' },
        status: { type: 'string', description: 'queued / success / error / cancelled / invalid / timeout' },
        valid: { type: 'boolean', description: 'Validation verdict, when validation ran' },
        files: { type: 'array', items: { type: 'string' }, description: 'Downloaded output files' },
        outputs: { type: 'array', items: { type: 'string' }, description: 'Human-readable output references' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Validation errors / execution errors' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal warnings' },
        metadata_path: { type: 'string', description: 'Metadata sidecar path, when written' },
        data: {
            type: 'object',
            additionalProperties: true,
            description: 'Machine-readable result (validation, upload result, queue summary, ...)'
        }
    },
    required: ['text', 'success', 'action'],
    additionalProperties: false
};
function issueStringsFromValidation(validation) {
    return [...issueStrings(validation.errors), ...issueStrings(validation.warnings)];
}
function workflowResultText(action, success, text, extra = {}) {
    return {
        text,
        success,
        action,
        ...extra
    };
}
/** Build the comfyui_workflow tool definition. */
export function createComfyUIWorkflowTool(pluginConfig) {
    return {
        name: WORKFLOW_TOOL_NAME,
        description: WORKFLOW_DESCRIPTION,
        parameters: WORKFLOW_PARAMETERS_SCHEMA,
        output: {
            schema: WORKFLOW_OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return { kind: 'comfyui-workflow', action: result?.action ?? 'unknown', promptId: result?.prompt_id ?? '' };
            }
        },
        async execute(args, exec) {
            const input = (args ?? {});
            const { config, cwd } = context(pluginConfig, exec);
            const client = clientFor(config);
            const hasWorkflow = input.workflow !== undefined || asString(input.workflow_path) !== undefined;
            const action = asString(input.action) ??
                (hasWorkflow ? 'run' : asString(input.file_path) ? 'upload' : asString(input.prompt_id) ? 'wait' : 'queue');
            const timeoutMs = clampInt(input.timeout_ms, 1_000, 3_600_000, config.timeoutMs);
            const pollIntervalMs = clampInt(input.poll_interval_ms, 100, 10_000, config.pollIntervalMs);
            try {
                switch (action) {
                    case 'validate':
                    case 'run': {
                        const loaded = loadWorkflow({
                            ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
                            ...(asString(input.workflow_path) ? { workflowPath: asString(input.workflow_path) } : {}),
                            cwd
                        });
                        const all = await client.objectInfo(exec?.signal, asBool(input.refresh, false) ? 0 : 60_000);
                        const validation = validateWorkflow(loaded.workflow, { objectInfo: all });
                        const validationText = formatValidation(validation);
                        if (action === 'validate') {
                            return workflowResultText(action, validation.valid, validationText, {
                                valid: validation.valid,
                                issues: issueStringsFromValidation(validation),
                                data: { validation, source: loaded.source, workflow_path: loaded.path }
                            });
                        }
                        if (asBool(input.validate, true) && !validation.valid) {
                            return workflowResultText(action, false, `${validationText}\n\nNothing was submitted. Fix the errors above, or pass validate=false to let ComfyUI try anyway.`, {
                                valid: false,
                                status: 'invalid',
                                issues: issueStringsFromValidation(validation),
                                data: { validation, source: loaded.source, workflow_path: loaded.path }
                            });
                        }
                        const promptId = await submitWorkflow(client, loaded.workflow, exec?.signal);
                        if (!asBool(input.wait, true)) {
                            return workflowResultText(action, true, `✅ Workflow submitted.\nprompt_id: ${promptId}\n\nUse action=wait with this prompt_id to collect outputs, or action=queue to watch it.`, {
                                prompt_id: promptId,
                                status: 'queued',
                                valid: validation.valid,
                                warnings: validation.warnings.map((issue) => issue.message),
                                data: { validation, submit: { prompt_id: promptId } }
                            });
                        }
                        let entry;
                        try {
                            entry = await waitForPrompt(client, promptId, { timeoutMs, pollIntervalMs, ...(exec?.signal ? { signal: exec.signal } : {}) });
                        }
                        catch (error) {
                            const timedOut = error instanceof ImagePluginError && /Timed out/.test(error.message);
                            return workflowResultText(action, false, failureText(timedOut ? `⚠️ Workflow ${promptId} is still running` : `Workflow ${promptId} failed`, error), {
                                prompt_id: promptId,
                                status: timedOut ? 'timeout' : 'error',
                                valid: validation.valid,
                                issues: [formatError(error)],
                                data: { validation }
                            });
                        }
                        const status = String(entry.status?.status_str ?? 'unknown');
                        const completed = Boolean(entry.status?.completed);
                        const issues = historyIssues(entry);
                        const collected = await collectOutputs(client, entry, {
                            cwd,
                            config,
                            promptId,
                            ...(asString(input.output_path) ? { outputPath: asString(input.output_path) } : {}),
                            saveOutputs: asBool(input.save_outputs, true),
                            writeMetadata: asBool(input.write_metadata, true),
                            maxOutputs: clampInt(input.max_outputs, 1, 100, 20),
                            workflow: loaded.workflow,
                            history: entry,
                            ...(exec?.signal ? { signal: exec.signal } : {})
                        });
                        const successful = status === 'success' && completed && issues.length === 0;
                        return workflowResultText(action, successful, formatWorkflowRunText({
                            promptId,
                            status,
                            completed,
                            files: collected.files,
                            outputs: collected.outputs,
                            text_outputs: collected.text_outputs,
                            warnings: collected.warnings,
                            issues,
                            ...(collected.metadata_path ? { metadataPath: collected.metadata_path } : {})
                        }), {
                            prompt_id: promptId,
                            status,
                            valid: validation.valid,
                            files: collected.files,
                            outputs: collected.outputs.map((output) => `${output.node_id}.${output.key}: ${output.filename}${output.path ? ` -> ${output.path}` : ''}`),
                            issues: issues.map((issue) => issue.message),
                            warnings: [...validation.warnings.map((issue) => issue.message), ...collected.warnings],
                            ...(collected.metadata_path ? { metadata_path: collected.metadata_path } : {}),
                            data: {
                                validation,
                                execution: { status, completed, issues },
                                outputs: collected.outputs,
                                text_outputs: collected.text_outputs,
                                ...(asBool(input.include_history, false) ? { history: entry } : {})
                            }
                        });
                    }
                    case 'wait': {
                        const promptId = asString(input.prompt_id);
                        if (!promptId) {
                            return workflowResultText(action, false, 'action=wait requires prompt_id. Submit a workflow with wait=false first, or use action=run with wait=true.', { status: 'invalid' });
                        }
                        let entry;
                        try {
                            entry = await waitForPrompt(client, promptId, { timeoutMs, pollIntervalMs, ...(exec?.signal ? { signal: exec.signal } : {}) });
                        }
                        catch (error) {
                            const timedOut = error instanceof ImagePluginError && /Timed out/.test(error.message);
                            return workflowResultText(action, false, failureText(timedOut ? `⚠️ Workflow ${promptId} is still running` : `Workflow ${promptId} failed`, error), { prompt_id: promptId, status: timedOut ? 'timeout' : 'error', issues: [formatError(error)] });
                        }
                        const status = String(entry.status?.status_str ?? 'unknown');
                        const completed = Boolean(entry.status?.completed);
                        const issues = historyIssues(entry);
                        const workflow = workflowFromHistory(entry);
                        const collected = await collectOutputs(client, entry, {
                            cwd,
                            config,
                            promptId,
                            ...(asString(input.output_path) ? { outputPath: asString(input.output_path) } : {}),
                            saveOutputs: asBool(input.save_outputs, true),
                            writeMetadata: asBool(input.write_metadata, true),
                            maxOutputs: clampInt(input.max_outputs, 1, 100, 20),
                            ...(workflow ? { workflow } : {}),
                            history: entry,
                            ...(exec?.signal ? { signal: exec.signal } : {})
                        });
                        const successful = status === 'success' && completed && issues.length === 0;
                        return workflowResultText(action, successful, formatWorkflowRunText({
                            promptId,
                            status,
                            completed,
                            files: collected.files,
                            outputs: collected.outputs,
                            text_outputs: collected.text_outputs,
                            warnings: collected.warnings,
                            issues,
                            ...(collected.metadata_path ? { metadataPath: collected.metadata_path } : {})
                        }), {
                            prompt_id: promptId,
                            status,
                            files: collected.files,
                            outputs: collected.outputs.map((output) => `${output.node_id}.${output.key}: ${output.filename}${output.path ? ` -> ${output.path}` : ''}`),
                            issues: issues.map((issue) => issue.message),
                            warnings: collected.warnings,
                            ...(collected.metadata_path ? { metadata_path: collected.metadata_path } : {}),
                            data: {
                                execution: { status, completed, issues },
                                outputs: collected.outputs,
                                text_outputs: collected.text_outputs,
                                ...(asBool(input.include_history, false) ? { history: entry } : {})
                            }
                        });
                    }
                    case 'upload': {
                        const filePath = asString(input.file_path);
                        if (!filePath) {
                            return workflowResultText(action, false, 'action=upload requires file_path.', { status: 'invalid' });
                        }
                        const resolved = resolveUserPath(filePath, cwd);
                        const bytes = readFileBytes(resolved, 'file_path');
                        const kindArg = asString(input.kind) ?? 'auto';
                        const extension = path.extname(resolved).toLowerCase();
                        const kind = kindArg === 'mask'
                            ? 'mask'
                            : kindArg === 'file'
                                ? 'file'
                                : ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'].includes(extension)
                                    ? 'image'
                                    : 'file';
                        const uploaded = await client.uploadFile({
                            filename: path.basename(resolved),
                            bytes,
                            mime: guessMime(resolved),
                            ...(asString(input.subfolder) ? { subfolder: asString(input.subfolder) } : {}),
                            overwrite: asBool(input.overwrite, true)
                        }, exec?.signal);
                        return workflowResultText(action, true, [
                            `✅ Uploaded ${resolved}`,
                            `name: ${uploaded.name}`,
                            `subfolder: ${uploaded.subfolder || '(none)'}`,
                            `type: ${uploaded.type}`,
                            '',
                            'Use this name in a workflow input, for example LoadImage inputs.image = ' + JSON.stringify(uploaded.name) + '.'
                        ].join('\n'), {
                            status: 'uploaded',
                            data: { upload: uploaded, local_path: resolved, kind, bytes: bytes.length }
                        });
                    }
                    case 'interrupt': {
                        await client.interruptNow(exec?.signal);
                        return workflowResultText(action, true, '✅ Interrupt requested for the currently running job.', {
                            status: 'interrupted'
                        });
                    }
                    case 'free': {
                        const unloadModels = asBool(input.unload_models, false);
                        const freeMemory = asBool(input.free_memory, false);
                        await client.free({ unloadModels, freeMemory }, exec?.signal);
                        return workflowResultText(action, true, `✅ Free requested (unload_models=${unloadModels}, free_memory=${freeMemory}).`, { status: 'ok', data: { unload_models: unloadModels, free_memory: freeMemory } });
                    }
                    case 'queue': {
                        const summary = summarizeQueue(await client.queue(exec?.signal));
                        return workflowResultText(action, true, formatQueueSummary(summary), {
                            status: 'ok',
                            data: summary
                        });
                    }
                    case 'queue_clear': {
                        await client.clearQueue(exec?.signal);
                        return workflowResultText(action, true, '✅ Pending queue cleared.', { status: 'ok' });
                    }
                    case 'queue_delete': {
                        const ids = Array.isArray(input.queue_ids) ? input.queue_ids.map(String).filter(Boolean) : [];
                        if (ids.length === 0) {
                            return workflowResultText(action, false, 'action=queue_delete requires queue_ids.', {
                                status: 'invalid'
                            });
                        }
                        await client.deleteQueueItems(ids, exec?.signal);
                        return workflowResultText(action, true, `✅ Removed ${ids.length} pending prompt(s).`, {
                            status: 'ok',
                            data: { queue_ids: ids }
                        });
                    }
                    default:
                        return workflowResultText(action, false, `Unknown action: ${action}.`, { status: 'invalid' });
                }
            }
            catch (error) {
                return workflowResultText(action, false, failureText('ComfyUI workflow action failed', error), {
                    status: 'error',
                    issues: [formatError(error)]
                });
            }
        }
    };
}
/* ────────────────────────────── comfyui_api ────────────────────────────── */
export const API_DESCRIPTION = [
    'Raw HTTP access to the configured ComfyUI server. Use this for endpoints not covered by comfyui_inspect / comfyui_workflow, such as settings, user data, custom-node manager APIs, or newer ComfyUI endpoints.',
    '',
    'The base URL is fixed to the plugin configuration; path must start with "/". JSON responses are parsed, text is returned, and binary responses (images, audio, video) are saved to save_path or the current project root.',
    'Multipart uploads are not supported here: use comfyui_workflow action=upload for /upload/image (images, masks and other input files).',
    '',
    'Examples:',
    '  GET  /models                       list model folders',
    '  GET  /history                      recent jobs',
    '  POST /free                         {"unload_models": true, "free_memory": true}',
    '  GET  /settings                     current server settings',
    '  POST /api/...                      any extension endpoint'
].join('\n');
export const API_PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            description: 'HTTP method (default GET).'
        },
        path: {
            type: 'string',
            description: 'Endpoint path beginning with "/" (for example "/models" or "/queue"); query can also be supplied separately.'
        },
        query: {
            type: 'object',
            additionalProperties: true,
            description: 'Query parameters. Arrays append multiple values for the same key.'
        },
        body: {
            type: 'object',
            additionalProperties: true,
            description: 'JSON request body (for POST/PUT/PATCH/DELETE).'
        },
        body_text: {
            type: 'string',
            description: 'Plain-text request body, when the endpoint does not accept JSON. Mutually exclusive with body.'
        },
        headers: {
            type: 'object',
            additionalProperties: true,
            description: 'Additional request headers. Host, content-length, connection, transfer-encoding and upgrade are rejected.'
        },
        timeout_ms: {
            type: 'integer',
            description: 'Request timeout in milliseconds (default requestTimeoutMs from config).'
        },
        response_type: {
            type: 'string',
            enum: ['auto', 'json', 'text', 'binary'],
            description: 'How to interpret the response (default auto: JSON -> parsed, text -> returned, other -> saved).'
        },
        save_path: {
            type: 'string',
            description: 'For binary responses: file or directory to save into. Defaults to a generated file in the current project root.'
        },
        max_bytes: {
            type: 'integer',
            description: 'Maximum textual/JSON response bytes to render (default 100000, max 50000000). Binary responses are saved in full.'
        }
    },
    required: ['path'],
    additionalProperties: false
};
export const API_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Readable response summary / body' },
        success: { type: 'boolean', description: 'Whether the HTTP request succeeded' },
        status: { type: 'integer', description: 'HTTP status code (0 when the request was rejected before sending)' },
        content_type: { type: 'string', description: 'Response content type' },
        path: { type: 'string', description: 'Saved file path for binary responses' },
        bytes: { type: 'integer', description: 'Response or saved file size in bytes' },
        truncated: { type: 'boolean', description: 'Whether the rendered body was truncated' },
        data: {
            type: 'object',
            additionalProperties: true,
            description: 'Parsed JSON (when applicable) and response headers'
        }
    },
    required: ['text', 'success', 'status'],
    additionalProperties: false
};
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade']);
function validateApiPath(rawPath) {
    const pathname = rawPath.split('?')[0] ?? rawPath;
    if (!pathname.startsWith('/')) {
        throw new ImagePluginError('The path must start with "/" (the ComfyUI base URL is fixed by the plugin configuration).', 'For example: path="/models" or path="/history".');
    }
    if (pathname.startsWith('//') || pathname.includes('://') || pathname.includes('\\')) {
        throw new ImagePluginError('The path must be a path on the configured ComfyUI server, not an absolute URL.', 'Pass path="/object_info", not "http://host/object_info".');
    }
    if (pathname.split('/').includes('..')) {
        throw new ImagePluginError('The path must not contain ".." segments.', 'Use a normal ComfyUI API path.');
    }
    if (pathname === '/ws' || pathname.startsWith('/ws/')) {
        throw new ImagePluginError('WebSocket endpoints are not supported by this tool.', 'Use comfyui_workflow action=wait or action=queue to follow job progress.');
    }
    if (pathname.startsWith('/upload/image') || pathname.startsWith('/upload/mask')) {
        throw new ImagePluginError('Multipart uploads are not supported by comfyui_api.', 'Use comfyui_workflow action=upload with file_path instead.');
    }
    return rawPath;
}
function responseExtension(contentType, pathname) {
    const fromMime = extensionForMime(contentType, '');
    if (fromMime)
        return fromMime;
    const ext = path.extname(pathname);
    return ext || '.bin';
}
function savePathFor(savePath, cwd, extension) {
    if (!savePath || savePath.trim() === '') {
        const name = `comfyui-api-${Date.now().toString(36)}${extension}`;
        return uniqueFilePath(path.join(cwd, name));
    }
    const resolved = resolveUserPath(savePath.trim(), cwd);
    let existingDirectory = false;
    if (existsSync(resolved)) {
        try {
            existingDirectory = statSync(resolved).isDirectory();
        }
        catch {
            existingDirectory = false;
        }
    }
    const looksLikeDirectory = /[/\\]$/.test(savePath) || path.extname(resolved) === '' || existingDirectory;
    if (looksLikeDirectory) {
        ensureDir(resolved);
        return uniqueFilePath(path.join(resolved, `comfyui-api-${Date.now().toString(36)}${extension}`));
    }
    ensureDir(path.dirname(resolved));
    return uniqueFilePath(resolved);
}
function isBinaryContentType(contentType) {
    return /^(image|audio|video|application\/octet-stream|application\/zip|application\/pdf)/i.test(contentType);
}
/** Build the comfyui_api tool definition. */
export function createComfyUIApiTool(pluginConfig) {
    return {
        name: API_TOOL_NAME,
        description: API_DESCRIPTION,
        parameters: API_PARAMETERS_SCHEMA,
        output: {
            schema: API_OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return { kind: 'comfyui-api', status: result?.status ?? 0, path: result?.path ?? '' };
            }
        },
        async execute(args, exec) {
            const input = (args ?? {});
            const { config, cwd } = context(pluginConfig, exec);
            const client = clientFor(config);
            const rawPath = asString(input.path);
            if (!rawPath) {
                return {
                    text: 'comfyui_api requires path, for example path="/models".',
                    success: false,
                    status: 0,
                    data: { error: 'missing path' }
                };
            }
            let pathname;
            try {
                pathname = validateApiPath(rawPath);
                if (input.body !== undefined && input.body_text !== undefined) {
                    throw new ImagePluginError('Provide either body or body_text, not both.', 'Use body for JSON, body_text for plain text.');
                }
            }
            catch (error) {
                return {
                    text: failureText('comfyui_api rejected the request', error),
                    success: false,
                    status: 0,
                    data: { error: formatError(error) }
                };
            }
            const method = (asString(input.method) ?? 'GET').toUpperCase();
            const headers = {};
            for (const [key, value] of Object.entries(input.headers ?? {})) {
                const lower = key.toLowerCase();
                if (FORBIDDEN_HEADERS.has(lower))
                    continue;
                if (value === undefined || value === null)
                    continue;
                headers[key] = String(value);
            }
            const maxBytes = clampInt(input.max_bytes, 1_024, 50_000_000, 100_000);
            const responseType = asString(input.response_type) ?? 'auto';
            try {
                const response = await client.rawRequest({
                    method,
                    pathname,
                    ...(input.query && typeof input.query === 'object' ? { query: input.query } : {}),
                    ...(input.body !== undefined ? { body: input.body } : {}),
                    ...(input.body_text !== undefined ? { bodyText: input.body_text } : {}),
                    ...(Object.keys(headers).length > 0 ? { headers } : {}),
                    ...(input.timeout_ms !== undefined
                        ? { timeoutMs: clampInt(input.timeout_ms, 1_000, 3_600_000, config.requestTimeoutMs) }
                        : {}),
                    ...(exec?.signal ? { signal: exec.signal } : {})
                });
                const contentType = response.contentType;
                const wantsJson = responseType === 'json' || (responseType === 'auto' && /json/i.test(contentType));
                const wantsBinary = responseType === 'binary' ||
                    (responseType === 'auto' && response.text === undefined && isBinaryContentType(contentType));
                if (wantsBinary) {
                    const extension = responseExtension(contentType, pathname);
                    const target = savePathFor(asString(input.save_path), cwd, extension);
                    writeFileSync(target, response.bytes);
                    return {
                        text: [
                            `HTTP ${response.status} ${response.ok ? 'OK' : 'error'} — ${contentType || 'unknown content type'}`,
                            `Saved ${response.bytes.length} bytes to: ${target}`
                        ].join('\n'),
                        success: response.ok,
                        status: response.status,
                        content_type: contentType,
                        path: target,
                        bytes: response.bytes.length,
                        truncated: false,
                        data: { headers: response.headers }
                    };
                }
                const rawText = response.text ?? response.bytes.toString('utf8');
                const text = rawText.slice(0, maxBytes);
                const truncated = rawText.length > maxBytes;
                let parsed;
                let parseError;
                if (wantsJson) {
                    try {
                        parsed = JSON.parse(rawText);
                    }
                    catch (error) {
                        parseError = error instanceof Error ? error.message : String(error);
                    }
                }
                const bodyText = parsed !== undefined ? JSON.stringify(parsed, null, 2) : text;
                const bodyShown = bodyText.slice(0, maxBytes);
                const bodyTruncated = bodyText.length > maxBytes;
                const jsonFits = parsed !== undefined && rawText.length <= maxBytes;
                const summary = [
                    `HTTP ${response.status} ${response.ok ? 'OK' : 'error'} — ${contentType || 'unknown content type'}`,
                    bodyShown,
                    ...(bodyTruncated || truncated ? [`... (truncated at ${maxBytes} bytes)`] : []),
                    ...(parseError ? [`JSON parse error: ${parseError}`] : []),
                    ...(parsed !== undefined && !jsonFits
                        ? [`JSON body omitted from data (${rawText.length} bytes); raise max_bytes or use a structured tool.`]
                        : [])
                ]
                    .filter(Boolean)
                    .join('\n');
                return {
                    text: truncate(summary),
                    success: response.ok,
                    status: response.status,
                    content_type: contentType,
                    bytes: response.bytes.length,
                    truncated: bodyTruncated || truncated,
                    data: {
                        headers: response.headers,
                        ...(jsonFits ? { json: parsed } : {}),
                        ...(parsed !== undefined && !jsonFits ? { json_omitted: true, json_bytes: rawText.length } : {}),
                        ...(parseError ? { parse_error: parseError } : {})
                    }
                };
            }
            catch (error) {
                return {
                    text: failureText('comfyui_api request failed', error),
                    success: false,
                    status: 0,
                    data: { error: formatError(error) }
                };
            }
        }
    };
}
