# 01 – Architecture Specification

Status: M0 deliverable, kept in sync with the code. Sections marked **[implemented]**
exist and are tested; **[planned]** do not exist yet. See `docs/05-compatibility-matrix.md`.

## 0. Preview vs production

| | Engineering preview (this repo, M1–M5) | Production app (M6–M10) |
|---|---|---|
| Raster engine | TypeScript **reference** implementation (`packages/raster-ref`) | Rust native engine (N-API / WASM) behind the same interfaces |
| Compositing | CPU reference only | GPU compositor, CPU path kept as golden reference |
| Color | sRGB-encoded 8-bit, no ICC | ICC (LittleCMS-class), working spaces, CMYK |
| Formats | `.pstudio`, PNG/JPEG/WebP via Chromium codecs | + TIFF, flattened PSD, then layered PSD/PSB |
| Packaging | Runs from source with Electron | Signed Windows installer (not built; no releases are published) |

The TypeScript raster code is a **tested reference backend**. It is not presented as the
production engine; its limits are in `docs/HANDOVER.md`.

## 1. Process model [implemented]

```
┌───────────────── Electron main (apps/desktop) ─────────────────┐
│ window lifecycle, native dialogs, atomic file IO, recovery dir │
│ capability list of user-approved paths; NO document logic      │
└───────────────▲────────────────────────────────────────────────┘
        narrow typed IPC (contextBridge, ~8 channels, validated)
┌───────────────┴────────────────────────────────────────────────┐
│ Renderer (apps/editor, React + TS, sandboxed, no Node)         │
│  UI panels ─▶ Tool controllers ─▶ Command engine ─▶ Document   │
│                                   │                    │       │
│                       History ◀───┘          Raster-ref + Compositor
└────────────────────────────────────────────────────────────────┘
```

Security posture: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
strict CSP (`default-src 'self'`), navigation and `window.open` denied, IPC handlers
validate sender frame URL and argument shape. Renderer never receives arbitrary file
system access: file reads/writes only for paths the user picked through a native
dialog in this run (main keeps the allow-list) or for the fixed recovery directory.

### Alternatives considered
* **Document model in main process**: rejected for the preview – IPC cost on every
  brush dab, and it couples model to Electron. The model package is process-agnostic so
  a utility process / worker can host it later (needed for batch isolation, M4/M6).
* **Rust/WASM from day one**: the build environment has `cargo` but no Windows target,
  no Electron-ABI native build verification, and no `wasm32` toolchain checked. Shipping
  unverified native scaffolding would violate the "no empty native scaffolding" rule.
  The raster API is therefore designed as a narrow, data-oriented interface
  (`TileStore`, `composeRegion`, `StrokeSession`, `resample`) so a native engine can be
  swapped in per function and verified against the TS reference as a golden oracle.
* **Canvas 2D as the pixel engine**: rejected – non-deterministic, premultiplied 8-bit,
  cannot support 16-bit/float, and cannot be tested headless.

## 2. Package layout [implemented]

```
packages/raster-ref   tiles, pixel formats, blending, CPU compositor, brush, resample
packages/document     versioned model, ids, validation, patch ops (inverse-producing)
packages/commands     command registry (allow-listed, validated), transactions, history
packages/codecs       .pstudio container reader/writer, limits, migration
apps/desktop          Electron main + preload (esbuild-bundled to CJS)
apps/editor           React UI, tool controllers, viewport renderer
tests/                unit/integration (vitest) and Electron E2E (playwright-core)
```
Dependency direction: `raster-ref ← document ← commands ← codecs/editor`. Nothing in
`packages/*` may import DOM, Electron or Node-only APIs (checked by the test-suite via
running them under plain Node). Future `crates/*` directories are created when real Rust
code with tests exists – not before.

## 3. Document model [implemented subset]

* `Document { schemaVersion, id, name, canvas{width,height,resolutionPpi,mode,bitDepth,
  profile}, layers (tree), selection, guides, unknown }`.
* Identity: every layer has a stable id (`ly_` + 12 base-36 chars from a counter+random,
  generated through an injectable id source for deterministic tests). Ids never change on
  move/duplicate-of-original; duplicates get new ids.
* Layer kinds: `raster`, `text`, `group`, plus `opaque` (preserved unknown kind).
  Reserved/planned: `shape`, `adjustment`, `smartObject`/embedded doc.
* Common layer props: `name, visible, locked{pixels,position,all}, opacity (0..1),
  blendMode, offset{x,y}` (integer doc-space position of layer origin), optional `mask`
  `{tiles(A8), enabled, linked}`; `clip` (clipping) reserved.
* Pixel data lives in `TileStore`s referenced by layers, not in JSON.
* Mode/precision today: **RGB, 8 bit/channel, straight (non-premultiplied) alpha,
  profile tag "sRGB (assumed, unmanaged)"**. Other modes are rejected on load, not
  silently converted.
* Document state is independent from UI state (tool, zoom, panels, active layer). The
  active-layer id and viewport live in the editor store and are saved to a separate
  `session` section only as hints.
