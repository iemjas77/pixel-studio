/**
 * Sparse tiled pixel storage (reference implementation, TypeScript).
 *
 * - Tile size is fixed at 256x256.
 * - A missing tile is semantically all-zero (transparent / mask 0).
 * - Tile arrays that have been handed to history are IMMUTABLE by convention.
 *   Writers must go through TileWriter, which clones a tile on first touch
 *   (copy-on-write) and records the original for undo.
 */
export const TILE_SIZE = 256;
export type PixelFormat = 'RGBA8' | 'A8';
export const BYTES_PER_PIXEL: Record<PixelFormat, number> = { RGBA8: 4, A8: 1 };
export const tileByteLength = (f: PixelFormat) => TILE_SIZE * TILE_SIZE * BYTES_PER_PIXEL[f];

export interface Rect { x: number; y: number; w: number; h: number }

export const tileKey = (tx: number, ty: number) => `${tx},${ty}`;
export function parseTileKey(k: string): [number, number] {
  const i = k.indexOf(',');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
}
export const floorDiv = (a: number, b: number) => Math.floor(a / b);

/** key -> new tile bytes, or null meaning "tile absent". */
export type TileChanges = Map<string, Uint8Array | null>;

export class TileStore {
  readonly tiles = new Map<string, Uint8Array>();
  /** `fill` is the value of every byte of an absent tile (A8 masks may use 255 = reveal-all). RGBA8 must use 0. */
  constructor(readonly format: PixelFormat, readonly fill = 0) {
    if (format === 'RGBA8' && fill !== 0) throw new RangeError('RGBA8 stores must have fill 0');
  }

  get bpp() { return BYTES_PER_PIXEL[this.format]; }
  get tileCount() { return this.tiles.size; }
  get byteSize() { return this.tiles.size * tileByteLength(this.format); }
  get(tx: number, ty: number) { return this.tiles.get(tileKey(tx, ty)); }
  getByKey(k: string) { return this.tiles.get(k); }

  /** Shallow clone: tiles are shared (safe because writers copy-on-write). */
  clone(): TileStore {
    const s = new TileStore(this.format, this.fill);
    for (const [k, v] of this.tiles) s.tiles.set(k, v);
    return s;
  }

  /** Apply changes; returns the inverse changes (previous values). */
  applyChanges(changes: TileChanges): TileChanges {
    const inv: TileChanges = new Map();
    const want = tileByteLength(this.format);
    for (const [k, v] of changes) {
      if (v && v.length !== want) throw new RangeError(`tile ${k}: expected ${want} bytes, got ${v.length}`);
      inv.set(k, this.tiles.get(k) ?? null);
      if (v) this.tiles.set(k, v); else this.tiles.delete(k);
    }
    return inv;
  }

  getPixel(x: number, y: number, out?: Uint8Array): Uint8Array {
    const bpp = this.bpp;
    const o = out ?? new Uint8Array(bpp);
    const t = this.tiles.get(tileKey(floorDiv(x, TILE_SIZE), floorDiv(y, TILE_SIZE)));
    if (!t) { o.fill(this.fill, 0, bpp); return o; }
    const lx = x - floorDiv(x, TILE_SIZE) * TILE_SIZE;
    const ly = y - floorDiv(y, TILE_SIZE) * TILE_SIZE;
    const i = (ly * TILE_SIZE + lx) * bpp;
    for (let c = 0; c < bpp; c++) o[c] = t[i + c];
    return o;
  }

  /** Copy a region into a dense buffer (zeros where tiles are absent). */
  readRegion(x: number, y: number, w: number, h: number, out?: Uint8Array): Uint8Array {
    const bpp = this.bpp;
    const buf = out ?? new Uint8Array(w * h * bpp);
    if (this.fill !== 0 || out) buf.fill(this.fill, 0, w * h * bpp);
    if (w <= 0 || h <= 0) return buf;
    const tx0 = floorDiv(x, TILE_SIZE), tx1 = floorDiv(x + w - 1, TILE_SIZE);
    const ty0 = floorDiv(y, TILE_SIZE), ty1 = floorDiv(y + h - 1, TILE_SIZE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = this.tiles.get(tileKey(tx, ty));
      if (!t) continue;
      const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
      const sx0 = Math.max(x, ox), sx1 = Math.min(x + w, ox + TILE_SIZE);
      const sy0 = Math.max(y, oy), sy1 = Math.min(y + h, oy + TILE_SIZE);
      const rowBytes = (sx1 - sx0) * bpp;
      for (let yy = sy0; yy < sy1; yy++) {
        const si = ((yy - oy) * TILE_SIZE + (sx0 - ox)) * bpp;
        const di = ((yy - y) * w + (sx0 - x)) * bpp;
        buf.set(t.subarray(si, si + rowBytes), di);
      }
    }
    return buf;
  }

