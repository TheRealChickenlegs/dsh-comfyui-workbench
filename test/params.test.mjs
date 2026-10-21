/**
 * Offline tests for the parameter layer (unified argument layer + smart defaults + mode inference).
 * No network, no service: pure function verification.
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { inferMode, normalizeRequest, ImagePluginError } from '../lib/index.js'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const cwd = tempDir('params')
const config = testConfig()

function normalize(args, overrides = {}) {
  return normalizeRequest(args, { cwd, config: overrides.config ?? config })
}

/* ─────────────────────────── mode inference (three rules) ─────────────────────────── */

test('inference: prompt only → text2img', () => {
  assert.equal(inferMode({ prompt: 'a cat' }), 'text2img')
  const { request, modeInferred } = normalize({ prompt: 'a cat' })
  assert.equal(request.mode, 'text2img')
  assert.equal(modeInferred, true)
})

test('inference: input_image present → img2img', () => {
  const input = writePng(path.join(cwd, 'in.png'))
  assert.equal(inferMode({ prompt: 'x', input_image: input }), 'img2img')
  const { request, modeInferred } = normalize({ prompt: 'x', input_image: input })
  assert.equal(request.mode, 'img2img')
  assert.equal(modeInferred, true)
})

test('inference: input_image + mask_image → inpaint', () => {
  const input = writePng(path.join(cwd, 'in2.png'))
  const mask = writePng(path.join(cwd, 'mask2.png'))
  assert.equal(inferMode({ prompt: 'x', input_image: input, mask_image: mask }), 'inpaint')
  const { request } = normalize({ prompt: 'x', input_image: input, mask_image: mask })
  assert.equal(request.mode, 'inpaint')
})

test('an explicit mode takes precedence over inference', () => {
  const input = writePng(path.join(cwd, 'in3.png'))
  const { request, modeInferred } = normalize({ mode: 'img2img', prompt: 'x', input_image: input })
  assert.equal(request.mode, 'img2img')
  assert.equal(modeInferred, false)
})

/* ───────────────────────── conflicts: clear errors, no guessing ───────────────────────── */

test('conflict: mode=text2img with input_image → error with a fix', () => {
  const input = writePng(path.join(cwd, 'c1.png'))
  assert.throws(
    () => normalize({ mode: 'text2img', prompt: 'x', input_image: input }),
    (error) => {
      assert.ok(error instanceof ImagePluginError)
      assert.match(error.message, /text2img does not accept input_image/)
      assert.match(error.hint, /img2img/)
      return true
    }
  )
})

test('conflict: mode=img2img without input_image → error', () => {
  assert.throws(() => normalize({ mode: 'img2img', prompt: 'x' }), /img2img requires input_image/)
})

test('conflict: mode=inpaint without mask_image → error', () => {
  const input = writePng(path.join(cwd, 'c2.png'))
  assert.throws(
    () => normalize({ mode: 'inpaint', prompt: 'x', input_image: input }),
    /inpaint requires mask_image/
  )
})

test('conflict: mask given without input → error', () => {
  const mask = writePng(path.join(cwd, 'c3.png'))
  assert.throws(() => normalize({ prompt: 'x', mask_image: mask }), /without input_image/)
})

test('conflict: mode=remove_background without input_image → error', () => {
  assert.throws(
    () => normalize({ mode: 'remove_background' }),
    /remove_background requires input_image/
  )
})

test('conflict: unknown mode → error listing the four supported modes', () => {
  assert.throws(
    () => normalize({ mode: 'outpaint', prompt: 'x' }),
    (error) => {
      assert.match(error.message, /Unknown mode/)
      assert.match(error.hint, /text2img \/ img2img \/ inpaint \/ remove_background/)
      return true
    }
  )
})

test('conflict: text2img without prompt → error', () => {
  assert.throws(() => normalize({}), /text2img requires prompt/)
})

/* ─────────────────────────── input files must exist ─────────────────────────── */

test('input_image missing → error (not discovered only after submitting the workflow)', () => {
  assert.throws(
    () => normalize({ prompt: 'x', input_image: path.join(cwd, 'no-such-image.png') }),
    /input_image points to a file that does not exist/
  )
})

test('mask_image missing → error', () => {
  const input = writePng(path.join(cwd, 'c4.png'))
  assert.throws(
    () => normalize({ prompt: 'x', input_image: input, mask_image: path.join(cwd, 'nope.png') }),
    /mask_image points to a file that does not exist/
  )
})

