# 05 – Compatibility Matrix

Categories: **Implemented** (code + passing tests) · **Partial** (works with listed
limits) · **Researched** (public documentation read and summarised in repo) ·
**Planned** (nothing exists). No “Photoshop equivalence” or PSD compatibility is claimed.

## Application features
Maintained as the matrix in `docs/HANDOVER.md` §Matrix (single source of truth to avoid
drift). Feature intent is in `02-feature-workflow-spec.md`.

## File formats

| Format | Read | Write | Status | Loss / notes |
|---|---|---|---|---|
| `.pstudio` v1 | layers, masks, text, groups, unknown-data | same | Implemented (M1) | self-roundtrip only – it is our own format; validated by negative tests |
| PNG | via Chromium decoder → 1 raster layer | flattened composite | Partial (M2) | 8-bit sRGB-assumed; embedded ICC ignored (reported as warning); 16-bit reduced to 8 |
| JPEG | decoder | quality-controlled export | Partial (M2) | no ICC; EXIF orientation applied by Chromium; no CMYK JPEG |
| WebP | decoder | export | Partial (M2) | lossy/lossless per quality |
| GIF/BMP | decode first frame | – | Partial (M2) | |
| TIFF | – | flattened RGBA 8-bit uncompressed | Partial (M4) | write-only; validated by Pillow + ImageMagick; no ICC/compression/16-bit/layers |
| PSD flattened composite | – | merged RGB8 + transparency, raw | Partial (M4) | labelled “flattened PSD”; write-only; Pillow + ImageMagick read it; **not layered PSD compatibility**; Adobe apps untested |
| PSD/PSB layered | – | – | **Planned; primary-source research not yet done** (M8) | feature rows to fill from Adobe's public file-format documentation: composite, layers/bounds, alpha/masks, groups/clipping, blend modes, ICC resource, text/adjustments/effects, unknown tagged blocks, compression + depth, PSB 64-bit lengths |
| SVG/PDF/RAW | – | – | Not in roadmap | |

PSD parser requirements (for M8, restated from master prompt): bounded allocations,
truncation checks, decompression-bomb limits, preserve/rasterize/cancel choices,
legal fixtures, independent validators.
