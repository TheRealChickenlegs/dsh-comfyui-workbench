/**
 * Shared type definitions for the whole plugin.
 *
 * Design principles (the "unified parameter layer" section of the spec):
 *   - `GenerateImageArgs`   = the **public** contract: exactly the arguments the Agent sees.
 *                             Keep it small and easy to understand.
 *   - `NormalizedRequest`   = the **internal** contract: defaults filled in, mode decided,
 *                             paths resolved. Every downstream module (workflow building /
 *                             execution / writing results) depends only on this.
 *   Keeping the two apart means: changes to ComfyUI internals only touch the workflow module,
 *   while new public arguments only touch args + params.
 */
/** The order here is the precedence used by mode inference. Do not change it casually. */
export const GENERATE_MODES = [
    'text2img',
    'img2img',
    'inpaint',
    'remove_background'
];
export function isGenerateMode(value) {
    return typeof value === 'string' && GENERATE_MODES.includes(value);
}
