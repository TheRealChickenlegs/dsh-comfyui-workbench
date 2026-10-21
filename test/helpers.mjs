/**
 * Shared test utilities.
 *
 * Two principles:
 *   1. **Never touch real user data**: the plugin config file location is pointed at a temp
 *      directory via `DSH_COMFYUI_IMAGE_CONFIG`, and the output directory is a temp directory too.
 *   2. **Config values must stay in their legal ranges**: `pickNumber(100, 10000, ...)` in
 *      `resolveConfig` drops out-of-range values and falls back to the defaults, so tests must not
 *      pass `pollIntervalMs` below 100 or `timeoutMs` below 1000 — otherwise the measured wait times
 *      would be fictitious.
 */
// Must come first: it points the plugin config file at a temp directory, and lib fixes that path at load time.
import { CONFIG_PATH } from './env-setup.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePng } from './mock-comfyui.mjs'
import { resolveConfig } from '../lib/index.js'

let counter = 0

/** Create a temp directory (not deleted automatically, so you can inspect the scene after a failure). */
export function tempDir(tag = 'dsh-cii') {
  counter += 1
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-${process.pid}-${counter}-`))
}

/**
 * Return the plugin config file path used by this test process.
 *
 * Note: it does **not** "take effect by itself" — lib already fixed `CONFIG_FILE` to the temp path
 * from `env-setup.mjs` when it loaded. This function just hands you that same path, avoiding the
 * fake isolation of "set a new path that was never read".
 */
export function isolatePluginConfig() {
  return CONFIG_PATH
}

/**
 * Build a test configuration.
 * `baseUrl` defaults to a port that can never connect; only override it when a service is really
 * needed — that way an "accidental network request" fails immediately instead of quietly reaching a
 * real ComfyUI on the machine's 8188.
 */
export function testConfig(overrides = {}) {
  isolatePluginConfig()
  return resolveConfig({
    baseUrl: 'http://127.0.0.1:1',
    pollIntervalMs: 100,
    timeoutMs: 5000,
    requestTimeoutMs: 3000,
    ...overrides
  })
}

/** Write a real PNG to the given path and return the path. */
export function writePng(file, width = 64, height = 64) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, makePng(width, height))
  return file
}

/** Build a fake "execution context" with cwd on agent.meta.cwd (one of the real host shapes). */
export function fakeExec(cwd, signal) {
  return {
    agent: { meta: { cwd } },
    ...(signal ? { signal } : {})
  }
}