/* ─────────────────────────── defaults and range validation ─────────────────────────── */

test('defaults: width/height/seed/steps/CFG all get sensible defaults', () => {
  const { request } = normalize({ prompt: 'a cat' })
  assert.equal(request.width, config.width)
  assert.equal(request.height, config.height)
  assert.equal(request.steps, config.steps)
  assert.equal(request.cfgScale, config.cfgScale)
  assert.equal(request.samplerName, config.samplerName)
  assert.equal(request.scheduler, config.scheduler)
  assert.ok(Number.isInteger(request.seed) && request.seed >= 0 && request.seed <= 4294967295)
  assert.ok(request.negativePrompt.length > 0, 'the negative prompt should have a default')
})

test('default output: lands in cwd (the project root) and filenames do not repeat', () => {
  const a = normalize({ prompt: 'a cat' }).request
  const b = normalize({ prompt: 'a cat' }).request
  assert.equal(path.dirname(a.outputPath), cwd)
  assert.match(path.basename(a.outputPath), /^comfyui-.*\.png$/)
  assert.notEqual(a.outputPath, b.outputPath, 'two calls should not collide on the same filename')
})

test('default output never overwrites: a specified file that exists is renamed', () => {
  const target = path.join(cwd, 'guarded.png')
  writePng(target)
  const { request } = normalize({ prompt: 'a cat', output_path: target })
  assert.equal(request.outputPath, path.join(cwd, 'guarded-1.png'))
})

test('seed=0 must be treated as a valid value (not swallowed by ??)', () => {
  const { request } = normalize({ prompt: 'a cat', seed: 0 })
  assert.equal(request.seed, 0)
})

test('dimensions are aligned to a multiple of 8, with an explanation', () => {
  const { request } = normalize({ prompt: 'a cat', width: 513, height: 500 })
  assert.equal(request.width, 512)
  assert.equal(request.height, 504)
  assert.ok(request.notes.some((note) => note.includes('multiple of 8')))
})

test('width/height out of range → a clear error', () => {
  assert.throws(() => normalize({ prompt: 'x', width: 9000 }), /width is outside the allowed range/)
  assert.throws(() => normalize({ prompt: 'x', steps: 0 }), /steps is outside the allowed range/)
  assert.throws(() => normalize({ prompt: 'x', cfg_scale: 200 }), /cfg_scale is outside the allowed range/)
  assert.throws(() => normalize({ prompt: 'x', strength: 2 }), /strength is outside the allowed range/)
})

test('width as a string → error (instead of silently becoming NaN)', () => {
  assert.throws(() => normalize({ prompt: 'x', width: '512' }), /width must be a number/)
})

test('img2img with width/height → ignored with an explanation (canvas follows the input image)', () => {
  const input = writePng(path.join(cwd, 'c5.png'))
  const { request } = normalize({ prompt: 'x', input_image: input, width: 768, height: 768 })
  assert.ok(request.notes.some((note) => note.includes('takes its output size from the input image')))
})

test('inpaint defaults strength to 1.0; img2img uses the configured default', () => {
  const input = writePng(path.join(cwd, 'c6.png'))
  const mask = writePng(path.join(cwd, 'c7.png'))
  assert.equal(normalize({ prompt: 'x', input_image: input, mask_image: mask }).request.strength, 1)
  assert.equal(normalize({ prompt: 'x', input_image: input }).request.strength, config.strength)
})

test('remove_background ignores prompt and leaves an explanation', () => {
  const input = writePng(path.join(cwd, 'c8.png'))
  const { request } = normalize({ mode: 'remove_background', prompt: 'ignored prompt', input_image: input })
  assert.equal(request.prompt, '')
  assert.ok(request.notes.some((note) => note.includes('does not use prompt')))
})

test('style_reference / character_reference are recorded only in V1 and do not affect generation', () => {
  const style = writePng(path.join(cwd, 'style.png'))
  const character = writePng(path.join(cwd, 'char.png'))
  const { request } = normalize({
    prompt: 'x',
    style_reference: style,
    character_reference: character
  })
  assert.equal(request.styleReference, style)
  assert.equal(request.characterReference, character)
  assert.ok(request.notes.some((note) => note.includes('style_reference')))
})

test('extra_options that is not an object → safely degrades to an empty object', () => {
  assert.deepEqual(normalize({ prompt: 'x', extra_options: 'nope' }).request.extra, {})
  assert.deepEqual(normalize({ prompt: 'x', extra_options: { a: 1 } }).request.extra, { a: 1 })
})
