import { declaredInputs, enumChoices, inputTypeName, specDefault } from './nodes.js';
function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function metaOf(spec) {
    if (!Array.isArray(spec))
        return {};
    const meta = spec[1];
    return meta && typeof meta === 'object' && !Array.isArray(meta)
        ? { ...meta }
        : {};
}
function inputDetail(name, spec, required, maxEnumValues) {
    const first = Array.isArray(spec) ? spec[0] : undefined;
    const isEnum = Array.isArray(first);
    const choices = enumChoices(spec);
    const typeName = isEnum ? 'ENUM' : (inputTypeName(spec) ?? 'UNKNOWN');
    const meta = metaOf(spec);
    const defaultValue = specDefault(spec);
    const detail = { name, required, type: typeName };
    if (defaultValue !== undefined)
        detail.default = defaultValue;
    if (isEnum) {
        detail.enum_count = choices?.length ?? 0;
        if (choices && maxEnumValues > 0 && choices.length > maxEnumValues) {
            detail.enum = choices.slice(0, maxEnumValues);
            detail.enum_truncated = true;
        }
        else {
            detail.enum = choices ?? [];
        }
    }
    delete meta.default;
    if (Object.keys(meta).length > 0)
        detail.meta = meta;
    return detail;
}
function orderedInputNames(info) {
    const required = info.input?.required ?? {};
    const optional = info.input?.optional ?? {};
    const order = info.input_order ?? {};
    const requiredNames = [
        ...(Array.isArray(order.required) ? order.required : []),
        ...Object.keys(required)
    ].filter((name, index, all) => name in required && all.indexOf(name) === index);
    const optionalNames = [
        ...(Array.isArray(order.optional) ? order.optional : []),
        ...Object.keys(optional)
    ].filter((name, index, all) => name in optional && all.indexOf(name) === index);
    return { required: requiredNames, optional: optionalNames };
}
/** Build a complete, model-friendly schema for one node. */
export function describeNode(name, info, maxEnumValues = 50) {
    const required = info.input?.required ?? {};
    const optional = info.input?.optional ?? {};
    const order = orderedInputNames(info);
    const inputs = [];
    for (const inputName of order.required) {
        inputs.push(inputDetail(inputName, required[inputName], true, maxEnumValues));
    }
    for (const inputName of order.optional) {
        inputs.push(inputDetail(inputName, optional[inputName], false, maxEnumValues));
    }
    const outputTypes = Array.isArray(info.output) ? info.output : [];
    const outputNames = Array.isArray(info.output_name) ? info.output_name : [];
    const outputs = outputTypes.map((type, index) => {
        const entry = { index, type: asString(type, 'UNKNOWN') };
        const outputName = outputNames[index];
        if (typeof outputName === 'string' && outputName !== '')
            entry.name = outputName;
        return entry;
    });
    return {
        name,
        display_name: asString(info.display_name, name),
        category: asString(info.category, ''),
        description: asString(info.description, ''),
        ...(info.python_module ? { python_module: info.python_module } : {}),
        output_node: Boolean(info.output_node),
        inputs,
        outputs
    };
}
/** Compact node list entry, used for search results. */
export function summarizeNode(name, info) {
    const required = info.input?.required ?? {};
    const optional = info.input?.optional ?? {};
    const outputTypes = Array.isArray(info.output) ? info.output.map((type) => asString(type, 'UNKNOWN')) : [];
    return {
        name,
        display_name: asString(info.display_name, name),
        category: asString(info.category, ''),
        description: asString(info.description, ''),
        output_node: Boolean(info.output_node),
        input_count: Object.keys(required).length + Object.keys(optional).length,
        required_input_count: Object.keys(required).length,
        output_types: outputTypes
    };
}
function editDistance(a, b) {
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
/** Suggest similar names for a typo (used when a requested node does not exist). */
export function suggestNames(value, candidates, count = 5) {
    const lower = value.toLowerCase();
    const limit = Math.max(2, Math.ceil(value.length / 3));
    return candidates
        .map((candidate) => {
        const candidateLower = candidate.toLowerCase();
        const score = candidateLower === lower
            ? 0
            : candidateLower.includes(lower) || lower.includes(candidateLower)
                ? 1
                : editDistance(lower, candidateLower);
        return { candidate, score };
    })
        .filter((entry) => entry.score <= limit)
        .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
        .slice(0, count)
        .map((entry) => entry.candidate);
}
function matchesQuery(haystack, query) {
    if (!query || query.trim() === '')
        return true;
    const lower = haystack.toLowerCase();
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => lower.includes(token));
}
/** Search the node catalogue by name, display name, category or description. */
export function searchNodes(all, options = {}) {
    const limit = Math.min(500, Math.max(1, Math.round(options.limit ?? 50)));
    const offset = Math.max(0, Math.round(options.offset ?? 0));
    const category = options.category?.trim().toLowerCase() ?? '';
    const query = options.query?.trim() ?? '';
    const matches = Object.entries(all).filter(([name, info]) => {
        const categoryValue = asString(info.category, '').toLowerCase();
        if (category && !categoryValue.includes(category))
            return false;
        return matchesQuery(`${name} ${asString(info.display_name, '')} ${asString(info.category, '')} ${asString(info.description, '')}`, query);
    });
    matches.sort((a, b) => {
        if (query && a[0].toLowerCase() === query.toLowerCase())
            return -1;
        if (query && b[0].toLowerCase() === query.toLowerCase())
            return 1;
        return a[0].localeCompare(b[0]);
    });
    const items = matches.slice(offset, offset + limit).map(([name, info]) => summarizeNode(name, info));
    return {
        total: matches.length,
        offset,
        limit,
        truncated: offset + items.length < matches.length,
        items
    };
}
/** Render one node schema as text (the primary thing the model reads). */
export function formatNodeDetail(detail) {
    const lines = [
        `${detail.name}${detail.display_name && detail.display_name !== detail.name ? ` (${detail.display_name})` : ''}`,
        `Category: ${detail.category || '(none)'}${detail.output_node ? ' | output node' : ''}`
    ];
    if (detail.description)
        lines.push(`Description: ${detail.description}`);
    if (detail.python_module)
        lines.push(`Module: ${detail.python_module}`);
    lines.push('', 'Inputs:');
    if (detail.inputs.length === 0)
        lines.push('  (none)');
    for (const input of detail.inputs) {
        const flags = [input.required ? 'required' : 'optional', input.type];
        if (input.default !== undefined)
            flags.push(`default=${JSON.stringify(input.default)}`);
        if (input.enum_count !== undefined) {
            flags.push(`${input.enum_count} values${input.enum_truncated ? `, first ${input.enum?.length ?? 0} shown` : ''}`);
        }
        lines.push(`  - ${input.name} [${flags.join(', ')}]`);
        if (input.enum && input.enum.length > 0)
            lines.push(`      ${input.enum.join(', ')}`);
        if (input.meta && Object.keys(input.meta).length > 0) {
            lines.push(`      meta: ${JSON.stringify(input.meta)}`);
        }
    }
    lines.push('', 'Outputs:');
    if (detail.outputs.length === 0)
        lines.push('  (none)');
    for (const output of detail.outputs) {
        lines.push(`  - ${output.index}: ${output.type}${output.name ? ` (${output.name})` : ''}`);
    }
    return lines.join('\n');
}
/** Render a node search result as text, grouped by category. */
export function formatNodeList(result) {
    const lines = [
        `Nodes: ${result.total} ${result.total === 1 ? 'match' : 'matches'}${result.truncated ? `, showing ${result.items.length} from offset ${result.offset}` : ''}`
    ];
    let lastCategory = '';
    for (const node of result.items) {
        if (node.category !== lastCategory) {
            lines.push('', `[${node.category || 'uncategorized'}]`);
            lastCategory = node.category;
        }
        lines.push(`  ${node.name}${node.display_name !== node.name ? ` — ${node.display_name}` : ''}` +
            ` (${node.input_count} inputs, ${node.output_types.join('/') || 'no outputs'}${node.output_node ? ', output node' : ''})`);
    }
    return lines.join('\n');
}
/**
 * Loader nodes whose enum choices expose model files. These are the inputs ComfyUI fills from its
 * model folders; the names have been stable across ComfyUI versions for a long time.
 */
