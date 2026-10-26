# Migrating from `dsh-comfyui-image` to `dsh-comfyui-workbench`

Version **0.2.0** renames the plugin from `dsh-comfyui-image` to `dsh-comfyui-workbench` and widens it into a full ComfyUI workbench. Tool names and call signatures are unchanged.

This guide covers the one-time upgrade. Legacy compatibility is available throughout **0.6.x** and will be removed in **0.7.0**.

## 1. Update the DSH plugin entry

The package/plugin id changed, so the old profile entry will no longer load the plugin. Remove the old bundle and install the new one from this repository:

Use **DSH → Settings → Plugins** to remove/uninstall the old `dsh-comfyui-image` entry, then install the new one:

```bash
dsh plugin --profile <your profile> add github:TheRealChickenlegs/dsh-comfyui-workbench
```

You can also install `github:TheRealChickenlegs/dsh-comfyui-workbench` from the plugin manager, or link the local checkout.

If you edited the profile manually, replace the old dependency/`bundles` entry:

```jsonc
{
  "dependencies": {
    "dsh-comfyui-workbench": "link:D:/dsh/plugins/dsh-comfyui-workbench"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-comfyui-workbench"
      ]
    }
  }
}
```

Restart DSH after changing the bundle list.

## 2. Move the configuration file

New location:

```text
~/.dsh-comfyui-workbench/config.json
```

On Windows: `C:\Users\<you>\.dsh-comfyui-workbench\config.json`.

Move the old directory:

```bash
# macOS / Linux
mv ~/.dsh-comfyui-image ~/.dsh-comfyui-workbench
```

```powershell
# Windows PowerShell
Move-Item "$env:USERPROFILE\.dsh-comfyui-image" "$env:USERPROFILE\.dsh-comfyui-workbench"
```

If you do not move it, **0.6.x** still reads `~/.dsh-comfyui-image/config.json` when the new file is absent, and logs a warning. The new file always wins when both exist.

## 3. Rename environment variables

| Old | New |
|---|---|
| `DSH_COMFYUI_IMAGE_CONFIG` | `DSH_COMFYUI_WORKBENCH_CONFIG` |
| `DSH_COMFYUI_IMAGE_OUTPUT` | `DSH_COMFYUI_WORKBENCH_OUTPUT` |
| `DSH_COMFYUI_IMAGE_DEBUG` | `DSH_COMFYUI_WORKBENCH_DEBUG` |

The old names are still accepted in 0.6.x, but the new names take precedence. The generic `COMFYUI_*` variables (`COMFYUI_URL`, `COMFYUI_CHECKPOINT`, ...) are unchanged.

## 4. Output files and metadata

- Existing generated images and `.json` sidecars are untouched.
- New ComfyUI-side outputs go to `output/dsh-comfyui-workbench/` instead of `output/dsh-comfyui-image/`.
- New metadata sidecars use `"plugin": "dsh-comfyui-workbench"`.
- Local output filenames remain `comfyui-<timestamp>-<random>.png`.

## 5. Tools are unchanged

These names and parameters are stable across the rename:

- `generate_image`
- `comfyui_inspect`
- `comfyui_workflow`
- `comfyui_api`

No Agent prompt changes are required.

## 6. Legacy support timeline

| Version | Behavior |
|---|---|
| **0.6.x** | Reads the legacy config file and accepts legacy `DSH_COMFYUI_IMAGE_*` variables as fallbacks |
| **0.7.0** | Legacy config/env support removed; only the new names are read |

For a clean installation, move the config and rename the variables now rather than relying on the fallback.
