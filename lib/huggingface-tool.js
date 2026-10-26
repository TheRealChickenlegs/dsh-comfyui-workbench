/**
 * Hugging Face model discovery and downloads.
 *
 * Search/list are read-only. Download writes a single repository file atomically into the configured
 * ComfyUI models directory when one is available; otherwise it writes to a local staging directory and
 * reports the path for the operator to copy to ComfyUI.
 */
import { resolveConfig } from './config.js';
import { ImagePluginError, formatError } from './errors.js';
import { resolveCwd } from './tool.js';
import { HuggingFaceClient, resolveDownloadDestination } from './huggingface.js';
export const HUGGINGFACE_TOOL_NAME = 'huggingface_models';
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
function asBool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.round(Math.min(max, Math.max(min, n)));
}
function clientFor(config) {
    return new HuggingFaceClient({
        endpoint: config.huggingFaceEndpoint,
        ...(config.huggingFaceToken ? { token: config.huggingFaceToken } : {}),
        requestTimeoutMs: config.requestTimeoutMs
    });
}
function formatBytes(bytes) {
    if (bytes === undefined)
        return 'unknown';
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}
export const HUGGINGFACE_DESCRIPTION = [
    'Search Hugging Face, list a model repository, and download model files for ComfyUI.',
    '',
    'A token is optional for public repositories and required for gated/private ones. Configure it as',
    'huggingFaceToken in the plugin page, in ~/.dsh-comfyui-workbench/config.json, or via HF_TOKEN.',
    'Accept the model license on huggingface.co before downloading a gated repository.',
    '',
    'When comfyuiModelsDir is configured, files go to <comfyuiModelsDir>/<folder>/ and are ready for a',
    'local ComfyUI. Otherwise the tool writes to modelDownloadDir or ~/.dsh-comfyui-workbench/downloads',
    'and reports the path; a remote ComfyUI server cannot be written through its HTTP API.',
    '',
    'Actions:',
    '  search   find repositories by name/tag',
    '  files    list files, sizes and LFS SHA-256 values in a repository',
    '  download download one file (dry_run=true reports size without writing)',
    '',
    'Examples:',
    '  { "action": "search", "query": "Wan 2.2 ComfyUI" }',
    '  { "action": "files", "repo_id": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" }',
    '  { "action": "download", "repo_id": "owner/repo", "filename": "models/model.safetensors", "folder": "checkpoints" }'
].join('\n');
export const HUGGINGFACE_PARAMETERS_SCHEMA = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['search', 'files', 'download'],
            description: 'Operation. Defaults to search when query is set, download when filename is set, otherwise files.'
        },
        query: {
            type: 'string',
            description: 'Search text for action=search.'
        },
        repo_id: {
            type: 'string',
            description: 'Hugging Face repository id in owner/name form.'
        },
        filename: {
            type: 'string',
            description: 'Exact file path inside the repository for action=download, for example split_files/vae/model.safetensors.'
        },
        revision: {
            type: 'string',
            description: 'Branch, tag or commit (default main).'
        },
        folder: {
            type: 'string',
            description: 'ComfyUI model folder, for example checkpoints, diffusion_models, text_encoders, vae or loras (default checkpoints).'
        },
        target_filename: {
            type: 'string',
            description: 'Optional local filename. Defaults to the basename of filename.'
        },
        output_dir: {
            type: 'string',
            description: 'Optional exact local directory. Overrides comfyuiModelsDir/modelDownloadDir and disables installed=true.'
        },
        limit: {
            type: 'integer',
            description: 'Search results or file-list rows to return (1-500, default 20 for search, 100 for files).'
        },
        overwrite: {
            type: 'boolean',
            description: 'Replace an existing target file (default false).'
        },
        dry_run: {
            type: 'boolean',
            description: 'For download: report size without writing the file.'
        }
    },
    required: [],
    additionalProperties: false
};
export const HUGGINGFACE_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        text: { type: 'string', description: 'Readable result' },
        success: { type: 'boolean', description: 'Whether the action succeeded' },
        action: { type: 'string', description: 'Action performed' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Warnings and next steps' },
        count: { type: 'integer', description: 'Returned/available count' },
        total: { type: 'integer', description: 'Total files before limiting' },
        repo_id: { type: 'string', description: 'Repository id' },
        filename: { type: 'string', description: 'Repository file path' },
        revision: { type: 'string', description: 'Revision used' },
        path: { type: 'string', description: 'Local saved path' },
        bytes: { type: 'integer', description: 'Bytes written' },
        size: { type: 'integer', description: 'Reported remote size' },
        folder: { type: 'string', description: 'ComfyUI model folder' },
        installed: { type: 'boolean', description: 'Whether the file was written inside comfyuiModelsDir' },
        dry_run: { type: 'boolean', description: 'Whether this was a dry run' },
        gated: { type: 'string', description: 'Gated status reported by Hugging Face' },
        models: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Search results' },
        files: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Repository files' }
    },
    required: ['text', 'success', 'action'],
    additionalProperties: false
};
function modelLine(item) {
    const bits = [item.id];
    if (item.pipeline_tag)
        bits.push(`[${item.pipeline_tag}]`);
    if (item.downloads !== undefined)
        bits.push(`${item.downloads} downloads`);
    if (item.likes !== undefined)
        bits.push(`${item.likes} likes`);
    if (item.gated)
        bits.push('gated');
    return `- ${bits.join(' · ')}`;
}
/** Build the huggingface_models tool. */
export function createHuggingFaceTool(pluginConfig) {
    return {
        name: HUGGINGFACE_TOOL_NAME,
        description: HUGGINGFACE_DESCRIPTION,
        parameters: HUGGINGFACE_PARAMETERS_SCHEMA,
        output: {
            schema: HUGGINGFACE_OUTPUT_SCHEMA,
            render: (_args, value) => [
                { type: 'text', text: String(value?.text ?? '') }
            ],
            presentationMeta: (_args, value) => {
                const result = value;
                return {
                    kind: 'huggingface-models',
                    action: result?.action ?? 'unknown',
                    repoId: result?.repo_id ?? '',
                    path: result?.path ?? ''
                };
            }
        },
        async execute(args, exec) {
            const input = (args ?? {});
            const config = resolveConfig(pluginConfig);
            const cwd = resolveCwd(exec);
            const query = asString(input.query);
            const repoId = asString(input.repo_id);
            const filename = asString(input.filename);
            const action = asString(input.action) ??
                (query ? 'search' : filename ? 'download' : 'files');
            const client = clientFor(config);
            try {
                if (action === 'search') {
                    if (!query) {
                        return { text: '❌ action=search requires query.', success: false, action };
                    }
                    const limit = clampInt(input.limit, 1, 100, 20);
                    const models = await client.search(query, limit, exec?.signal);
                    const text = models.length
                        ? [`Hugging Face models matching ${JSON.stringify(query)} (${models.length}):`, '', ...models.map(modelLine)].join('\n')
                        : `No Hugging Face models matched ${JSON.stringify(query)}.`;
                    return {
                        text,
                        success: true,
                        action,
                        count: models.length,
                        models: models
                    };
                }
                if (action === 'files') {
                    if (!repoId) {
                        return { text: '❌ action=files requires repo_id.', success: false, action };
                    }
                    const result = await client.files(repoId, asString(input.revision) ?? 'main', exec?.signal);
                    const limit = clampInt(input.limit, 1, 500, 100);
                    const files = result.files.slice(0, limit);
                    const text = [
                        `Repository: ${result.repo_id}`,
                        `Revision: ${result.revision}`,
                        `Files: ${result.files.length}${result.files.length > files.length ? ` (showing ${files.length})` : ''}`,
                        ...(result.gated ? [`Gated: ${String(result.gated)}`] : []),
                        '',
                        ...files.map((file) => `- ${file.path}${file.size !== undefined ? ` [${formatBytes(file.size)}]` : ''}${file.lfs_sha256 ? ` sha256:${file.lfs_sha256}` : ''}`)
                    ].join('\n');
                    return {
                        text,
                        success: true,
                        action,
                        repo_id: result.repo_id,
                        revision: result.revision,
                        count: files.length,
                        total: result.files.length,
                        ...(result.gated !== undefined ? { gated: String(result.gated) } : {}),
                        files: files
                    };
                }
                if (action !== 'download') {
                    return { text: `❌ Unknown action: ${action}.`, success: false, action };
                }
                if (!repoId || !filename) {
                    return { text: '❌ action=download requires repo_id and filename.', success: false, action };
                }
                const revision = asString(input.revision) ?? 'main';
                const folder = asString(input.folder) ?? 'checkpoints';
                const destination = resolveDownloadDestination(config, cwd, {
                    filename,
                    folder,
                    ...(asString(input.target_filename) ? { targetFilename: asString(input.target_filename) } : {}),
                    ...(asString(input.output_dir) ? { outputDir: asString(input.output_dir) } : {})
                });
                const maxBytes = config.maxDownloadBytes;
                const dryRun = asBool(input.dry_run, false);
                if (dryRun) {
                    const head = await client.head(repoId, filename, revision, exec?.signal);
                    const text = [
                        `Dry run: ${repoId}/${filename}`,
                        `Revision: ${revision}`,
                        `Remote size: ${formatBytes(head.size)}`,
                        `Would write to: ${destination.target}`,
                        destination.installed ? 'Destination: ComfyUI models directory' : 'Destination: local staging directory'
                    ].join('\n');
                    return {
                        text,
                        success: true,
                        action,
                        repo_id: repoId,
                        filename,
                        revision,
                        folder: destination.folder,
                        installed: destination.installed,
                        dry_run: true,
                        ...(head.size !== undefined ? { size: head.size } : {})
                    };
                }
                const result = await client.download({
                    repoId,
                    filename,
                    revision,
                    destination,
                    maxBytes,
                    overwrite: asBool(input.overwrite, false),
                    ...(exec?.signal ? { signal: exec.signal } : {})
                });
                const notes = [];
                if (!destination.installed) {
                    notes.push(`Saved outside ComfyUI's models directory. Copy it to ComfyUI/models/${destination.folder}/, or set comfyuiModelsDir in the plugin page.`);
                }
                else {
                    notes.push(`ComfyUI should discover it under models/${destination.folder}/; restart or refresh ComfyUI if it does not.`);
                }
                if (config.huggingFaceToken)
                    notes.push('Authenticated Hugging Face download.');
                const text = [
                    `✅ Downloaded ${repoId}/${filename}`,
                    '',
                    `Path: ${result.path}`,
                    `Size: ${formatBytes(result.bytes)}`,
                    `Folder: ${destination.folder}`,
                    destination.installed ? 'Installed in the configured ComfyUI models directory.' : 'Saved to local staging.',
                    '',
                    ...notes.map((note) => `- ${note}`)
                ].join('\n');
                return {
                    text,
                    success: true,
                    action,
                    repo_id: repoId,
                    filename,
                    revision,
                    path: result.path,
                    bytes: result.bytes,
                    folder: destination.folder,
                    installed: destination.installed,
                    notes
                };
            }
            catch (error) {
                if (error instanceof ImagePluginError) {
                    return { text: `❌ ${formatError(error)}`, success: false, action, notes: [formatError(error)] };
                }
                return {
                    text: `❌ Hugging Face action failed: ${formatError(error)}`,
                    success: false,
                    action,
                    notes: [formatError(error)]
                };
            }
        }
    };
}
