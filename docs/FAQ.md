# FAQ and Troubleshooting

Suggested order: **run `npm run doctor` first** (it answers "config → connectivity → checkpoints → four modes" in one go),
then use the raw error table below to narrow it down.

```bash
cd <plugin-directory>
npm run doctor            # for humans
npm run doctor -- --json  # for pasting into an issue
```

---

## 1. Reading the Self-Check First

```
[Configuration]
  Config file: C:\Users\me\.dsh-comfyui-workbench\config.json
  ComfyUI address: http://127.0.0.1:8188
  Checkpoint: (not set, one will be picked automatically)
  ...

[Connection]
  ✓ ComfyUI is up: http://127.0.0.1:8188
  ✓ Version: 0.3.40 (Python 3.11.9)
  ✓ Device: cuda:0 NVIDIA GeForce RTX 4090 (cuda, 22.1 GB VRAM free)

[Capability probing]
  ✓ 1234 nodes reported
  ✓ All core nodes required by the built-in workflows are present
  ✓ Checkpoints: 2 available, using "sd_xl_base_1.0.safetensors"
  ✓ Sampling: euler / normal

[Mode availability]
  ✓ text-to-image (text2img): available
  ✓ image-to-image (img2img): available
  ✓ inpainting (inpaint): available
  ✗ background removal (remove_background): unavailable
    → No usable background-removal node exists in the local ComfyUI.
```

What the three exit codes mean:

| Exit code | Meaning | Next step |
|---|---|---|
| `0` | All four modes available | Nothing else; just generate |
| `1` | **Cannot reach ComfyUI** | Fix connectivity first, see §2 below |
| `2` | Connected, but some mode cannot run | Read the reasons on the `✗` lines (usually a missing checkpoint or background-removal node) |

> Remember that `npm run doctor` runs **in the plugin directory** and does not go through DSH — so you can use it to verify
> the ComfyUI side before installing the plugin.

---

## 2. Cannot Reach ComfyUI

Raw error:

```text
❌ Image generation failed (text-to-image)

Cannot reach ComfyUI at http://127.0.0.1:8188 (fetch failed)

Start the local ComfyUI service first (it listens on 127.0.0.1:8188 by default), or fix the address: change baseUrl in ~/.dsh-comfyui-workbench/config.json, or set the environment variable COMFYUI_URL=http://host:port.
```

Check in order:

1. **Is ComfyUI actually running**: open `http://127.0.0.1:8188/system_stats` in a browser and look for JSON.
   From the command line: `curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8188/system_stats` (use `/dev/null` on Linux/macOS).
2. **Is the port right**: ComfyUI changes ports with a startup argument (`--port 8189`); after changing it, update `baseUrl` here too.
3. **Are you inside a container / WSL / VM**: there `127.0.0.1` means **itself**, not the host machine.
   Change `baseUrl` to the host's actual IP (for example `http://192.168.1.10:8188`) and start ComfyUI with `--listen 0.0.0.0`.
4. **Do not use `0.0.0.0` as the request address**: `0.0.0.0` means "listen on all interfaces", not a connectable target.
   Seeing that value, the plugin warns and suggests `127.0.0.1` (or a specific IP).
5. **Proxy variables**: if `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` are set, some Node configurations route even `127.0.0.1`
   through the proxy, blocking local requests. Temporarily clear them and try:

   ```powershell
   $env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:ALL_PROXY=''; npm run doctor
   ```

6. **Firewall**: the first time ComfyUI starts, Windows asks "allow network access"; if "Cancel" was clicked,
   loopback usually still works, but a LAN IP will be blocked.

---

## 3. Raw Error → Cause → Fix

### "ComfyUI has no CheckpointLoaderSimple node" / "ComfyUI has no KSampler node"

```text
ComfyUI has no CheckpointLoaderSimple node.

That node ships with core ComfyUI. Confirm that baseUrl points at real ComfyUI and that the version is not too old.
```

**Cause**: `baseUrl` points at something that is not ComfyUI (your own reverse proxy, another service, or a dead port),
or the ComfyUI version is too old. **First visit `http://<baseUrl>/object_info/KSampler`** and check for JSON.

