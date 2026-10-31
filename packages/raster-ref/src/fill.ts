import { TILE_SIZE, TileStore, TileWriter, floorDiv, type Rect } from './tiles';

export type Coverage = (x: number, y: number) => number;

/** Fill rect (layer-local) with RGBA colour, source-over on RGBA8, or lerp-to-value on A8. */
export function fillRect(w: TileWriter, r: Rect, rgba: [number, number, number, number], clip?: Coverage | null, offset = { x: 0, y: 0 }) {
  const store = w.store;
  const bpp = store.bpp;
  const sa0 = rgba[3] / 255;
  const luma = Math.round(0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]);
  const tx0 = floorDiv(r.x, TILE_SIZE), tx1 = floorDiv(r.x + r.w - 1, TILE_SIZE);
  const ty0 = floorDiv(r.y, TILE_SIZE), ty1 = floorDiv(r.y + r.h - 1, TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (bpp === 4 && sa0 === 0) continue;
    if (bpp === 1 && !store.get(tx, ty) && luma === store.fill) continue;
    const t = w.tile(tx, ty);
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    const x0 = Math.max(r.x, ox), x1 = Math.min(r.x + r.w, ox + TILE_SIZE);
    const y0 = Math.max(r.y, oy), y1 = Math.min(r.y + r.h, oy + TILE_SIZE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const cov = clip ? clip(x + offset.x, y + offset.y) : 1;
      if (cov <= 0) continue;
      const li = (y - oy) * TILE_SIZE + (x - ox);
      if (bpp === 1) {
        t[li] = Math.round(t[li] + (luma - t[li]) * cov * sa0);
      } else {
        const i = li * 4;
        const e = sa0 * cov;
        const da = t[i + 3] / 255;
        const ra = e + da * (1 - e);
        const wd = da * (1 - e);
        t[i] = Math.round((rgba[0] * e + t[i] * wd) / ra);
        t[i + 1] = Math.round((rgba[1] * e + t[i + 1] * wd) / ra);
        t[i + 2] = Math.round((rgba[2] * e + t[i + 2] * wd) / ra);
        t[i + 3] = Math.round(ra * 255);
      }
    }
  }
}

/** Erase (alpha→0 / mask→0) inside rect with coverage. */
export function clearRect(w: TileWriter, r: Rect, clip?: Coverage | null, offset = { x: 0, y: 0 }) {
  const store = w.store;
  const bpp = store.bpp;
  const tx0 = floorDiv(r.x, TILE_SIZE), tx1 = floorDiv(r.x + r.w - 1, TILE_SIZE);
  const ty0 = floorDiv(r.y, TILE_SIZE), ty1 = floorDiv(r.y + r.h - 1, TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    if (!store.get(tx, ty) && store.fill === 0) continue; // sparse: nothing to clear
    const t = w.tile(tx, ty);
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    const x0 = Math.max(r.x, ox), x1 = Math.min(r.x + r.w, ox + TILE_SIZE);
    const y0 = Math.max(r.y, oy), y1 = Math.min(r.y + r.h, oy + TILE_SIZE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const cov = clip ? clip(x + offset.x, y + offset.y) : 1;
      if (cov <= 0) continue;
      const li = (y - oy) * TILE_SIZE + (x - ox);
      if (bpp === 1) t[li] = Math.round(t[li] * (1 - cov));
      else {
        const i = li * 4;
        t[i + 3] = Math.round(t[i + 3] * (1 - cov));
        if (t[i + 3] === 0) { t[i] = 0; t[i + 1] = 0; t[i + 2] = 0; }
      }
    }
  }
}

/** Bake an A8 mask into RGBA pixels' alpha (used by "apply mask"). */
export function applyMaskToPixels(w: TileWriter, mask: TileStore) {
  const store = w.store;
  for (const k of [...store.tiles.keys()]) {
    const comma = k.indexOf(',');
    const tx = Number(k.slice(0, comma)), ty = Number(k.slice(comma + 1));
    const m = mask.get(tx, ty);
    const t = w.tile(tx, ty);
    for (let li = 0; li < TILE_SIZE * TILE_SIZE; li++) {
      const mv = m ? m[li] : mask.fill;
      const i = li * 4;
      t[i + 3] = Math.round((t[i + 3] * mv) / 255);
      if (t[i + 3] === 0) { t[i] = 0; t[i + 1] = 0; t[i + 2] = 0; }
    }
  }
}
