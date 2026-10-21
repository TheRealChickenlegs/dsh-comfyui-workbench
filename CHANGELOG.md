# Changelog

This file records version changes of **dsh-comfyui-workbench**. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-10-21

### Changed

- Rewrote the README around the full workbench: all six tools, audio/video model requirements and detection, advanced workflows, configuration, outputs and troubleshooting.
- Added npm installation as the primary path in the README and installation guide.
- Republished to npm to refresh the package README. No runtime behavior changed from 0.2.0.

## [0.2.0] — 2026-10-21

### Added

- **High-level `generate_audio` and `generate_video` tools** with capability detection:
  - `generate_audio` runs ACE-Step 1.5 from either the AIO checkpoint `ace_step_1.5_turbo_aio.safetensors` or the split diffusion + qwen text encoders + ace VAE layout, with tags, lyrics, duration, BPM, key, language, seed and sampler controls.
  - `generate_video` runs the tested Wan 2.1 text-to-video graph (Wan T2V diffusion model + UMT5 safetensors encoder + Wan VAE), with dimensions, frames, fps, steps, CFG and seed.
  - Both tools inspect models and required nodes **before submitting**, and report detected media models plus the exact missing pieces when a setup is incomplete. Other video families are intentionally left to `comfyui_workflow`.
- [docs/MEDIA.md](docs/MEDIA.md): supported audio/video model layouts, parameters, detection feedback examples and troubleshooting.
- **Full ComfyUI access through three advanced tools** (registered alongside `generate_image`, which is unchanged):
  - `comfyui_inspect` — read-only discovery of **every installed model** grouped by ComfyUI model folder, **every available
    node** with a compact search and full input/output schema, embeddings, system stats, queue and history. Model discovery
    prefers `/models` and falls back to loader-node enums, with a dynamic scan of custom-node model inputs.
  - `comfyui_workflow` — local validation of arbitrary API-format workflows (unknown nodes/inputs, missing required inputs,
    dangling links, enum/numeric violations), submission, polling, downloading every output, metadata sidecars, input uploads,
    queue inspection/clear/delete, interrupt and free-memory controls.
  - `comfyui_api` — raw HTTP access to any other ComfyUI endpoint, with the base URL fixed, path validation, JSON/text/binary
    handling and binary saving.
- [docs/ADVANCED.md](docs/ADVANCED.md): model/node discovery, workflow validation and execution, uploads, job control,
  raw API examples, safety limits and troubleshooting. The README now has a "Full ComfyUI Access" section.
- [docs/MIGRATION.md](docs/MIGRATION.md): upgrading from `dsh-comfyui-image`, config/env migration and the legacy support timeline.
- The test suite grew from 88 to **134 tests**, covering model fallbacks, node schemas, validation failures, workflow
  execution with exact-file and multi-output saving, uploads, job control and raw API guardrails.

### Changed

- **English localization across the whole plugin**: every user-visible string is now English — the tool description and
  parameter/output schema descriptions, result text, notes, error messages, the `doctor` self-check output, debug logs,
  and the plugin title/description shown in the DSH plugin list. Source comments, tests, CI messages, and all documentation
  were translated as well. The English `README.en.md` / `docs/INSTALL.en.md` duplicates were merged into `README.md` /
  `docs/INSTALL.md`, so the GitHub default page and the packaged README both render English.
- **Renamed the plugin from `dsh-comfyui-image` to `dsh-comfyui-workbench`** and widened its identity from an image tool to a
  ComfyUI workbench. Package id, DSH entry id, config directory, config/env variable names, output folder, metadata and log
  prefixes all use the new name. Tool names and call signatures are unchanged. See [docs/MIGRATION.md](docs/MIGRATION.md).
- **Repository metadata and install instructions are now self-contained**: badges, `package.json` repository/bugs/homepage,
  install commands and release links point at `TheRealChickenlegs/dsh-comfyui-workbench`; no external npm package is
  referenced. `publish.yml` reads the package name from `package.json`, so renaming the package does not break publishing.

### Fixed

