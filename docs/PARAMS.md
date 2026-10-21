# Tool Parameters

This document covers the high-level `generate_image` tool: its parameters, defaults, and when each one is ignored. For the advanced `comfyui_inspect` / `comfyui_workflow` / `comfyui_api` tools, see [ADVANCED.md](./ADVANCED.md); for `generate_audio` / `generate_video`, see [MEDIA.md](./MEDIA.md).

- The parameter schema lives in `src/tool.ts` (`PARAMETERS_SCHEMA`); normalization logic lives in `src/params.ts`.
- The parameters are a **raw JSON Schema** using only the subset DSH supports (`minimum` / `maximum` / `format` are rejected outright),
  so value ranges live only in the descriptions, and the plugin **validates at runtime and reports a clear error**.

---

## 1. Parameter Reference

| Parameter | Type | Default | Effective modes | Description |
|---|---|---|---|---|
| `mode` | string enum | inferred | all | `text2img` / `img2img` / `inpaint` / `remove_background`. An unknown value is an error |
| `prompt` | string | — | `text2img` `img2img` `inpaint` | Positive prompt, required. For `remove_background` it is ignored and `notes` says so |
| `negative_prompt` | string | plugin default negative prompt | generation modes | Overrides `negativePrompt` from the config |
| `input_image` | string | — | `img2img` `inpaint` `remove_background` | Required. Absolute, or relative to the **current working directory**; `~` is supported |
| `mask_image` | string | — | `inpaint` | Required. **White/bright areas = the region to repaint** (the alpha channel is not read); dimensions must match `input_image` |
| `width` | integer | by checkpoint (1024 / 512) | **only** `text2img` | `64`–`8192`; values not divisible by 8 are aligned, with a note in `notes` |
| `height` | integer | by checkpoint (1024 / 512) | **only** `text2img` | Same as above |
| `seed` | integer | random | generation modes | `0`–`4294967295`. Same seed + same prompt + same checkpoint = the same image |
| `output_path` | string | current working directory | all | A directory → a name is generated inside it; a path with an image extension (e.g. `xxx.png`) → treated as a file path (if it exists, `-1`/`-2` is appended; **never overwritten**) |
| `strength` | number | `img2img` 0.6 / `inpaint` 1.0 | `img2img` `inpaint` | `0`–`1`; lower stays closer to the original. For `remove_background` it is ignored |
| `steps` | integer | `20` | generation modes | `1`–`500`; more is finer and slower |
| `cfg_scale` | number | `7` | generation modes | `0`–`100`; higher follows the prompt more closely, lower is freer |
| `model` | string | auto-pick | generation modes | Checkpoint file name. Picked automatically when omitted (preferring names containing `xl`); what was chosen goes into the result's `notes` |
| `sampler_name` | string | `euler` | generation modes | An **explicit** value missing on this machine → error with the available values; only a stale config default → fall back with a note in `notes` |
| `scheduler` | string | `normal` | generation modes | Same as above |
| `style_reference` | string | — | **(reserved)** | V1 only verifies the file exists and writes it to metadata; **it does not affect generation** |
| `character_reference` | string | — | **(reserved)** | Same as above |
| `extra_options` | object | — | all | Only `workflow_path` currently has behaviour: the API-format workflow it points at **takes over** this generation |

> The `width` / `height` in the result are always the **actual pixel dimensions of the produced image**: for `text2img` that equals the requested size,
> while for `img2img` / `inpaint` / `remove_background` it equals the input image's size — those modes take their canvas from the input image,
> and the requested `width` / `height` do not apply. When the size differs from the request, `notes` explains why.

### Ranges and errors

Out-of-range values are **clear errors**, not clamped to the boundary:

```
width is outside the allowed range 64-8192, received 99999.
```

```
steps must be a number, received "abc".
```

### Ignored rather than rejected

These do not fail, but the result's `notes` says so explicitly, so you never assume they took effect:

| Situation | What `notes` says (paraphrased) |
|---|---|
| `width` / `height` passed with a non-`text2img` mode | "takes its output size from the input image; width/height were ignored" |
| `prompt` passed to `remove_background` | "does not use prompt; it was ignored" |
| `strength` passed to `remove_background` | "does not use strength; it was ignored" |
| A dimension not divisible by 8 | "width was aligned from 1001 to a multiple of 8: 1000 (ComfyUI requirement)" |
| `style_reference` / `character_reference` passed | "only recorded in V1 (written to metadata); they do not affect generation yet" |
| `model` not passed | "Checkpoint chosen automatically: xxx (N available on this machine; use the model argument to specify one)." |
| The config's default sampler / scheduler does not exist locally (**not** passed explicitly at call time) | "Sampler xxx does not exist on this machine; switched to yyy." |
| No `width` / `height` given, and the checkpoint-derived default differs from the config default | "No size specified: adapted to 512x512 for checkpoint xxx (was 1024x1024 before adaptation; override with width/height)." |
| The `img2img` / `inpaint` output size differs from the requested `width` / `height` | "Output size is 512x512 (the canvas for img2img is determined by the input image; the requested 1024x1024 does not apply)." |

---

## 2. Mode Inference and Conflict Rules

When `mode` is omitted, three rules infer it:

```
input_image AND mask_image   →  inpaint
only input_image             →  img2img
neither                      →  text2img
```

**Inference does only this one step.** Any conflict is an immediate error (better an error than guessing what you meant):