const MODEL_HINTS = [
    {
        folder: 'checkpoints',
        nodes: [
            ['CheckpointLoaderSimple', 'ckpt_name'],
            ['ImageOnlyCheckpointLoader', 'ckpt_name']
        ],
        usage: 'Main diffusion checkpoints (SD1.5, SDXL, ...).'
    },
    {
        folder: 'loras',
        nodes: [
            ['LoraLoader', 'lora_name'],
            ['LoraLoaderModelOnly', 'lora_name']
        ],
        usage: 'LoRA adapters.'
    },
    { folder: 'vae', nodes: [['VAELoader', 'vae_name']], usage: 'Standalone VAE files.' },
    {
        folder: 'controlnet',
        nodes: [
            ['ControlNetLoader', 'control_net_name'],
            ['DiffControlNetLoader', 'control_net_name']
        ],
        usage: 'ControlNet models.'
    },
    {
        folder: 'upscale_models',
        nodes: [['UpscaleModelLoader', 'model_name']],
        usage: 'Upscale models (ESRGAN and similar).'
    },
    {
        folder: 'text_encoders',
        nodes: [
            ['CLIPLoader', 'clip_name'],
            ['DualCLIPLoader', 'clip_name1'],
            ['DualCLIPLoader', 'clip_name2'],
            ['TripleCLIPLoader', 'clip_name1'],
            ['TripleCLIPLoader', 'clip_name2'],
            ['TripleCLIPLoader', 'clip_name3']
        ],
        usage: 'Text encoders / CLIP files.'
    },
    {
        folder: 'clip_vision',
        nodes: [['CLIPVisionLoader', 'clip_name']],
        usage: 'CLIP vision encoders.'
    },
    {
        folder: 'style_models',
        nodes: [['StyleModelLoader', 'style_model_name']],
        usage: 'Style models (T2I-Adapter style).'
    },
    { folder: 'gligen', nodes: [['GLIGENLoader', 'gligen_name']], usage: 'GLIGEN models.' },
    {
        folder: 'hypernetworks',
        nodes: [['HypernetworkLoader', 'hypernetwork_name']],
        usage: 'Legacy hypernetworks.'
    },
    {
        folder: 'photomaker',
        nodes: [['PhotoMakerLoader', 'photomaker_model_name']],
        usage: 'PhotoMaker models.'
    },
    {
        folder: 'diffusion_models',
        nodes: [['UNETLoader', 'unet_name']],
        usage: 'Standalone diffusion models / UNETs.'
    },
    { folder: 'configs', nodes: [['CheckpointLoader', 'config_name']], usage: 'Model config files.' },
    {
        folder: 'audio_encoders',
        nodes: [['AudioEncoderLoader', 'audio_encoder_name']],
        usage: 'Audio encoder models for audio-conditioned workflows.'
    },
    {
        folder: 'model_patches',
        nodes: [['ModelPatchLoader', 'name']],
        usage: 'Model patches.'
    }
];
/** Registered folders that are not model storage and should never appear in the model catalogue. */
const EXCLUDED_MODEL_FOLDERS = new Set(['custom_nodes']);
/**
 * Hide cache/code noise that some custom nodes keep inside their model folders.
 * Real model files (weights, configs, prompts, fonts, formats) are kept.
 */