- **`PLUGIN_VERSION` disagreed with `package.json`**: `src/runner.ts` still reported `0.1.0` while the package was `0.1.1`,
  so the startup log and every metadata sidecar carried the wrong version. Package and runtime are now both `0.2.0`.
- **The lockfile pointed at a third-party mirror and had a stale version**: `package-lock.json` resolved tarballs from
  `mirrors.huaweicloud.com` and still recorded `0.1.0`, so `npm ci` outside China could fail. It now pins
  `https://registry.npmjs.org` with integrity hashes and the `0.1.1` version, and CI uses `npm ci`.

## [0.1.1] — 2026-10-04

### Added

- **Automated release pipelines** (both tag-driven; no local publish command needed):
  - [.github/workflows/release.yml](.github/workflows/release.yml): pushing a `v*.*.*` tag automatically creates a GitHub Release
    (notes generated by GitHub from the commits; an existing Release with the same name is skipped rather than erroring;
    historical tags can be backfilled manually from the Actions page).
  - [.github/workflows/publish.yml](.github/workflows/publish.yml): after a Release is published, automatically runs
    `npm test` + `npm publish --provenance --access public`. Before publishing it **verifies that the tag name matches the
    `package.json` version** (npm cannot republish the same version, so this guard is worth more than fixing the version afterwards);
    when the `NPM_TOKEN` secret is not configured it **skips publishing and prints a notice**, keeping the workflow green so
    forks that push tags do not turn red.
- Package metadata completed with `repository` / `bugs` / `homepage` / `publishConfig` (`publishConfig` explicitly pins the official
  registry so a local or CI mirror cannot change the publish target; `repository` is also a prerequisite for npm provenance signing).
- Documentation: added [docs/RELEASING.md](docs/RELEASING.md) (release steps, how to generate and configure `NPM_TOKEN`,
  manual re-release, provenance, checking the `npm pack` list), and linked it from the documentation table.
- Added an **example output image** [docs/preview.png](docs/preview.png) to the top of the README: produced by this plugin against
  a local ComfyUI, with its reproduction parameters (`seed 42` / 512×512 / SD1.5 checkpoint) recorded in the documentation, so
  new visitors can see at a glance that it really generates images.
- Installation is **from this repository**: `dsh plugin --profile <your profile> add github:TheRealChickenlegs/dsh-comfyui-workbench`
  (`dsh plugin` is backed by pnpm, and the installed `lib/` files run directly — **no local clone, no build**), or by linking a local checkout.
- Added a **release badge** to the top of the README.

### Fixed

- **CI Actions upgraded to v7**: `actions/checkout` and `actions/setup-node` went from `@v4` to `@v7`.
  The trigger was GitHub adding a `Node.js 20 is deprecated` annotation to every job — the v4 series of these Actions declares a Node 20 runtime,
  which was being forced onto Node 24. Before upgrading, both `action.yml` files were checked item by item to confirm they still support
  the `fetch-depth` / `node-version` / `registry-url` inputs this repository uses, and that they declare `using: node24` — not upgraded by guessing from version numbers.

- **The token setup instructions in `docs/RELEASING.md` did not match the current npm UI**: the original text said "choose Granular Access Token,
  or the classic **Automation** type", but today's npm, after clicking **Generate New Token**, goes **straight to the
  `New Granular Access Token` form with no Classic entry at all**; the original "package scope: this package or all packages"
  also does not exist in the actual UI. It has been rewritten as an item-by-item table matching the real UI, with the three easiest mistakes:
  `Bypass two-factor authentication (2FA)` **must be checked** (otherwise publishing needs a code and CI hangs),
  `Permissions` must be **Read and write (publish and stage)** (`stage only` cannot publish),
  and `Allowed IP ranges` **must be left empty** (GitHub Actions egress IPs change every time). Also added the **90-day lifetime and rotation** explanation.
  Getting credential documentation wrong costs people half an hour of searching in a UI — this time it was rewritten after checking every item against real screenshots.

## [0.1.0] — 2026-10-03

