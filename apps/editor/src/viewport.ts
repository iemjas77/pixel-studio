import { TILE_SIZE, composeRegion, floorDiv, type Rect } from '@ps/raster';
import { buildRenderTree, type PixelResolver, type PsDocument } from '@ps/document';

export interface ViewState { zoom: number; panX: number; panY: number }

interface CTile { canvas: HTMLCanvasElement; valid: boolean; data: Uint8ClampedArray | null; w: number; h: number }

/** Lazily composited tile cache for display (CPU reference compositor → canvas tiles). */
export class CompositeCache {
  private tiles = new Map<string, CTile>();
  constructor(private getDoc: () => PsDocument, private resolve: PixelResolver) {}

  invalidateAll() { for (const t of this.tiles.values()) t.valid = false; }
  invalidateRect(r: Rect) {
    const tx0 = floorDiv(r.x, TILE_SIZE), tx1 = floorDiv(r.x + r.w - 1, TILE_SIZE);
    const ty0 = floorDiv(r.y, TILE_SIZE), ty1 = floorDiv(r.y + r.h - 1, TILE_SIZE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = this.tiles.get(`${tx},${ty}`);
      if (t) t.valid = false;
    }
  }
  clear() { this.tiles.clear(); }

  getTile(tx: number, ty: number): HTMLCanvasElement | null {
    const doc = this.getDoc();
    const { width, height } = doc.canvas;
    const x = tx * TILE_SIZE, y = ty * TILE_SIZE;
    if (x >= width || y >= height || x < 0 || y < 0) return null;
    const w = Math.min(TILE_SIZE, width - x), h = Math.min(TILE_SIZE, height - y);
    const key = `${tx},${ty}`;
    let t = this.tiles.get(key);
    if (t && t.valid) return t.canvas;
    const data = composeRegion(buildRenderTree(doc.layers, this.resolve), x, y, w, h);
    if (!t) {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      t = { canvas, valid: false, data: null, w, h };
      this.tiles.set(key, t);
    }
    const clamped = new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    t.canvas.getContext('2d')!.putImageData(new ImageData(clamped, w, h), 0, 0);
    t.data = clamped; t.valid = true;
    return t.canvas;
  }

  /** Composite colour at a doc pixel (RGBA, straight alpha) or null outside canvas. */
  sample(x: number, y: number): [number, number, number, number] | null {
    const doc = this.getDoc();
    if (x < 0 || y < 0 || x >= doc.canvas.width || y >= doc.canvas.height) return null;
    const out = composeRegion(buildRenderTree(doc.layers, this.resolve), x, y, 1, 1);
    return [out[0], out[1], out[2], out[3]];
  }
}

let checker: CanvasPattern | null = null;
function checkerPattern(ctx: CanvasRenderingContext2D) {
  if (checker) return checker;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9dbe0'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#b4b8c2'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  checker = ctx.createPattern(c, 'repeat');
  return checker;
}

export function drawDocument(ctx: CanvasRenderingContext2D, cache: CompositeCache, doc: PsDocument, v: ViewState, cssW: number, cssH: number) {
  const { width, height } = doc.canvas;
  const z = v.zoom;
  ctx.fillStyle = '#101113';
  ctx.fillRect(0, 0, cssW, cssH);
  const x0 = Math.round(v.panX), y0 = Math.round(v.panY);
  const dw = width * z, dh = height * z;
  // drop shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 18; ctx.fillStyle = '#000';
  ctx.fillRect(x0, y0, dw, dh);
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, dw, dh); ctx.clip();
  const pat = checkerPattern(ctx);
  if (pat) { ctx.fillStyle = pat; ctx.fillRect(x0, y0, dw, dh); }
  ctx.imageSmoothingEnabled = z < 1;
  ctx.imageSmoothingQuality = 'high';
  const vx0 = Math.max(0, Math.floor(-v.panX / z)), vy0 = Math.max(0, Math.floor(-v.panY / z));
  const vx1 = Math.min(width, Math.ceil((cssW - v.panX) / z)), vy1 = Math.min(height, Math.ceil((cssH - v.panY) / z));
  for (let ty = floorDiv(vy0, TILE_SIZE); ty <= floorDiv(vy1 - 1, TILE_SIZE); ty++) {
    for (let tx = floorDiv(vx0, TILE_SIZE); tx <= floorDiv(vx1 - 1, TILE_SIZE); tx++) {
      const c = cache.getTile(tx, ty);
      if (!c) continue;
      ctx.drawImage(c, x0 + tx * TILE_SIZE * z, y0 + ty * TILE_SIZE * z, c.width * z, c.height * z);
    }
  }
  ctx.restore();
}

export const MIN_ZOOM = 0.02, MAX_ZOOM = 64;
export function fitView(doc: PsDocument, cssW: number, cssH: number, margin = 40): ViewState {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((cssW - margin * 2) / doc.canvas.width, (cssH - margin * 2) / doc.canvas.height)));
  const zoom = z > 1 ? Math.floor(z) || 1 : z;
  return { zoom, panX: (cssW - doc.canvas.width * zoom) / 2, panY: (cssH - doc.canvas.height * zoom) / 2 };
}
export function zoomAt(v: ViewState, newZoom: number, cx: number, cy: number): ViewState {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const dx = (cx - v.panX) / v.zoom, dy = (cy - v.panY) / v.zoom;
  return { zoom: z, panX: cx - dx * z, panY: cy - dy * z };
}
