# Roadmap

What we want to do after V1, and **why each thing is not done yet**. Three tiers: near-term (the interface is
already in place; incremental work), mid-term (needs a new dependency or node), and long-term (needs a design
problem solved first).

> The principle stays the same: **practicality first**. Better few and stable than a pile of parameters that
> "look like they exist but do not actually work".

---

## 1. Near Term (V1.x, interfaces already reserved)

### 1. Consistency: wire up the reserved slots

Today `style_reference` / `character_reference` are only written to metadata. There are two paths to making them real:

| Option | Dependency | Description |
|---|---|---|
| **IPAdapter family** | `ComfyUI_IPAdapter_plus` | Encode the reference image as conditioning into KSampler; style and character references are essentially the same thing, just different weights/layers |
| **Reference image + denoise redraw** | Core nodes only | The simple version: use the reference image as the `img2img` input with a low `strength`, which borrows some style similarity |

No interface change is needed: `NormalizedRequest` already has `styleReference` / `characterReference`;
what gets added is **two more nodes in the workflow-building layer**. The metadata sidecar has recorded these
fields from day one, so historical data can support comparison experiments later.

### 2. Batch generation

Today one image per call (`batch_size` is fixed at 1). The thing to think through for batching is the **return shape**:
`outputPaths` is already an array and `files` is already an array, so the low level does not change. What changes:

- add a `count` tool parameter (1–8);
- `EmptyLatentImage.batch_size` or `RepeatLatentBatch` in the workflow;
- list multiple paths in the result text (one absolute path per line, so the frontend can recognise them);
- decide the failure semantics clearly: **all succeed or all fail** (a single ComfyUI job is atomic),
  not "partially successful".

### 3. Super-resolution / upscaling `upscale`

- Through **model upscaling** (`UpscaleModelLoader` + `ImageUpscaleWithModel`) or **simple scaling** (`ImageScaleBy`) —
  both are core nodes, no installation needed;
- Parameter design: the escape hatch in `extra_options` already works; formalising it means adding `mode: upscale` +
  a `scale` parameter (2x / 4x);
- Note: model upscaling requires users to put ESRGAN-like weights into `models/upscale_models/`; when missing,
  give a "what to install" hint like the background-removal nodes do.

### 4. Outpainting `outpaint`

- A simplified version core nodes can do: paste the image onto a larger canvas + edge mask + `inpaint` redraw;
- The formal version must handle "which direction to extend, by how much", making the parameters more complex than today —
  which is why it ranks low.

### 5. Smarter modes and sizes

- When no size is passed, besides looking at the checkpoint name (already done), also align to the **input image size**;
- For the three modes other than `remove_background`, when `input_image` is missing but the user clearly wants to
  "edit an image", can we give a more precise hint (**without auto-adding an image**)?

---

## 2. Mid Term (needs a new dependency / node)

### 6. Background removal: wire up core `RemoveBackground` (zero third-party dependencies)

Since 0.3x, core ships `LoadBackgroundRemovalModel` + `RemoveBackground`
(`comfy_extras/nodes_bg_removal.py`, **not** API nodes): image → **MASK** output, with the model placed in
`models/background_removal/`. It could turn `remove_background` from "requires third-party nodes" into
"works out of the box", but three things must be solved first:

1. today's workflow is "one image in, one image out", while it produces a mask — the chain must become
   `LoadBackgroundRemovalModel → RemoveBackground → JoinImageWithAlpha → SaveImage`
   (`JoinImageWithAlpha` is also a core node: `image` + `alpha` → an IMAGE with an alpha channel);
2. `RembgPlan` currently has only `single` / `pair` build shapes; a third "custom build" is needed;
3. users must put the model into `models/background_removal/` themselves (the same class of problem as `upscale`
   weights); when missing, provide a download link.

