/**
 * End-to-end tests: really start a fake ComfyUI and run the whole pipeline for all four modes.
 *
 * This is the plugin's most important evidence: it verifies not "a function returned an object" but
 *   "arguments → workflow → HTTP → polling → fetching the image → writing to disk → metadata"
 * flowing end to end, and that **the produced PNG really has the requested dimensions**
 * (the fake ComfyUI really renders using the EmptyLatentImage size from the workflow).
 */
import './env-setup.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { ImagePluginError, runGeneration } from '../lib/index.js'
import { briaNodes, createMockComfyUI, defaultNodes, readPngSize, wasNodes } from './mock-comfyui.mjs'
import { tempDir, testConfig, writePng } from './helpers.mjs'

const running = []

async function startMock(options = {}) {
  const mock = createMockComfyUI(options)
  const baseUrl = await mock.listen()
  running.push(mock)
  return { mock, baseUrl }
}

after(async () => {
  for (const mock of running) await mock.close()
})

/* ─────────────────────────────── text2img ─────────────────────────────── */

test('text2img end to end: generates, correct size, written to the project root, metadata written', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-t2i')
  const config = testConfig({ baseUrl, width: 512, height: 512 })

  const run = await runGeneration({
    args: { prompt: 'a corgi astronaut, digital art' },
    cwd,
    config
  })

  // A real image was written
  assert.equal(run.outputPaths.length, 1)
  const output = run.outputPaths[0]
  assert.ok(fs.existsSync(output), `the output file should exist: ${output}`)
  assert.equal(path.dirname(output), cwd, 'the default output directory must be the "project root"')
  assert.match(path.basename(output), /^comfyui-.*\.png$/)

  // The image is real, and its size is our 512×512 (not just any image)
  const png = readPngSize(fs.readFileSync(output))
  assert.deepEqual(png, { width: 512, height: 512 }, 'the fake ComfyUI should render at the workflow size')

  assert.equal(run.mode, 'text2img')
  assert.equal(run.modeInferred, true)
  assert.equal(run.checkpoint, 'sd_xl_base_1.0.safetensors', 'when no checkpoint is specified it should auto-pick the one containing xl')
  assert.ok(run.promptId.length > 0)
  assert.equal(run.comfyUrl, baseUrl)
  assert.ok(run.durationMs >= 0)
  assert.ok(
    run.notes.some((note) => note.includes('Checkpoint chosen automatically')),
    'auto-switching the checkpoint must be reported to the caller'
  )

  // Metadata sidecar
  assert.ok(run.metadataPath && fs.existsSync(run.metadataPath), 'a metadata sidecar should be written')
  const meta = JSON.parse(fs.readFileSync(run.metadataPath, 'utf8'))
  assert.equal(meta.mode, 'text2img')
  assert.equal(meta.seed, run.request.seed)
  assert.equal(meta.width, 512)
  assert.equal(meta.height, 512)
  assert.equal(meta.checkpoint, 'sd_xl_base_1.0.safetensors')
  assert.ok(meta.workflow && Object.keys(meta.workflow).length >= 7, 'metadata should store the complete workflow for reproduction')
  assert.equal(meta.outputFile, output)
  assert.ok(meta.pluginVersion.length > 0)

  // Process facts: health check happened, nothing was uploaded, polling did not time out
  assert.ok(mock.state.stats.system_stats >= 1, 'a health check should happen first')
  assert.equal(mock.state.stats.upload, 0)
  assert.ok(mock.state.stats.history >= 2, 'it should poll more than once (simulating a queue)')
  assert.ok(mock.state.stats.view >= 1, 'it should fetch the image bytes')
})

test('text2img: an SD1.5 checkpoint automatically uses 512', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-legacy')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({
    args: { prompt: 'x', model: 'v1-5-pruned-emaonly.safetensors' },
    cwd,
    config
  })

  assert.equal(run.request.width, 512, 'SD1.5-family should use 512 instead of the configured 1024')
  assert.equal(run.request.height, 512)
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 512, height: 512 })
})