### "ComfyUI reports no available checkpoints (models/checkpoints is empty)"

**Cause**: ComfyUI's `models/checkpoints/` is empty.

**Fix**: put a `.safetensors` / `.ckpt` in there (SDXL or SD1.5 both work), then **refresh** in the ComfyUI UI
(or restart it), and run `doctor` again. Make sure you use the right directory — for the portable build it is
`ComfyUI_windows_portable/ComfyUI/models/checkpoints/`.

### "The specified checkpoint does not exist: xxx"

```text
The specified checkpoint does not exist: my-model.safetensors

Checkpoints available on this machine: a.safetensors, b.safetensors. Change model to one of them, or clear that config setting to let the plugin pick automatically.
```

**Cause**: the name in the config's `checkpoint` (or the `model` passed at call time) does not exactly match the name
ComfyUI knows (a **subdirectory prefix** and the `.safetensors` suffix can differ). Copy the name from the error message.

### "Sampler does not exist" / "Scheduler does not exist"

```text
Sampler does not exist: dpmpp_3m

Available on this machine: euler, euler_ancestral, dpmpp_2m, ...
```

**Cause**: you **explicitly** passed `sampler_name` / `scheduler` and this machine does not have that value — explicit values are strictly validated.

**Note the difference**: if only the **config default** is missing on this machine, the plugin does not error; it **falls back** and explains in the result's `notes`:

```text
Notes:
  - Sampler dpmpp_3m does not exist on this machine; switched to euler.
```

### "No usable background-removal node exists in the local ComfyUI"

