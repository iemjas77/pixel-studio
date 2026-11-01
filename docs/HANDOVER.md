# Pixel Studio – Handover

> **Engineering preview. Not a production release.** No installers, releases, public deploys or paid
> services exist. Photoshop equivalence and PSD compatibility are **not** claimed.
> This file is the single source of truth for status; update it with every milestone commit.

## 1. Launch / build / test

Requirements: Node ≥ 22, npm ≥ 10. Developed and verified on Linux (container, Xvfb). **Never run on Windows yet.**

```bash
npm install                       # also downloads the Electron binary (postinstall)
npm run build                     # vite (editor) + esbuild (Electron main/preload)
npm start                         # build + launch the app (needs a display)
npm run typecheck
npm test                          # 75 unit/integration tests (plain Node, no DOM/Electron)
npm run test:e2e                  # build + 11 Electron E2E tests (incl. GPU golden, actions/batch) under Xvfb (xvfb-run -a); screenshots → e2e-artifacts/
npm run licenses                  # licence summary of installed packages
```
Notes: if `node_modules/electron/path.txt` is missing, run `node node_modules/electron/install.js`.
Running Electron as root in a container needs `--no-sandbox` (the E2E harness passes it; the app itself
keeps `sandbox: true` for the renderer in normal runs). The E2E build honours three env vars that are
**ignored unless `PIXEL_STUDIO_E2E=1`**: `PIXEL_STUDIO_E2E_DIALOGS` (scripted native-dialog results),
`PIXEL_STUDIO_USER_DATA`, and it exposes `window.__ps` for assertions.

## 2. Milestone status

| Milestone | Status | Evidence |
|---|---|---|
| M0 specs | ✅ done | `docs/01…05` |
| M1 document/commands/tiles/native roundtrip | ✅ done | 57 unit tests (§5) |
| M2 working workspace + foundational tools | ✅ done for the listed scope | 6 Electron E2E tests + screenshots (§5) |
| M3 GPU composition + colour reference | ✅ done for stated scope (no ICC; that is M7) | `tests/e2e/gpu.test.ts`: 50 golden scenes ≤ 1/255 vs CPU reference; context-loss recovery; leak check |
| M4 Actions, batch, initial interchange | ✅ done for stated scope | `tests/unit/automation.test.ts`, `tests/unit/interchange.test.ts`, `tests/e2e/actions.test.ts`; spec `docs/06-actions-and-batch.md` |
| M5 … M10 | not started | – |

Acceptance E2E scenarios from the master prompt: **1 ✅, 2 ✅, 4 ✅** automated; **3 ✅** (all four master-prompt scenarios automated).
M5/M10 are *not* met: no Windows run, no accessibility audit, no designer sign-off.

## 3. Layout
`packages/raster-ref` (tiles, blend, CPU compositor, brush, transform, fill) · `packages/document` (model, patch ops,
render tree, preview) · `packages/commands` (engine, history, registry, built-in commands) · `packages/codecs`
(`.pstudio`) · `apps/desktop` (Electron main/preload, atomic IO) · `apps/editor` (React UI) · `tests/unit`, `tests/e2e` ·
`scripts/` (licence report, micro-benchmarks) · `docs/`.
Dependency direction: `raster-ref ← document ← commands ← codecs/editor`; packages never import DOM/Electron.

## 4. Matrix (implemented / partial / planned)