test('text2img: with no model passed, an auto-picked SD1.5 checkpoint also decides the default size', async () => {
  // Regression: on a real machine with only an SD1.5 checkpoint it produced 1024×1024, while the tool
  // description promised "size adapts to the checkpoint". The root cause was that adaptation happened
  // in the parameter layer, before the checkpoint was auto-picked, so this must cover the auto-pick path.
  const { baseUrl } = await startMock({ checkpoints: ['v1-5-pruned-emaonly.safetensors'] })
  const cwd = tempDir('e2e-legacy-auto')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({ args: { prompt: 'x' }, cwd, config })

  assert.equal(run.checkpoint, 'v1-5-pruned-emaonly.safetensors', 'it should auto-pick the only SD1.5 checkpoint')
  assert.equal(run.request.width, 512, 'an auto-picked SD1.5 checkpoint must also lower the default size to 512')
  assert.equal(run.request.height, 512)
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 512, height: 512 })
  assert.ok(
    run.notes.some((note) => note.includes('adapted to') && note.includes('512x512')),
    'a changed default size must state its basis in notes'
  )
})

test('text2img: an explicit width wins; only dimensions not given adapt to the checkpoint', async () => {
  const { baseUrl } = await startMock({ checkpoints: ['v1-5-pruned-emaonly.safetensors'] })
  const cwd = tempDir('e2e-legacy-explicit')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })

  const run = await runGeneration({ args: { prompt: 'x', width: 768 }, cwd, config })

  assert.equal(run.request.width, 768, 'an explicit width must not be overridden by checkpoint adaptation')
  assert.equal(run.request.height, 512, 'only the height that was not given adapts to the checkpoint')
})

test('seed is really used in the image, and the same seed reproduces it', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-seed')
  const config = testConfig({ baseUrl, width: 256, height: 256 })

  const run = await runGeneration({ args: { prompt: 'x', seed: 777 }, cwd, config })
  assert.equal(run.request.seed, 777)
  assert.equal(run.workflow['5'].inputs.seed, 777)
  assert.equal(run.workflow['4'].inputs.width, 256)
  assert.ok(mock.state.stats.prompt >= 1)
})

/* ─────────────────────────────── img2img ─────────────────────────────── */

test('img2img end to end: upload input image → VAEEncode → sample, denoise follows strength', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-i2i')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'input-300x200.png'), 300, 200)

  const run = await runGeneration({
    args: { mode: 'img2img', prompt: 'make it snowy', input_image: input, strength: 0.4 },
    cwd,
    config
  })

  assert.equal(run.mode, 'img2img')
  assert.equal(mock.state.stats.upload, 1, 'the input image should be uploaded to ComfyUI')
  assert.equal(mock.state.lastUploadFilename, 'input-300x200.png')

  assert.equal(run.workflow['8'].class_type, 'LoadImage')
  assert.equal(run.workflow['8'].inputs.image, 'input-300x200.png')
  assert.equal(run.workflow['10'].class_type, 'VAEEncode')
  assert.deepEqual(run.workflow['5'].inputs.latent_image, ['10', 0])
  assert.equal(run.workflow['5'].inputs.denoise, 0.4)

  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.ok(readPngSize(fs.readFileSync(run.outputPaths[0])), 'the output is a valid PNG too')
})

/* ─────────────────────────────── inpaint ─────────────────────────────── */

test('inpaint end to end: upload source + mask → VAEEncodeForInpaint', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-inpaint')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'photo.png'), 512, 512)
  const mask = writePng(path.join(cwd, 'mask.png'), 512, 512)

  const run = await runGeneration({
    args: { prompt: 'replace the sky with a rainbow', input_image: input, mask_image: mask },
    cwd,
    config
  })

  assert.equal(run.mode, 'inpaint', 'input + mask should be inferred as inpaint')
  assert.equal(run.modeInferred, true)
  assert.equal(mock.state.stats.upload, 2, 'both the source and the mask must be uploaded')

  assert.equal(run.workflow['9'].class_type, 'LoadImageMask')
  assert.equal(run.workflow['9'].inputs.channel, 'red')
  assert.equal(run.workflow['10'].class_type, 'VAEEncodeForInpaint')
  assert.deepEqual(run.workflow['10'].inputs.mask, ['9', 0])
  assert.deepEqual(run.workflow['10'].inputs.pixels, ['8', 0])
  assert.equal(run.workflow['10'].inputs.grow_mask_by, config.inpaintGrowMask)
  assert.equal(run.workflow['5'].inputs.denoise, 1)

  assert.ok(fs.existsSync(run.outputPaths[0]))
})

