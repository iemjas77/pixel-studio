import { TILE_SIZE, TileStore, TileWriter, floorDiv, tileByteLength, tileKey, type TileDiff } from './tiles';

export interface BrushParams {
  /** Diameter in px (0.5..2048). */
  size: number;
  /** 0 (soft) .. 1 (hard edge). */
  hardness: number;
  /** Stroke-wide opacity cap 0..1 (dabs do not exceed it where they overlap). */
  opacity: number;
  /** Per-dab strength 0..1; low flow builds up gradually within a stroke. */
  flow: number;
  /** Dab spacing as a fraction of diameter (0.01..2). */
  spacing: number;
  /** sRGB colour 0..255 (RGBA target) – on an A8 mask target its Rec.601 luma is used. */
  color: [number, number, number];
  pressureSize: boolean;
  pressureOpacity: boolean;
}
export type StrokeMode = 'paint' | 'erase';
export type Clip = (x: number, y: number) => number; // doc-space coverage 0..1

export const DEFAULT_BRUSH: BrushParams = {
  size: 24, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, color: [0, 0, 0], pressureSize: false, pressureOpacity: false,
};

/**
 * Stamp-based stroke renderer. Coordinates passed to addPoint are *layer-local* floats
 * (pixel centres at +0.5). `offset` converts layer-local to doc space for clipping.
 * Pixels are always recomputed from the pre-stroke tile + accumulated stroke coverage, so
 * overlapping dabs cannot exceed `opacity` and results are independent of dab batching.
 */
export class StrokeSession {
  private writer: TileWriter;
  private cov = new Map<string, Uint16Array>();
  private last: { x: number; y: number; p: number } | null = null;
  private carry = 0;
  private finished = false;
  private bpp: number;
  readonly dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private take = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  constructor(
    readonly store: TileStore,
    readonly params: BrushParams,
    readonly mode: StrokeMode,
    private clip: Clip | null = null,
    private offset: { x: number; y: number } = { x: 0, y: 0 },
  ) {
    this.writer = new TileWriter(store);
    this.bpp = store.bpp;
  }

  addPoint(x: number, y: number, pressure = 1) {
    if (this.finished) throw new Error('stroke already finished');
    if (!this.last) {
      this.dab(x, y, pressure);
      this.last = { x, y, p: pressure };
      this.carry = 0;
      return;
    }
    const L = this.last;
    const dx = x - L.x, dy = y - L.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    let consumed = 0;
    for (;;) {
      const pAt = L.p + (pressure - L.p) * (consumed / len);
      const need = this.stepFor(pAt) - this.carry;
      if (consumed + need <= len) {
        consumed += need;
        const t = consumed / len;
        this.dab(L.x + dx * t, L.y + dy * t, L.p + (pressure - L.p) * t);
        this.carry = 0;
      } else {
        this.carry += len - consumed;
        break;
      }
    }
    this.last = { x, y, p: pressure };
  }

  private stepFor(pressure: number) {
    const p = this.params;
    const size = p.pressureSize ? p.size * Math.max(0.05, pressure) : p.size;
    return Math.max(0.5, size * p.spacing);
  }