* **Mutation only via patch ops** (`packages/document/src/ops.ts`). Every op applies to a
  document and returns its exact inverse. This is the single choke-point for history,
  transactions, and later for sync/replay.

## 4. Command engine [implemented]

* `CommandRegistry`: allow-listed `type → {version, paramSchema, label, execute}`.
  Params are validated against a declarative schema before execution; invalid commands
  never touch the document.
* `Engine.execute(cmd)` opens a **transaction**: handler emits ops through a `Tx` that
  applies them immediately and records inverses. On exception, inverses are applied in
  reverse order → document is bit-identical to pre-state (tested). Success → exactly one
  history entry.
* Gestures: a brush stroke is one `paint.stroke` command. Live drawing uses
  `StrokeSession` directly for responsiveness and records the identical command + tile
  diff with `Engine.record(...)`; replaying the recorded command yields byte-identical
  pixels (tested).
* History: linear stack with pointer. A new commit after undo discards the redo branch.
  Bounded by entry count **and** tile-byte budget (default 256 MiB, configurable); oldest
  entries are evicted first. Tile diffs share unchanged tiles (copy-on-write: strokes
  clone a tile on first touch; history keeps the original reference).
* Entries keep their semantic command list (type, version, params) so Actions (M4) can
  replay them; commands that cannot be expressed semantically are marked non-recordable.
* Dirty-region events: each commit/undo/redo emits `{layerIds, tileKeys|all}` so the
  viewport re-composites only affected tiles.

## 5. Tiled raster engine [implemented reference, limits published]

* Tile = 256×256 px. `TileStore` is a sparse `Map<"tx,ty", Uint8Array>`; absent tile ≡
  fully transparent (RGBA) or 0 (A8). Negative tile coordinates allowed (layers may extend
  left/up of the origin).
* Formats today: `RGBA8` (straight alpha) and `A8` (masks). `RGBA16`/`RGBAF32` are
  **planned (M6)**; the `PixelFormat` descriptor already carries bytes-per-pixel so
  stores are format-generic.
* Fully transparent tiles produced by erasing are dropped when detected
  (`TileStore.prune`) so sparse allocation stays honest.
* Planned: disk-spill, tile eviction/LRU, worker parallelism, cancellation tokens
  (the compositor already takes an `AbortSignal`-like `isCancelled()`), native engine.

## 6. Compositing and color [CPU reference implemented; GPU planned M3]

* Blend math follows the public W3C *Compositing and Blending Level 1* formulas on
  float values derived from 8-bit **encoded sRGB** (i.e. no linearisation). This is a
  deliberate, documented choice (matches common raster-editor default behaviour of
  compositing in gamma-encoded space) and is *not* claimed to be Photoshop-identical.
* Premultiplication rule: stored pixels are straight alpha; the compositor converts to
  float premultiplied for accumulation and un-premultiplies once on output.
* Per-operation colour space: brush/fill/blend/composite = encoded sRGB; resampling =
  encoded sRGB (documented limitation; linear-light resampling planned M3/M7).
* Browser display uses the OS/Chromium sRGB path – **not** an ICC-managed print
  pipeline. No ICC conversion exists yet.

## 7. Typography [basic implemented; production planned M7]

* Text layers keep their source (string, font family, size, weight, style, colour,
  alignment, line-height, tracking, box width for area text). The rendered bitmap is a
  cache regenerated by a `TextRasterizer` interface (browser Canvas 2D in the app; stub
  in tests). The original `fontFamily` is kept even if the OS lacks it (fallback is
  render-time only; "missing font" is surfaced in the Properties panel).
* Planned: HarfBuzz shaping (WASM), bidi, OpenType features, variable fonts, path text,
  fallback chains. Canvas 2D already gives browser-grade shaping for the preview; this
  is not claimed to be verified for Arabic/Indic/CJK until tests exist (M7).

## 8. File formats

See `docs/05-compatibility-matrix.md`. `.pstudio` container is specified in
`docs/02-feature-workflow-spec.md` §2 and `packages/codecs/src/pstudio.ts`.

## 9. Actions, batch, scripting [planned M4]

Actions are lists of registry commands (allow-listed, versioned, validated) stored as
JSON data – never code. Batch runs jobs in isolated documents (one `Engine` instance per
job, sequential by default, bounded concurrency), with cancellation and per-file reports.
No arbitrary scripting in the preview; the plugin boundary is the same command registry.

## 10. Recovery and durability [implemented basics]

* Native writes: serialize to bytes in renderer → main writes `<file>.<rand>.tmp`,
  `fsync`, then `rename` over the target (atomic replace on NTFS/POSIX). Failures leave
  the original untouched and temp is removed.
* Autosave: periodic snapshot (only when dirty) to `userData/recovery/<docId>.pstudio`;
  on next launch, recovery files are listed and offered explicitly; they are deleted
  only after successful explicit save/discard.
* Unsupported/corrupt open never replaces the active document (E2E scenario 4).