/* ─────────────────────────────── background removal ─────────────────────────────── */

test('remove_background end to end: uses the essentials node pair (RemBGSession → ImageRemoveBackground+), no sampler', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-rembg')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'portrait.png'), 256, 256)

  const run = await runGeneration({
    args: { mode: 'remove_background', input_image: input },
    cwd,
    config
  })

  assert.equal(run.mode, 'remove_background')
  assert.ok(
    run.rembgLabel && run.rembgLabel.includes('essentials'),
    `it should report which removal plan was used; actual: ${run.rembgLabel}`
  )
  assert.ok(
    run.notes.some((note) => note.includes('Background removal plan')),
    'the plan used must be written into notes'
  )

  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('ImageRemoveBackground+'), 'it should include the essentials consumer node')
  assert.ok(
    classes.includes('RemBGSession+'),
    'the session node must be built too: on a real machine rembg_session is a required input, and the single-node shape does not work'
  )
  assert.ok(!classes.includes('KSampler'), 'background removal should not run a sampler')
  assert.equal(run.workflow['7'].class_type, 'SaveImage')

  const [sourceId] = run.workflow['7'].inputs.images
  assert.equal(run.workflow[sourceId].class_type, 'ImageRemoveBackground+')
  // The session output must really be wired into the consumer's rembg_session, not filled arbitrarily by autoFill.
  const [sessionId] = run.workflow[sourceId].inputs.rembg_session
  assert.equal(run.workflow[sessionId].class_type, 'RemBGSession+')
  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.equal(mock.state.stats.upload, 1)
})

test('removal plan precedence: falls back to BRIA when essentials is absent', async () => {
  const { baseUrl } = await startMock({ nodes: briaNodes() })
  const cwd = tempDir('e2e-bria')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  const run = await runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config })

  assert.ok(run.rembgLabel.includes('BRIA'), `it should identify the BRIA plan; actual: ${run.rembgLabel}`)
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('BRIA_RMBG_Zho'))
  assert.ok(classes.includes('BRIA_RMBG_ModelLoader_Zho'))
})

test('removal plan precedence: with only a single-node plan (WAS Node Suite) it uses buildSingle, without inventing a session node', async () => {
  const { baseUrl } = await startMock({ nodes: wasNodes() })
  const cwd = tempDir('e2e-was')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  const run = await runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config })

  assert.ok(run.rembgLabel.includes('WAS'), `it should identify the WAS plan; actual: ${run.rembgLabel}`)
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('Image Rembg (Remove Background)'))
  assert.ok(!classes.includes('RemBGSession+'), 'a single-node plan should not invent a session node')
  assert.equal(
    classes.filter((c) => c.includes('Rembg') || c.includes('RemoveBackground')).length,
    1,
    'a single-node plan should have exactly one removal node'
  )
})

test('no removal node installed → a clear error saying what to install and how', async () => {
  const nodes = defaultNodes()
  delete nodes['RemBGSession+']
  delete nodes['ImageRemoveBackground+']
  const { baseUrl } = await startMock({ nodes })
  const cwd = tempDir('e2e-norembg')
  const config = testConfig({ baseUrl })
  const input = writePng(path.join(cwd, 'x.png'), 64, 64)

  await assert.rejects(
    () => runGeneration({ args: { mode: 'remove_background', input_image: input }, cwd, config }),
    (error) => {
      assert.ok(error instanceof ImagePluginError, `should be an ImagePluginError, actual ${error?.constructor?.name}`)
      assert.match(error.message, /background-removal/)
      assert.match(error.hint, /custom_nodes/, 'it must tell the user where to install the node')
      return true
    }
  )
})

/* ─────────────────────────── other behaviour ─────────────────────────── */

test('saveToComfyUI=false uses PreviewImage and still writes to disk locally', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-preview')
  const config = testConfig({ baseUrl, width: 128, height: 128, saveToComfyUI: false })

  const run = await runGeneration({ args: { prompt: 'x' }, cwd, config })
  const classes = Object.values(run.workflow).map((node) => node.class_type)
  assert.ok(classes.includes('PreviewImage'))
  assert.ok(!classes.includes('SaveImage'))
  assert.ok(fs.existsSync(run.outputPaths[0]), 'even without saving to ComfyUI it must land locally')
})

