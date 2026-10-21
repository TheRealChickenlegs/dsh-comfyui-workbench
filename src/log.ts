/**
 * Minimal logging: only prints lines prefixed with `[dsh-comfyui-image]`, and only when needed.
 *
 * Quiet by default: a normal generation only logs under debug, to avoid polluting DSH session
 * output. Enable with the environment variable `DSH_COMFYUI_IMAGE_DEBUG=1`.
 */

const PREFIX = '[dsh-comfyui-image]'

const debugEnabled = (): boolean => {
  const raw = process.env.DSH_COMFYUI_IMAGE_DEBUG
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Important lifecycle information (plugin loaded, tool registered, config problems) — always printed. */
export function logInfo(message: string): void {
  console.log(`${PREFIX} ${message}`)
}

/** Warning — always printed, but only for "it works, yet you should know" situations. */
export function logWarn(message: string): void {
  console.warn(`${PREFIX} ${message}`)
}

/** Debug details (HTTP requests, node probing, workflows) — requires DSH_COMFYUI_IMAGE_DEBUG=1. */
export function logDebug(message: string, detail?: unknown): void {
  if (!debugEnabled()) return
  if (detail === undefined) {
    console.log(`${PREFIX} ${message}`)
    return
  }
  let rendered: string
  try {
    rendered = typeof detail === 'string' ? detail : JSON.stringify(detail)
  } catch {
    rendered = String(detail)
  }
  console.log(`${PREFIX} ${message} ${rendered}`)
}