| Feature | State | Notes |
|---|---|---|
| Versioned document model, stable ids, patch ops with exact inverses | Implemented | |
| Command engine: allow-list, schema validation, atomic transactions + rollback | Implemented | |
| Undo/redo, redo invalidation, bounded history (entries + bytes), dirty tracking, one entry per gesture | Implemented | default 500 entries / 256 MiB |
| Sparse 256² tiles, RGBA8 + A8 (fill 0/255), copy-on-write | Implemented | TS reference engine |
| Brush / eraser (size, hardness, opacity cap, flow, spacing, pressure→size/flow), interpolation, selection clip | Implemented | pen pressure path **untested with hardware** |
| Rect selection (marquee, select all, deselect), fill, clear | Implemented | single rectangle only |
| Move (drag + arrow nudge), flip H/V, rotate 90/180, scale % | Implemented / Partial | scale = bilinear, aliases on large downscale; no interactive handles |
| Layers: add/delete/duplicate/reorder (DnD)/rename/visibility/lock/opacity/12 blend modes | Implemented | |
| Groups | Partial | create, nest via drag, collapse, isolated compositing; no pass-through, no group transform |
| Layer masks: reveal/hide/from selection, paint on mask, enable/disable, delete, apply | Implemented | mask is raster-only; no density/feather |
| Text layers: create/edit/rasterize, family/size/weight/italic/colour/align/leading/tracking/area width, missing-font notice | Partial | Canvas 2D shaping; **no tests for Arabic/Indic/CJK/bidi**; no OpenType UI, path text |
| Eyedropper, zoom/pan/fit, hand, space-pan | Implemented | |
| Document tabs (multi-doc), new/open/save/save-as/close, dirty prompts | Implemented | E2E covers single-doc flows; multi-tab switching manually unverified |
| `.pstudio` v1 read/write, limits, CRC, bomb-safe inflate, unknown-data preservation | Implemented | self-roundtrip + negative tests only |
| Import PNG/JPEG/WebP/GIF/BMP (Chromium decoders) | Partial | ≤ 64 Mpx; embedded ICC **not verified** (Chromium may convert to sRGB); 16-bit reduced to 8 |
| Export flattened PNG/JPEG/WebP | Partial | ≤ 100 Mpx; JPEG composited on white; clearly labelled "flattened" |
| Atomic native save; autosave (15 s, dirty only); explicit crash recovery dialog | Implemented | recovery E2E uses SIGKILL |
| Narrow IPC, contextIsolation, sandbox, CSP, navigation/window.open denied | Implemented | not independently audited |
| Place image as layer | Implemented | not Action-recordable |
| History panel (jump), Color panel, Properties, Layers | Implemented | |
| Actions: record, stop, name, save/load (.psaction), replay (undoable, atomic), allow-listed validation | Implemented | absolute coordinates; symbolic layer targets |
| Batch: folder in/out, naming template, overwrite policy, isolated docs, bounded concurrency, progress, cancel, per-file report | Implemented | cancel verified in unit test with fake IO (not clicked in E2E); runs on renderer main thread |
| Flattened TIFF + flattened PSD (composite only) export | Implemented | validated by Pillow + ImageMagick; **not** layered, no ICC |
| WebGL2 per-layer compositor (12 blend modes, masks, opacity, offsets, isolated groups, RGBA32F premultiplied accumulation), CPU fallback, context-loss recovery, resource cleanup | Implemented | tiles ≤ 4096² per call; layer pixels uploaded per region (no persistent GPU texture cache yet); GPU readback per tile |
| Linear-light blending option (`canvas.blendSpace`, format 1.1, undoable command, View menu) | Implemented | CPU + GPU; resampling/brush/fill remain on encoded sRGB |
| ICC, CMYK, soft proof, 16-bit/float | Planned (M6/M7) | |
| Rulers, guides (model only), dockable panels, workspace presets, shortcut editor, Photoshop-like preset | Planned (M10) | |
| Crop/resample, lasso/wand, feather, gradients, patterns, clone/heal, curves/levels, filters, effects, clipping, adjustment layers | Planned (M9) | |
| PSD/PSB (any form) | Planned (M8) – **no primary-source research done yet** | |

## 5. What was verified (and how)
**Unit/integration (`npm test`, 57 tests):** tiles (sparse, boundaries, negative coords, COW, fill-255 masks) · brush (no gaps on
390 px jump, tile crossing, opacity cap, flow, selection clip with layer offset, eraser, mask paint, determinism, cancel) ·
compositor (blend values vs W3C formulas, alpha, offsets, masks, isolated groups, cancellation) · command engine (undo/redo
exactness over 5 states, redo invalidation, batch rollback incl. mid-op failure, strict param validation, locks/hidden/text
guards, bounded history, dirty tracking, **live-stroke ≡ replayed command byte-identical**, masks, transforms identity laws,
groups, text rasterize undo, dirty rects) · `.pstudio` (roundtrip + byte-stable rewrite, sparse file size, header/manifest/blob
corruption, every-truncation sweep, ~300 single-byte flips, version policy, 64 MiB deflate bomb rejected < 5 s, malformed
manifests, unknown-data preservation) · atomic write failure injection (write/fsync/rename, short writes).
**Electron E2E (`npm run test:e2e`, 6 tests, real UI input via Playwright `_electron`, assertions on live document state and,
for export, on an independently decoded PNG):** (1) create→paint→undo/redo→save→reopen with identical fingerprint; (2) PNG
import (pixel-exact)→layer→marquee fill→hide-all mask→paint mask→opacity slider (1 history entry)→text→refusal to paint on
text→flattened PNG export decoded and checked at mask/text/base pixels; (4) truncated / garbage / future-major files each give a
clear dialog and leave the document, history and tab count unchanged; workspace test (move, nudge, flip, blend, visibility,
duplicate, group, selection-clipped brush, history jump, zoom); rasterize/eraser/eyedropper undo chain; autosave + SIGKILL + recovery.
Screenshots: `e2e-artifacts/*.png` (git-ignored; regenerate with the E2E command).
`npm audit`: 0 vulnerabilities. Licence summary: MIT/Apache-2.0/ISC/BSD only (+1 CC-BY-4.0 data package, dev-only).