  private dab(cx: number, cy: number, pressure: number) {
    const p = this.params;
    const size = p.pressureSize ? Math.max(0.5, p.size * Math.max(0.05, pressure)) : p.size;
    const strength = p.flow * (p.pressureOpacity ? Math.max(0, Math.min(1, pressure)) : 1);
    const r = size / 2;
    const hard = Math.min(0.999, Math.max(0, p.hardness));
    const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    this.dirty.x0 = Math.min(this.dirty.x0, x0); this.dirty.y0 = Math.min(this.dirty.y0, y0);
    this.dirty.x1 = Math.max(this.dirty.x1, x1); this.dirty.y1 = Math.max(this.dirty.y1, y1);
    this.take.x0 = Math.min(this.take.x0, x0); this.take.y0 = Math.min(this.take.y0, y0);
    this.take.x1 = Math.max(this.take.x1, x1); this.take.y1 = Math.max(this.take.y1, y1);
    const covLen = TILE_SIZE * TILE_SIZE;
    const touched = new Set<string>();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const ddx = x + 0.5 - cx, ddy = y + 0.5 - cy;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        const edge = Math.min(1, Math.max(0, r + 0.5 - d)); // 1px antialiased rim
        if (edge <= 0) continue;
        let fall = 1;
        const hr = r * hard;
        if (d > hr) {
          const t = Math.min(1, (d - hr) / Math.max(1e-6, r - hr));
          fall = 1 - t * t * (3 - 2 * t);
        }
        let a = fall * edge * strength;
        if (this.clip) a *= this.clip(x + this.offset.x, y + this.offset.y);
        if (a <= 0) continue;
        const tx = floorDiv(x, TILE_SIZE), ty = floorDiv(y, TILE_SIZE);
        const k = tileKey(tx, ty);
        let c = this.cov.get(k);
        if (!c) { c = new Uint16Array(covLen); this.cov.set(k, c); }
        const li = (y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE);
        const prev = c[li] / 65535;
        c[li] = Math.round((prev + a - prev * a) * 65535);
        touched.add(k);
      }
    }
    for (const k of touched) this.resolveTile(k, x0, y0, x1, y1);
  }

  /** Re-derive pixels of tile k within dab bbox from pre-stroke tile + coverage. */
  private resolveTile(k: string, bx0: number, by0: number, bx1: number, by1: number) {
    const comma = k.indexOf(',');
    const tx = Number(k.slice(0, comma)), ty = Number(k.slice(comma + 1));
    const tile = this.writer.tile(tx, ty);
    const base = this.writer.originalOf(k);
    const cov = this.cov.get(k)!;
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    const lx0 = Math.max(0, bx0 - ox), lx1 = Math.min(TILE_SIZE, bx1 - ox);
    const ly0 = Math.max(0, by0 - oy), ly1 = Math.min(TILE_SIZE, by1 - oy);
    const op = this.params.opacity;
    const [cr, cg, cb] = this.params.color;
    const luma = Math.round(0.299 * cr + 0.587 * cg + 0.114 * cb);
    for (let ly = ly0; ly < ly1; ly++) for (let lx = lx0; lx < lx1; lx++) {
      const li = ly * TILE_SIZE + lx;
      const e = (cov[li] / 65535) * op;
      if (e <= 0) continue;
      if (this.bpp === 1) {
        const m0 = base ? base[li] : this.store.fill;
        const target = this.mode === 'erase' ? 0 : luma;
        tile[li] = Math.round(m0 + (target - m0) * e);
      } else {
        const i = li * 4;
        const dr = base ? base[i] : 0, dg = base ? base[i + 1] : 0, db = base ? base[i + 2] : 0, da = (base ? base[i + 3] : 0) / 255;
        if (this.mode === 'erase') {
          tile[i] = dr; tile[i + 1] = dg; tile[i + 2] = db;
          tile[i + 3] = Math.round(da * (1 - e) * 255);
          if (tile[i + 3] === 0) { tile[i] = 0; tile[i + 1] = 0; tile[i + 2] = 0; }
        } else {
          const ra = e + da * (1 - e);
          if (ra <= 0) continue;
          const wd = da * (1 - e);
          tile[i] = Math.round((cr * e + dr * wd) / ra);
          tile[i + 1] = Math.round((cg * e + dg * wd) / ra);
          tile[i + 2] = Math.round((cb * e + db * wd) / ra);
          tile[i + 3] = Math.round(ra * 255);
        }
      }
    }
  }

  /** Doc-space-agnostic layer-local dirty rect (or null if nothing was drawn). */
  get dirtyRect() {
    const d = this.dirty;
    return d.x1 < d.x0 ? null : { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
  }

  /** Layer-local rect changed since the previous call (for incremental redraw), or null. */
  takeDirtyRect() {
    const d = this.take;
    if (d.x1 < d.x0) return null;
    const r = { x: d.x0, y: d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
    d.x0 = Infinity; d.y0 = Infinity; d.x1 = -Infinity; d.y1 = -Infinity;
    return r;
  }

  finish(): TileDiff {
    this.finished = true;
    return this.writer.finish();
  }

  /** Abort: restore the store exactly. */
  cancel() {
    this.finished = true;
    for (const k of this.writer.touchedKeys) {
      const o = this.writer.originalOf(k);
      if (o) this.store.tiles.set(k, o); else this.store.tiles.delete(k);
    }
  }
}

void tileByteLength;
