/**
 * The plugin's own error type.
 *
 * Why a dedicated type: DSH shows the `message` we throw directly to the model, so an error
 * message must **guide the next action** (start ComfyUI / check the path / install a node)
 * instead of dumping a bare `fetch failed`. `hint` holds the "what to do" part.
 */

/** Base class for every error this plugin throws on purpose. */
export class ImagePluginError extends Error {
  /** A next-step suggestion for the user/model. */
  readonly hint?: string

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ImagePluginError'
    if (hint) this.hint = hint
  }
}

/** Compose a complete error: main message + optional next-step suggestion. */
export function formatError(error: unknown): string {
  if (error instanceof ImagePluginError) {
    return error.hint ? `${error.message}\nNext step: ${error.hint}` : error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** ComfyUI is unreachable (not running / wrong address / wrong port). */
export function comfyUnreachable(baseUrl: string, cause?: unknown): ImagePluginError {
  const detail = cause instanceof Error ? ` (${cause.message})` : ''
  return new ImagePluginError(
    `Cannot reach ComfyUI at ${baseUrl}${detail}`,
    'Start the local ComfyUI service first (it listens on 127.0.0.1:8188 by default), or fix the ' +
      'address: change baseUrl in ~/.dsh-comfyui-image/config.json, or set the environment variable ' +
      'COMFYUI_URL=http://host:port.'
  )
}

/** An input/output file does not exist. */
export function fileMissing(kind: string, path: string): ImagePluginError {
  return new ImagePluginError(
    `${kind} does not exist: ${path}`,
    'Check the path is correct, and use either an absolute path or a path relative to the current working directory.'
  )
}

/** Arguments conflict (deliberately no black-box guessing: a conflict is an error). */
export function argConflict(message: string, hint?: string): ImagePluginError {
  return new ImagePluginError(message, hint)
}

/** A required ComfyUI node does not exist. */
export function nodeMissing(classType: string, hint: string): ImagePluginError {
  return new ImagePluginError(`ComfyUI has no node named \`${classType}\``, hint)
}

/** The workflow failed while executing inside ComfyUI. */
export function executionFailed(detail: string, promptId: string): ImagePluginError {
  return new ImagePluginError(
    `ComfyUI failed to execute the workflow (prompt_id=${promptId}): ${detail}`,
    'The two most common causes: a node/model used by the workflow does not exist on this machine ' +
      '(check the ComfyUI console for red errors), or VRAM ran out. You can also retry with smaller ' +
      'model parameters: reduce model / steps / width / height in generate_image.'
  )
}

/** Timed out. */
export function timedOut(waitedMs: number, promptId: string, baseUrl: string): ImagePluginError {
  return new ImagePluginError(
    `Timed out waiting for ComfyUI to produce an image (waited ${Math.round(waitedMs / 1000)} s, prompt_id=${promptId})`,
    `Check whether ComfyUI at ${baseUrl} is stuck or busy running another job (look at its queue). ` +
      'You can also increase timeoutMs in the configuration.'
  )
}
