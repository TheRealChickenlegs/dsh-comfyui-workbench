# Configuration

The plugin's configuration has **four sources, highest priority first**:

```
1. Plugin config    the config: of that entry in the profile's cordis.patch.yml   ← highest
2. Config file      ~/.dsh-comfyui-workbench/config.json
3. Environment      COMFYUI_URL etc.
4. Built-in defaults   DEFAULTS in src/config.ts                                  ← lowest
```

Merging is **per key**: if a setting is absent from ① but present in ②, ② is used. Invalid values (negative steps, a non-numeric timeout...)
do **not** crash the plugin — they are dropped and replaced with the default (with a trace in the debug log).

Why ① is highest: DSH's config tree is the authoritative source for the host/operator, so an explicit config should win.
② and ③ are convenience layers for people who "just want to change an address without touching YAML".

> ✨ **Config is resolved on every call** — an edited `config.json` takes effect **immediately, with no DSH restart**.
>
> **Upgrading from `dsh-comfyui-image`?** 0.8.x reads the legacy `~/.dsh-comfyui-image/config.json` when the new file is absent, and accepts the legacy `DSH_COMFYUI_IMAGE_*` variables as fallbacks. New names win; legacy support ends in 0.9.0. See [MIGRATION.md](./MIGRATION.md).

---

## 0. Edit Everything in the Plugin Page

Open **Plugins → ComfyUI Workbench → Configuration** in DSH. The page contains **all keys** from the table below, grouped as Connection, Image defaults, Output, Background removal and Hugging Face downloads.

- Every field is optional and blank means **inherit** from the config file, environment or built-in default.
- Saving writes only the fields you changed into the active profile's plugin config (the highest-priority layer); file and environment settings still apply to untouched fields.
- No DSH restart is needed for a save to take effect.
- If the deployment reports settings as read-only, the page is visible but disabled.

The rest of this document describes the file, environment and profile methods used by the same resolution chain.

---

## 1. The Most Common Way: Edit the Config File

Path: `~/.dsh-comfyui-workbench/config.json` (on Windows: `C:\Users\<you>\.dsh-comfyui-workbench\config.json`)

Create it if it does not exist (create the directory too). A typical config:

```json
{
  "baseUrl": "http://127.0.0.1:8188",
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "outputDir": "D:/images",
  "steps": 25,
  "cfgScale": 7,
  "timeoutMs": 600000,
  "saveToComfyUI": false
}
```

**Every key is optional**; write only the ones you want to change.

---

## 2. All Configuration Options

### Connection and locations