function isUsefulModelPath(file) {
    const segments = file.split(/[\\/]/);
    if (segments.some((segment) => segment.startsWith('.') || segment === '__pycache__'))
        return false;
    if (/\.(py|pyc|pyi|metadata|gitignore|gitattributes)$/i.test(file))
        return false;
    return true;
}
const FOLDER_ALIASES = {
    ckpt: 'checkpoints',
    checkpoint: 'checkpoints',
    checkpoints: 'checkpoints',
    lora: 'loras',
    loras: 'loras',
    vae: 'vae',
    controlnet: 'controlnet',
    control_net: 'controlnet',
    upscale: 'upscale_models',
    upscale_models: 'upscale_models',
    clip: 'text_encoders',
    text_encoders: 'text_encoders',
    unet: 'diffusion_models',
    diffusion_models: 'diffusion_models',
    embeddings: 'embeddings',
    embedding: 'embeddings'
};
function looksLikeModelInput(key) {
    return /model|ckpt|lora|vae|clip|unet|control|style|embed|adapter|upscale|gligen|hypernetwork|photomaker|patch/i.test(key);
}
function dedupe(values) {
    return [...new Set(values)].filter((value) => value !== '');
}
/**
 * Build the complete model catalogue.
 *
 * `/models` is preferred because it reports folders the plugin does not know about. Known loader
 * enums are merged in (they are what workflows actually reference), and any remaining model-like enum
 * from a custom node is reported under `dynamic`.
 */
