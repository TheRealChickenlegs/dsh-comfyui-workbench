# Audio and Video Generation

The plugin adds two high-level media tools alongside `generate_image`:

| Tool | What it does |
|---|---|
| `generate_audio` | Generate music/audio with **ACE-Step 1.5** |
| `generate_video` | Generate a short video with **Wan 2.1 text-to-video** |

Both tools **detect the local model/node setup before submitting**. If a required model or node is missing, the error lists the video/audio models that *are* installed and the exact missing pieces, instead of returning a raw ComfyUI node failure.

---

## 1. Audio: ACE-Step 1.5

### Supported model layouts

**Recommended: AIO checkpoint**

```text
ComfyUI/models/checkpoints/ace_step_1.5_turbo_aio.safetensors
```

This single file contains the diffusion model, text encoder and VAE. The tool uses 8 sampler steps and CFG 1 by default.

**Split layout**

```text
ComfyUI/models/diffusion_models/acestep_v1.5_xl_base_bf16.safetensors
ComfyUI/models/text_encoders/qwen_0.6b_ace15.safetensors
ComfyUI/models/text_encoders/qwen_4b_ace15.safetensors
ComfyUI/models/vae/ace_1.5_vae.safetensors
```

The split layout also needs a `DualCLIPLoader` that exposes the `ace` type. It uses 50 sampler steps and CFG 6 by default.

Required ComfyUI nodes: `CheckpointLoaderSimple` (AIO) or `UNETLoader` + `DualCLIPLoader` + `VAELoader` (split), plus `TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `ModelSamplingAuraFlow`, `ConditioningZeroOut`, `VAEDecodeAudio`, `KSampler`, and `SaveAudioMP3` (or `SaveAudio`).

### Example

```json
{
  "prompt": "warm neo-soul, live drums, brushed hi-hats, 92 BPM, intimate studio",
  "lyrics": "[Verse]\nLate night glow on your skin\n[Chorus]\nStay right there",
  "duration_seconds": 30,
  "bpm": 92,
  "keyscale": "E minor",
  "seed": 42
}
```

Instrumental: omit `lyrics` (or use `"[Instrumental]"`).

Useful parameters:

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | required | Style/tags description |
| `lyrics` | empty | Section tags such as `[Verse]` / `[Chorus]` |
| `duration_seconds` | 30 | 1–600; both the text encoder and latent use it |
| `bpm` | 120 | 10–300 |
| `timesignature` | `"4"` | `2`, `3`, `4`, `6` |
| `language` | `en` | Lyrics language code |
| `keyscale` | `C major` | For example `E minor` |
| `seed` | random | Reuse to reproduce a track |
| `steps` / `cfg_scale` | family default | 8/1 for AIO, 50/6 for split |
| `model` | auto | Specific checkpoint/diffusion file |
| `output_path` | project root | Directory or exact `.mp3` path |
| `timeout_ms` | config `timeoutMs` | Maximum 1 hour |

### Not available?

If no ACE-Step 1.5 setup is detected, the tool reports:

```text
Audio generation is not available on this ComfyUI.

Detected audio-related models:
  - ...

Missing:
  - ...

Supported setups:
  - ACE-Step 1.5 AIO ...
  - ACE-Step 1.5 split ...
