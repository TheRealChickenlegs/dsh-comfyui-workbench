/**
 * A fake ComfyUI service, for end-to-end verification of this plugin on machines without ComfyUI.
 *
 * It implements only the endpoints the plugin actually uses, but its **behaviour stays close to real
 * ComfyUI**:
 *   GET  /system_stats          health check
 *   GET  /object_info           node catalogue (determines how checkpoints/samplers/removal plans are chosen)
 *   GET  /object_info/{node}    single node definition (the plugin tries this first)
 *   POST /upload/image          multipart upload of input images/masks
 *   POST /prompt                submit a workflow
 *   GET  /history/{prompt_id}   poll for the result (returns {} for the first N calls to simulate queuing)
 *   GET  /view                  fetch the produced image
 *   POST /interrupt             the plugin tries to cancel on timeout
 *
 * The key point is that it **does not return fixed data**: the dimensions of the produced PNG are
 * read from the submitted EmptyLatentImage node. That lets tests assert "the requested parameters
 * really became an image", not merely "a file was created".
 */
import http from 'node:http'
import zlib from 'node:zlib'

/* ─────────────────────── real PNG encoding (no libraries) ─────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** Generate a solid-colour PNG (a real image, with valid IHDR/IDAT/IEND and CRCs). */
export function makePng(width, height, rgb = [90, 140, 255]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = 1 + width * 3
  const row = Buffer.alloc(stride)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Read the width/height of a PNG (tests use it to assert dimensions); null when invalid. */
export function readPngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ─────────────────────────── /object_info node table ─────────────────────────── */

function node(required, output, category = 'test') {
  return {
    input: { required, optional: {} },
    output,
    output_name: output.map((_, i) => `out${i}`),
    name: category,
    display_name: category,
    description: '',
    category,
    output_node: output.length === 0
  }
}

/**
 * The default node table = "a ComfyUI with the core nodes plus the ComfyUI_essentials removal node pair".
 * `node.name` is set only for readability; the plugin does not read that field.
 */
export function defaultNodes(checkpoints = ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors']) {
  return {
    CheckpointLoaderSimple: node(
      { ckpt_name: [checkpoints, {}] },
      ['MODEL', 'CLIP', 'VAE'],
      'CheckpointLoaderSimple'
    ),
    CLIPTextEncode: node(
      { text: ['STRING', { multiline: true }], clip: ['CLIP'] },
      ['CONDITIONING'],
      'CLIPTextEncode'
    ),
    EmptyLatentImage: node(
      { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] },
      ['LATENT'],
      'EmptyLatentImage'
    ),
    KSampler: node(
      {
        model: ['MODEL'],
        seed: ['INT', { default: 0 }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 8 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim'], {}],
        scheduler: [['normal', 'karras', 'exponential'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1 }]
      },
      ['LATENT'],
      'KSampler'
    ),
    VAEDecode: node({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE'], 'VAEDecode'),
    VAEEncode: node({ pixels: ['IMAGE'], vae: ['VAE'] }, ['LATENT'], 'VAEEncode'),
    VAEEncodeForInpaint: node(
      { pixels: ['IMAGE'], vae: ['VAE'], mask: ['MASK'], grow_mask_by: ['INT', { default: 6 }] },
      ['LATENT'],
      'VAEEncodeForInpaint'
    ),
    SaveImage: node({ images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] }, [], 'SaveImage'),
    PreviewImage: node({ images: ['IMAGE'] }, [], 'PreviewImage'),
    LoadImage: node({ image: [[], { image_upload: true }] }, ['IMAGE', 'MASK'], 'LoadImage'),
    LoadImageMask: node(
      { image: [[], { image_upload: true }], channel: [['red', 'green', 'blue', 'alpha'], {}] },
      ['MASK'],
      'LoadImageMask'
    ),
    // The real shape of ComfyUI_essentials background removal: a session node (REMBG_SESSION) → a consumer node.
    // This is the plugin's highest-priority plan; the single-node shape (only ImageRemoveBackground+) does not
    // work on a real machine.
    // Class names **must match the registered keys on a real machine character for character**: essentials
    // registers "RemBGSession+" (with the plus; the version without it is only the Python class name and does
    // not exist in /object_info at all).
    'RemBGSession+': node(
      {
        model: [['u2net: general purpose', 'u2netp: lightweight general purpose', 'isnet-general-use: general purpose'], {}],
        providers: [['CPU', 'CUDA', 'DirectML'], {}]
      },
      ['REMBG_SESSION'],
      'RemBGSession+'
    ),
    'ImageRemoveBackground+': node(
      { rembg_session: ['REMBG_SESSION'], image: ['IMAGE'] },
      ['IMAGE', 'MASK'],
      'ImageRemoveBackground+'
    )
  }
}

/** A ComfyUI with the BRIA removal plan installed (used to test plan precedence). */
export function briaNodes(checkpoints) {
  const base = defaultNodes(checkpoints)
  delete base['RemBGSession+']
  delete base['ImageRemoveBackground+']
  base.BRIA_RMBG_ModelLoader_Zho = node({ model: [['briaai/RMBG-1.4'], {}] }, ['RMBG_MODEL'], 'BRIA')
  base.BRIA_RMBG_Zho = node(
    { rmbg_model: ['RMBG_MODEL'], image: ['IMAGE'] },
    ['IMAGE', 'MASK'],
    'BRIA'
  )
  return base
}

/**
 * A ComfyUI with only the WAS Node Suite removal node (the **single-node** shape).
 * Covers the buildSingle branch — essentials uses two nodes, so without this the single-node path
 * would have no test shaped like a real machine.
 */
export function wasNodes(checkpoints) {
  const base = defaultNodes(checkpoints)
  delete base['RemBGSession+']
  delete base['ImageRemoveBackground+']
  base['Image Rembg (Remove Background)'] = node({ images: ['IMAGE'] }, ['IMAGE', 'MASK'], 'WAS')
  return base
}

/* ─────────────────────────────── fake ComfyUI ─────────────────────────────── */

/**
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.nodes]            node table
 * @param {number}  [options.pollsBeforeDone=2]               how many polls before a result appears
 * @param {string}  [options.failMode]                        null | 'execution_error' | 'no_images' | 'hang' | 'reject'
 * @param {number}  [options.pngWidth], [options.pngHeight]   force the output size (default: read from the workflow)
 */
export function createMockComfyUI(options = {}) {
  const state = {
    checkpoints: options.checkpoints ?? ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors'],
    nodes: options.nodes ?? defaultNodes(options.checkpoints),
    pollsBeforeDone: options.pollsBeforeDone ?? 2,
    failMode: options.failMode ?? null,
    stats: { system_stats: 0, object_info: 0, object_info_one: 0, upload: 0, prompt: 0, history: 0, view: 0, interrupt: 0 },
    prompts: new Map(),
    uploads: new Map(),
    lastPrompt: null,
    lastClientId: null,
    lastUploadFilename: null
  }

  function findNodeIdByClass(prompt, classTypes) {
    for (const [nodeId, nodeDef] of Object.entries(prompt ?? {})) {
      if (nodeDef && typeof nodeDef === 'object' && classTypes.includes(nodeDef.class_type)) return nodeId
    }
    return undefined
  }

  function outputSize() {
    if (options.pngWidth && options.pngHeight) return { width: options.pngWidth, height: options.pngHeight }
    const prompt = state.lastPrompt ?? {}
    const latentId = findNodeIdByClass(prompt, ['EmptyLatentImage'])
    const latent = latentId ? prompt[latentId] : undefined
    const width = Number(latent?.inputs?.width)
    const height = Number(latent?.inputs?.height)
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height }
    }
    // img2img / inpaint / background removal have no EmptyLatentImage: real ComfyUI takes the canvas
    // **from the input image** (on a real machine a 512×512 input produced a 512 image). So read the
    // dimensions from the uploaded LoadImage image, instead of always returning 64×64 — that would make
    // the mock lie about the output size and hide a real inconsistency.
    const loadImageId = findNodeIdByClass(prompt, ['LoadImage'])
    const uploadedName = loadImageId ? prompt[loadImageId]?.inputs?.image : undefined
    const uploaded = typeof uploadedName === 'string' ? state.uploads.get(uploadedName) : undefined
    if (uploaded) {
      // Note: state.uploads stores the **whole multipart body** (boundaries and headers precede the PNG),
      // so find the PNG signature first, then read width/height 16 / 20 bytes after it — not at offset 0.
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const at = uploaded.indexOf(signature)
      if (at >= 0 && uploaded.length >= at + 24) {
        return { width: uploaded.readUInt32BE(at + 16), height: uploaded.readUInt32BE(at + 20) }
      }
    }
    return { width: 64, height: 64 }
  }

  function buildHistoryEntry(promptId) {
    const record = state.prompts.get(promptId)
    const prompt = record?.prompt ?? {}
    const entry = {
      prompt: [0, promptId, prompt, { client_id: state.lastClientId }, []],
      outputs: {},
      status: { status_str: 'success', completed: true, messages: [] }
    }

    if (state.failMode === 'execution_error') {
      entry.status = {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { prompt_id: promptId }],
          [
            'execution_error',
            {
              prompt_id: promptId,
              node_id: findNodeIdByClass(prompt, ['KSampler']) ?? '5',
              node_type: 'KSampler',
              exception_message: 'CUDA out of memory (deliberately caused by the mock)',
              exception_type: 'RuntimeError'
            }
          ]
        ]
      }
      return entry
    }

    if (state.failMode === 'no_images') {
      // Finished, but produced no images (for example the workflow does not end in SaveImage).
      return entry
    }

    const saveId = findNodeIdByClass(prompt, ['SaveImage', 'PreviewImage'])
    const { width, height } = outputSize()
    if (saveId) {
      entry.outputs[saveId] = {
        images: [{ filename: `dsh-mock-${promptId}.png`, subfolder: '', type: 'output' }]
      }
    }
    entry.__mockPngSize = { width, height }
    return entry
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)

      const sendJson = (status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
        res.end(text)
      }

      // ── health check ──
      if (url.pathname === '/system_stats') {
        state.stats.system_stats += 1
        return sendJson(200, {
          system: { os: 'mock', comfyui_version: '0.0.0-mock', python_version: '3.11.0', ram_total: 1 },
          devices: [{ name: 'mock-cpu', type: 'cpu', vram_total: 1, vram_free: 1 }]
        })
      }

      // ── node catalogue ──
      if (url.pathname === '/object_info') {
        state.stats.object_info += 1
        return sendJson(200, state.nodes)
      }
      if (url.pathname.startsWith('/object_info/')) {
        state.stats.object_info_one += 1
        const classType = decodeURIComponent(url.pathname.slice('/object_info/'.length))
        const found = state.nodes[classType]
        // Real ComfyUI returns {} for a missing node, not 404.
        return sendJson(200, found ? { [classType]: found } : {})
      }

      // ── upload ──
      if (url.pathname === '/upload/image' && req.method === 'POST') {
        state.stats.upload += 1
        // Extract the filename from multipart (read binary as latin1; filenames are ASCII).
        const raw = body.toString('latin1')
        const match = /filename="([^"]*)"/.exec(raw)
        const name = match ? match[1] : `upload-${Date.now()}.png`
        state.uploads.set(name, body)
        state.lastUploadFilename = name
        return sendJson(200, { name, subfolder: '', type: 'input' })
      }

      // ── submit workflow ──
      if (url.pathname === '/prompt' && req.method === 'POST') {
        state.stats.prompt += 1
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          return sendJson(400, { error: { type: 'invalid_json', message: 'request body is not JSON' } })
        }
        if (state.failMode === 'reject') {
          return sendJson(400, {
            error: { type: 'prompt_outputs_failed_validation', message: 'mock rejection' },
            node_errors: {
              '1': { errors: [{ type: 'value_not_in_list', message: 'ckpt_name is not in the available list' }] }
            }
          })
        }
        if (!parsed?.prompt || Object.keys(parsed.prompt).length === 0) {
          return sendJson(400, { error: { type: 'prompt_empty', message: 'the workflow is empty' } })
        }
        const promptId = `mock-${state.prompts.size + 1}-${Math.random().toString(36).slice(2, 8)}`
        state.prompts.set(promptId, { prompt: parsed.prompt, polls: 0 })
        state.lastPrompt = parsed.prompt
        state.lastClientId = parsed.client_id
        return sendJson(200, { prompt_id: promptId, number: state.prompts.size, node_errors: {} })
      }

      // ── poll history ──
      if (url.pathname.startsWith('/history/')) {
        state.stats.history += 1
        const promptId = decodeURIComponent(url.pathname.slice('/history/'.length))
        const record = state.prompts.get(promptId)
        if (!record) return sendJson(200, {})
        if (state.failMode === 'hang') return sendJson(200, {}) // never produces a result → tests the timeout
        record.polls += 1
        if (record.polls < state.pollsBeforeDone) return sendJson(200, {})
        const entry = buildHistoryEntry(promptId)
        // Stash the mock image size on the server for /view.
        server.__mockPngSize = entry.__mockPngSize
        delete entry.__mockPngSize
        return sendJson(200, { [promptId]: entry })
      }

      // ── fetch image ──
      if (url.pathname === '/view') {
        state.stats.view += 1
        if (state.failMode === 'view_500') {
          res.writeHead(500, { 'content-type': 'text/plain' })
          return res.end('mock: failed to fetch the image')
        }
        const size = server.__mockPngSize ?? { width: 64, height: 64 }
        const png = makePng(size.width, size.height)
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length })
        return res.end(png)
      }

      // ── cancel ──
      if (url.pathname === '/interrupt' && req.method === 'POST') {
        state.stats.interrupt += 1
        return sendJson(200, {})
      }

      return sendJson(404, { error: `mock does not implement ${req.method} ${url.pathname}` })
    })
  })

  return {
    state,
    server,
    /** Start the server and return baseUrl. */
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      return `http://127.0.0.1:${port}`
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