The first usable version (the "practical V1").

### Added

- **A single Agent tool, `generate_image`**: one entry point covers four modes, split into modules internally,
  exposing only one tool externally (`text2img` / `img2img` / `inpaint` / `remove_background`).
- **Parameter inference**: when `mode` is omitted it is inferred from `input_image` / `mask_image` (image + mask → inpaint, image only → img2img,
  neither → text2img); the mode is **never guessed**: a conflict is an immediate error explaining how to fix it.
- **Unified parameter layer**: `prompt` / `negative_prompt` / `input_image` / `mask_image` / `width` / `height` /
  `seed` / `output_path` / `strength` / `steps` / `cfg_scale` / `model` / `sampler_name` / `scheduler` /
  `extra_options`; `style_reference` / `character_reference` as reserved consistency slots (V1 only records them in metadata).
- **Sensible defaults**: size follows the checkpoint (SDXL 1024 / SD1.5 512), random seed, steps 20, cfg 7,
  output lands in the current project root, filenames are timestamped and **never overwrite** existing files.
- **Local ComfyUI backend**: only Node built-ins (`fetch` / `FormData`), zero runtime dependencies;
  its own implementation of the `/system_stats`, `/object_info`, `/upload/image`, `/prompt`, `/history`, `/view`, `/interrupt` calls.
