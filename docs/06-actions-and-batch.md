# 06 – Actions, Batch and Flattened Interchange (M4)

## Action file (`.psaction`, JSON, format `pixel-studio-action` v1)
```json
{ "format": "pixel-studio-action", "version": 1, "name": "Red tint",
  "steps": [ { "type": "layer.add", "version": 1, "params": {} },
             { "type": "edit.fill", "version": 1, "params": { "layerId": "$created:0", "plane": "pixels", "color": [255,0,0,255], "region": "selection" } } ] }
```
* **Data only.** Steps are command-registry entries (`packages/commands/src/builtins.ts`): allow-listed type, exact version, params validated by the
  same schema as live commands. Unknown types/versions/fields, forward references, non-recordable commands (`layer.placePixels`), >10 000 steps
  or >8 MiB files are rejected with a per-step error list; **nothing is imported or executed** from a rejected file.
* **Layer targets** (`id`, `layerId`, `parentId` only): `$active` (the active layer at that point; becomes the layer created by the most recent
  layer-creating step, as in the UI), `$created:N` (layer created by step N), `$name:X` (first layer with that exact name; recorded only for
  non-active pre-existing layers). A missing target fails the step with a clear message.
* **Coordinates are absolute** document coordinates (strokes, offsets, rectangular selections). Actions are not resolution-independent.
* **Recording** captures committed history entries; undo while recording removes the step, redo restores it; history jumps add a warning.
* **Replay** = `Engine.executeBatch`: all-or-nothing, **one undo entry** ("Action: name"), locks/hidden-layer rules apply, failures report the step.
* Library persisted in renderer `localStorage` (revalidated on load); files via Save…/Load….

## Batch
`runBatch(jobs, io, {action, overwrite, concurrency 1–8 (UI 1–4), signal, onProgress})` in `packages/automation`.
* Each file → its own decoded document + `Engine` (history capped at 5); a failure/cancel in one job cannot affect another job or the open documents.
* Per-file report: ok / failed (with message) / skipped / cancelled. Cancellation stops new work; completed outputs stay.
* Main-process IPC allows reads only from the user-picked input folder (supported extensions, no path separators) and writes only into the picked output
  folder (sanitised name, atomic write). Overwrite policy: skip | overwrite | rename (`name-1`).
* Output: `.pstudio` (layers kept) or flattened PNG/JPEG/WebP/TIFF/PSD. Size limits: input ≤ 64 Mpx/file (images), output ≤ 100 Mpx.

## Flattened interchange
`writeFlatTiff` (baseline TIFF 6.0, RGBA 8-bit, unassociated alpha, uncompressed, ≤ 4 GiB) and `writeFlatPsd` (PSD v1, RGB 8-bit, merged image only,
raw, channel 4 = transparency, ≤ 30 000 px). **Both are flattened composites only – not layered PSD/TIFF support.**
Validated with two independent readers: Pillow (pixel-exact for TIFF; RGB-exact where alpha>0 for PSD) and ImageMagick `identify`
(`tests/unit/interchange.test.ts`), plus Pillow in the batch/export E2E. Not validated against Adobe software.