| Input | Result |
|---|---|
| `mode=text2img` + `input_image` | ✗ Error: "To edit that image, pass `mode="img2img"` explicitly" |
| `mode=text2img` + `mask_image` | ✗ Error: "Pass `mode="inpaint"` explicitly" |
| `mode=img2img` + `mask_image` | ✗ Error: "a mask means inpainting; use `mode="inpaint"` instead" |
| `mask_image` but no `input_image` | ✗ Error: "Inpainting needs two images, the source and the mask" |
| `mode=img2img` / `inpaint` / `remove_background` without `input_image` | ✗ Error |
| `mode=inpaint` without `mask_image` | ✗ Error (V1 does not do automatic matting / mask generation) |
| `mode=text2img` / `img2img` / `inpaint` without `prompt` | ✗ Error |
| `input_image` / `mask_image` path does not exist | ✗ Error, caught **before the upload** |
| `input_image` points at a directory or a 0-byte file | ✗ Error, explaining "provide a specific image file path" / "the file contains no image data" |
| `mode` is an unknown value | ✗ Error, listing the four modes V1 supports |

**Why this design**: the worst failure when an Agent calls a tool is "silently degrading into another mode" — you think you are inpainting, but it redraws the whole image.
So this plugin's principle is: **infer what is unambiguous; error on anything ambiguous**, with "what to do" in the error text.

---

## 3. Output Structure

The tool's return value (`output.schema`) fields:

| Field | Type | Description |
|---|---|---|
| `text` | string | Complete result description for the model (also the text shown in the UI) |
| `path` | string | **Absolute path of the primary output file** (first, so the frontend recognises it as a clickable file) |
| `files` | string[] | All files produced by this call (currently always 1) |
| `mode` | string | The mode actually used |
| `seed` | integer | The seed used (reproduction relies on it) |
| `width` / `height` | integer | Actual dimensions (the input image's size for non-`text2img` modes) |
| `steps` / `cfg_scale` / `strength` | number | Parameters used |
| `model` | string | The checkpoint actually used (may have been auto-picked) |
| `sampler` / `scheduler` | string | The sampler / scheduler actually used (may have been a fallback) |
| `prompt_id` | string | ComfyUI's `prompt_id`, for looking up this job in its UI/queue |
| `comfy_url` | string | The ComfyUI address used |
| `duration_ms` | integer | Time from submission to fetching the image |
| `success` | boolean | Whether it succeeded (on failure the tool throws; it never returns `success:false`) |
| `mode_inferred` | boolean | Whether the mode was inferred automatically |
| `metadata_path` | string? | The `.json` metadata sidecar path (absent when `writeMetadata` is off) |
| `notes` | string[] | Notes for this call (see the table above) |

The `text` layout is deliberate: **the absolute path occupies its own line, undecorated**, so the DSH frontend renders it as a clickable file link.

```text
✅ Image generated (inpainting)

Image: C:\Users\me\Desktop\comfyui-20261003-131501-7f2c.png
Metadata: C:\Users\me\Desktop\comfyui-20261003-131501-7f2c.png.json

Params: seed=991203 size=768x768 steps=25 cfg=7 strength=1
Checkpoint: sd_xl_base_1.0.safetensors
Sampling: euler / normal  Elapsed: 18.7 s
ComfyUI: http://127.0.0.1:8188 (prompt_id=1f0a…)

Notes:
  - Checkpoint chosen automatically: sd_xl_base_1.0.safetensors (3 available on this machine; use the model argument to specify one).
```

## 4. What Failure Looks Like

On failure the tool **throws**, and the error text = "what happened" + "what to do next":

```text
❌ Image generation failed (text-to-image)

Cannot reach ComfyUI at http://127.0.0.1:8188 (fetch failed)

Start the local ComfyUI service first (it listens on 127.0.0.1:8188 by default), or fix the address: change baseUrl in ~/.dsh-comfyui-workbench/config.json, or set the environment variable COMFYUI_URL=http://host:port.
```

Other common ones: no available checkpoint, a missing background-removal node (listing all four installation options),
workflow execution failure (with `prompt_id` and troubleshooting advice), waiting timeout (after trying to cancel the job),
and "the job finished but produced no images" (usually a custom workflow that does not end in `SaveImage`).

## 5. Custom Workflow Placeholders

When `extra_options.workflow_path` takes over generation, the plugin substitutes these placeholders before submitting:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | Positive prompt |
| `{{negative_prompt}}` | Negative prompt (including the plugin default) |
| `{{width}}` / `{{height}}` | Dimensions |
| `{{seed}}` | Seed |
| `{{steps}}` | Sampling steps |
| `{{cfg_scale}}` | CFG |
| `{{strength}}` | Strength |
| `{{checkpoint}}` | The checkpoint name actually used |
| `{{input_image}}` | The file name **after uploading to ComfyUI** (not the local path) |
| `{{mask_image}}` | Same as above |
| `{{mode}}` | The mode for this call |

Substitution rules:

- **The whole value is one placeholder** (e.g. `"ckpt_name": "{{checkpoint}}"`) → replaced as-is, **with the type preserved** (a number stays a number);
- A placeholder embedded mid-sentence → concatenated as a string;
- **A placeholder that was not supplied is left as-is** (e.g. `{{foo}}` stays `{{foo}}`) — making your own typo easy to spot.

> Note: `input_image` means "the file name inside ComfyUI's input directory" — because the `image` parameter of the `LoadImage`
> node is an **enum of file names in the input directory**, not a free-form string. The plugin back-fills it with the file name
> returned by `/upload/image`, so `{{input_image}}` in your template is correct; do not write a local absolute path.
