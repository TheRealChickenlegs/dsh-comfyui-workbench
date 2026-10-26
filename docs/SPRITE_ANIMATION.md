# One-Call Sprite Animation Cards (W2 → W3)

`generate_sprite_animation` turns one base PNG into a complete animated sprite card. It packages the process used for the Draconid characters:

1. Generate short **turn clips** for left, right and back with W2.
2. Keep the **last frame of each turn** and use it as the keyframe for that facing.
3. For each row, run **W2** (Wan 2.2 image-to-video) from the appropriate keyframe.
4. Run **W3** (BiRefNet background removal + alpha) over the clip, keeping the source colours.
5. Pick eight frames, align the subject by feet and centre, box-downsample 128 → 64 px, and pack an **8-column card**.

The default is the full ten-row card:

```text
idle
walk_down, walk_left, walk_right, walk_up
attack_down, attack_left, attack_right, attack_up
death
```

## Why the turn clips exist

A front-facing sprite asked to walk left spends the first half of the clip turning. By the time the body faces left, only a few usable frames remain. The pipeline generates the turn once, uses its final frame as the left/right/back keyframe, then starts the walk and attack already facing the right way.

Turns are 13 frames. Idle and walks use 9 frames; attacks and death use 13, because 9 frames ended before the strike or fall completed.

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

A directional single-row call still generates the necessary turn first, so it uses two W2 clips: one turn and one animation.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `sprite_path` | required | Local base/front PNG |
| `animation` | `all` | One of the ten rows, or `all` |
| `character` | sprite filename | Output name/manifest character |
| `output_dir` | `<cwd>/sprite_animation/<character>` | Artifact directory |
| `prompt` / `negative_prompt` | per-row defaults | Override for every selected row |
| `seed` | derived per character + animation | W2 seed |
| `frames` | 9 or 13 | Override; must be `4n+1` |
| `cell_size` | `64` | `32`, `64` or `128` |
| `width` / `height` | `384` | W2 canvas |
| `fps` | `16` | W2 video fps |
| `steps` | `4` | Lightx2v sampling steps |
| `high_noise_model` | `wan2.2_i2v_high_noise_lightx2v_Q4_K_M.gguf` | W2 stage 1 GGUF |
| `low_noise_model` | `wan2.2_i2v_low_noise_lightx2v_Q4_K_M.gguf` | W2 stage 2 GGUF |
| `clip_model` | `umt5-xxl-encoder-Q5_K_M.gguf` | UMT5 GGUF |
| `vae_model` | `wan_2.1_vae.safetensors` | WAN 2.1 VAE, **not** 2.2 |
| `rmbg_model` | `BiRefNet_lite` | W3 segmentation model |
| `job_timeout_ms` | 600000 | Per ComfyUI job timeout |

## Outputs

```text
<output_dir>/
  videos/
    turn_left.mp4, turn_right.mp4, turn_up.mp4
    idle.mp4, walk_down.mp4, ...
  keyframes/
    front.png, left.png, right.png, up.png
  frames/
    idle/001.png ... 009.png
    ...
  sprite_sheet.png      8 × N cells, RGBA, source colours
  sprite_sheet.json     row/fps/loop/video manifest
  report.json           timings, models, seed, videos, warnings
```

The card keeps the source colours, matching the Draconid card used by the game. The W3 mask is inverted before `JoinImageWithAlpha` because ComfyUI’s alpha convention is `1 = transparent`.

## Alignment and downsampling

W2 does not keep the subject perfectly still. Each 128 px W3 frame is measured by its alpha box and shifted so its feet sit at `y=120` and its horizontal centre at `x=64`. The top margin is clamped to at least 2 px so a staff cannot be clipped. The death row applies the first cell’s offset to the whole row so the fall still reads as a fall.

The 128 px frames are then alpha-weighted box-downsampled to 64 px. This preserves the palette and avoids a dark fringe around transparent edges.

## Models and nodes

W2 requires:

- `ComfyUI-GGUF` (`UnetLoaderGGUF`, `CLIPLoaderGGUF`)
- `comfyui_vram_helpers` (`VRAMUnloadModel`)
- Wan 2.2 i2v Q4 high/low-noise GGUFs
- UMT5 Q5 GGUF and `wan_2.1_vae.safetensors`

W3 requires:

- `ComfyUI-RMBG` (`BiRefNetRMBG`) and `BiRefNet_lite` (auto-downloaded by that node pack)

All model names are parameters, so a server with different filenames can still use the tool.

## Runtime

On an RTX 5060 Ti, the full card is typically **5–12 minutes** depending on model warmth and server load; the original warm estimate was 3.5–5.5 minutes. All 16 characters took 60–90 minutes in the original Draconid run. A single idle/walk row is roughly 20–30 seconds plus W3; a directional row adds a turn clip.

ComfyUI 0.40 had a cache bug that could kill its prompt worker after several W3 runs. The tool gives every W3 graph fresh node IDs, which avoids the stale cache keys. The server used for the original run also has a one-line null guard in `comfy_execution/caching.py`; that patch is outside this plugin.

## Custom prompts

The default prompts are tuned for a front-facing pixel-art RPG character with a visible face. For a non-humanoid or a design where the face is intentionally hidden, pass a full `prompt`/`negative_prompt`. Keep the camera fixed, the background white, and the character identity consistent; W2 otherwise tends to drift or redesign gear.

## Result shape

The tool returns:

- `spritesheet` — the card PNG
- `manifest` — row/fps/loop metadata
- `report` — timings and exact models
- `videos` — every W2 clip, including turns
- `animations` — the rows generated
- `warnings` — non-fatal W3/row issues

If W2 or W3 fails, the tool returns `success: false` with the ComfyUI node error and the likely missing model/custom-node cause.
