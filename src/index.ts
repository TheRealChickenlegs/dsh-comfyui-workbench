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
import { resolveConfig } from './config.js'
import { logInfo, logWarn } from './log.js'
import { PLUGIN_VERSION } from './runner.js'
import { createGenerateImageTool, TOOL_NAME } from './tool.js'

/** Plugin name (also the default id of the loader entry). */
export const name = 'dsh-comfyui-image'

/** The tool registry service this plugin depends on. */
export const inject = ['tools']

/** Minimal host context surface. */
interface HostContextLike {
  reflect?: { get?: (key: string, strict?: boolean) => unknown }
  get?: (key: string) => unknown
}

/** Get the tool registry; returns undefined when unavailable (the plugin must not take DSH down). */
function getToolRegistry(ctx: HostContextLike): ToolRegistryLike | undefined {
  const candidates: unknown[] = []
  if (typeof ctx.reflect?.get === 'function') {
    candidates.push(ctx.reflect.get('tools', false))
    candidates.push(ctx.reflect.get('tools'))
  }
  if (typeof ctx.get === 'function') candidates.push(ctx.get('tools'))
  for (const candidate of candidates) {
    if (candidate && typeof (candidate as ToolRegistryLike).register === 'function') {
      return candidate as ToolRegistryLike
    }
  }
  return undefined
}

interface ToolRegistryLike {
  register: (definition: unknown) => unknown
}

/**
 * The plugin body.
 *
 * @param ctx    Host context
 * @param config Plugin config (the contents of `config:` in cordis.patch.yml, may be empty)
 */
export function apply(ctx: HostContextLike, config?: unknown): void {
  const tools = getToolRegistry(ctx)
  if (!tools) {
    logWarn('Cannot obtain the tools service; generate_image was not registered (check the plugin dependencies in the profile).')
    return
  }

  tools.register(createGenerateImageTool(config))

  // Print one summary line at startup: do **not** make network requests during loading, to avoid slowing DSH startup.
  const resolved = resolveConfig(config)
  logInfo(
    `v${PLUGIN_VERSION} ready, registered tool ${TOOL_NAME} (four modes). ComfyUI address: ${resolved.baseUrl}` +
      (resolved.checkpoint ? `, checkpoint: ${resolved.checkpoint}` : ', checkpoint: automatic')
  )
  if (resolved.baseUrl.includes('0.0.0.0')) {
    logWarn('baseUrl contains 0.0.0.0. That works in a browser address bar, but as a request target use 127.0.0.1 instead.')
  }
}

/* ─────────────── Re-exports for local tests (unit-testable without starting DSH) ─────────────── */
export { ComfyUIClient } from './comfy/client.js'
export { chooseCheckpoint, chooseRembgPlan, chooseSampler, declaredInputs, enumChoices, pickDeclaredKey } from './comfy/nodes.js'
export { buildWorkflow, buildText2Img, buildImg2Img, buildInpaint, buildRemoveBackground, filenamePrefixFor, applyCustomWorkflow } from './comfy/workflows.js'
export { DEFAULTS, CONFIG_FILE, readConfigFile, resolveConfig, suggestSizeForCheckpoint, writeConfigFile } from './config.js'
export { formatError, ImagePluginError } from './errors.js'
export { guessImageMime, planOutputFile, randomSeed, timestampSlug } from './files.js'
export { inferMode, normalizeRequest } from './params.js'
export { formatResult, renderResultText } from './result.js'
export { runGeneration, pickImageRef, PLUGIN_VERSION } from './runner.js'
export { createGenerateImageTool, PARAMETERS_SCHEMA, OUTPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_NAME, resolveCwd } from './tool.js'
export type { GenerateImageArgs, GenerateMode, NormalizedRequest } from './types.js'
