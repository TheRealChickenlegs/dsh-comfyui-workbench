# One-Call Sprite Animation Cards (W2 → W3)

`generate_sprite_animation` turns one base PNG into a complete animated sprite card. It packages the process used for the Draconid characters:

1. Generate **left/right turn clips** with W2; reuse each turn's last frame as its keyframe.
2. Generate **walk_down** directly from the front master with 25 W2 frames.
3. Generate **walk_up** from a **Qwen-Image-Edit back-view keyframe**, then 25 W2 frames away from the viewer.
4. Run **W3** (BiRefNet background removal + alpha) over each clip, keeping the source colours.
5. Pick eight frames, align by feet/centre, apply the walk_up scale lock, box-downsample 128 → 64 px, and pack an **8-column card**.

The default is the full ten-row card:

```text
idle
walk_down, walk_left, walk_right, walk_up
attack_down, attack_left, attack_right, attack_up
death
```

## Why the turn clips exist

A front-facing sprite asked to walk left spends the first half of the clip turning. The pipeline generates the left/right turn once and uses its final frame as that facing's keyframe.

The back view is different: the old W2 **up turn** often failed and left a front-facing keyframe. The current pipeline asks **Qwen-Image-Edit** for a full back view, BiRefNet-cuts it out, normalises it onto a 384 px keyframe, and then runs W2 away from it. If the Qwen stack is unavailable, the tool falls back to the W2 turn with a warning.

Frame counts:

- `walk_down` and `walk_up`: **25** W2 frames, then 8 selected for the row.
- idle and left/right walks: 9.
- attacks, death and turns: 13.

`walk_up` also applies a **scale lock**: every W3 frame is re-fitted to a constant subject height (116 px inside the 128 px cell, feet at y=120) because W2 sometimes zooms out during the away walk.

## Basic call

Full card:

```json
{
  "sprite_path": "godot/assets/player_sprites/player_draconid_bard_female.png"
}
```

Fast single-row test:

```json
{
  "sprite_path": "godot/assets/player_sprites/player_draconid_bard_female.png",
  "animation": "walk_left"
}
```

A left/right directional single-row call generates its turn first. A `walk_up` call uses Qwen-Image-Edit plus one W2 clip; `walk_down` uses one W2 clip from the front master.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `sprite_path` | required | Local base/front PNG |
| `animation` | `all` | One of the ten rows, or `all` |
| `character` | sprite filename | Output name/manifest character |
| `output_dir` | `<cwd>/sprite_animation/<character>` | Artifact directory |
| `prompt` / `negative_prompt` | per-row defaults | Override for every selected row |
| `seed` | derived per character + animation | W2 seed |
| `frames` | 25 for walk_down/up; 9 or 13 otherwise | Override; must be `4n+1` |
| `cell_size` | `64` | `32`, `64` or `128` |
| `width` / `height` | `384` | W2 canvas |
| `fps` | `16` | W2 video fps |
| `steps` | `4` | Lightx2v sampling steps |
| `high_noise_model` | `wan2.2_i2v_high_noise_lightx2v_Q4_K_M.gguf` | W2 stage 1 GGUF |
| `low_noise_model` | `wan2.2_i2v_low_noise_lightx2v_Q4_K_M.gguf` | W2 stage 2 GGUF |
| `clip_model` | `umt5-xxl-encoder-Q5_K_M.gguf` | UMT5 GGUF |
| `vae_model` | `wan_2.1_vae.safetensors` | WAN 2.1 VAE, **not** 2.2 |
| `rmbg_model` | `BiRefNet_lite` | W3/Qwen-cutout segmentation model |
| `back_view` | `qwen` | `walk_up` keyframe: Qwen back-view edit or W2 turn |
| `qwen_model` | `Qwen-Image-Edit-2509-Q4_K_M.gguf` | Qwen GGUF |
| `qwen_lora` | Qwen Lightning 4-step LoRA | Qwen LoRA |
| `qwen_clip` | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Qwen encoder |
| `qwen_vae` | `qwen_image_vae.safetensors` | Qwen VAE |
| `job_timeout_ms` | 600000 | Per ComfyUI job timeout |

