# Usage Examples

One pass through each of the four modes, then a few patterns you will actually use (reproduction, fine-tuning, saving elsewhere, batching, custom workflows).

> Two general tips:
> 1. **Just talk to the Agent normally** — it fills in the parameters itself. The JSON below shows what its call looks like, and what a programmatic call looks like.
> 2. Every call leaves a `.json` metadata file next to the image, containing **all the parameters** used and **the complete workflow submitted to ComfyUI**.

---

## 1. Text-to-Image `text2img`

Tell the Agent:

```text
Draw a corgi in a spacesuit standing on the moon, digital art style, square image
```

The corresponding call (no `mode`; without an input image it is text-to-image):

```json
{
  "prompt": "a corgi in a spacesuit standing on the moon, digital art, highly detailed",
  "negative_prompt": "blurry, low quality, watermark",
  "width": 1024,
  "height": 1024,
  "steps": 25
}
```

Add a fixed seed to compare prompts repeatedly:

```json
{
  "prompt": "a corgi in a spacesuit, digital art",
  "seed": 1234567
}
```

---

## 2. Image-to-Image `img2img`

Tell the Agent:

```text
Turn D:/pics/room.jpg into a watercolor painting, keep the composition
```

The corresponding call (has `input_image`, no `mask_image` → inferred as `img2img`):

```json
{
  "prompt": "watercolor painting, soft edges, paper texture, same composition",
  "input_image": "D:/pics/room.jpg",
  "strength": 0.45
}
```

**`strength` is the most important knob here**:

| Value | Effect |
|---|---|
| `0.2` – `0.35` | Mostly stylisation; composition/subject stays stable |
| `0.45` – `0.65` | Clearly changed, but still recognisably the original (default `0.6`) |
| `0.75` – `1.0` | Essentially repainted; only the rough idea carries over |

