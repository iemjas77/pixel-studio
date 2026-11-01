import { TileStore, composeRegion, TILE_SIZE, type RenderNode } from '@ps/raster';
import type { Layer, PsDocument } from './types';
import { absoluteOffset } from './offsets';

/** Supplies pixels for layers that have no raster store of their own (text). */
export type PixelResolver = (layer: Layer) => TileStore | null;

export function buildRenderTree(layers: Layer[], resolve?: PixelResolver): RenderNode[] {
  return layers.map((l): RenderNode => {
    const n: RenderNode = {
      visible: l.visible, opacity: l.opacity, blend: l.blendMode, offsetX: l.offset.x, offsetY: l.offset.y,
      mask: l.mask?.tiles ?? null, maskEnabled: l.mask?.enabled ?? false,
    };
    if (l.kind === 'raster') n.pixels = l.pixels;
    else if (l.kind === 'text') n.pixels = resolve?.(l) ?? null;
    else if (l.kind === 'group') n.children = buildRenderTree(l.children, resolve);
    else n.visible = false; // opaque: not renderable
    return n;
  });
}

export function composeDocument(doc: PsDocument, x: number, y: number, w: number, h: number, resolve?: PixelResolver, isCancelled?: () => boolean) {
  return composeRegion(buildRenderTree(doc.layers, resolve), x, y, w, h, { isCancelled, linear: doc.canvas.blendSpace === 'linear' });
}

/** Whole-canvas flatten, tile by tile, into a dense RGBA8 buffer. */
export function flattenDocument(doc: PsDocument, resolve?: PixelResolver, isCancelled?: () => boolean): Uint8Array {
  const { width, height } = doc.canvas;
  const out = new Uint8Array(width * height * 4);
  const tree = buildRenderTree(doc.layers, resolve);
  for (let ty = 0; ty < height; ty += TILE_SIZE) for (let tx = 0; tx < width; tx += TILE_SIZE) {
    const w = Math.min(TILE_SIZE, width - tx), h = Math.min(TILE_SIZE, height - ty);
    const t = composeRegion(tree, tx, ty, w, h, { isCancelled, linear: doc.canvas.blendSpace === 'linear' });
    for (let y = 0; y < h; y++) out.set(t.subarray(y * w * 4, (y + 1) * w * 4), ((ty + y) * width + tx) * 4);
  }
  return out;
}

/** Box-filtered preview, longest side ≤ max. Composites tile-by-tile (bounded memory). */
export function renderPreview(doc: PsDocument, max = 256, resolve?: PixelResolver): { width: number; height: number; rgba: Uint8Array } {
  const { width, height } = doc.canvas;
  const k = Math.max(1, Math.ceil(Math.max(width, height) / max));
  const pw = Math.max(1, Math.ceil(width / k)), ph = Math.max(1, Math.ceil(height / k));
  const sum = new Float64Array(pw * ph * 4); // premultiplied sums
  const cnt = new Uint32Array(pw * ph);
  const tree = buildRenderTree(doc.layers, resolve);
  for (let ty = 0; ty < height; ty += TILE_SIZE) for (let tx = 0; tx < width; tx += TILE_SIZE) {
    const w = Math.min(TILE_SIZE, width - tx), h = Math.min(TILE_SIZE, height - ty);
    const t = composeRegion(tree, tx, ty, w, h, { linear: doc.canvas.blendSpace === 'linear' });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, a = t[i + 3] / 255;
      const pi = Math.floor((ty + y) / k) * pw + Math.floor((tx + x) / k);
      sum[pi * 4] += t[i] * a; sum[pi * 4 + 1] += t[i + 1] * a; sum[pi * 4 + 2] += t[i + 2] * a; sum[pi * 4 + 3] += a;
      cnt[pi]++;
    }
  }
  const rgba = new Uint8Array(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) {
    const a = sum[i * 4 + 3];
    if (a <= 0) continue;
    rgba[i * 4] = Math.round(sum[i * 4] / a); rgba[i * 4 + 1] = Math.round(sum[i * 4 + 1] / a);
    rgba[i * 4 + 2] = Math.round(sum[i * 4 + 2] / a); rgba[i * 4 + 3] = Math.round((a / cnt[i]) * 255);
  }
  return { width: pw, height: ph, rgba };
}
void absoluteOffset;
