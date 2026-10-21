/**
 * Stable plugin identity and legacy names.
 *
 * This module is deliberately dependency-free: config, logging, runner and workflow modules all
 * import it, and none of them should create a dependency cycle through this file.
 *
 * The legacy constants exist only for a one-release migration window (0.2.x). They can be removed
 * in 0.3.0 once users have moved their config and environment variables.
 */
/** Current plugin/package id, also used as the config directory name. */
export const PLUGIN_ID = 'dsh-comfyui-workbench';
/** Human-readable name shown in the DSH plugin list and documentation. */
export const PLUGIN_DISPLAY_NAME = 'ComfyUI Workbench';
/** Previous plugin id; used only for config/env migration. */
export const LEGACY_PLUGIN_ID = 'dsh-comfyui-image';
export const ENV_PREFIX = 'DSH_COMFYUI_WORKBENCH';
export const LEGACY_ENV_PREFIX = 'DSH_COMFYUI_IMAGE';
/** Current environment variables. */
export const ENV_CONFIG = `${ENV_PREFIX}_CONFIG`;
export const ENV_OUTPUT = `${ENV_PREFIX}_OUTPUT`;
export const ENV_DEBUG = `${ENV_PREFIX}_DEBUG`;
/** Previous environment variables, accepted for the 0.2.x migration window. */
export const LEGACY_ENV_CONFIG = `${LEGACY_ENV_PREFIX}_CONFIG`;
export const LEGACY_ENV_OUTPUT = `${LEGACY_ENV_PREFIX}_OUTPUT`;
export const LEGACY_ENV_DEBUG = `${LEGACY_ENV_PREFIX}_DEBUG`;