## Outputs

```text
<output_dir>/
  videos/
    turn_left.mp4, turn_right.mp4
    walk_down.mp4, walk_up.mp4, ...
  keyframes/
    front.png, left.png, right.png, up.png
    back_qwen.png, back_qwen_raw.png, back_qwen_cut.png
  frames/
    walk_down/001.png ... 025.png
    walk_up/001.png ... 025.png
    idle/001.png ... 009.png
  sprite_sheet.png      8 × N cells, RGBA, source colours
  sprite_sheet.json     row/fps/loop/video manifest
  report.json           timings, models, seed, videos, warnings
```

The card keeps the source colours, matching the Draconid card used by the game. The W3 mask is inverted before `JoinImageWithAlpha` because ComfyUI’s alpha convention is `1 = transparent`.

## Alignment and downsampling

W2 does not keep the subject perfectly still. Each 128 px W3 frame is measured by its alpha box and shifted so its feet sit at `y=120` and its horizontal centre at `x=64`. The top margin is clamped to at least 2 px so a staff cannot be clipped. The death row applies the first cell’s offset to the whole row so the fall still reads as a fall.

For `walk_up`, the scale lock re-fits each selected frame to 116/128 of the cell height before packing. The same frames are then box-downsampled to 64 px.

The 128 px frames are alpha-weighted box-downsampled to 64 px. This preserves the palette and avoids a dark fringe around transparent edges.

## Models and nodes

W2 requires:

- `ComfyUI-GGUF` (`UnetLoaderGGUF`, `CLIPLoaderGGUF`)
- `comfyui_vram_helpers` (`VRAMUnloadModel`)
- Wan 2.2 i2v Q4 high/low-noise GGUFs
- UMT5 Q5 GGUF and `wan_2.1_vae.safetensors`

W3 requires:

- `ComfyUI-RMBG` (`BiRefNetRMBG`) and `BiRefNet_lite` (auto-downloaded by that node pack)

Qwen walk_up additionally requires:

- `UnetLoaderGGUF` with `Qwen-Image-Edit-2509-Q4_K_M.gguf`
- `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors`
- `qwen_2.5_vl_7b_fp8_scaled.safetensors` and `qwen_image_vae.safetensors`
- `TextEncodeQwenImageEditPlus` and the VRAM helper nodes

All model names are parameters, so a server with different filenames can still use the tool. If Qwen is missing, `back_view` falls back to the W2 turn.

## Runtime

On an RTX 5060 Ti, the full card is typically **6–12 minutes** depending on model warmth and server load. The 25-frame walk_down row took about 40 s live; walk_up (Qwen back + 25 W2 + W3 + scale lock) took about 76 s. A left/right row adds a turn clip.

ComfyUI 0.40 had a cache bug that could kill its prompt worker after several W3 runs. The tool gives every W3 graph fresh node IDs, which avoids the stale cache keys. The server used for the original run also has a one-line null guard in `comfy_execution/caching.py`; that patch is outside this plugin.

## Custom prompts

The default prompts are tuned for a front-facing pixel-art RPG character with a visible face. For a non-humanoid or a design where the face is intentionally hidden, pass a full `prompt`/`negative_prompt`. Keep the camera fixed, the background white, and the character identity consistent; W2 otherwise tends to drift or redesign gear.

## Result shape

The tool returns:

- `spritesheet` — the card PNG
- `manifest` — row/fps/loop metadata
- `report` — timings and exact models
- `videos` — every W2 clip, including turns and the 25-frame walk clips
- `animations` — the rows generated
- `warnings` — non-fatal W3/row issues

If W2 or W3 fails, the tool returns `success: false` with the ComfyUI node error and the likely missing model/custom-node cause.
