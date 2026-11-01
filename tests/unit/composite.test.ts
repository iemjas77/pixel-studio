import { describe, expect, it } from 'vitest';
import { BLEND_MODES, BLEND_FUNCTIONS, TileStore, TileWriter, composeRegion, fillRect, type RenderNode } from '@ps/raster';

function solid(rgba: [number, number, number, number], w = 4, h = 4, x = 0, y = 0): TileStore {
  const s = new TileStore('RGBA8'); const wr = new TileWriter(s); fillRect(wr, { x, y, w, h }, rgba); wr.finish(); return s;
}
const node = (pixels: TileStore, o: Partial<RenderNode> = {}): RenderNode => ({ visible: true, opacity: 1, blend: 'normal', offsetX: 0, offsetY: 0, pixels, ...o });
const px = (buf: Uint8Array, i = 0) => [...buf.subarray(i * 4, i * 4 + 4)];

describe('CPU reference compositor', () => {
  it('normal over opaque with opacity', () => {
    const out = composeRegion([node(solid([0, 0, 255, 255])), node(solid([255, 0, 0, 255]), { opacity: 0.5 })], 0, 0, 1, 1);
    expect(px(out)).toEqual([128, 0, 128, 255]);
  });
  it('multiply of mid-grey with mid-grey', () => {
    const out = composeRegion([node(solid([128, 128, 128, 255])), node(solid([128, 128, 128, 255]), { blend: 'multiply' })], 0, 0, 1, 1);
    expect(px(out)[0]).toBe(64);
  });
  it('blend over transparent backdrop equals normal (spec rule)', () => {
    for (const m of BLEND_MODES) {
      const out = composeRegion([node(solid([200, 100, 50, 255]), { blend: m })], 0, 0, 1, 1);
      expect(px(out), m).toEqual([200, 100, 50, 255]);
    }
  });
  it('known blend values for cb=0.5, cs=0.25', () => {
    const f = BLEND_FUNCTIONS;
    expect(f.multiply(0.5, 0.25)).toBeCloseTo(0.125);
    expect(f.screen(0.5, 0.25)).toBeCloseTo(0.625);
    expect(f.overlay(0.5, 0.25)).toBeCloseTo(0.25);
    expect(f['hard-light'](0.5, 0.25)).toBeCloseTo(0.25);
    expect(f.difference(0.5, 0.25)).toBeCloseTo(0.25);
    expect(f.exclusion(0.5, 0.25)).toBeCloseTo(0.5);
    expect(f.darken(0.5, 0.25)).toBe(0.25);
    expect(f.lighten(0.5, 0.25)).toBe(0.5);
    expect(f['color-dodge'](0.5, 0.25)).toBeCloseTo(0.6667, 3);
    expect(f['color-burn'](0.5, 0.25)).toBeCloseTo(0.0, 5);
    expect(f['soft-light'](0.5, 0.25)).toBeCloseTo(0.5 - 0.5 * 0.5 * 0.5, 5);
  });
  it('straight alpha: 50% red over transparent keeps colour, alpha 128', () => {
    const out = composeRegion([node(solid([255, 0, 0, 255]), { opacity: 0.5 })], 0, 0, 1, 1);
    expect(px(out)).toEqual([255, 0, 0, 128]);
  });
  it('respects layer offset and sparse regions', () => {
    const out = composeRegion([node(solid([9, 9, 9, 255], 2, 2), { offsetX: 3, offsetY: 1 })], 0, 0, 6, 4);
    expect(px(out, 1 * 6 + 3)).toEqual([9, 9, 9, 255]);
    expect(px(out, 1 * 6 + 2)).toEqual([0, 0, 0, 0]);
    expect(px(out, 3 * 6 + 3)).toEqual([0, 0, 0, 0]);
  });
  it('mask hides, disabled mask ignored, mask fill 255 reveals', () => {
    const m = new TileStore('A8', 0); const w = new TileWriter(m); fillRect(w, { x: 0, y: 0, w: 1, h: 1 }, [255, 255, 255, 255]); w.finish();
    const src = solid([10, 20, 30, 255]);
    let out = composeRegion([node(src, { mask: m, maskEnabled: true })], 0, 0, 2, 1);
    expect(px(out, 0)[3]).toBe(255); expect(px(out, 1)[3]).toBe(0);
    out = composeRegion([node(src, { mask: m, maskEnabled: false })], 0, 0, 2, 1);
    expect(px(out, 1)[3]).toBe(255);
    out = composeRegion([node(src, { mask: new TileStore('A8', 255), maskEnabled: true })], 0, 0, 2, 1);
    expect(px(out, 1)[3]).toBe(255);
  });
  it('hidden layers and zero opacity are skipped; group is isolated', () => {
    const base = node(solid([255, 255, 255, 255]));
    const hidden = node(solid([0, 0, 0, 255]), { visible: false });
    const grp: RenderNode = { visible: true, opacity: 1, blend: 'normal', offsetX: 0, offsetY: 0, children: [node(solid([100, 100, 100, 255]), { blend: 'multiply' })] };
    // multiply inside an isolated group has no backdrop → plain colour, then group is normal over white
    const out = composeRegion([base, hidden, grp], 0, 0, 1, 1);
    expect(px(out)).toEqual([100, 100, 100, 255]);
  });
  it('is cancellable', () => {
    expect(() => composeRegion([node(solid([1, 1, 1, 255]))], 0, 0, 2, 2, { isCancelled: () => true })).toThrow(/cancel/);
  });
});

describe('linear-light blending (CPU reference)', () => {
  it('50% black over white: encoded blend = 128, linear blend = sRGB(0.5) ≈ 188', () => {
    const nodes = [node(solid([255, 255, 255, 255])), node(solid([0, 0, 0, 255]), { opacity: 0.5 })];
    expect(px(composeRegion(nodes, 0, 0, 1, 1))).toEqual([128, 128, 128, 255]);
    expect(px(composeRegion(nodes, 0, 0, 1, 1, { linear: true }))).toEqual([188, 188, 188, 255]);
  });
  it('is a no-op for opaque unblended pixels (round-trips every 8-bit value)', () => {
    for (let v = 0; v < 256; v += 5) expect(px(composeRegion([node(solid([v, v, v, 255]))], 0, 0, 1, 1, { linear: true }))).toEqual([v, v, v, 255]);
  });
});