## 6. Performance & memory (Node 22, Linux x64 container, 4 vCPU; `scripts/bench*.entry.ts`; reference engine, not production claims)
| Case | Time | RSS |
|---|---|---|
| Brush stroke, 60 points, 17 px | ≈15 ms | |
| Stroke, 100 px hard brush over 2000 px | ≈200–330 ms | |
| Composite 256² × 5 layers (multiply) | ≈18 ms | |
| Composite 1920×1080 × 3 layers | ≈280 ms | |
| 12 Mpx white doc: create+fill / flatten / preview / save / parse | 0.44 s / 0.8 s / 1.0 s / 0.6 s / 0.26 s | 102 → 190 MB |
| 48 Mpx white doc: create+fill / flatten / preview / save / parse | 1.2 s / 1.8 s / 2.6 s / 2.0 s / 0.8 s | 312 → 590 MB |
| Undo of a stroke | < 1 ms | |
Whole pixel data stays in memory (no eviction/spill); a 100 Mpx RGBA layer ≈ 400 MB per layer. No interactive-frame-rate
measurement inside Electron has been taken yet.

### M3 evidence and tolerances
Golden comparison (SwiftShader software GL in Electron/Xvfb, **not a hardware GPU**): 2 colour spaces × 2 backdrops (opaque/translucent)
× 12 blend modes with mask, 0.73 opacity and a layer offset crossing tile boundaries, plus nested groups (blend, opacity, mask, hidden
child) → 50 scenes, worst per-channel difference **1/255** (rounding). Documented tolerance: ≤ 1/255 per channel incl. alpha.
Per-operation colour space: blend/composite = encoded sRGB by default or linear light when `canvas.blendSpace='linear'`;
brush, fill, resampling, masks, opacity = encoded sRGB / linear coverage; display = Chromium sRGB. Hardware-GPU behaviour is untested.

## 7. Known limits & defects
* 8-bit RGB only; colour unmanaged (sRGB assumed); other modes/depths rejected on open. Display is Chromium's sRGB path, **not** an ICC-managed pipeline.
* CPU compositor is the only compositor; large zoomed-out views composite tiles lazily on the main thread (can stutter on big docs).
* Tiles are never evicted or spilled; practical limit ≈ 100 Mpx total pixel data per session.
* Layers are unbounded in layer-local coordinates but masks use fill-based sparsity; transforms are capped at 64 Mpx.
* Selection: single rectangle. Brush has no tablet tilt/rotation, no custom tips/presets.
* Text: font list is a static suggestion list (no system font enumeration); availability detection is a metrics heuristic.
* Text/groups cannot be transformed (blocked with a message); undo of preview-based edits (opacity, text typing) is one entry per gesture, coalesced by blur/pointer-up/700 ms debounce.
* Windows is untested. Packaging (installer, signing) does not exist. Accessibility: labels/focus styles exist but no audit/screen-reader test was done.
* E2E hooks (`window.__ps`, scripted dialogs) are active only with `PIXEL_STUDIO_E2E=1`.

## 8. Dependency licences
See `docs/03-dependency-license-assessment.md` and `npm run licenses`.

## 9. Exact next steps
3. Run the app on Windows 10/11 and fix platform issues (paths, fonts, sandbox flags) before calling M2 fully accepted.
4. Measure in-app brush latency and compositing frame time on 20–50 Mpx documents; decide on worker/OffscreenCanvas compositing.
5. Research PSD/PSB from Adobe's public file-format documentation and fill the format matrix before writing any parser (M8).
