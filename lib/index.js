/**
 * Plugin entry point (host side).
 *
 * How it mounts: after loading this package, the DSH Loader calls `apply(ctx, config)`;
 * `inject = ['tools']` guarantees `ctx.reflect.get('tools')` can obtain the tool registry.
 *
 * ⚠️ Hard-won lesson (same as dsh-novel): do **not** import any `@deepseek-ai/*` host package in a
 * plugin. Under a link install, Node resolves node_modules from the physical path and inevitably
 * throws ERR_MODULE_NOT_FOUND. `tools.register()` accepts a plain object, so no type imports are
 * needed at all.
 */
import { resolveConfig } from './config.js';
import { PLUGIN_ID, PLUGIN_DISPLAY_NAME } from './identity.js';
import { logInfo, logWarn } from './log.js';
import { PLUGIN_VERSION } from './runner.js';
import { createGenerateImageTool, TOOL_NAME } from './tool.js';
import { ADVANCED_TOOL_NAMES, createComfyUIApiTool, createComfyUIInspectTool, createComfyUIWorkflowTool } from './comfy-tools.js';
/** Plugin name (also the default id of the loader entry). */
export const name = PLUGIN_ID;
/** The tool registry service this plugin depends on. */
export const inject = ['tools'];
/** Get the tool registry; returns undefined when unavailable (the plugin must not take DSH down). */
function getToolRegistry(ctx) {
    const candidates = [];
    if (typeof ctx.reflect?.get === 'function') {
        candidates.push(ctx.reflect.get('tools', false));
        candidates.push(ctx.reflect.get('tools'));
    }
    if (typeof ctx.get === 'function')
        candidates.push(ctx.get('tools'));
    for (const candidate of candidates) {
        if (candidate && typeof candidate.register === 'function') {
            return candidate;
        }
    }
    return undefined;
}
/**
 * The plugin body.
 *
 * @param ctx    Host context
 * @param config Plugin config (the contents of `config:` in cordis.patch.yml, may be empty)
 */
export function apply(ctx, config) {
    const tools = getToolRegistry(ctx);
    if (!tools) {
        logWarn('Cannot obtain the tools service; the ComfyUI tools were not registered (check the plugin dependencies in the profile).');
        return;
    }
    tools.register(createGenerateImageTool(config));
    tools.register(createComfyUIInspectTool(config));
    tools.register(createComfyUIWorkflowTool(config));
    tools.register(createComfyUIApiTool(config));
    // Print one summary line at startup: do **not** make network requests during loading, to avoid slowing DSH startup.
    const resolved = resolveConfig(config);
    const registered = [TOOL_NAME, ...ADVANCED_TOOL_NAMES].join(', ');
    logInfo(`${PLUGIN_DISPLAY_NAME} v${PLUGIN_VERSION} ready, registered tools: ${registered}. ComfyUI address: ${resolved.baseUrl}` +
        (resolved.checkpoint ? `, checkpoint: ${resolved.checkpoint}` : ', checkpoint: automatic'));
    if (resolved.baseUrl.includes('0.0.0.0')) {
        logWarn('baseUrl contains 0.0.0.0. That works in a browser address bar, but as a request target use 127.0.0.1 instead.');
    }
}
/* ─────────────── Re-exports for local tests (unit-testable without starting DSH) ─────────────── */
export { ComfyUIClient } from './comfy/client.js';
export { chooseCheckpoint, chooseRembgPlan, chooseSampler, declaredInputs, enumChoices, pickDeclaredKey } from './comfy/nodes.js';
export { buildWorkflow, buildText2Img, buildImg2Img, buildInpaint, buildRemoveBackground, filenamePrefixFor, applyCustomWorkflow } from './comfy/workflows.js';
export { DEFAULTS, CONFIG_FILE, LEGACY_CONFIG_FILE, readConfigFile, resolveConfig, suggestSizeForCheckpoint, writeConfigFile } from './config.js';
export { LEGACY_PLUGIN_ID, PLUGIN_DISPLAY_NAME, PLUGIN_ID } from './identity.js';
export { formatError, ImagePluginError } from './errors.js';
export { guessImageMime, planOutputFile, randomSeed, timestampSlug } from './files.js';
export { inferMode, normalizeRequest } from './params.js';
export { formatResult, renderResultText } from './result.js';
export { runGeneration, pickImageRef, PLUGIN_VERSION } from './runner.js';
export { createGenerateImageTool, PARAMETERS_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_NAME, resolveCwd } from './tool.js';
export { ADVANCED_TOOL_NAMES, API_DESCRIPTION, API_OUTPUT_SCHEMA, API_PARAMETERS_SCHEMA, API_TOOL_NAME, INSPECT_DESCRIPTION, INSPECT_OUTPUT_SCHEMA, INSPECT_PARAMETERS_SCHEMA, INSPECT_TOOL_NAME, WORKFLOW_DESCRIPTION, WORKFLOW_OUTPUT_SCHEMA, WORKFLOW_PARAMETERS_SCHEMA, WORKFLOW_TOOL_NAME, createComfyUIApiTool, createComfyUIInspectTool, createComfyUIWorkflowTool } from './comfy-tools.js';
export { describeNode, formatHistorySummary, formatModelCatalog, formatNodeDetail, formatNodeList, formatQueueSummary, formatSystemStats, listModels, searchNodes, summarizeHistory, summarizeNode, summarizeQueue } from './comfy/introspect.js';
export { collectOutputs, formatValidation, formatWorkflowRunText, historyIssues, loadWorkflow, submitWorkflow, validateWorkflow, waitForPrompt, workflowFromHistory } from './comfy/workflow-runner.js';