> No size needed: the `img2img` canvas comes from the input image, so a passed `width` / `height` is ignored (the result's `notes` says so).

---

## 3. Inpainting `inpaint`

Tell the Agent:

```text
Replace the background in D:/pics/portrait.png with a city at night; I marked the mask in D:/pics/mask.png
```

The corresponding call (`input_image` + `mask_image` → inferred as `inpaint`):

```json
{
  "prompt": "night city skyline with bokeh lights, cinematic",
  "input_image": "D:/pics/portrait.png",
  "mask_image": "D:/pics/mask.png",
  "strength": 1.0
}
```

Three things about the mask that must be clear:

1. **White/bright areas = the region to repaint**; black/dark areas = keep as-is;
2. The mask **must have the same dimensions as the input image** (a mismatch is reported by ComfyUI, and the plugin passes the original text back);
3. The plugin automatically **grows the repainted region outward by 6 pixels** (config option `inpaintGrowMask`, adjustable 0–256) —
   that removes hard seams; setting it to `0` leaves visible seams.

To stay closer to the original image, set `strength` to `0.6`–`0.8`.

---

## 4. Background Removal `remove_background`

Tell the Agent:

```text
Remove the background from D:/pics/product.jpg, keep only the product
```

The corresponding call (only `input_image`, no `prompt` needed):

```json
{
  "input_image": "D:/pics/product.jpg",
  "output_path": "D:/pics/cutout.png"
}
```

Prerequisite: a **third-party background-removal node** installed in ComfyUI (core ComfyUI's own `RemoveBackground`
requires a model under `models/background_removal/` and outputs a mask, which this plugin does not wire up yet).
The plugin automatically picks the best of `ComfyUI_essentials` / `ComfyUI-BRIA_AI-RMBG` / `ComfyUI-LayerStyle` / `WAS Node Suite`,
and tells you in the result's `notes` which one it used:

```text
Notes:
  - Background removal plan: ComfyUI_essentials (RemBGSession+ → ImageRemoveBackground+)
```

When none is installed it errors clearly and lists the installation command for all four. To pin one specific option, set the `rembgNode` config.

---

## Audio and Video (High-Level Tools)

The plugin also exposes `generate_audio` and `generate_video`. Both detect the local models/nodes first and return a precise missing-dependency list instead of submitting a broken graph.

**Music/audio (ACE-Step 1.5):**

```json
{
  "prompt": "warm neo-soul, live drums, brushed hi-hats, 92 BPM",
  "lyrics": "[Verse]\nLate night glow on your skin",
  "duration_seconds": 20,
  "bpm": 92,
  "keyscale": "E minor",
  "seed": 42
}
```

Supported audio layouts: the AIO checkpoint `ace_step_1.5_turbo_aio.safetensors`, or the split ACE-Step 1.5 diffusion + qwen text encoders + ace VAE files.

**Video (Wan 2.1 text-to-video):**

```json
{
  "prompt": "a fox running through a snowy forest, tracking camera, cinematic light",
  "width": 832,
  "height": 480,
  "length_frames": 33,
  "fps": 16,
  "seed": 7
}
```

Video requires `wan2.1_t2v_*.safetensors`, a UMT5 safetensors encoder and `wan_2.1_vae.safetensors`. Wan 2.2 I2V/VACE and other families are not enabled in the high-level tool; use `comfyui_workflow`.

If the setup is incomplete, the tool reports detected media models and the exact missing pieces. See [MEDIA.md](./MEDIA.md) for model layouts, all parameters and troubleshooting.

## 5. Pattern: Reproducing the Same Image / Fine-Tuning

The first call's result contains a `seed`; copying it down is the whole reproduction key:

```text
Params: seed=1783492011 size=1024x1024 steps=20 cfg=7
```

- **Exact reproduction**: the same `prompt` + `negative_prompt` + `seed` + `model` + `sampler_name` + `scheduler` + dimensions;
- **Fine-tuning**: change `prompt` (keep the seed to see "different descriptions of the same composition") or change the seed (to see "different random results for the same prompt");
- The safest reproduction method: read the `.json` metadata next to the image — it stores the **complete workflow**,
  which you can import straight into ComfyUI and rerun.

> With a different checkpoint, seed reproducibility is meaningless. That is why the metadata also records the actual `checkpoint`.

---

## 6. Pattern: Choosing the Output Location

Without `output_path` → the image lands in the **current project root**, named `comfyui-<timestamp>-<4 random chars>.png`.

```json
// give a directory: a name is generated inside it
{ "prompt": "a cat", "output_path": "D:/images" }

// give a file: if it exists, -1 / -2 is appended; it is never overwritten
{ "prompt": "a cat", "output_path": "D:/images/cat-cover.png" }
```

You can also set a default directory in the config once, instead of passing it every time:

```json
// ~/.dsh-comfyui-workbench/config.json
{ "outputDir": "D:/images" }
```

---

## 7. Pattern: Batch Generation

V1's `generate_image` produces **one image per call** (deliberately: failure retries and progress feedback stay simple).
For batches, let the Agent loop — it naturally goes one at a time and reports errors per item:

```text
Use generate_image to make a 512x512 image each for "cat / dog / rabbit",
all with seed=42, output to D:/images/pets/
```

The extra benefit: one failure does not affect the others, and each image has independent metadata.
(True batch / multi-image workflows can be wired in through the escape hatch in the next section.)

---

## 8. Pattern: Custom Workflows for Anything V1 Doesn't Build In

Outpainting, upscaling and special nodes can all be taken over via `extra_options.workflow_path`:

**Step 1**: build the workflow in the ComfyUI UI and export the JSON with **Save (API Format)** from the menu.

**Step 2**: replace the fields that vary with placeholders (a text editor is fine):

```jsonc
{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "seed": "{{seed}}",          // the whole value is a placeholder → still a number
      "steps": "{{steps}}",
      "cfg": "{{cfg_scale}}",
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": "{{strength}}",
      "positive": ["6", 0],
      "model": ["4", 0],
      "negative": ["7", 0],
      "latent_image": ["5", 0]
    }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "{{prompt}}", "clip": ["4", 1] }
  }
}
```

**Step 3**: point the call at it:

```json
{
  "mode": "img2img",
  "prompt": "same scene, extended to the left",
  "input_image": "D:/pics/pano.png",
  "extra_options": { "workflow_path": "D:/workflows/outpaint.json" }
}
```

Key points:

- With the escape hatch the plugin **no longer injects** the built-in parameter nodes; it only probes what the template really needs (it picks a checkpoint only if `{{checkpoint}}` appears in the template);
- The workflow **must end with `SaveImage` / `PreviewImage`**, otherwise you get "the job finished but produced no images";
- To recover the workflow used: the `workflow` field in the `.json` metadata is the substituted final version.

---

## 9. What It Looks Like in DSH

In the tool's returned text, **the image's absolute path sits on its own line**, and the DSH frontend renders it as a clickable file reference:

```text
✅ Image generated (text-to-image, mode inferred automatically)

Image: C:\Users\me\Desktop\comfyui-20261003-130812-a1b2.png
```

Click it, or paste that line into a file manager, to view the image; the `.json` next to it is the metadata of the same name.

When calling from code (not through the Agent), you get the fields from the [output structure](./PARAMS.md#3-output-structure);
`path` is the absolute path, and `text` is the human/model-readable text.

---

## More

- Every parameter and its default: [PARAMS.md](./PARAMS.md)
- Configuration and four-layer priority: [CONFIG.md](./CONFIG.md)
- Troubleshooting: [FAQ.md](./FAQ.md)
- Full ComfyUI access (models, nodes, arbitrary workflows, raw API): [ADVANCED.md](./ADVANCED.md)
