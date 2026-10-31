# Pixel Studio – Handover

> Engineering preview. Not a production release. No installers, releases or public deploys exist.
> This document is the single source of truth for status; update it with every milestone commit.

## 1. Quick start

Requirements: Node ≥ 22, npm ≥ 10, Linux/macOS/Windows. (Electron binary is downloaded by the
`electron` package's postinstall; if `node_modules/electron/path.txt` is missing run
`node node_modules/electron/install.js`.)

```bash
npm install
npm test            # unit + integration (vitest, plain Node)
npm run typecheck
```
(Run/build instructions for the Electron app are added with M2 below.)

## 2. Milestone status

| Milestone | Status | Evidence |
|---|---|---|
| M0 specs | ✅ done | `docs/01…05` |
| M1 document/commands/tiles/native | ✅ done (see §5 test list) | `npm test` → 57 tests |
| M2 workspace + tools | in progress | – |
| M3 … M10 | not started | – |

## 3. Layout
`packages/raster-ref` (tiles, blend, CPU composite, brush, transform) · `packages/document`
(model, patch ops, render tree) · `packages/commands` (engine, registry, builtins) ·
`packages/codecs` (`.pstudio`) · `apps/desktop` (Electron main/preload, atomic IO) ·
`apps/editor` (React UI) · `tests/` · `docs/`.

## 4. Matrix (implemented / partial / planned)

| Feature | State | Notes |
|---|---|---|
| Versioned document model, stable ids, patch ops with exact inverses | Implemented | |
| Command engine: allow-list, schema validation, atomic transactions, rollback | Implemented | |
| Undo/redo, redo invalidation, bounded history (entries + bytes), dirty tracking | Implemented | byte budget counts tile payloads |
| Sparse 256² tiles, RGBA8 + A8 (fill 0/255), copy-on-write | Implemented | reference TS engine |
| Stamp brush/eraser, interpolation, opacity/flow/hardness/pressure, selection clip, mask painting | Implemented | deterministic |
| Fill / clear / mask add (reveal, hide, selection) / apply | Implemented | |
| Flip / rot90 / rot180 exact; scale bilinear | Implemented | scale: no prefilter (aliases when downscaling >2×) |
| CPU compositor: 12 blend modes, opacity, masks, offsets, isolated groups | Implemented | encoded-sRGB math |
| `.pstudio` v1 read/write, limits, CRC, bomb-safe inflate, unknown-data preservation | Implemented | self-roundtrip + negative tests only |
| Atomic native save (temp+fsync+rename) | Implemented | failure injection tested |
| Text layers (model + commands) | Implemented (model); rendering in M2 UI | |
| Electron shell, UI, tools | In progress (M2) | |
| GPU compositor, linear-light, ICC, CMYK, 16-bit | Planned (M3/M6/M7) | |
| Actions / batch | Planned (M4) | |
| PSD/PSB | Planned (M8); no research done yet | |

## 5. Verified in M1 (tests in `tests/unit`)
tiles (sparse, boundaries, negative coords, COW, fill-255 masks) · brush (interpolation gaps,
tile crossing, opacity cap, flow, selection clip, eraser, mask paint, determinism, cancel) ·
compositor (blend values, alpha, offsets, masks, group isolation, cancellation) · command engine
(undo/redo exactness, redo invalidation, rollback, strict validation, locks, bounded history,
dirty tracking, live-stroke≡replay byte equality, masks, transforms, groups, text) · `.pstudio`
(roundtrip + byte-stable rewrite, sparse size, corruption/truncation sweeps, version policy, bomb,
malformed manifests, unknown-data preservation) · atomic write failures.

## 6. Known limits (reference engine)
* 8-bit RGB only; colour unmanaged (sRGB assumed). Files declaring other modes/depths are rejected.
* Tiles never evicted/spilled to disk yet; whole document lives in memory.
* Transform results limited to 64 Mpx; scale uses bilinear without prefilter.
* Selection is a single rectangle (no feather/add/subtract).
* Groups: model + compositing + undoable commands; no pass-through blend mode.
* No clipping masks, adjustment layers, effects, shapes, paths, channels, artboards.

## 7. Performance (Linux x64 container, 4 vCPU, Node 22; micro-benchmarks via `scripts/bench.entry.ts`)
| Case | Time |
|---|---|
| Brush stroke, 60 points, 17 px | ≈15 ms |
| Brush stroke, 40 points over 2000 px, 100 px hard | ≈200 ms |
| Composite 256² × 5 layers multiply | ≈18 ms |
| Composite 1920×1080 × 3 layers | ≈280 ms |
These are reference-engine numbers, not production claims.

## 8. Next steps
M2: Electron main/preload (narrow IPC), React workspace, viewport renderer, tools, panels, E2E.