  /** Pixel-exact bounds of non-zero content, or null. Scans stored tiles only. */
  contentBounds(): Rect | null {
    const bpp = this.bpp;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [k, t] of this.tiles) {
      const [tx, ty] = parseTileKey(k);
      for (let ly = 0; ly < TILE_SIZE; ly++) for (let lx = 0; lx < TILE_SIZE; lx++) {
        const i = (ly * TILE_SIZE + lx) * bpp;
        let nz = false;
        // RGBA: content = alpha>0; A8: value>0
        nz = bpp === 4 ? t[i + 3] !== 0 : t[i] !== 0;
        if (nz) {
          const x = tx * TILE_SIZE + lx, y = ty * TILE_SIZE + ly;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Write a dense region (replace semantics) with copy-on-write via writer. */
  writeRegion(writer: TileWriter, x: number, y: number, w: number, h: number, data: Uint8Array) {
    const bpp = this.bpp;
    const tx0 = floorDiv(x, TILE_SIZE), tx1 = floorDiv(x + w - 1, TILE_SIZE);
    const ty0 = floorDiv(y, TILE_SIZE), ty1 = floorDiv(y + h - 1, TILE_SIZE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
      const sx0 = Math.max(x, ox), sx1 = Math.min(x + w, ox + TILE_SIZE);
      const sy0 = Math.max(y, oy), sy1 = Math.min(y + h, oy + TILE_SIZE);
      // skip fully-zero source spans over absent tiles (keeps allocation sparse)
      if (!this.tiles.has(tileKey(tx, ty))) {
        let any = false;
        for (let yy = sy0; yy < sy1 && !any; yy++) {
          const di = ((yy - y) * w + (sx0 - x)) * bpp;
          for (let i = 0; i < (sx1 - sx0) * bpp; i++) if (data[di + i] !== this.fill) { any = true; break; }
        }
        if (!any) continue;
      }
      const t = writer.tile(tx, ty);
      for (let yy = sy0; yy < sy1; yy++) {
        const di = ((yy - y) * w + (sx0 - x)) * bpp;
        const ti = ((yy - oy) * TILE_SIZE + (sx0 - ox)) * bpp;
        t.set(data.subarray(di, di + (sx1 - sx0) * bpp), ti);
      }
    }
  }
}

function isFill(t: Uint8Array, v: number) {
  for (let i = 0; i < t.length; i++) if (t[i] !== v) return false;
  return true;
}
function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface TileDiff { before: TileChanges; after: TileChanges }

/**
 * Copy-on-write writer. `tile()` returns a tile that is safe to mutate: the first
 * touch clones the existing tile (or allocates zeros) and installs the clone in the
 * store, remembering the original. `finish()` drops all-zero tiles and unchanged
 * tiles and returns the diff for history.
 */
export class TileWriter {
  private owned = new Set<Uint8Array>();
  private original = new Map<string, Uint8Array | null>();
  constructor(readonly store: TileStore) {}

  tile(tx: number, ty: number): Uint8Array {
    const k = tileKey(tx, ty);
    const cur = this.store.tiles.get(k);
    if (cur && this.owned.has(cur)) return cur;
    if (!this.original.has(k)) this.original.set(k, cur ?? null);
    const fresh = cur ? cur.slice() : new Uint8Array(tileByteLength(this.store.format));
    if (!cur && this.store.fill !== 0) fresh.fill(this.store.fill);
    this.owned.add(fresh);
    this.store.tiles.set(k, fresh);
    return fresh;
  }
  get touchedKeys() { return [...this.original.keys()]; }
  originalOf(k: string) { return this.original.get(k) ?? null; }

  finish(): TileDiff {
    const before: TileChanges = new Map(), after: TileChanges = new Map();
    for (const [k, orig] of this.original) {
      let cur: Uint8Array | null = this.store.tiles.get(k) ?? null;
      if (cur && isFill(cur, this.store.fill)) { this.store.tiles.delete(k); cur = null; }
      if (orig === null && cur === null) continue;
      if (orig && cur && equalBytes(orig, cur)) {
        // unchanged: restore original reference so history stays shared
        this.store.tiles.set(k, orig);
        continue;
      }
      before.set(k, orig);
      after.set(k, cur);
    }
    this.owned.clear();
    return { before, after };
  }
}

export function changesByteSize(c: TileChanges): number {
  let n = 0;
  for (const v of c.values()) if (v) n += v.length;
  return n;
}
