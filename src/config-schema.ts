/**
 * Editable Cordis config schema for the plugin page.
 *
 * Every field is optional and volatile:
 * - optional, so an unset field still falls through to the config file, environment and defaults;
 * - volatile, so the Settings form can write it into the active profile and DSH can update the
 *   running plugin without a remount.
 *
 * No defaults live here on purpose. A schema default would become a plugin-config value and
 * silently override the lower-priority config file and environment layers.
 */
import Schema from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  baseUrl: Schema.string().volatile(),
  outputDir: Schema.string().volatile(),
  requestTimeoutMs: Schema.number().volatile(),
  timeoutMs: Schema.number().volatile(),
  pollIntervalMs: Schema.number().volatile(),
  checkpoint: Schema.string().volatile(),
  negativePrompt: Schema.string().volatile(),
  steps: Schema.number().volatile(),
  cfgScale: Schema.number().volatile(),
  samplerName: Schema.string().volatile(),
  scheduler: Schema.string().volatile(),
  width: Schema.number().volatile(),
  height: Schema.number().volatile(),
  strength: Schema.number().volatile(),
  inpaintGrowMask: Schema.number().volatile(),
  saveToComfyUI: Schema.boolean().volatile(),
  writeMetadata: Schema.boolean().volatile(),
  rembgNode: Schema.string().volatile(),
  huggingFaceToken: Schema.string().role('secret').volatile(),
  huggingFaceEndpoint: Schema.string().volatile(),
  comfyuiModelsDir: Schema.string().volatile(),
  modelDownloadDir: Schema.string().volatile(),
  maxDownloadBytes: Schema.number().volatile()
})