This only affects `remove_background`; the other three modes are unaffected. The plugin lists the installation commands for all four options
(`ComfyUI_essentials` / `ComfyUI-BRIA_AI-RMBG` / `ComfyUI-LayerStyle` / `WAS Node Suite`);
install any one and restart ComfyUI. See [INSTALL.md §1.5](./INSTALL.md#15-optional-install-background-removal-nodes).

### "Node rb1: required_input_missing … rembg_session"

```text
The workflow was rejected by ComfyUI (HTTP 400): Node rb1: [{"type":"required_input_missing","message":"Required input is missing: rembg_session"}]
```

`ImageRemoveBackground+` has a **required** input `rembg_session` (type `REMBG_SESSION`),
which must be fed by `RemBGSession+`; since 0.1.0 the plugin builds these two nodes **as a pair**.
Seeing this error means an old copy that "treated that node as a single node" is running —
plugin modules are loaded at startup, **file changes are not hot-reloaded, so restart DSH (or start a new session)**.

### "rembgNode=xxx in the config is not a known plan"

```text
rembgNode=foo in the config is not a known plan.

Known: essentials (ComfyUI_essentials (RemBGSession+ → ImageRemoveBackground+)); bria (...); layerstyle (...); was (...)
```

`rembgNode` only accepts those four keys, or a node class name directly (such as `RemBGSession+`, `ImageRemoveBackground+`).
Clear it to restore "auto-pick".

### "ComfyUI failed to execute the workflow (prompt_id=…)"

```text
ComfyUI failed to execute the workflow (prompt_id=8f3c…): Node type KSampler (id=5) Exception RuntimeError: ...

The two most common causes: a node/model used by the workflow does not exist on this machine (check the ComfyUI console for red errors), or VRAM ran out. You can also retry with smaller model parameters: reduce model / steps / width / height in generate_image.
```

**What to do**: open the ComfyUI UI, find this job by `prompt_id` in the queue/history, and look at the node marked red.
The three most common causes: a missing custom node, a missing VAE/model sub-file, insufficient VRAM (OOM).
Typical OOM fixes: drop the size to 768 or 512, lower `steps`, or use a smaller checkpoint.

### "Timed out waiting for ComfyUI to produce an image (waited N s)"

**Cause**: ComfyUI is queued/very slow. **What to do**:

- increase `timeoutMs` in the config (default 300 s, maximum 1 hour);
- check whether ComfyUI is running another job (by default it runs one at a time);
- reduce the size / lower `steps`; CPU mode is inherently slow, and 1024×1024 may take minutes;
- on timeout the plugin **has already tried to call `/interrupt`** (so it does not keep occupying VRAM), but ComfyUI may still be finishing up.

### "ComfyUI reports the job finished (status …) but produced no images"

```text
ComfyUI reports the job finished (status success) but produced no images (prompt_id=…).

The most common cause is a workflow that does not end in a SaveImage / PreviewImage node — this happens easily with a custom workflow passed via extra_options.workflow_path. The workflow might also only output non-image results such as mask / latent.
```

**Cause**: with the escape hatch, the custom workflow does not end in a save node. **Fix**: add a
`SaveImage` (or `PreviewImage`) to the workflow in ComfyUI, and re-export it in API format.

### "input_image points to a file that does not exist" / "is an empty file (0 bytes)"

```text
input_image points to a file that does not exist: D:\pics\in.png

Check that the path is correct.
```

- Relative paths are **relative to the Agent's current working directory** (the directory where default output lands), not the plugin directory;
- `~` is supported; Windows accepts both backslashes and forward slashes; **quote paths containing spaces** (inside JSON they are just normal strings);
- 0-byte files are caught early: common causes are an interrupted download, or a path that actually points at a placeholder file.

### "width is outside the allowed range 64-8192" / "steps must be a number"

Parameter validation errors; just fix the value. Note:
- Dimensions only matter for `text2img`; for other modes they are **ignored** (and `notes` says so);
- Dimensions are automatically aligned to a **multiple of 8**, and a change is stated in `notes` too.

### "Cancelled: the caller aborted this generation."

You pressed stop/interrupt in DSH. The job on the ComfyUI side **may still finish** (the plugin's cancellation is best effort).

### Parameter-conflict errors

```text
mode=text2img does not accept input_image (received D:\in.png).

To edit that image, pass mode="img2img" explicitly (for a local edit, also pass mask_image and use mode="inpaint").
```

These errors are **intentional** (better an error than a guess, avoiding "thought I was inpainting, but it redrew the whole image").
Adjust the parameters using [PARAMS.md's conflict table](./PARAMS.md#2-mode-inference-and-conflict-rules).

---

## 4. Other Common Questions

### The `generate_image` tool is not visible in DSH

Check in order:

1. **Is the plugin enabled**: is `dsh-comfyui-workbench` switched on in Settings → Plugins;
2. **Was it installed into the current profile**: if you switched profiles (web / desktop / headless),
   `dsh.profile.bundles` was added to the `package.json` of **that particular** profile;
3. **Did you restart DSH**: the bundle list is read at startup;
4. **Was the session opened before installing the plugin**: the tool table is injected when the session/runtime is assembled, so **start a new session** after installing;
5. **Look for this warning in the host log**: `Cannot obtain the tools service; generate_image was not registered (check the plugin dependencies in the profile).`
   — if it appears, the plugin loaded but could not obtain the tool registry.

### Upgrading from `dsh-comfyui-image`

The package/plugin id changed in 0.2.0. Remove the old bundle, install `dsh-comfyui-workbench`, and move the config from `~/.dsh-comfyui-image/` to `~/.dsh-comfyui-workbench/`. The old config/env names are accepted as fallbacks through 0.7.x and removed in 0.8.0. See [MIGRATION.md](./MIGRATION.md).

### Changing `~/.dsh-comfyui-workbench/config.json` has no effect

Config is **re-resolved on every call**, so normally it takes effect immediately. If not, it is usually one of:

1. The same key is **also** in the profile's plugin `config:` — plugin config has higher priority and overrides the config file;
2. An environment variable is overriding it (`COMFYUI_URL` etc.);
3. **The JSON is broken**: when it cannot be read the plugin **does not crash**; it silently falls back to defaults and leaves only a warning in the log.
   Running `npm run doctor` and reading the "Configuration" section is the quickest way to see this.

### The image does not show up / cannot be opened in DSH

- The returned `path` is an **absolute path**, and the plugin guarantees it occupies its own line (so the frontend can recognise it as a file reference);
- Does the file really exist: go and look at that path (there will be a same-named `.json` next to it);
- In the extreme case of a very long path / special characters, try passing `output_path` to a shorter, simpler directory.

### Generation is very slow

| Measure | Effect |
|---|---|
| Lower the size (1024 → 768 / 512) | Most effective; VRAM use and time drop with area |
| `steps` 20 → 12–15 | Noticeably faster, usually acceptable quality loss |
| Use a smaller checkpoint (SD1.5 family) | Much faster; the plugin switches to 512 automatically for SD1.5 |
| Confirm it uses the GPU, not the CPU | Check the ComfyUI startup log; a CPU 1024 image taking minutes is normal |
| Turn off `saveToComfyUI` | Does not affect speed, but stops piling files into ComfyUI's output |

### How much disk does it use / what can be cleaned up

- Each image ≈ 1–3 MB (1024×1024 PNG), with a few KB of `.json` next to it;
- On the ComfyUI side (when `saveToComfyUI: true`) a copy stays in `output/dsh-comfyui-workbench/`; delete it any time;
- Input images uploaded to ComfyUI go into ComfyUI's `input/` directory; if ComfyUI does not clean it up, it keeps growing.

### Does it leak privacy / does it use the network

No. The plugin only connects to the `baseUrl` you configure, never contacts any third-party service, and never uploads images to a cloud.
The only network behaviour is talking to your own ComfyUI. See [CONFIG.md §6](./CONFIG.md#6-security-and-privacy).

### `generate_audio` / `generate_video` says the setup is not available

Run `comfyui_inspect` with `scope=models` and `scope=nodes`. Audio needs an ACE-Step 1.5 AIO checkpoint (or the split diffusion + qwen encoders + ace VAE), plus the ACE audio nodes. Video needs a Wan 2.1 T2V diffusion model, a UMT5 **safetensors** encoder, `wan_2.1_vae.safetensors`, and the core Wan/video nodes.

The error lists detected media files and missing pieces. For Wan 2.2 I2V/VACE, HunyuanVideo, LTX-Video or another family, use `comfyui_workflow`; the high-level `generate_video` intentionally only enables the tested Wan 2.1 T2V graph. See [MEDIA.md](./MEDIA.md).

### The advanced tools (`comfyui_inspect` / `comfyui_workflow` / `comfyui_api`)

These expose the rest of ComfyUI; see [ADVANCED.md](./ADVANCED.md) for the full reference.

- **`comfyui_inspect` says no models**: ComfyUI may be too old for `/models`. The plugin falls back to loader-node enums,
  so at least checkpoints/LoRAs should still appear; check `ComfyUI/models/` and refresh the ComfyUI UI.
- **`Unknown node type "..."`**: the custom node is not installed/loaded, or the class name is wrong. Search with
  `comfyui_inspect scope=nodes` and pass `refresh=true` after installing nodes.
- **`Missing required input "..."`**: read `comfyui_inspect scope=node` for that node; API workflows must provide required
  inputs explicitly.
- **Workflow runs but no files are saved**: add an output node (`SaveImage`, `PreviewImage`, `SaveAudio`, ...) at the end, or
  check the result's `warnings` for download errors.
- **`comfyui_api` returns 404**: the endpoint is not available on this ComfyUI version; use the structured tools or a
  version-specific path.
- **Workflow is still running after `action=run`**: use `comfyui_inspect scope=queue` / `scope=history`, then
  `comfyui_workflow action=wait` with the `prompt_id` and a larger `timeout_ms`.

### How to report a problem

Include these and it can usually be located in one pass:

1. The output of `npm run doctor --json` (it contains only config and the node list, no business data);
2. The raw error text (the block the tool returned, including `prompt_id`);
3. The corresponding `.json` metadata in the output directory (full parameters and workflow — **note it may contain your prompts and local paths**, redact as needed);
4. DSH version, operating system, ComfyUI version (visible in `/system_stats`).

For finer process logs (the chosen background-removal plan, file names uploaded to ComfyUI, HTTP details),
set `DSH_COMFYUI_WORKBENCH_DEBUG=1` before starting DSH, reproduce once, then paste the lines prefixed with `[dsh-comfyui-workbench]`.
