/**
 * Must be the first module imported.
 *
 * Why: `lib/config.js` fixes `CONFIG_FILE` at **module load time**
 * (`process.env.DSH_COMFYUI_IMAGE_CONFIG || ~/.dsh-comfyui-image/config.json`).
 * Setting the environment variable after the import would leave the plugin reading and writing the
 * user's real config file — tests would touch real user data. So this points it at a temp directory
 * **before any** lib import.
 *
 * This file imports no lib code; that is the premise that makes it meaningful.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cii-cfg-'))

/** The plugin config file path used by this test process. */
export const CONFIG_PATH = path.join(dir, 'config.json')

process.env.DSH_COMFYUI_IMAGE_CONFIG = CONFIG_PATH
