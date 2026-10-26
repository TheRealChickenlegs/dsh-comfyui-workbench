# Hugging Face Model Downloads

The `huggingface_models` tool searches Hugging Face, lists repository files and downloads model files for ComfyUI.

## 1. Configure a token

A token is optional for public repositories. It is required for gated or private repositories and for higher API limits.

Provide it in one of these ways:

**Plugin page**

Open **Plugins → ComfyUI Workbench → Configuration → Hugging Face downloads**. The token field is write-only: it never shows the stored value. Enter a new token to replace it.

**Environment variable (recommended)**

```bash
export HF_TOKEN=hf_...
```

The plugin also accepts `HUGGING_FACE_TOKEN`.

**Config file**

```json
{
  "huggingFaceToken": "hf_..."
}
```

The token is sent only as an `Authorization: Bearer ...` header to the configured Hugging Face endpoint. It is not returned in tool output or debug logs, and it is not forwarded to a cross-origin CDN redirect.

For a gated repository, sign in at `https://huggingface.co`, open the model page, and accept its license before downloading. A token with read access is still required.

## 2. Choose where downloads go

### Local ComfyUI (recommended)

Set:

```json
{
  "comfyuiModelsDir": "/Users/me/ComfyUI/models"
}
```

The tool installs files into:

```text
<comfyuiModelsDir>/<folder>/<filename>
```

For example, `folder: "vae"` writes into `ComfyUI/models/vae/`.

### Remote ComfyUI

ComfyUI's HTTP API does not expose a model-upload endpoint. When `comfyuiModelsDir` is not available on the DSH host, set a staging directory:

```json
{
  "modelDownloadDir": "/Users/me/model-staging"
}
```

Then copy the staged file to the ComfyUI server's `models/<folder>/` (for example with `scp`/`rsync`) and restart or refresh ComfyUI.

If neither path is set, staging defaults to:

```text
~/.dsh-comfyui-workbench/downloads/<folder>/
```

A per-call `output_dir` overrides both settings.

### Folder names

Common ComfyUI model folders:

```text
checkpoints
diffusion_models
text_encoders
vae
loras
controlnet
upscale_models
```

`folder` is a single path segment; traversal is rejected.

## 3. Search and inspect

```json
{ "action": "search", "query": "Wan 2.2 ComfyUI" }
```

```json
{ "action": "files", "repo_id": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged" }
```

`files` returns paths, sizes and LFS SHA-256 values where Hugging Face provides them. Use `limit` to bound large repositories (default 100, maximum 500).

## 4. Download

```json
{
  "action": "download",
  "repo_id": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
  "filename": "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_Q4_K_M.gguf",
  "folder": "diffusion_models"
}
```

Options:

| Option | Purpose |
|---|---|
| `revision` | Branch, tag or commit (default `main`) |
| `folder` | Destination model folder (default `checkpoints`) |
| `target_filename` | Override the local basename |
| `output_dir` | Exact destination directory; disables `installed=true` |
| `overwrite` | Replace an existing file (default false) |
| `dry_run` | Report the remote size without writing |

Downloads are written to a `.part` file and renamed only after completion. Partial files are removed on failure. Existing files are never replaced unless `overwrite: true`.

The default safety cap is 50 GiB. Change `maxDownloadBytes` in the plugin page/config if you need a larger model.

## 5. After download

Inspect what ComfyUI sees:

```text
comfyui_inspect scope=models folder=diffusion_models
```

If a newly downloaded file is not listed, restart/refresh ComfyUI. The plugin's node catalogue cache is separate and can be refreshed with `comfyui_inspect refresh=true`.

For a remote ComfyUI, the returned `path` is on the DSH host; copy it to the server before using it in a workflow.

## 6. Endpoint override

The default endpoint is:

```text
https://huggingface.co
```

A compatible mirror can be configured with `huggingFaceEndpoint` or `HF_ENDPOINT`. The endpoint must use HTTP or HTTPS. The token is only sent to that endpoint's origin, not to a different CDN origin.

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 / 403 | Check the token, read access and the model license acceptance |
| 404 | Check `repo_id`, `revision` and the exact `filename` via `action=files` |
| Download too large | Raise `maxDownloadBytes` or use a smaller quantisation |
| Existing file error | Pass `overwrite: true` or choose another `target_filename` |
| Not visible in ComfyUI | Verify `comfyuiModelsDir`, then restart/refresh ComfyUI |
| Remote ComfyUI | Download to staging and copy to the server; the HTTP API cannot install models |
