# Full ComfyUI Access

`generate_image` is the simple path: four curated modes with smart defaults. The advanced tools expose the rest of ComfyUI so an Agent can discover what is installed, inspect any node, and run any workflow the server supports.

| Tool | Purpose | Writes? |
|---|---|---|
| `comfyui_inspect` | Read-only discovery: models, all nodes and their schemas, embeddings, system, queue, history | No |
| `comfyui_workflow` | Validate / run / wait on arbitrary API-format workflows, upload assets, job control | Yes (outputs, uploads, queue/free) |
| `comfyui_api` | Raw HTTP escape hatch for any other ComfyUI endpoint | Depends on the endpoint |

All three use the same `baseUrl` configuration as `generate_image` and are registered automatically when the plugin loads.

---

## 1. Inspect: models, nodes, system, queue, history

`comfyui_inspect` has a `scope` parameter; the default is `overview`.

### Models

```json
{ "scope": "models" }
```

Returns every model file grouped by the ComfyUI folder it loads from, for example:

```text
Models: 124 file(s) across 9 folder(s) (source: mixed)

checkpoints (3)
  Main diffusion checkpoints (SD1.5, SDXL, ...).
  used by: CheckpointLoaderSimple.ckpt_name
  - sd_xl_base_1.0.safetensors
  - ...

loras (41)
  LoRA adapters.
  used by: LoraLoader.lora_name, LoraLoaderModelOnly.lora_name
  - detail.safetensors
  ...
```

Model discovery uses, in order:

1. ComfyUI's `/models` and `/models/{folder}` endpoints (modern versions);
2. the enum choices of known loader nodes (`CheckpointLoaderSimple`, `LoraLoader`, `VAELoader`, `ControlNetLoader`, `UpscaleModelLoader`, `CLIPLoader`, `UNETLoader`, ...);
3. `/embeddings` for textual inversion embeddings;
4. a dynamic scan of every other model-like enum in `/object_info`, which catches model files added by custom nodes.

Filters: `folder` (for example `checkpoints`, `loras`, `vae`, `controlnet`, `upscale_models`) and `query` (substring of the file name). The `data` field contains the complete catalogue; the text output shows a bounded sample.

Some custom nodes register non-model folders (`custom_nodes`, prompt libraries, fonts, video formats). `custom_nodes` is excluded, and cache/code files are filtered out; other registered asset folders are kept because their nodes use them.

### Nodes

```json
{ "scope": "nodes", "query": "controlnet", "limit": 25 }
```

Search by class name, display name, category or description. Results include input counts and output types. Use `category` to narrow to a category substring.

### One node's full schema

```json
{ "scope": "node", "node": "KSampler" }
```

Returns required/optional inputs, types, defaults, enum values, metadata (`min`/`max`/`tooltip`/...), and outputs. `max_enum_values` controls truncation (default 50); set it to `0` for the complete list.

Use the comma form for several nodes: `"node": "KSampler,VAEDecode,SaveImage"`. A misspelled name returns suggestions instead of failing.

### Overview, system, embeddings, queue, history

```json
{ "scope": "overview" }
{ "scope": "system" }
{ "scope": "embeddings" }
{ "scope": "queue" }
{ "scope": "history", "limit": 20 }
```

`overview` combines the system summary, model/node counts, queue state and a few recent history entries. `history` returns completed jobs with their prompt ids, status, node types and output names; `query` filters those fields.

### Refreshing the node catalogue

`/object_info` is cached for 60 seconds. After installing custom nodes, pass `"refresh": true` to force a refetch.

---

## 2. Workflow: validate and run arbitrary workflows

