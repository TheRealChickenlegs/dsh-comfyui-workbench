# Item Studio Tool

`item_studio` is the native form of the portable **Item Studio pack** saved under
`iMoria/tools/item_studio`. It bundles the 108-item catalogue and the pack's four workflow templates, then performs:

1. SDXL + pixel-art LoRA generation from the catalogue prompt and variant suffix.
2. BiRefNet cutout with `BiRefNet_lite-matting`.
3. Largest-component isolation, alpha crop, fill scaling and bottom-centre placement.
4. 64×64 small / 64×128 tall sprite output plus a 32×32 inventory icon.

Nothing is auto-adopted. Outputs are candidates for the review gate in `ART-DIRECTION.md`.

## Catalogue

The bundled catalogue is the saved framework's `item_catalog.json`:

- **108 items**, 35 families
- 90 small (64×64) and 18 tall (64×128)
- Four variants per item: `base`, `material`, `worn`, `runed` (family-specific names for potions, scrolls, wands, staffs and books)
- Family fill targets from `ART-DIRECTION.md`
- Catalogue prompt, key colour, tier, material, frame and icon names

List it with:

```json
{ "action": "list" }
```

Filter with `query`, `category`, `size` and `limit`.

## Generate one candidate

```json
{
  "action": "generate",
  "item_id": "long_sword",
  "variant": "base",
  "output_dir": "assets/build/item_studio"
}
```

Output layout:

```text
<output_dir>/
  raw/       SDXL render
  cutout/    BiRefNet RGBA
  sprites/   64×64 or 64×128 candidate
  icons/     32×32 inventory candidate
  manifest.json
```

A custom item can be generated without a catalogue entry:

```json
{
  "action": "generate",
  "name": "moonstone_ring",
  "size": "small",
  "prompt": "pixel art RPG inventory icon, a single silver ring with a moonstone, plain solid #00FF00 background, centred, one object only"
}
```

## Cutout only

```json
{
  "action": "cutout",
  "raw_path": "assets/build/item_studio/raw/long_sword_base.png",
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

`item_ids` selects explicit items; omit it for the whole catalogue. `variants: "all"` generates all four variants (432 artifacts for the full set) and writes `candidates.json`. Batch continues after per-item failures and reports them in `warnings`.

Test one family representative before running the full set; the pack's review gate exists because candidate quality varies.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `checkpoint` | `sd_xl_base_1.0.safetensors` | SDXL checkpoint |
| `lora` | `pixel-art-xl.safetensors` | Pixel-art LoRA |
| `rmbg_model` | `BiRefNet_lite-matting` | W3/BiRefNet cutout |
| `seed` | catalogue variant seed | Override |
| `outline` | `true` | One-pixel dark outline |
| `force` | `false` | Regenerate cached raw/cutout |
| `job_timeout_ms` | 600000 | Per ComfyUI job |
| `catalog_path` | bundled catalogue | Custom catalogue JSON |

## Background policy

The catalogue prompt requests lime (`#00FF00`) or magenta (`#FF00FF`), never white. The pilot in the pack showed the model does not reliably honour that key, so **BiRefNet is primary**, not a literal chroma key. The tool follows that decision.

If the simple template paints multiple objects, the finalizer keeps the largest connected opaque component and discards the rest. The raw and full cutout remain on disk so you can see what happened; this is a safety net, not a substitute for the review gate.

## Templates

Bundled from the portable pack:

- `item_64.template.json`
- `item_tall.template.json`
- `cutout_birefnet.template.json`
- `icon_32.template.json` (the tool derives the icon locally after finalization)

The simple pack template is **SDXL + pixel LoRA**. It is not the ControlNet/IPAdapter guided graph used by the original Item Studio Python pilot. The guided graph is the quality path for production; this tool makes the saved pack executable without copying JSON or invoking Python.

## Review

The framework's contract remains:

- candidates are not adopted automatically;
- review at 64, 32 and 16 px;
- check family/fill, one object, edge margin, palette count, key-colour remnants and duplicate variants;
- approve one seed per item before atlas packing.

The tool outputs candidate paths and a manifest; it does not edit `animations.json`, `content.json`, the atlas or the game.
