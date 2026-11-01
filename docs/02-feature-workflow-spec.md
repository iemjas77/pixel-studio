# 02 – End-to-end Feature and Workflow Specification

Legend: ✅ implemented & tested · 🟡 partial · ⬜ planned (milestone).
Normal UI controls only expose ✅/🟡 features; 🟡 limits are shown in tooltips/status.

## 1. Target user workflows

1. **Photo/composite**: open image → layers → masks → adjust → export for client.
2. **Painting/retouch**: new document → brush/eraser on layers → undo history.
3. **Typography**: editable text layers over imagery → export.
4. **Production**: repeatable Actions + batch export (M4).
5. **Interchange**: PSD hand-off (M8; flattened composite first, M4).

## 2. Native container `.pstudio` (v1.0) ✅

```
offset 0   magic  "PSTUDIO\0"                    8 bytes
       8   u16le  formatMajor (1)
      10   u16le  formatMinor (0)
      12   u32le  manifestLength
      16   u32le  manifestCrc32
      20   u32le  blobAreaLength
      24   u32le  headerCrc32 (over bytes 0..24)
      28   manifest JSON (UTF-8)
      28+M blob area: concatenated raw-deflate tile blobs
```
* Manifest: document (canvas, layers tree with all props), `tiles[]` entries
  `{layer, plane:"pixels"|"mask", tx, ty, off, len, rawLen, crc}`, `preview` entry,
  `unknown` bag, `writer` info.
* Limits (enforced on read): file ≤ 2 GiB, manifest ≤ 64 MiB, canvas ≤ 32 768 px/side and
  ≤ 400 Mpx, ≤ 4 096 layers, ≤ 1 000 000 tiles, nesting depth ≤ 64, every inflate has an
  exact expected output size (decompression-bomb safe), blob ranges must lie inside the
  blob area, duplicate/overlapping tile keys rejected.
* Version policy: different **major** → `UnsupportedVersionError` (document untouched).
  Same major, higher **minor** → load; unknown manifest/layer properties are preserved in
  `unknown` bags and re-emitted on save; unknown layer *kinds* load as `opaque` layers
  (rendered empty, flagged, re-emitted verbatim). Older minors migrate through
  `migrate(manifest)` (identity at v1.0; migration table is tested with a synthetic
  v0 fixture).
* Loss reporting: reader returns `{document, warnings[]}`; any dropped/unsupported item is
  a warning, never silent.

## 3. Foundation feature set (M2) – per feature

| Area | Behaviour | Undo | Status |
|---|---|---|---|
| New document | size (1–16 384), ppi, background (transparent/white/colour) | n/a | ✅ |
| Open | `.pstudio`, PNG/JPEG/WebP/GIF/BMP (single frame) → new doc, one raster layer | n/a | ✅ |
| Save / Save As | `.pstudio`, atomic, dirty flag, title bar state | n/a | ✅ |
| Export | PNG, JPEG (quality), WebP (quality) of flattened composite; honest "flattened" | n/a | ✅ |
| Zoom/pan/fit | wheel zoom at cursor, Space/hand pan, Fit, 100 %, zoom field | no | ✅ |
| Layers | add raster, delete, duplicate, reorder (buttons + drag), rename | 1 entry each | ✅ |
| Layer state | visibility, lock (pixels/position/all), opacity, 12 blend modes | 1 entry each (slider = 1 entry per gesture) | ✅ |
| Groups | create group from layer, nested compose | yes | 🟡 (no pass-through mode, no group transform) |
| Brush | size, hardness, opacity, flow, spacing, colour, pressure→size/opacity, interpolation | 1 entry/stroke | ✅ |
| Eraser | same engine, on pixels; on mask paints black | 1 entry/stroke | ✅ |
| Rect selection | marquee, Select All, Deselect; clips brush/eraser/fill/delete | yes | ✅ |
| Move | moves active layer (offset), arrow-key nudge, respects lock | 1 entry/drag | ✅ |
| Transforms | flip H/V, rotate 90°/180°, uniform+non-uniform scale % (bilinear) on raster layers | yes | 🟡 (no interactive handles, no rotate-by-angle/perspective: M9) |
| Text | create/edit text layers, font family/size/weight/style/colour/align/leading/tracking, area text via width | yes | 🟡 (Canvas 2D shaping; no OpenType UI, no path text: M7) |
| Layer masks | add (reveal all / from selection), disable, delete, paint on mask, apply to layer | yes | ✅ |
| Fill / clear | fill selection or layer with FG colour, Delete clears selection | yes | ✅ |
| Eyedropper | sample composite → FG colour | no | ✅ |
| History panel | list, jump to state, redo-branch greyed | n/a | ✅ |
| Undo/redo | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | n/a | ✅ |

Behavioural rules:
* A drag/slider gesture creates exactly one history entry, committed on pointer-up;
  cancelled gestures (Esc) create none and restore state.
* Locked pixels block brush/eraser/fill/clear/transform; locked position blocks move;
  blocked attempts show a status message, never fail silently.
* Painting on a text layer is blocked with an actionable message (“Rasterize text layer
  first”). `Rasterize` is an explicit, undoable command and the only way editable text
  is converted.
* Hidden layers cannot be painted on.

## 4. Later feature groups (not in normal UI until implemented)

* M3: GPU composition, colour-managed display design, linear-light option.
* M4: Actions record/replay, batch, flattened PSD/TIFF interchange.
* M5: stabilisation, perf record, handover.
* M6: native raster engine, 16-bit, disk spill, large-doc budgets, recovery hardening.
* M7: ICC, CMYK, soft proof, HarfBuzz typography.
* M8: layered PSD/PSB.
* M9: crop/resample, perspective, lasso/wand/colour range, feather, gradients, patterns,
  clone/heal, curves/levels/hue-sat, non-destructive adjustments, filters, layer effects,
  clipping masks, embedded documents.
* M10: Windows packaging, accessibility audit, designer acceptance.

## 5. Keyboard (default preset “Pixel Studio”; remapping UI planned M10)

B brush · E eraser · V move · M marquee · T text · I eyedropper · H hand · Z zoom ·
X swap colours · D default colours · [ ] brush size · Ctrl+N/O/S · Ctrl+Shift+S ·
Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y · Ctrl+A / Ctrl+D · Ctrl+0 fit · Ctrl+1 100 % ·
Ctrl+J duplicate layer · Delete clear · Space (hold) pan.
Photoshop-like shortcut preset is **planned** (M10); the table above is the single
default map, centralised in `apps/editor/src/shortcuts.ts` so it can become editable.

## 6. Acceptance E2E scenarios (release gates for M2/M5)

1. Create doc → paint → undo/redo → save → reopen → pixels equal.
2. Import PNG → layers → mask → text → export PNG → decode → expected pixels.
3. Record Action → replay → batch (M4).
4. Open corrupt/unsupported file → clear error → existing document unchanged.

## 7. Added after M4 (status = see HANDOVER matrix)
Adjust menu (invert, desaturate, brightness/contrast, levels, hue/saturation, 3-point curves), Filter menu (Gaussian blur, sharpen, noise),
Gradient tool (G), Image menu (crop to selection, image size), Actions panel (record/play/save/load/batch), flattened TIFF/PSD export,
View ▸ compositing backend and linear-light blending. All run as undoable registry commands and are recordable in Actions.
