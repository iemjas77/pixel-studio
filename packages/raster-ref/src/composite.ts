import { BLEND_FUNCTIONS, type BlendMode } from './blend';
import { TileStore } from './tiles';

/**
 * Renderer-independent render tree consumed by the CPU reference compositor.
 * `layers` are in painter's order: index 0 is the bottom-most.
 * Colour math: encoded sRGB values (8-bit/255), straight alpha in storage,
 * premultiplied float accumulation, one un-premultiply on output.
 */
export interface RenderNode {
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  offsetX: number;
  offsetY: number;
  /** RGBA8 pixels (raster/text layers). */
  pixels?: TileStore | null;
  /** Child nodes (groups, isolated compositing). */
  children?: RenderNode[];
  /** A8 mask; used only when maskEnabled. */
  mask?: TileStore | null;
  maskEnabled?: boolean;
}

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.name = 'CancelledError'; }
}
export interface ComposeOptions { isCancelled?: () => boolean }

/** Compose region [x,x+w)×[y,y+h) of doc space; returns straight-alpha RGBA8. */
export function composeRegion(nodes: RenderNode[], x: number, y: number, w: number, h: number, opts: ComposeOptions = {}): Uint8Array {
  const acc = new Float32Array(w * h * 4); // premultiplied
  composeInto(acc, nodes, x, y, w, h, opts);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = acc[i * 4 + 3];
    if (a <= 0) continue;
    const inv = 1 / a;
    out[i * 4] = to8(acc[i * 4] * inv);
    out[i * 4 + 1] = to8(acc[i * 4 + 1] * inv);
    out[i * 4 + 2] = to8(acc[i * 4 + 2] * inv);
    out[i * 4 + 3] = to8(a);
  }
  return out;
}

const to8 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

function composeInto(acc: Float32Array, nodes: RenderNode[], x: number, y: number, w: number, h: number, opts: ComposeOptions) {
  for (const node of nodes) {
    if (opts.isCancelled?.()) throw new CancelledError();
    if (!node.visible || node.opacity <= 0) continue;
    const n = w * h;
    // Source straight colour (0..255 RGB) + alpha float (0..1)
    let src8: Uint8Array | null = null;
    let srcPre: Float32Array | null = null;
    if (node.children) {
      srcPre = new Float32Array(n * 4);
      composeInto(srcPre, node.children, x - node.offsetX, y - node.offsetY, w, h, opts);
    } else if (node.pixels) {
      src8 = node.pixels.readRegion(x - node.offsetX, y - node.offsetY, w, h);
    } else continue;
    const mask = node.maskEnabled && node.mask ? node.mask.readRegion(x - node.offsetX, y - node.offsetY, w, h) : null;
    // Note: group children are composed in group-local space; mask is read in the same space.
    const blend = BLEND_FUNCTIONS[node.blend];
    const normal = node.blend === 'normal';
    const op = node.opacity;
    for (let i = 0; i < n; i++) {
      let sa: number, sr: number, sg: number, sb: number;
      if (src8) {
        const a8 = src8[i * 4 + 3];
        if (a8 === 0) continue;
        sa = a8 / 255; sr = src8[i * 4] / 255; sg = src8[i * 4 + 1] / 255; sb = src8[i * 4 + 2] / 255;
      } else {
        const pa = srcPre![i * 4 + 3];
        if (pa <= 0) continue;
        sa = pa; sr = srcPre![i * 4] / pa; sg = srcPre![i * 4 + 1] / pa; sb = srcPre![i * 4 + 2] / pa;
      }
      sa *= op;
      if (mask) sa *= mask[i] / 255;
      if (sa <= 0) continue;
      const o = i * 4;
      const ab = acc[o + 3];
      if (ab <= 0 || normal) {
        const k = 1 - sa;
        acc[o] = acc[o] * k + sa * sr;
        acc[o + 1] = acc[o + 1] * k + sa * sg;
        acc[o + 2] = acc[o + 2] * k + sa * sb;
      } else {
        const inv = 1 / ab;
        const br = acc[o] * inv, bg = acc[o + 1] * inv, bb = acc[o + 2] * inv;
        const k = 1 - sa, m = 1 - ab;
        acc[o] = acc[o] * k + sa * (m * sr + ab * blend(br, sr));
        acc[o + 1] = acc[o + 1] * k + sa * (m * sg + ab * blend(bg, sg));
        acc[o + 2] = acc[o + 2] * k + sa * (m * sb + ab * blend(bb, sb));
      }
      acc[o + 3] = sa + ab * (1 - sa);
    }
  }
}