| Key | Type | Default | Environment variable | Description |
|---|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8188` | `COMFYUI_URL` / `COMFYUI_BASE_URL` | ComfyUI address; a trailing `/` is removed automatically. **Do not use `0.0.0.0`** (that is a listen address, not a request address); the plugin warns and suggests `127.0.0.1` |
| `outputDir` | string | none (the current project root) | `DSH_COMFYUI_WORKBENCH_OUTPUT` | Default output directory. The tool argument `output_path` takes precedence; `~` is expanded |
| `requestTimeoutMs` | number | `30000` | — | Timeout for a single HTTP request (ms), valid range `1000`–`600000` |
| `timeoutMs` | number | `300000` | `COMFYUI_TIMEOUT_MS` | Total timeout **waiting for an image** (ms), valid range `1000`–`3600000`. Raise it on slow machines / big models |
| `pollIntervalMs` | number | `700` | — | Interval for polling `/history` (ms), valid range `100`–`10000` |

### Generation defaults

| Key | Type | Default | Environment variable | Description |
|---|---|---|---|---|
| `checkpoint` | string | auto-pick | `COMFYUI_CHECKPOINT` | Checkpoint file name (the name under `models/checkpoints`). Picks an available one automatically when empty, **preferring names containing `xl`** |
| `negativePrompt` | string | see below | — | Default negative prompt; the tool argument `negative_prompt` overrides it |
| `steps` | number | `20` | `COMFYUI_STEPS` | Sampling steps, valid range `1`–`500` |
| `cfgScale` | number | `7` | `COMFYUI_CFG_SCALE` | CFG, valid range `0`–`100` |
| `samplerName` | string | `euler` | `COMFYUI_SAMPLER` | Sampler; **falls back automatically** when it does not exist on this machine, with a note in the result's `notes` |
| `scheduler` | string | `normal` | `COMFYUI_SCHEDULER` | Scheduler; also falls back automatically with a note |
| `width` / `height` | number | `1024` / `1024` | — | Default size, valid range `64`–`8192`. **Only effective for `text2img`**; an SD1.5-like checkpoint name switches it to 512×512 automatically |
| `strength` | number | `0.6` | — | Default img2img change amount, valid range `0`–`1` (`inpaint`'s default is hard-coded to `1.0`) |
| `inpaintGrowMask` | number | `6` | — | How many pixels the mask grows outward during inpainting, valid range `0`–`256`. Larger values make seams more natural; `0` leaves hard edges |

Built-in default negative prompt:

```text
lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry
```

### Output and metadata

| Key | Type | Default | Environment variable | Description |
|---|---|---|---|---|
| `saveToComfyUI` | boolean | `true` | — | `true` = the workflow uses `SaveImage`, so the output also stays in ComfyUI's `output/dsh-comfyui-workbench/`; `false` = uses `PreviewImage`, **not polluting** ComfyUI's output directory |
| `writeMetadata` | boolean | `true` | — | Whether to write a `<image>.json` metadata sidecar next to the image (full parameters and workflow; future consistency work will rely on it) |

### Background removal

| Key | Type | Default | Environment variable | Description |
|---|---|---|---|---|
| `rembgNode` | string | auto-pick | `COMFYUI_REMBG_NODE` | Select the background-removal plan; **only affects `remove_background`**. Accepts a plan key: `essentials` / `bria` / `layerstyle` / `was`, or a node class name (such as `RemBGSession+`, `ImageRemoveBackground+`). A specified plan missing on this machine produces a **clear error** (rather than quietly using another) |

### The plugin itself

| Environment variable | Description |
|---|---|
| `DSH_COMFYUI_WORKBENCH_CONFIG` | Overrides the **config file path itself** (default `~/.dsh-comfyui-workbench/config.json`). For tests and multi-environment switching |
| `DSH_COMFYUI_WORKBENCH_DEBUG` | Set to `1` / `true` / `yes` to enable debug logging (prefixed `[dsh-comfyui-workbench]`): resolved config, the chosen background-removal plan, file names uploaded to ComfyUI, HTTP details, and so on. **Off by default** to avoid polluting DSH session output |
| `HF_TOKEN` / `HUGGING_FACE_TOKEN` | Hugging Face read token; preferred over storing it in a file |
| `HF_ENDPOINT` | Hugging Face Hub endpoint override |
| `DSH_COMFYUI_WORKBENCH_MODELS_DIR` | Local `ComfyUI/models` path |
| `DSH_COMFYUI_WORKBENCH_DOWNLOAD_DIR` | Model download staging directory |

---

## 3. Environment Variable Cheat Sheet

Alphabetical, easy to copy into Docker / startup scripts:

```bash
COMFYUI_URL=http://127.0.0.1:8188          # = baseUrl
COMFYUI_BASE_URL=http://127.0.0.1:8188     # = baseUrl (alias)
COMFYUI_CHECKPOINT=sd_xl_base_1.0.safetensors
COMFYUI_STEPS=25
COMFYUI_CFG_SCALE=7
COMFYUI_SAMPLER=euler
COMFYUI_SCHEDULER=normal
COMFYUI_TIMEOUT_MS=600000
COMFYUI_REMBG_NODE=essentials
DSH_COMFYUI_WORKBENCH_OUTPUT=D:/images         # = outputDir
DSH_COMFYUI_WORKBENCH_CONFIG=/etc/dsh-workbench.json # the config file path itself
DSH_COMFYUI_WORKBENCH_DEBUG=1                  # enable debug logging
```

Boolean options (`saveToComfyUI` / `writeMetadata`) have no environment variable: set them as JSON `true` / `false` in the config file or the profile config.

> Environment variables are process-wide for the whole DSH process — if a key should apply to **everyone** but rank below the profile,
> put it in the config file; if you want a one-off override, use an environment variable. Also **note**: DSH launched from a
> graphical interface may not inherit variables you `set` in a terminal (especially easy to hit on Windows).

---

## 4. Writing It in the Profile Config Tree (Highest Priority)

Edit `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: dsh-comfyui-workbench
  name: dsh-comfyui-workbench
  config:
    baseUrl: 'http://127.0.0.1:8188'
    checkpoint: 'sd_xl_base_1.0.safetensors'
    outputDir: 'D:/images'
    timeoutMs: 900000
```

Restart DSH afterwards (the config tree is read at startup). To disable the plugin temporarily: add `disabled: true` in the same place,
or toggle it in the plugin manager.

When a plugin does not export a `Config` schema, Cordis hands the raw object to `apply` **as-is**, so no schema declaration is needed here.

---

## 5. Confirming the Config Really Took Effect

```bash
cd <plugin-directory>
npm run doctor
```

The first section of the output is the **effective configuration**:

```
[Configuration]
  Config file: C:\Users\me\.dsh-comfyui-workbench\config.json
  ComfyUI address: http://127.0.0.1:8188
  Checkpoint: (not set, one will be picked automatically)
  Default sampling: euler / normal, steps=20, cfg=7
  Default size: 1024x1024 (SD1.5-family drops to 512 automatically)
  Output directory: (not set, defaults to the current project root)
```

`--json` gives a machine-readable version, handy for comparisons and for pasting into an issue.

**Three checks, in order, when config does not take effect**:

1. Is that key **also** written in the profile's plugin `config:`? (It has higher priority and overrides the config file.)
2. Maybe an environment variable is overriding it: was `COMFYUI_URL` or similar set elsewhere?
3. Is the JSON malformed? — the plugin **does not crash** when the config cannot be read; it **silently falls back to defaults** with a
   warning in the log, so "the file was clearly edited but nothing changed" is most often a misplaced comma. Just validate the syntax:

   ```bash
   node -e "const fs=require('fs'),os=require('os'),p=require('path');JSON.parse(fs.readFileSync(p.join(os.homedir(),'.dsh-comfyui-workbench','config.json'),'utf8'));console.log('JSON syntax OK')"
   ```

   Or just look at the "Configuration" section `doctor` prints — it shows the **merged values that will really be used**.

---

## 6. Security and Privacy

- The plugin talks **only** to the `baseUrl` you configure; it never contacts any third-party service;
- It does not upload your images to any cloud (only to your local ComfyUI's `/upload/image`);
- It neither reads nor writes ComfyUI's config/model directories (except through its HTTP API);
- The only places it writes: the output directory you specify, `~/.dsh-comfyui-workbench/`, and the `.json` sidecar next to each image.
- The advanced tools are equally local, but `comfyui_workflow` executes arbitrary workflows and `comfyui_api` can call any endpoint (including `/free`, `/queue` and `/settings`). Treat them as privileged local operations.