export async function listModels(client, options = {}) {
    const signal = options.signal;
    const maxDynamicValues = options.maxDynamicValues && options.maxDynamicValues > 0 ? options.maxDynamicValues : 5000;
    const all = options.objectInfo ?? (await client.objectInfo(signal, options.refresh ? 0 : 60_000));
    const hintByNodeInput = new Map();
    for (const hint of MODEL_HINTS) {
        for (const [node, input] of hint.nodes)
            hintByNodeInput.set(`${node}.${input}`, hint.folder);
    }
    const groups = new Map();
    const ensureGroup = (folder, usage) => {
        let group = groups.get(folder);
        if (!group) {
            group = { files: [], usedBy: [], usage, sources: new Set() };
            groups.set(folder, group);
        }
        return group;
    };
    for (const hint of MODEL_HINTS) {
        const group = ensureGroup(hint.folder, hint.usage);
        for (const [nodeName, inputName] of hint.nodes) {
            const info = all[nodeName];
            if (!info)
                continue;
            const spec = declaredInputs(info)[inputName];
            const values = enumChoices(spec);
            if (!values || values.length === 0)
                continue;
            group.files.push(...values);
            group.sources.add('object_info');
            const reference = `${nodeName}.${inputName}`;
            if (!group.usedBy.includes(reference))
                group.usedBy.push(reference);
        }
    }
    let apiFolders;
    try {
        apiFolders = await client.modelFolders(signal);
    }
    catch {
        apiFolders = undefined;
    }
    if (apiFolders && apiFolders.length > 0) {
        for (const folder of apiFolders) {
            if (EXCLUDED_MODEL_FOLDERS.has(folder))
                continue;
            const group = ensureGroup(folder, groups.get(folder)?.usage);
            let files;
            try {
                files = await client.modelFiles(folder, signal);
            }
            catch {
                files = undefined;
            }
            const useful = files?.filter(isUsefulModelPath) ?? [];
            if (useful.length > 0) {
                group.files.push(...useful);
                group.sources.add('api');
            }
        }
    }
    let embeddings;
    try {
        embeddings = await client.embeddings(signal);
    }
    catch {
        embeddings = undefined;
    }
    if (embeddings && embeddings.length > 0) {
        const group = ensureGroup('embeddings', 'Textual inversion embeddings; reference them in prompts as embedding:<name>.');
        group.files.push(...embeddings);
        group.sources.add('embeddings');
    }
    const dynamic = [];
    for (const [nodeName, info] of Object.entries(all)) {
        for (const [inputName, spec] of Object.entries(declaredInputs(info))) {
            if (!looksLikeModelInput(inputName))
                continue;
            const knownFolder = hintByNodeInput.get(`${nodeName}.${inputName}`);
            if (knownFolder)
                continue;
            const values = enumChoices(spec);
            if (!values || values.length === 0)
                continue;
            dynamic.push({
                node: nodeName,
                input: inputName,
                count: values.length,
                values: values.slice(0, maxDynamicValues),
                truncated: values.length > maxDynamicValues
            });
        }
    }
    dynamic.sort((a, b) => `${a.node}.${a.input}`.localeCompare(`${b.node}.${b.input}`));
    const requestedFolder = options.folder?.trim().toLowerCase();
    const normalisedFolder = requestedFolder ? (FOLDER_ALIASES[requestedFolder] ?? requestedFolder) : undefined;
    const query = options.query?.trim().toLowerCase() ?? '';
    const folders = [];
    for (const [folder, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (normalisedFolder && folder.toLowerCase() !== normalisedFolder)
            continue;
        if (group.files.length === 0)
            continue;
        const allFiles = dedupe(group.files).sort((a, b) => a.localeCompare(b));
        const files = query ? allFiles.filter((file) => file.toLowerCase().includes(query)) : allFiles;
        if (query && files.length === 0)
            continue;
        folders.push({
            folder,
            count: files.length,
            total: allFiles.length,
            files,
            source: group.sources.has('api') && group.sources.has('object_info')
                ? 'mixed'
                : group.sources.has('api')
                    ? 'api'
                    : group.sources.has('embeddings')
                        ? 'embeddings'
                        : 'object_info',
            used_by: group.usedBy,
            ...(group.usage ? { usage: group.usage } : {})
        });
    }
    const hasApiFiles = folders.some((folder) => folder.source === 'api' || folder.source === 'mixed');
    const hasObjectInfoFiles = folders.some((folder) => folder.source === 'object_info' || folder.source === 'mixed');
    const source = hasApiFiles && hasObjectInfoFiles ? 'mixed' : hasApiFiles ? 'api' : 'object_info';
    return {
        folders,
        dynamic,
        total_files: folders.reduce((sum, folder) => sum + folder.total, 0),
        source
    };
}
/** Render a model catalogue as text, showing all known folders and a bounded sample of files. */
export function formatModelCatalog(catalog, maxFilesPerFolder = 40) {
    const lines = [];
    const total = catalog.folders.reduce((sum, folder) => sum + folder.count, 0);
    lines.push(`Models: ${total} file(s) across ${catalog.folders.length} folder(s) (source: ${catalog.source})`);
    if (catalog.folders.length === 0) {
        lines.push('  No models reported. Check ComfyUI models/ and refresh object_info.');
    }
    for (const folder of catalog.folders) {
        lines.push('', `${folder.folder} (${folder.count}${folder.count !== folder.total ? ` of ${folder.total}` : ''})`);
        if (folder.usage)
            lines.push(`  ${folder.usage}`);
        if (folder.used_by.length > 0)
            lines.push(`  used by: ${folder.used_by.join(', ')}`);
        const shown = folder.files.slice(0, maxFilesPerFolder);
        for (const file of shown)
            lines.push(`  - ${file}`);
        if (folder.files.length > shown.length) {
            lines.push(`  ... ${folder.files.length - shown.length} more (see the tool's data field)`);
        }
    }
    if (catalog.dynamic.length > 0) {
        lines.push('', `Custom node model inputs: ${catalog.dynamic.length}`);
        for (const entry of catalog.dynamic.slice(0, 30)) {
            lines.push(`  - ${entry.node}.${entry.input}: ${entry.count} value(s)`);
        }
        if (catalog.dynamic.length > 30)
            lines.push(`  ... ${catalog.dynamic.length - 30} more`);
    }
    return lines.join('\n');
}
function queueEntrySummary(entry, state) {
    const number = typeof entry[0] === 'number' ? entry[0] : undefined;
    const promptId = typeof entry[1] === 'string' ? entry[1] : '';
    const prompt = entry[2];
    const classTypes = [];
    let nodeCount = 0;
    if (prompt && typeof prompt === 'object' && !Array.isArray(prompt)) {
        for (const node of Object.values(prompt)) {
            nodeCount += 1;
            if (node && typeof node === 'object' && 'class_type' in node) {
                classTypes.push(String(node.class_type));
            }
        }
    }
    return {
        state,
        ...(number !== undefined ? { number } : {}),
        prompt_id: promptId,
        node_count: nodeCount,
        class_types: classTypes.slice(0, 12)
    };
}
export function summarizeQueue(queue) {
    const entries = [
        ...queue.queue_running.map((entry) => queueEntrySummary(entry, 'running')),
        ...queue.queue_pending.map((entry) => queueEntrySummary(entry, 'pending'))
    ];
    return {
        running: queue.queue_running.length,
        pending: queue.queue_pending.length,
        entries
    };
}
export function formatQueueSummary(summary) {
    const lines = [`Queue: ${summary.running} running, ${summary.pending} pending`];
    if (summary.entries.length === 0)
        lines.push('  (empty)');
    for (const entry of summary.entries) {
        lines.push(`  - [${entry.state}] ${entry.prompt_id || '(no prompt id)'} — ${entry.node_count} node(s)` +
            (entry.class_types.length > 0 ? `: ${entry.class_types.join(', ')}` : ''));
    }
    return lines.join('\n');
}
function entryTimestamp(entry) {
    // ComfyUI's prompt[0] is a queue number, not a timestamp. The execution messages carry
    // millisecond timestamps; prefer the completion time, then fall back to the start time.
    let started;
    for (const message of entry.status?.messages ?? []) {
        if (!Array.isArray(message) || message.length < 2)
            continue;
        const [kind, payload] = message;
        if (!payload || typeof payload !== 'object')
            continue;
        const timestamp = payload.timestamp;
        if (typeof timestamp !== 'number')
            continue;
        if (kind === 'execution_success' || kind === 'execution_error') {
            const date = new Date(timestamp);
            return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
        }
        if (kind === 'execution_start')
            started = timestamp;
    }
    if (started !== undefined) {
        const date = new Date(started);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    return undefined;
}
function entryPrompt(entry) {
    const prompt = entry.prompt;
    if (Array.isArray(prompt) && prompt[2] && typeof prompt[2] === 'object' && !Array.isArray(prompt[2])) {
        return prompt[2];
    }
    return {};
}
/** Summarize history entries, newest first. */
export function summarizeHistory(history, options = {}) {
    const limit = Math.min(200, Math.max(1, Math.round(options.limit ?? 20)));
    const offset = Math.max(0, Math.round(options.offset ?? 0));
    const query = options.query?.trim() ?? '';
    const entries = Object.entries(history).map(([promptId, entry]) => {
        const prompt = entryPrompt(entry);
        const classTypes = Object.values(prompt)
            .map((node) => (node && typeof node === 'object' && 'class_type' in node ? String(node.class_type) : ''))
            .filter(Boolean);
        const outputs = [];
        for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
            for (const [key, value] of Object.entries(output ?? {})) {
                if (Array.isArray(value)) {
                    for (const item of value) {
                        if (item && typeof item === 'object' && 'filename' in item) {
                            outputs.push(`${nodeId}.${key}:${String(item.filename)}`);
                        }
                    }
                }
            }
        }
        return {
            prompt_id: promptId,
            status: String(entry.status?.status_str ?? 'unknown'),
            completed: Boolean(entry.status?.completed),
            ...(entryTimestamp(entry) ? { timestamp: entryTimestamp(entry) } : {}),
            node_count: Object.keys(prompt).length,
            class_types: [...new Set(classTypes)].slice(0, 12),
            output_count: outputs.length,
            outputs
        };
    });
    const filtered = entries
        .filter((entry) => {
        if (!query)
            return true;
        const haystack = `${entry.prompt_id} ${entry.status} ${entry.class_types.join(' ')} ${entry.outputs.join(' ')}`;
        return haystack.toLowerCase().includes(query.toLowerCase());
    })
        // History is stored oldest-first; reverse it so newest is first even when timestamps are absent.
        .reverse()
        .sort((a, b) => {
        const at = a.timestamp ? Date.parse(a.timestamp) : 0;
        const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
        return bt - at;
    });
    const page = filtered.slice(offset, offset + limit);
    return {
        total: filtered.length,
        offset,
        limit,
        truncated: offset + page.length < filtered.length,
        entries: page
    };
}
export function formatHistorySummary(summary) {
    const lines = [`History: ${summary.total} ${summary.total === 1 ? 'entry' : 'entries'}${summary.truncated ? `, showing ${summary.entries.length} from offset ${summary.offset}` : ''}`];
    if (summary.entries.length === 0)
        lines.push('  (none)');
    for (const entry of summary.entries) {
        lines.push(`  - ${entry.prompt_id} [${entry.status}${entry.completed ? ', completed' : ''}]` +
            `${entry.timestamp ? ` at ${entry.timestamp}` : ''} — ${entry.node_count} node(s), ${entry.output_count} output(s)`);
        if (entry.class_types.length > 0)
            lines.push(`      nodes: ${entry.class_types.join(', ')}`);
    }
    return lines.join('\n');
}
/** Render /system_stats into a short readable summary. */
export function formatSystemStats(stats) {
    const system = (stats.system ?? {});
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    const lines = ['ComfyUI system:'];
    if (system.comfyui_version)
        lines.push(`  version: ${String(system.comfyui_version)}`);
    if (system.python_version)
        lines.push(`  python: ${String(system.python_version)}`);
    if (system.os)
        lines.push(`  os: ${String(system.os)}`);
    if (devices.length === 0) {
        lines.push('  devices: none reported (possibly CPU-only)');
    }
    else {
        for (const device of devices) {
            const name = device.name ? String(device.name) : 'unknown';
            const type = device.type ? String(device.type) : 'unknown';
            const free = typeof device.vram_free === 'number' ? `, ${(device.vram_free / 1024 ** 3).toFixed(2)} GB VRAM free` : '';
            lines.push(`  device: ${name} (${type}${free})`);
        }
    }
    return lines.join('\n');
}
