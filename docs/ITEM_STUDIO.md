# Item Studio Tool

`item_studio` is the native form of the saved **Item Studio pack**. It bundles the 108-item catalogue,
orientation-aware prompts, local Flux.2 Klein graph, the original guided ControlNet/IPAdapter graph and
the simple SDXL + pixel-LoRA templates.

Nothing is auto-adopted. Outputs are candidates for the review gate in `ART-DIRECTION.md`.

## Generator selection

`generator` defaults to `auto`.

| Generator | What it does | Requirements |
|---|---|---|
| `auto` | Flux.2 if local assets exist; otherwise guided for small items; otherwise simple | whatever is installed |
| `flux2` | Local Flux.2 Klein 9B text-to-image | Flux.2 model, qwen3 encoder, Flux2 VAE, native nodes |
| `guided` | Original ControlNet Union + IPAdapter Plus SDXL graph | SDXL, pixel LoRA, ControlNet Union, IPAdapter Plus, guides/style |
| `simple` | Portable SDXL + pixel-LoRA templates | SDXL and pixel LoRA |

`auto` for tall items is Flux.2 when available, otherwise simple. Guided tall is not supported in this
version.

## Local Flux.2 graph

The tool builds the native ComfyUI Flux.2 graph:

```text
UNETLoader(flux-2-klein-9b-fp8)
  + CLIPLoader(qwen_3_8b_fp8mixed, type=flux2)
  + VAELoader(full_encoder_small_decoder)
  -> CLIPTextEncode
  -> ConditioningZeroOut
  -> CFGGuider(cfg=1)
  -> Flux2Scheduler(steps=4, 256x256)
  -> KSamplerSelect(euler)
  -> RandomNoise
  -> EmptyFlux2LatentImage
  -> SamplerCustomAdvanced
  -> VAEDecode
  -> SaveImage
```

The preferred render size is **256×256**: it produces chunkier, more readable 64 px items than 1024 and runs in roughly 15–25 s per item. `flux2_width`/`flux2_height` override it.

The preferred model is `flux-2-klein-9b-fp8.safetensors`; `flux-2-klein-4b` and
`flux-2-klein-base-9b-fp8` are fallbacks if the preferred model is absent. Base 9B uses 20 steps by
default. No external image API is called.

### Flux.2 finalization

Flux.2 paints a flat lime/magenta field. The tool:

1. Decodes the PNG.
2. Reads the actual median border colour (not only the catalogue key).
3. Flood-fills the border, keeps the largest opaque component, and crops.
4. Falls back to BiRefNet if less than 2% was removed.
5. Snaps to the 32-colour Underdeep palette.
6. Applies family fill, bottom-centre placement, outline, 64×64/64×128 sprite and 32×32 icon.

## Guided SDXL graph

The original graph is available as a quality/local fallback:

- SDXL + `pixel-art-xl`
- `IPAdapterUnifiedLoader` `PLUS (high strength)`
- `IPAdapterAdvanced` weight 0.45, `style transfer`, 0→0.8, `V only`
- `ControlNetApplyAdvanced` strength 0.75, 0→0.85
- 26 steps, CFG 7, `dpmpp_2m` / `karras`, 1024×1024
- 36 bundled guide images (all 35 families plus `gem`)
- bundled original style reference

Guided output goes through BiRefNet and then the same palette/finalization path.

## Catalogue

The bundled catalogue is the latest 108-item framework data:

- 90 small (64×64) and 18 tall (64×128)
- 35 families, four variants each
- orientation clauses for weapons (vertical/upright) and armour/front-facing items
- prompt, key colour, tier, material and frame names

```json
{ "action": "list", "query": "sword" }
```

## Generate one candidate

```json
{
  "action": "generate",
  "item_id": "long_sword",
  "variant": "base"
}
```

Use `generator: "flux2"` to force local Flux.2, or `generator: "guided"` to test the ControlNet/IPAdapter
path. A custom item can use `prompt`/`name`/`size` without a catalogue entry.

Output:

```text
<output_dir>/
  raw/       generated render (suffix indicates generator)
  cutout/    key or BiRefNet RGBA
  sprites/   64×64 or 64×128 candidate
  icons/     32×32 candidate
  manifest.json
```

Artifacts record `generator`, model, steps, CFG, guide/style, finish method and palette use.

## Cutout only

```json
{
  "action": "cutout",
  "raw_path": "assets/build/item_studio/raw/long_sword_base_flux2.png",
  "item_id": "long_sword"
}
```

## Batch

```json
{
  "action": "batch",
  "variants": "base",
  "limit": 14
}
```

`item_ids` selects explicit items; omit it for the whole catalogue. `variants: "all"` produces 432
artifacts for the full set. Batch continues after per-item failures and writes `candidates.json`.

The first base candidate for all 108 items is the recommended review path; do not run all four variants
before the base set is approved.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `generator` | `auto` | `auto`, `flux2`, `guided`, `simple` |
| `flux2_model` | `flux-2-klein-9b-fp8.safetensors` | Flux.2 diffusion model |
| `flux2_text_encoder` | `qwen_3_8b_fp8mixed.safetensors` | Flux.2 encoder |
| `flux2_vae` | `full_encoder_small_decoder.safetensors` | Flux.2 VAE |
| `flux2_steps` | 4 (base 20) | Flux.2 steps |
| `flux2_cfg` | 1 | Flux.2 CFG |
| `flux2_width` / `flux2_height` | 256 | Flux.2 render size |
| `archetype` / `guide_path` | catalogue family | Guided silhouette |
| `style_reference_path` | bundled reference | Guided IPAdapter reference |
| `use_style_reference` | true | Disable guided IPAdapter |
| `controlnet_strength` / `controlnet_end` | 0.75 / 0.85 | Guided ControlNet |
| `style_strength` / `style_end` | 0.45 / 0.8 | Guided IPAdapter |
| `guided_steps` / `guided_cfg` | 26 / 7 | Guided sampler |
| `checkpoint` / `lora` | SDXL / pixel-art-xl | Guided/simple models |
| `rmbg_model` | `BiRefNet_lite-matting` | Fallback cutout |
| `outline` | false | Extra one-pixel outline (prompts already request one) |
| `force` | false | Regenerate cached raw/cutout |

## Requirements

**Flux.2**

- `diffusion_models/flux-2-klein-9b-fp8.safetensors`
- `text_encoders/qwen_3_8b_fp8mixed.safetensors`
- `vae/full_encoder_small_decoder.safetensors`
- native Flux2 nodes in ComfyUI

**Guided**

- `sd_xl_base_1.0.safetensors`, `pixel-art-xl.safetensors`
- `SDXL/controlnet-union-sdxl-1.0/diffusion_pytorch_model.safetensors`
- `ip-adapter-plus_sdxl_vit-h.safetensors`
- ComfyUI-IPAdapter-plus and ComfyUI-ControlNet

**Simple**

- SDXL + pixel LoRA

Missing Flux.2 assets make `auto` fall back; an explicit `flux2` request errors with the exact missing
item.

## Review

- Candidates are not adopted automatically.
- Review at 64, 32 and 16 px.
- Check one object, family/fill, edge margin, palette, key-colour remnants and duplicate variants.
- Approve one seed per item before atlas packing.
- The tool does not edit `content.json`, the atlas or the game.