```

Install one of the supported layouts, then retry. For another audio family (Stable Audio, MiniMax Music, etc.), use `comfyui_workflow` with a matching API workflow.

---

## 2. Video: Wan 2.1 text-to-video

### Supported model layout

```text
ComfyUI/models/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors
ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
ComfyUI/models/vae/wan_2.1_vae.safetensors
```

Required ComfyUI nodes: `UNETLoader`, `CLIPLoader` with the `wan` type, `VAELoader`, `CLIPTextEncode`, `EmptyHunyuanLatentVideo`, `ModelSamplingSD3`, `KSampler`, `VAEDecode`, `CreateVideo`, and `SaveVideo`.

Defaults: 832×480, 33 frames at 16 fps (~2 seconds), 30 steps, CFG 6, `uni_pc` / `simple`.

### Example

```json
{
  "prompt": "a fox running through a snowy forest, tracking camera, cinematic light",
  "negative_prompt": "low quality, blurry, static, watermark",
  "width": 832,
  "height": 480,
  "length_frames": 33,
  "fps": 16,
  "seed": 7
}
```

Useful parameters:

| Parameter | Default | Notes |
|---|---|---|
| `prompt` | required | Video description |
| `negative_prompt` | quality-focused default | What to avoid |
| `width` / `height` | 832 / 480 | Aligned to 16 |
| `length_frames` | 33 | Aligned to 1+4k; at 16 fps, 33 ≈ 2 s |
| `fps` | 16 | Output frame rate |
| `steps` / `cfg_scale` | 30 / 6 | Sampling quality |
| `seed` | random | Reuse for a similar clip |
| `model` | auto | Specific Wan T2V diffusion file |
| `output_path` | project root | Directory or exact `.mp4` path |
| `timeout_ms` | config `timeoutMs` | Maximum 1 hour |

### Not available?

The tool only enables the tested Wan 2.1 T2V graph. It reports other video files without pretending to support them:

```text
Video generation is not available on this ComfyUI.

Detected video-related models:
  - unet_gguf/Wan2.1_14B_VACE-Q4_K_M.gguf
  - unet_gguf/wan2.2_i2v_high_noise_lightx2v_Q4_K_M.gguf
  - clip_gguf/umt5-xxl-encoder-Q5_K_M.gguf
  - vae/wan_2.1_vae.safetensors

Missing:
  - No Wan 2.1 text-to-video diffusion model ...
  - No UMT5 safetensors text encoder ...
```

Wan 2.2 I2V/VACE, HunyuanVideo, LTX-Video, SVD and other families are intentionally **not** wired into this high-level tool. Their graphs differ significantly (dual experts, image conditioning, VACE control, etc.); use `comfyui_workflow` with the matching template after inspecting models/nodes with `comfyui_inspect`.

This is deliberate: a clear "not supported with these files" is better than submitting a graph that fails halfway through a 10-minute render.

---

## 3. Outputs and metadata

- The returned absolute path is clickable in DSH.
- Audio is normally `.mp3` via `SaveAudioMP3` (lossless `.flac`/`.wav` via `SaveAudio`); video is normally `.mp4`.
- A `.json` metadata sidecar is written next to the media file with:
  - `kind`: `audio-generation` or `video-generation`
  - `mediaType`, `family`, prompt, lyrics/negative prompt, seed, dimensions/frames/fps
  - the complete submitted workflow and ComfyUI history
- ComfyUI-side files go under `output/audio/dsh-comfyui-workbench/` and `output/video/dsh-comfyui-workbench/` when the save nodes use the generated prefix.
- Existing files are never overwritten; a numeric suffix is added.

## 4. Limits and troubleshooting

| Symptom | Cause / fix |
|---|---|
| Audio says no ACE-Step model | Install the AIO checkpoint or all four split files; check `models/checkpoints`, `diffusion_models`, `text_encoders`, `vae` |
| Split audio says `DualCLIPLoader` has no `ace` type | Update ComfyUI or use the AIO checkpoint |
| Video says no Wan T2V model | Install `wan2.1_t2v_*.safetensors` in `models/diffusion_models` |
| Video says no UMT5 safetensors | The installed UMT5 GGUF is not used by this high-level graph; install the safetensors encoder or use a custom GGUF workflow |
| Timeout | Raise `timeout_ms`, lower `length_frames`/resolution, or check the ComfyUI queue |
| MP3/MP4 cannot be opened | Check the ComfyUI console; the metadata sidecar contains the submitted graph |

For model/node discovery before installing anything:

```text
Use comfyui_inspect with scope=models and scope=nodes to show audio/video model files and node availability.
```