test('custom workflow escape hatch: tokens are replaced with real values, numbers stay numbers', async () => {
  const { mock, baseUrl } = await startMock()
  const cwd = tempDir('e2e-custom')
  const config = testConfig({ baseUrl })
  const templatePath = path.join(cwd, 'custom-workflow.json')

  fs.writeFileSync(
    templatePath,
    JSON.stringify({
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['1', 1] } },
      '3': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
      '4': { class_type: 'PreviewImage', inputs: { images: ['3', 0] } }
    }),
    'utf8'
  )

  const run = await runGeneration({
    args: {
      prompt: 'a "quoted" prompt',
      width: 256,
      height: 192,
      extra_options: { workflow_path: templatePath }
    },
    cwd,
    config
  })

  assert.equal(run.workflow['2'].inputs.text, 'a "quoted" prompt', 'a prompt with quotes must be restored correctly')
  assert.strictEqual(run.workflow['3'].inputs.width, 256, 'a numeric placeholder must be a number')
  assert.strictEqual(run.workflow['3'].inputs.height, 192)
  assert.equal(run.workflow['1'].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors', 'the checkpoint placeholder should get the auto-picked checkpoint')
  assert.ok(run.notes.some((note) => note.includes('custom workflow')))
  assert.ok(fs.existsSync(run.outputPaths[0]))
  assert.deepEqual(readPngSize(fs.readFileSync(run.outputPaths[0])), { width: 256, height: 192 })
  assert.ok(mock.state.stats.prompt >= 1)
})

test('a missing custom workflow file → a clear error (not a bare ENOENT)', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-custom-missing')
  const config = testConfig({ baseUrl })

  await assert.rejects(
    () =>
      runGeneration({
        args: { prompt: 'x', extra_options: { workflow_path: path.join(cwd, 'missing.json') } },
        cwd,
        config
      }),
    (error) => {
      assert.ok(error instanceof ImagePluginError)
      assert.match(error.message, /does not exist/)
      return true
    }
  )
})

test('two generations do not overwrite each other', async () => {
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-unique')
  const config = testConfig({ baseUrl, width: 64, height: 64 })

  const first = await runGeneration({ args: { prompt: 'x', seed: 1 }, cwd, config })
  const second = await runGeneration({ args: { prompt: 'x', seed: 2 }, cwd, config })

  assert.notEqual(first.outputPaths[0], second.outputPaths[0])
  assert.ok(fs.existsSync(first.outputPaths[0]))
  assert.ok(fs.existsSync(second.outputPaths[0]))
})

test('img2img / inpaint: the reported size is the **produced image** size, not the requested width/height', async () => {
  // Seen on a real machine: a 512×512 input produced a 512 image, yet the report and sidecar said 1024
  // (the requested value), contradicting OUTPUT_SCHEMA's promise that "width = output width".
  const { baseUrl } = await startMock()
  const cwd = tempDir('e2e-actual-size')
  const config = testConfig({ baseUrl, width: 1024, height: 1024 })
  const input = writePng(path.join(cwd, 'input-320x240.png'), 320, 240)

  const img2img = await runGeneration({
    args: { mode: 'img2img', prompt: 'make it snowy', input_image: input },
    cwd,
    config
  })
  assert.deepEqual(readPngSize(fs.readFileSync(img2img.outputPaths[0])), { width: 320, height: 240 })
  assert.equal(img2img.request.width, 320, 'the reported width must be the produced image width')
  assert.equal(img2img.request.height, 240)
  assert.ok(
    img2img.notes.some((note) => note.includes('canvas for')),
    'when the size follows the input image, say why instead of silently keeping the requested value in the report'
  )

  const mask = writePng(path.join(cwd, 'mask-320x240.png'), 320, 240)
  const inpaint = await runGeneration({
    args: { mode: 'inpaint', prompt: 'a golden pear', input_image: input, mask_image: mask },
    cwd,
    config
  })
  assert.deepEqual(readPngSize(fs.readFileSync(inpaint.outputPaths[0])), { width: 320, height: 240 })
  assert.equal(inpaint.request.width, 320, 'same for inpainting: report the produced size')
  assert.equal(inpaint.request.height, 240)
})