The workflow format is ComfyUI's **API format**: an object mapping node ids to `{ class_type, inputs }`. Link inputs are `[upstream_node_id, output_index]`.

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "a corgi astronaut", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "blurry, watermark", "clip": ["1", 1] } },
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "5": {
    "class_type": "KSampler",
    "inputs": {
      "seed": 42,
      "steps": 20,
      "cfg": 7,
      "sampler_name": "euler",
      "scheduler": "normal",
      "denoise": 1,
      "model": ["1", 0],
      "positive": ["2", 0],
      "negative": ["3", 0],
      "latent_image": ["4", 0]
    }
  },
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
  "7": { "class_type": "SaveImage", "inputs": { "filename_prefix": "agent", "images": ["6", 0] } }
}
```

### Validate before running

```json
{ "action": "validate", "workflow": { "...": "..." } }
```

Local validation checks:

- unknown node types (with "did you mean" suggestions);
- unknown input names (with suggestions);
- missing required inputs;
- links to nodes that do not exist, or output slots out of range;
- values outside a declared enum or numeric `min`/`max`;
- workflows with no output node (warning).

This catches most mistakes before ComfyUI returns an opaque HTTP 400. Validation is also performed automatically by `run` unless `"validate": false`.

### Run and save outputs

```json
{
  "action": "run",
  "workflow_path": "D:/workflows/outpaint.json",
  "output_path": "D:/images/runs/outpaint-1",
  "timeout_ms": 600000,
  "max_outputs": 20
}
```

- `wait` defaults to `true`: the tool polls `/history/{prompt_id}` and downloads every produced file.
- With `"wait": false`, the tool returns the `prompt_id` immediately; collect it later with `{ "action": "wait", "prompt_id": "..." }`.
- Output files are saved under `output_path` (default: the current project root). A single output may be given an exact file path (for example `D:/images/out.png`); multiple outputs use it as a directory.
- Existing files are never overwritten: `-1`, `-2`, ... is appended.
- Images, GIFs, audio, video and arbitrary binary outputs are fetched through `/view`; text outputs are included in the result.
- A `comfyui-workflow-<timestamp>-<prompt>.json` metadata sidecar records the workflow, prompt id, status, outputs and history.
- `save_outputs=false` skips downloads; `write_metadata=false` skips the sidecar.

### Upload input files

```json
{ "action": "upload", "file_path": "D:/pics/input.png" }
```

Returns the file name ComfyUI assigned. Use it in `LoadImage` / `LoadImageMask` inputs, for example:

```json
{ "class_type": "LoadImage", "inputs": { "image": "input.png" } }
```

`kind` can be `auto` (default), `image`, `mask` or `file`. All are uploaded to ComfyUI's input directory via `/upload/image`; the label is informational and is returned in the result.

### Job control

```json
{ "action": "queue" }
{ "action": "queue_delete", "queue_ids": ["abc123"] }
{ "action": "queue_clear" }
{ "action": "interrupt" }
{ "action": "free", "unload_models": true, "free_memory": true }
```

`interrupt` cancels the currently running job (ComfyUI's `/interrupt` has no prompt id). `free` unloads models or releases cached memory.

### Workflow paths and the Agent

`workflow_path` resolves relative to the Agent's current working directory. Both `workflow` (inline) and `workflow_path` are accepted, but not both at once.

---

## 3. Raw API: any other endpoint

`comfyui_api` sends an HTTP request to the configured ComfyUI server. The base URL cannot be changed, and the path must start with `/`.

```json
{ "method": "GET", "path": "/models" }
{ "method": "GET", "path": "/object_info/KSampler" }
{ "method": "POST", "path": "/free", "body": { "unload_models": true, "free_memory": true } }
{ "method": "GET", "path": "/settings" }
```

Responses:

- JSON is parsed and returned in `data.json`; text is returned in `text`.
- Binary content (images, audio, video, octet-stream) is saved to `save_path` or a generated file in the current working directory.
- `response_type` can force `json`, `text` or `binary`.
- `max_bytes` caps textual/JSON rendering (default 100 KB); binary files are saved in full. Raise it for a specific endpoint if you really need a larger dump, or use `comfyui_inspect` for structured discovery.

Guardrails:

- only the configured ComfyUI host can be reached (no absolute URLs);
- `..` path segments, websocket paths and multipart upload endpoints are rejected with a hint to use the structured tools;
- `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` and `Upgrade` headers are ignored;
- redirects are not followed automatically, so a 3xx is returned instead of silently contacting another host.

Use this for settings, user data, custom-node manager APIs, newer ComfyUI endpoints, or any extension route. Treat it as an escape hatch: prefer `comfyui_inspect` and `comfyui_workflow` when they cover the task.

---

## 4. Building a workflow from discovery

A reliable Agent loop:

1. `comfyui_inspect` `scope=overview` — confirm the server is reachable and see versions.
2. `comfyui_inspect` `scope=models` — confirm the required checkpoint/LoRA/VAE file names.
3. `comfyui_inspect` `scope=nodes` `query=...` — find nodes for the task (for example `controlnet`, `ipadapter`, `upscale`).
4. `comfyui_inspect` `scope=node` for each chosen node — read required inputs, enum values and defaults.
5. `comfyui_workflow` `action=validate` — catch structural mistakes.
6. `comfyui_workflow` `action=run` — execute and save outputs.
7. If something fails, read the error, adjust, and validate again.

This is exactly the information needed to build a valid API-format graph: node class names, input names, required vs optional inputs, link types, enum choices and output slots.

---

## 5. Safety and limits

- All requests go only to the configured `baseUrl`; there is no third-party network access.
- Workflows can do anything the installed nodes can do, including writing files through ComfyUI output nodes. Treat workflow execution as privileged, like running code on the ComfyUI host.
- Raw API access can change server state (`/free`, `/queue`, `/settings`, custom-node manager endpoints). Use it deliberately.
- Output downloads are capped by `max_outputs` (default 20, max 100).
- Workflow waits are capped by `timeout_ms` (default: the configured `timeoutMs`, 5 minutes out of the box; max 1 hour); a timeout leaves the job running.
- Local validation is best-effort. Setting `"validate": false` lets ComfyUI make the final decision.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown node type "..."` | The custom node is not installed/loaded, or the class name is misspelled. Check `comfyui_inspect scope=nodes`, and `refresh=true` after installing nodes. |
| `Missing required input "..."` | Read `comfyui_inspect scope=node` for that node and supply the input explicitly. |
| `Input "..." does not accept "..."` | Use one of the listed enum values; `scope=models` shows installed model file names. |
| `links to node "...", which does not exist` | The link must reference a node id present in the same workflow object. |
| `No output node ... found` | End the workflow with `SaveImage`, `PreviewImage`, `SaveAudio` or another output node. |
| Outputs not downloaded | Check that `save_outputs` is true and `output_path` is writable; read `warnings` for fetch errors. |
| `comfyui_api` returns 404 | The endpoint does not exist on this ComfyUI version. Use the version-specific endpoint or the structured tools. |
| `action=wait` times out | Confirm the prompt id with `comfyui_inspect scope=queue` / `scope=history`, then increase `timeout_ms`. |

For the high-level generate_image path, see the main [README](../README.md) and [USAGE.md](./USAGE.md).
