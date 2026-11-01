import { TILE_SIZE, TileStore, TileWriter, parseTileKey, type Rect } from './tiles';
import type { Coverage } from './fill';

/**
 * Destructive pixel adjustments and filters (reference implementation, encoded sRGB 8-bit, straight alpha).
 * Colour math is on encoded values (documented limitation). `clip` limits effect to the selection (doc-space
 * coverage via `offset`); only tiles that already exist are visited (transparent pixels carry no colour).
 */
export type PixelFn = (r: number, g: number, b: number, a: number, x: number, y: number) => [number, number, number];

export function mapPixels(w: TileWriter, fn: PixelFn, clip?: Coverage | null, offset = { x: 0, y: 0 }) {
  for (const k of [...w.store.tiles.keys()]) {
    const [tx, ty] = parseTileKey(k);
    const src = w.store.tiles.get(k)!;
    let t: Uint8Array | null = null;
    for (let ly = 0; ly < TILE_SIZE; ly++) for (let lx = 0; lx < TILE_SIZE; lx++) {
      const i = (ly * TILE_SIZE + lx) * 4;
      const a = src[i + 3];
      if (a === 0) continue;
      const x = tx * TILE_SIZE + lx, y = ty * TILE_SIZE + ly;
      const cov = clip ? clip(x + offset.x, y + offset.y) : 1;
      if (cov <= 0) continue;
      const [r, g, b] = fn(src[i], src[i + 1], src[i + 2], a, x, y);
      if (!t) t = w.tile(tx, ty);
      const c = (v: number, o: number) => Math.round(o + (Math.min(255, Math.max(0, v)) - o) * cov);
      t[i] = c(r, src[i]); t[i + 1] = c(g, src[i + 1]); t[i + 2] = c(b, src[i + 2]);
    }
  }
}

// ---------------------------------------------------------------- per-pixel adjustments
export const invert: PixelFn = (r, g, b) => [255 - r, 255 - g, 255 - b];
export const desaturate: PixelFn = (r, g, b) => { const l = 0.299 * r + 0.587 * g + 0.114 * b; return [l, l, l]; };

/** Photoshop-like legacy model: brightness shifts, contrast pivots around mid-grey. Both −100..100. */
export function brightnessContrast(brightness: number, contrast: number): PixelFn {
  const lut = new Float32Array(256);
  const c = contrast / 100;
  const slope = c >= 0 ? 1 / Math.max(1e-3, 1 - c * 0.99) : 1 + c;
  for (let v = 0; v < 256; v++) lut[v] = (v - 127.5) * slope + 127.5 + brightness * 2.55;
  return (r, g, b) => [lut[r], lut[g], lut[b]];
}

export interface LevelsParams { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
export function levels(p: LevelsParams): PixelFn {
  const lut = new Float32Array(256);
  const span = Math.max(1, p.inWhite - p.inBlack);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - p.inBlack) / span));
    lut[v] = p.outBlack + Math.pow(t, 1 / p.gamma) * (p.outWhite - p.outBlack);
  }
  return (r, g, b) => [lut[r], lut[g], lut[b]];
}

/** Monotone cubic (Fritsch–Carlson) curve through points (x,y in 0..255, strictly increasing x). */
export function curveLut(points: [number, number][]): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
  const t = new Array(n).fill(0);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    if (v <= pts[0][0]) { lut[v] = pts[0][1]; continue; }
    if (v >= pts[n - 1][0]) { lut[v] = pts[n - 1][1]; continue; }
    let i = 0; while (v > pts[i + 1][0]) i++;
    const h = dx[i], s = (v - pts[i][0]) / h;
    const s2 = s * s, s3 = s2 * s;
    lut[v] = (2 * s3 - 3 * s2 + 1) * pts[i][1] + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * pts[i + 1][1] + (s3 - s2) * h * t[i + 1];
  }
  return lut;
}
export function curves(points: [number, number][]): PixelFn {
  const lut = curveLut(points);
  return (r, g, b) => [lut[r], lut[g], lut[b]];
}

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  const hh = h / 360;
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}
/** hue −180..180 degrees, saturation/lightness −100..100 (HSL, encoded sRGB). */
export function hueSaturation(hue: number, sat: number, light: number): PixelFn {
  return (r, g, b) => {
    let [h, s, l] = rgb2hsl(r, g, b);
    h = (h + hue + 360) % 360;
    s = sat >= 0 ? s + (1 - s) * (sat / 100) : s * (1 + sat / 100);
    l = light >= 0 ? l + (1 - l) * (light / 100) : l * (1 + light / 100);
    return hsl2rgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)));
  };
}

/** Position-hashed noise so results never depend on tile order. amount 0..100 (% of full range). */
export function addNoise(amount: number, seed: number, mono: boolean): PixelFn {
  const hash = (x: number, y: number, c: number) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519) ^ Math.imul(c, 3266489917);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const k = (amount / 100) * 255 * 2;
  return (r, g, b, _a, x, y) => mono
    ? (() => { const n = (hash(x, y, 0) - 0.5) * k; return [r + n, g + n, b + n] as [number, number, number]; })()
    : [r + (hash(x, y, 0) - 0.5) * k, g + (hash(x, y, 1) - 0.5) * k, b + (hash(x, y, 2) - 0.5) * k];
}

// ---------------------------------------------------------------- blur / sharpen
function gaussKernel(radius: number): Float32Array {
  const sigma = Math.max(0.3, radius / 2);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}