The benefit is concrete: this path **needs no `pip install rembg`**, sidestepping the whole onnxruntime dependency
chain, and `doctor`'s probing logic (choose a plan by available nodes) can be reused directly.

### 7. Multiple backends

`runner.ts` and `comfy/` are separate, so adding a backend should only touch the `comfy/` layer. Planned order:

1. **Remote ComfyUI instance** (works today: point `baseUrl` at it; there is just no auth/retry);
2. **A1111 / Forge** (`/sdapi/v1/txt2img`) — much of the parameter mapping can be reused;
3. **Other local inference services** (SD.cpp, LocalAI, and so on) — their parameter models must be confirmed first.

Prerequisite: abstract "workflow building" into an interface (`Backend`); today it is four concrete `buildXxx` functions.

### 8. Stability and experience

- **Retries**: ComfyUI occasionally OOMs or queues past the timeout; a limited retry for "submission failed" is
  reasonable (**do not** retry "submitted but timed out", or you produce duplicate images);
- **Job cancellation**: timeouts already call `/interrupt`; add an explicit `cancel` semantic (DSH's `signal` is already wired up);
- **Queue visibility**: `prompt_id` exists already; the result could include a link to ComfyUI's queue page
  (requires knowing whether it is LAN-reachable).

### 9. Consistency data loop

The metadata sidecar is already a complete record of "parameters + workflow + output path". Next:

- an optional **generation history index** (`~/.dsh-comfyui-workbench/history.jsonl`) for searching by prompt / seed;
- seed and prompt reuse experiments for "multiple images of the same character" based on history;
- one-click import of the `.json` back into the ComfyUI UI (dragging it in works today; there is just no tutorial).

---

## 3. Long Term (needs a design problem solved first)

### 10. DSH-side visualisation and interaction

- Edit configuration directly in a settings page (today you edit `config.json` by hand) — needs DSH client-plugin UI capabilities;
- Inline preview in the session after generation (today you click the path); DSH has GenUI components that could render the image path as a card;
- A "recently generated images" panel.

### 11. Prompt assistance

- **Prompt enhancement** (turn conversational phrasing into SD-friendly English tag strings) — that is a model capability, and may fit better on the DSH side than in the plugin;
- **Negative prompt preset library** (one set each for portraits / landscapes / product shots);
- **Style vocabulary** ("watercolor / cyberpunk / Pixar" → a string of tags).

### 12. Security and quotas

- There is no quota concept today (local ComfyUI, your machine your rules);
- If a shared multi-user/remote instance is needed, add: concurrency limits, a per-call size ceiling, an output directory allowlist.

---

## 4. Explicitly **Not** Planned

Written down here to avoid re-discussing it:

| Not doing | Reason |
|---|---|
| Built-in commercial API backends (DALL·E / SD API and so on) | The plugin's positioning is "no external commercial API dependency"; any integration would be an optional backend in the mid term |
| Automatically downloading checkpoints / removal weights | Several GB at a time; a plugin should not download them silently — giving links and commands is more responsible |
| Automatic mask generation (e.g. a segmentation model doing fully automatic matting) | Too heavy a dependency chain, unpredictable behaviour; "white/bright = repaint area" is simple and controllable |
| Dumping every ComfyUI parameter to the Agent | Contradicts the "unified parameter layer" intent; use the `workflow_path` escape hatch when low-level control is needed |
| Silent degradation (making the decision for the user on a mode conflict) | It makes people think they are inpainting while the whole image gets redrawn; **an error is better** |

---

## 5. Want to Contribute?

- For the code structure see [the architecture section of the README](../README.md#architecture); tests do not need a real ComfyUI (a mock ships with the repo);
- When filing an issue, include the output of `npm run doctor --json` and the raw error text; that speeds up diagnosis a lot;
- If you plan to add a parameter / a mode, read the comments in `src/types.ts` and `src/tool.ts` first —
  the layering convention there (public contract / parameter layer / execution layer) is the extension interface.
