import { TileStore, TileWriter, type Rect } from '@ps/raster';
import type { Layer, PixelResolver, TextData } from '@ps/document';

const MAX_SIDE = 8192;

function fontString(t: TextData) {
  const fam = t.fontFamily.replace(/["\\]/g, '');
  return `${t.italic ? 'italic ' : ''}${t.fontWeight} ${t.fontSize}px "${fam}", sans-serif`;
}

/** Break text into lines (explicit newlines + greedy word wrap when boxWidth is set). */
export function layoutLines(ctx: OffscreenCanvasRenderingContext2D, t: TextData): { lines: string[]; widths: number[] } {
  const out: string[] = [];
  for (const para of t.text.split('\n')) {
    if (!t.boxWidth) { out.push(para); continue; }
    const words = para.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const tryLine = cur + w;
      if (ctx.measureText(tryLine).width <= t.boxWidth || cur === '') {
        cur = tryLine;
        // hard-break overlong single words
        while (ctx.measureText(cur).width > t.boxWidth && cur.length > 1) {
          let n = cur.length - 1;
          while (n > 1 && ctx.measureText(cur.slice(0, n)).width > t.boxWidth) n--;
          out.push(cur.slice(0, n)); cur = cur.slice(n);
        }
      } else { out.push(cur.trimEnd()); cur = w.trimStart(); }
    }
    out.push(cur.trimEnd());
  }
  return { lines: out, widths: out.map(l => ctx.measureText(l).width) };
}

/** Rasterize text into layer-local RGBA8 tiles (origin = top-left of the first line box). */
export function rasterizeText(t: TextData): TileStore {
  const store = new TileStore('RGBA8');
  if (!t.text) return store;
  const probe = new OffscreenCanvas(8, 8).getContext('2d')!;
  probe.font = fontString(t);
  (probe as any).letterSpacing = `${t.tracking}px`;
  const { lines, widths } = layoutLines(probe, t);
  const lh = t.fontSize * t.lineHeight;
  const blockW = t.boxWidth ?? Math.max(1, ...widths);
  const pad = Math.ceil(t.fontSize * 0.5) + 2;
  const w = Math.min(MAX_SIDE, Math.ceil(blockW) + pad * 2), h = Math.min(MAX_SIDE, Math.ceil(lines.length * lh) + pad * 2);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.font = fontString(t);
  (ctx as any).letterSpacing = `${t.tracking}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = `rgba(${t.color[0]},${t.color[1]},${t.color[2]},${t.color[3] / 255})`;
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent ?? t.fontSize * 0.8, desc = m.fontBoundingBoxDescent ?? t.fontSize * 0.2;
  lines.forEach((line, i) => {
    const lw = widths[i];
    const x = t.align === 'left' ? 0 : t.align === 'center' ? (blockW - lw) / 2 : blockW - lw;
    const y = i * lh + (lh - (asc + desc)) / 2 + asc;
    ctx.fillText(line, pad + x, pad + y);
  });
  const img = ctx.getImageData(0, 0, w, h);
  const wr = new TileWriter(store);
  store.writeRegion(wr, -pad, -pad, w, h, new Uint8Array(img.data.buffer));
  wr.finish();
  return store;
}

const availCache = new Map<string, boolean>();
/** Heuristic: a family is "installed" if its metrics differ from at least one generic baseline. */
export function fontAvailable(family: string): boolean {
  const f = family.trim();
  if (['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'].includes(f.toLowerCase())) return true;
  const hit = availCache.get(f);
  if (hit !== undefined) return hit;
  const ctx = new OffscreenCanvas(8, 8).getContext('2d')!;
  const sample = 'mmmmmmmmmmlliWWWQ@0123456789Ωжあ';
  const w = (font: string) => { ctx.font = `72px ${font}`; return ctx.measureText(sample).width; };
  const q = `"${f.replace(/["\\]/g, '')}"`;
  const ok = ['monospace', 'serif', 'sans-serif'].some(base => Math.abs(w(`${q}, ${base}`) - w(base)) > 0.01);
  availCache.set(f, ok);
  return ok;
}

interface Entry { key: string; store: TileStore; bounds: Rect | null }
/** Per-document cache of rasterized text layers, keyed by layer id + content hash. */
export class TextCache {
  private map = new Map<string, Entry>();
  resolver: PixelResolver = (layer: Layer) => (layer.kind === 'text' ? this.get(layer.id, layer.text).store : null);
  get(id: string, t: TextData): Entry {
    const key = JSON.stringify(t);
    const hit = this.map.get(id);
    if (hit && hit.key === key) return hit;
    const store = rasterizeText(t);
    const e = { key, store, bounds: store.contentBounds() };
    this.map.set(id, e);
    return e;
  }
  prune(liveIds: Set<string>) { for (const k of [...this.map.keys()]) if (!liveIds.has(k)) this.map.delete(k); }
}
