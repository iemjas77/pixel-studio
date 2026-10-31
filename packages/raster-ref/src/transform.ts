import { TILE_SIZE, TileStore, TileWriter, floorDiv, type Rect, type TileDiff } from './tiles';

/** Affine map in doc/layer-local continuous coordinates: [x',y'] = [a*x+c*y+e, b*x+d*y+f]. */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }

export function invertAffine(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) throw new RangeError('singular transform');
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}
const apply = (m: Affine, x: number, y: number): [number, number] => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

/** Tile-aligned bounds of stored tiles (used for stores whose absent tiles are non-zero). */
export function storedTileBounds(src: TileStore): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of src.tiles.keys()) {
    const i = k.indexOf(',');
    const tx = Number(k.slice(0, i)), ty = Number(k.slice(i + 1));
    x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
  }
  return x1 < x0 ? null : { x: x0 * TILE_SIZE, y: y0 * TILE_SIZE, w: (x1 - x0 + 1) * TILE_SIZE, h: (y1 - y0 + 1) * TILE_SIZE };
}

export type Interp = 'nearest' | 'bilinear';

/** Max pixels a single transform may allocate (reference implementation guard). */
export const MAX_TRANSFORM_PIXELS = 64 * 1024 * 1024;

/**
 * Apply `m` to the content of `src`, returning a NEW store (src untouched).
 * Bilinear interpolation is done in premultiplied space for RGBA8. Outside source = 0.
 */
export function transformStore(src: TileStore, m: Affine, interp: Interp, within?: Rect | null): TileStore {
  const out = new TileStore(src.format, src.fill);
  const sb = within ?? (src.fill === 0 ? src.contentBounds() : storedTileBounds(src));
  if (!sb) return out;
  const bpp = src.bpp;
  const corners = [apply(m, sb.x, sb.y), apply(m, sb.x + sb.w, sb.y), apply(m, sb.x, sb.y + sb.h), apply(m, sb.x + sb.w, sb.y + sb.h)];
  const x0 = Math.floor(Math.min(...corners.map(c => c[0])) + 1e-6), x1 = Math.ceil(Math.max(...corners.map(c => c[0])) - 1e-6);
  const y0 = Math.floor(Math.min(...corners.map(c => c[1])) + 1e-6), y1 = Math.ceil(Math.max(...corners.map(c => c[1])) - 1e-6);
  const dw = x1 - x0, dh = y1 - y0;
  if (dw <= 0 || dh <= 0) return out;
  if (dw * dh > MAX_TRANSFORM_PIXELS || sb.w * sb.h > MAX_TRANSFORM_PIXELS) throw new RangeError('transform result too large for reference engine');
  const sdata = src.readRegion(sb.x, sb.y, sb.w, sb.h);
  const inv = invertAffine(m);
  const ddata = new Uint8Array(dw * dh * bpp);
  if (src.fill !== 0) ddata.fill(src.fill);
  const px = new Float64Array(bpp);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const [sx, sy] = apply(inv, x0 + x + 0.5, y0 + y + 0.5);
    const fx = sx - sb.x, fy = sy - sb.y; // continuous position in sdata space
    const di = (y * dw + x) * bpp;
    if (interp === 'nearest') {
      const ix = Math.floor(fx), iy = Math.floor(fy);
      if (ix < 0 || iy < 0 || ix >= sb.w || iy >= sb.h) continue;
      const si = (iy * sb.w + ix) * bpp;
      for (let c = 0; c < bpp; c++) ddata[di + c] = sdata[si + c];
    } else {
      const gx = fx - 0.5, gy = fy - 0.5;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const tx = gx - ix, ty = gy - iy;
      px.fill(0);
      let wsum = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const xx = ix + i, yy = iy + j;
        const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
        if (wgt === 0 || xx < 0 || yy < 0 || xx >= sb.w || yy >= sb.h) continue;
        const si = (yy * sb.w + xx) * bpp;
        if (bpp === 4) {
          const a = sdata[si + 3] / 255;
          px[0] += sdata[si] * a * wgt; px[1] += sdata[si + 1] * a * wgt; px[2] += sdata[si + 2] * a * wgt; px[3] += a * wgt;
        } else px[0] += sdata[si] * wgt;
        wsum += wgt;
      }
      if (wsum === 0) continue;
      if (bpp === 4) {
        const a = px[3];
        if (a <= 0) continue;
        ddata[di] = Math.round(px[0] / a); ddata[di + 1] = Math.round(px[1] / a); ddata[di + 2] = Math.round(px[2] / a);
        ddata[di + 3] = Math.round(a * 255);
      } else ddata[di] = Math.round(px[0] + src.fill * (1 - wsum));
    }
  }
  const w = new TileWriter(out);
  out.writeRegion(w, x0, y0, dw, dh, ddata);
  w.finish();
  return out;
}

/** Build one of the exact (integer-aligned) transforms about an integer pivot. */
export function exactTransform(kind: 'flipH' | 'flipV' | 'rot90cw' | 'rot90ccw' | 'rot180', bounds: Rect): Affine {
  const cx = Math.round(bounds.x + bounds.w / 2), cy = Math.round(bounds.y + bounds.h / 2);
  switch (kind) {
    case 'flipH': return { a: -1, b: 0, c: 0, d: 1, e: 2 * cx, f: 0 };
    case 'flipV': return { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * cy };
    case 'rot180': return { a: -1, b: 0, c: 0, d: -1, e: 2 * cx, f: 2 * cy };
    // rotate about (cx,cy): x' = cx - (y-cy), y' = cy + (x-cx)  (clockwise on screen, y down)
    case 'rot90cw': return { a: 0, b: 1, c: -1, d: 0, e: cx + cy, f: cy - cx };
    case 'rot90ccw': return { a: 0, b: -1, c: 1, d: 0, e: cx - cy, f: cy + cx };
  }
}

export function scaleAbout(sx: number, sy: number, cx: number, cy: number): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: cx - sx * cx, f: cy - sy * cy };
}

/** Replace the full content of `store` with `next`, producing a diff for history. */
export function replaceStoreContent(store: TileStore, next: TileStore): TileDiff {
  const w = new TileWriter(store);
  const keys = new Set<string>([...store.tiles.keys(), ...next.tiles.keys()]);
  for (const k of keys) {
    const comma = k.indexOf(',');
    const tx = Number(k.slice(0, comma)), ty = Number(k.slice(comma + 1));
    const t = w.tile(tx, ty);
    const n = next.tiles.get(k);
    if (n) t.set(n); else t.fill(0);
  }
  return w.finish();
}

void TILE_SIZE; void floorDiv;