- **Capability probing**: auto-select a checkpoint (preferring names containing `xl`), verify that samplers/schedulers really exist,
  choose a background-removal plan by availability (best of ComfyUI_essentials / ComfyUI-BRIA_AI-RMBG / ComfyUI-LayerStyle / WAS Node Suite;
  repository and class names come from ComfyUI-Manager's `extension-node-map.json` index, not from memory).
- **Clear errors**: cannot reach ComfyUI, input file missing, workflow execution failure, timeout, missing background-removal node...
  every error carries "what to do next" instead of a bare `fetch failed`.
- **Results and metadata**: returns the local absolute path (on its own line, clickable in DSH), mode / seed / size / duration / prompt_id, and more;
  a `.json` metadata sidecar next to every image (full parameters and submitted workflow, reproducible and debuggable).
- **Four configuration sources**: plugin config > `~/.dsh-comfyui-workbench/config.json` > environment variables > built-in defaults;
  editing the config file **takes effect immediately**, with no DSH restart.
- **Extension escape hatch**: `extra_options.workflow_path` can point at any API-format workflow JSON,
  using placeholders such as `{{prompt}}` / `{{seed}}` / `{{input_image}}` to take over this generation (outpainting, upscaling, batching, special nodes can all be wired in).
- **Self-check script** `npm run doctor`: prints the effective config, ComfyUI version and devices, real available checkpoint/sampler values,
  and decides per mode whether it can run (exit code 0 all available / 1 unreachable / 2 some mode unavailable).
- **Tests**: 88 tests, including end-to-end verification against a "fake ComfyUI" (real PNG encode/decode, real uploads, real polling, real error paths) —
  runnable on machines without ComfyUI.
- **Documentation**: bilingual README (`README.md` / `README.en.md`) and installation guide (`docs/INSTALL.md` / `docs/INSTALL.en.md`) at the time,
  plus `docs/` (configuration, usage, parameters, FAQ, roadmap). From 0.2.0 onward the documentation is English-only.

### Fixed

Two bugs found during real-machine verification (ComfyUI 0.38.0 + Intel Arc XPU), both fixed with regression tests:

- **"Adapt size to the checkpoint" did not work on the most common path**: when the parameter layer resolved arguments, the checkpoint might not
  be decided yet (the user passed no `model`, the config had no `checkpoint`, so it had to be auto-picked), so the size always fell back to the
  config default — with only an SD1.5 checkpoint on the machine it still produced 1024×1024, contradicting the tool description's promise of 512.
  Now the request records "which dimensions were given explicitly", and once the checkpoint is really chosen (possibly auto-picked) the default
  size is filled in, with the basis stated in `notes`; the mock also gained a "only an SD1.5 checkpoint" case, removing the blind spot where
  "the adapted value happened to equal the config default".
- **The size reported by `img2img` / `inpaint` did not match the produced image**: in `OUTPUT_SCHEMA`, `width` / `height` mean
  "output width / output height", but the report and sidecar used to copy the requested values — a 512×512 input produced a 512 image while
  the report said 1024. Now it always uses the real pixels from the **produced file bytes** (parsing PNG / JPEG headers), and when it differs
  from the request an extra `notes` entry explains why. The mock was also made faithful: `img2img` / `inpaint` output size now follows the
  uploaded input image (matching real ComfyUI) instead of always returning 64×64.
- **One environment-dependent test**: it required "the default address can never connect", which failed on machines with ComfyUI installed
  (green in CI, red on a dev machine). Following the test suite's own principle, the default address is now pinned to an unreachable port,
  so the test verifies only what it should.
- **`npm test` failed outright on Node 20** (the two Node 20 platforms in the CI matrix were red, Node 22 green):
  `node --test "test/*.test.mjs"` depends on `--test` glob expansion, a Node 21 feature; Node 20 treats the quoted wildcard as a literal path
  and reports `Could not find '.../test/*.test.mjs'`; removing the quotes so the shell expands also fails — npm scripts run through cmd on Windows
  (no glob expansion) and sh on POSIX (expansion). It now uses `scripts/run-tests.mjs`: it lists `test/*.test.mjs` itself and hands
  **explicit paths** to `--test`, which works on Node 18+ with identical behaviour on both platforms (`engines` still declares `>=20`;
  compatibility is not hidden by raising the floor).
- **Three serious flaws in the background-removal options list** (exposed only after installing `ComfyUI_essentials` on a real machine, settled with
  ComfyUI-Manager's `extension-node-map.json` index):
  1. the original top-priority option named a node class `RemBG`, but **no repository** in the index declares that class, and the repository
     the install hint pointed at, `Limbicnation/ComfyUI_RemBG-U2Net`, **does not exist** (the API returned 404);
  2. the hint said `git clone https://github.com/1038lab/ComfyUI-RMBG` would provide `BRIA_RMBG_Zho`, but that repository provides the
     `AILab_*` family; the real provider is `ZHO-ZHO-ZHO/ComfyUI-BRIA_AI-RMBG`;
  3. the essentials option treated `ImageRemoveBackground+` as a **single node**, but its `rembg_session` is a required input that must be fed by
     `RemBGSession+`; without it, a real machine fails with "HTTP 400 required_input_missing: rembg_session" — **and `doctor` still wrongly
     reported "available"**, because probing only checked whether the node existed.
  All four options are now real repositories verifiable in the index; essentials builds `RemBGSession+ → ImageRemoveBackground+` **as a pair**
  with asserted wiring, and a regression test for a single-node option (WAS) covers the `buildSingle` branch.

### Known Limitations

- Background removal depends on third-party custom nodes; this plugin only does selection and installation guidance, not packaging nodes.
  Core ComfyUI 0.3x ships `LoadBackgroundRemovalModel` + `RemoveBackground` (image → MASK, requiring a model under
  `models/background_removal/`); different from the existing "one image in, one image out" path, it is **not wired up yet**.
- `upscale` / `outpaint` / batch multi-image are **not built into V1**; use `extra_options.workflow_path` custom workflows instead.
- `style_reference` / `character_reference` are **recorded only in V1 and do not affect generation** (consistency is a later version).
- Verified on a real machine: ComfyUI 0.38.0 + Intel Arc (XPU backend, `torch 2.14.0+xpu`), **all four modes pass end to end** —
  `text2img` / `img2img` / `inpaint` generate directly; `remove_background` goes through `RemBGSession+ → ImageRemoveBackground+`,
  producing a 512×512 RGBA image (a real alpha channel, verifiable). The error path when third-party nodes are missing was also tested for real,
  listing four installation options that can be followed directly. Node key names and enums were checked character for character against the
  official ComfyUI source (`nodes.py` / `samplers.py`).