/** Separable Gaussian on a premultiplied float RGBA buffer (edge = transparent). */
function blurPremult(src: Float32Array, w: number, h: number, kernel: Float32Array): Float32Array {
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; const i = (y * w + xx) * 4, wt = kernel[k + r]; a0 += src[i] * wt; a1 += src[i + 1] * wt; a2 += src[i + 2] * wt; a3 += src[i + 3] * wt; }
    const o = (y * w + x) * 4; tmp[o] = a0; tmp[o + 1] = a1; tmp[o + 2] = a2; tmp[o + 3] = a3;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; const i = (yy * w + x) * 4, wt = kernel[k + r]; a0 += tmp[i] * wt; a1 += tmp[i + 1] * wt; a2 += tmp[i + 2] * wt; a3 += tmp[i + 3] * wt; }
    const o = (y * w + x) * 4; out[o] = a0; out[o + 1] = a1; out[o + 2] = a2; out[o + 3] = a3;
  }
  return out;
}

export const MAX_FILTER_PIXELS = 48 * 1024 * 1024;

/**
 * Gaussian blur (`amount` ignored) or unsharp-mask sharpen on an RGBA8 store. The processed region is the content
 * bounds grown by the kernel radius; results are written only where `clip` allows.
 */
export function convolveFilter(w: TileWriter, kind: 'blur' | 'sharpen', radius: number, amount: number, clip?: Coverage | null, offset = { x: 0, y: 0 }) {
  const store = w.store;
  const cb = store.contentBounds();
  if (!cb) return;
  const kernel = gaussKernel(radius);
  const pad = kind === 'blur' ? (kernel.length - 1) / 2 : 0;
  const R: Rect = { x: cb.x - pad, y: cb.y - pad, w: cb.w + pad * 2, h: cb.h + pad * 2 };
  if (R.w * R.h > MAX_FILTER_PIXELS) throw new RangeError('layer too large for this filter in the reference engine');
  const raw = store.readRegion(R.x, R.y, R.w, R.h);
  const n = R.w * R.h;
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const a = raw[i * 4 + 3] / 255; src[i * 4] = raw[i * 4] * a; src[i * 4 + 1] = raw[i * 4 + 1] * a; src[i * 4 + 2] = raw[i * 4 + 2] * a; src[i * 4 + 3] = a; }
  const bl = blurPremult(src, R.w, R.h, kernel);
  const out = new Uint8Array(raw.length);
  for (let y = 0; y < R.h; y++) for (let x = 0; x < R.w; x++) {
    const i = (y * R.w + x) * 4;
    const cov = clip ? clip(R.x + x + offset.x, R.y + y + offset.y) : 1;
    let pr: number, pg: number, pb: number, pa: number;
    if (kind === 'blur') { pr = bl[i]; pg = bl[i + 1]; pb = bl[i + 2]; pa = bl[i + 3]; }
    else {
      pa = src[i + 3];
      pr = Math.min(pa * 255, Math.max(0, src[i] + amount * (src[i] - bl[i])));
      pg = Math.min(pa * 255, Math.max(0, src[i + 1] + amount * (src[i + 1] - bl[i + 1])));
      pb = Math.min(pa * 255, Math.max(0, src[i + 2] + amount * (src[i + 2] - bl[i + 2])));
    }
    // blend with original by clip coverage (straight alpha)
    const oa = src[i + 3];
    const ra = oa + (pa - oa) * cov;
    if (ra <= 0) continue;
    const mr = src[i] + (pr - src[i]) * cov, mg = src[i + 1] + (pg - src[i + 1]) * cov, mb = src[i + 2] + (pb - src[i + 2]) * cov;
    out[i] = Math.round(mr / ra); out[i + 1] = Math.round(mg / ra); out[i + 2] = Math.round(mb / ra); out[i + 3] = Math.round(ra * 255);
  }
  store.writeRegion(w, R.x, R.y, R.w, R.h, out);
  // writeRegion skips fully-zero spans over absent tiles only; zeroed-out content inside existing tiles is written above.
}

// ---------------------------------------------------------------- gradient
export function gradientFill(w: TileWriter, rect: Rect, from: [number, number], to: [number, number], c0: number[], c1: number[], kind: 'linear' | 'radial', clip?: Coverage | null, offset = { x: 0, y: 0 }) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len2 = Math.max(1e-6, dx * dx + dy * dy), len = Math.sqrt(len2);
  const data = w.store.readRegion(rect.x, rect.y, rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const px = rect.x + x + 0.5, py = rect.y + y + 0.5;
    let t = kind === 'linear' ? ((px - from[0]) * dx + (py - from[1]) * dy) / len2 : Math.hypot(px - from[0], py - from[1]) / len;
    t = Math.min(1, Math.max(0, t));
    const cov = clip ? clip(rect.x + x + offset.x, rect.y + y + offset.y) : 1;
    if (cov <= 0) continue;
    const i = (y * rect.w + x) * 4;
    const sr = c0[0] + (c1[0] - c0[0]) * t, sg = c0[1] + (c1[1] - c0[1]) * t, sb = c0[2] + (c1[2] - c0[2]) * t, sa = (c0[3] + (c1[3] - c0[3]) * t) / 255 * cov;
    if (w.store.bpp === 1) { const l = 0.299 * sr + 0.587 * sg + 0.114 * sb; data[y * rect.w + x] = Math.round(data[y * rect.w + x] + (l - data[y * rect.w + x]) * sa); continue; }
    const da = data[i + 3] / 255, ra = sa + da * (1 - sa);
    if (ra <= 0) continue;
    data[i] = Math.round((sr * sa + data[i] * da * (1 - sa)) / ra); data[i + 1] = Math.round((sg * sa + data[i + 1] * da * (1 - sa)) / ra);
    data[i + 2] = Math.round((sb * sa + data[i + 2] * da * (1 - sa)) / ra); data[i + 3] = Math.round(ra * 255);
  }
  w.store.writeRegion(w, rect.x, rect.y, rect.w, rect.h, data);
}
void TileStore;
