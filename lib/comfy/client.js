import { comfyUnreachable, executionFailed, ImagePluginError } from '../errors.js';
import { logDebug } from '../log.js';
/** Combine an external AbortSignal with a timeout, preserving "who triggered it" information. */
function linkSignal(external, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (external) {
        if (external.aborted)
            controller.abort();
        else
            external.addEventListener('abort', onAbort);
    }
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            external?.removeEventListener('abort', onAbort);
        },
        timedOut: () => timedOut
    };
}
export class ComfyUIClient {
    baseUrl;
    requestTimeoutMs;
    /** `/object_info` cache: the response can be several MB, no point refetching it within one process. */
    objectInfoCache;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.requestTimeoutMs = options.requestTimeoutMs;
    }
    get url() {
        return this.baseUrl;
    }
    async request(pathname, init, external, timeoutMs = this.requestTimeoutMs) {
        const linked = linkSignal(external, timeoutMs);
        const target = `${this.baseUrl}${pathname}`;
        try {
            logDebug(`HTTP ${init.method ?? 'GET'} ${target}`);
            const response = await fetch(target, { ...init, signal: linked.signal });
            return response;
        }
        catch (error) {
            if (linked.timedOut()) {
                throw new ImagePluginError(`ComfyUI request timed out: ${target} (exceeded ${timeoutMs} ms)`, 'ComfyUI may be busy or stuck; try again later, or increase requestTimeoutMs in the configuration.');
            }
            if (external?.aborted) {
                throw new ImagePluginError('Cancelled: the caller aborted this generation.');
            }
            throw comfyUnreachable(this.baseUrl, error);
        }
        finally {
            linked.dispose();
        }
    }
    async json(pathname, init, external, timeoutMs) {
        const response = await this.request(pathname, init, external, timeoutMs);
        const text = await response.text();
        if (!response.ok) {
            throw this.httpError(pathname, response.status, text);
        }
        try {
            return JSON.parse(text);
        }
        catch {
            throw new ImagePluginError(`ComfyUI returned invalid JSON (${pathname}): ${text.slice(0, 300)}`, 'This usually means the address points at a different service (for example a plain web server). Confirm that baseUrl really is ComfyUI.');
        }
    }
    httpError(pathname, status, body) {
        const snippet = body.slice(0, 500).replace(/\s+/g, ' ').trim();
        if (status === 404) {
            return new ImagePluginError(`ComfyUI has no endpoint ${pathname} (404).`, 'Confirm that this address really is a ComfyUI service and that its version is not too old (/prompt and /history are standard endpoints).');
        }
        return new ImagePluginError(`ComfyUI returned HTTP ${status} (${pathname}): ${snippet || '(empty response)'}`, 'Take a look at the ComfyUI console output; it usually contains a more specific error.');
    }
    /** Health check: are we really talking to ComfyUI? */
    async systemStats(external) {
        return this.json('/system_stats', { method: 'GET' }, external, 8_000);
    }
    /** Fetch the node catalogue (cached). */
    async objectInfo(external, maxAgeMs = 60_000) {
        const now = Date.now();
        if (this.objectInfoCache && now - this.objectInfoCache.fetchedAt < maxAgeMs) {
            return this.objectInfoCache.data;
        }
        const data = await this.json('/object_info', { method: 'GET' }, external, 30_000);
        this.objectInfoCache = { fetchedAt: now, data };
        logDebug(`Fetched /object_info, ${Object.keys(data).length} nodes`);
        return data;
    }
    /** The definition of a single node (tries /object_info/{node} first, falling back to the full table). */
    async nodeInfo(classType, external) {
        try {
            const single = await this.json(`/object_info/${encodeURIComponent(classType)}`, { method: 'GET' }, external, 20_000);
            if (single && typeof single === 'object' && single[classType])
                return single[classType];
            if (single && typeof single === 'object' && Object.keys(single).length > 0) {
                return Object.values(single)[0];
            }
        }
        catch (error) {
            logDebug(`/object_info/${classType} unavailable, falling back to the full table`, String(error));
        }
        const all = await this.objectInfo(external);
        return all[classType];
    }
    /** Whether a node exists (used for capability probing). */
    async hasNode(classType, external) {
        return (await this.nodeInfo(classType, external)) !== undefined;
    }
    /** Upload a local image into ComfyUI's input directory. */
    async uploadImage(input, external) {
        const form = new FormData();
        // Do not rely on a global File; Blob plus a third filename argument works on Node 20+ undici.
        const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mime });
        form.append('image', blob, input.filename);
        form.append('overwrite', input.overwrite === false ? 'false' : 'true');
        if (input.subfolder)
            form.append('subfolder', input.subfolder);
        form.append('type', 'input');
        const result = await this.json('/upload/image', { method: 'POST', body: form }, external, 60_000);
        logDebug('Image uploaded successfully', result);
        return result;
    }
    /**
     * Submit a workflow.
     * ComfyUI returns 400 + `node_errors` when node validation fails; translate that into a human-readable error.
     */
    async queuePrompt(workflow, clientId, external) {
        const response = await this.request('/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId })
        }, external, 60_000);
        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new ImagePluginError(`Failed to submit the workflow: ComfyUI returned non-JSON (HTTP ${response.status}).`, text.slice(0, 300));
        }
        const nodeErrors = parsed.node_errors && Object.keys(parsed.node_errors).length > 0 ? parsed.node_errors : undefined;
        if (!response.ok || nodeErrors || !parsed.prompt_id) {
            const detail = nodeErrors
                ? Object.entries(nodeErrors)
                    .map(([nodeId, value]) => {
                    const errors = value && typeof value === 'object' && 'errors' in value
                        ? JSON.stringify(value.errors)
                        : JSON.stringify(value);
                    return `Node ${nodeId}: ${errors}`;
                })
                    .join('; ')
                : JSON.stringify(parsed.error ?? text.slice(0, 400));
            throw new ImagePluginError(`The workflow was rejected by ComfyUI (HTTP ${response.status}): ${detail}`, 'The most common causes are a model/node referenced by the workflow that does not exist on this machine, ' +
                'or a parameter of the wrong type. Check that the model passed to generate_image (the checkpoint file ' +
                'name) matches a name under ComfyUI models/checkpoints.');
        }
        logDebug(`Workflow submitted, prompt_id=${parsed.prompt_id}`);
        return { promptId: parsed.prompt_id };
    }
    /** Look up one history entry; undefined while it has not finished. */
    async historyEntry(promptId, external) {
        const data = await this.json(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' }, external);
        return data[promptId];
    }
    /** Fetch the produced image bytes. */
    async viewImage(ref, external) {
        const params = new URLSearchParams({
            filename: ref.filename,
            subfolder: ref.subfolder ?? '',
            type: ref.type || 'output'
        });
        const response = await this.request(`/view?${params.toString()}`, { method: 'GET' }, external, 120_000);
        if (!response.ok) {
            const body = await response.text();
            throw this.httpError(`/view?${params.toString()}`, response.status, body);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
    /** Cancel the currently running job (best effort; a failure does not affect the main flow). */
    async interrupt(external) {
        try {
            await this.json('/interrupt', { method: 'POST' }, external, 10_000);
        }
        catch (error) {
            logDebug('interrupt failed (ignored)', String(error));
        }
    }
}
/**
 * Extract "what exactly went wrong" from the history status and turn it into one readable sentence.
 * ComfyUI puts errors inside the `status.messages` array, shaped like:
 *   [["execution_start", {...}], ["execution_error", { node_id, node_type, exception_message, ... }]]
 */
export function describeHistoryError(entry, promptId) {
    const messages = entry.status?.messages ?? [];
    for (const message of messages) {
        if (!Array.isArray(message) || message.length < 2)
            continue;
        const [kind, payload] = message;
        if (kind === 'execution_error' && payload && typeof payload === 'object') {
            const info = payload;
            const parts = [
                info.node_type ? `Node type ${String(info.node_type)}` : '',
                info.node_id ? `(id=${String(info.node_id)})` : '',
                info.exception_type ? `Exception ${String(info.exception_type)}` : '',
                info.exception_message ? `: ${String(info.exception_message)}` : ''
            ].filter(Boolean);
            return executionFailed(parts.join(' ') || 'unknown execution error', promptId);
        }
        if (kind === 'execution_interrupted') {
            return new ImagePluginError(`ComfyUI execution was interrupted (prompt_id=${promptId}).`, 'Someone may have clicked Cancel in the ComfyUI UI, or the plugin cancelled the job. Retry once.');
        }
    }
    return executionFailed(`status was ${String(entry.status?.status_str ?? 'error')}, but there are no more details`, promptId);
}
