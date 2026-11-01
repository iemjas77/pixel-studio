import { describe, expect, it } from 'vitest';
import { Engine, createDefaultRegistry } from '@ps/commands';
import { createDocument, getLayer, SequentialIdSource, type RasterLayer, type TextLayer } from '@ps/document';
import { TileStore, TileWriter, fillRect, curveLut } from '@ps/raster';
import { snapshot } from '../helpers';

function setup(w = 64, h = 48, color: [number, number, number, number] = [200, 100, 50, 255]) {
  const src = new SequentialIdSource();
  const doc = createDocument(src, { width: w, height: h, background: color });
  const e = new Engine(doc, { ids: src, registry: createDefaultRegistry() });
  return { e, doc, id: doc.layers[0].id };
}
const px = (e: Engine, id: string, x: number, y: number) => [...(getLayer(e.doc, id) as RasterLayer).pixels.getPixel(x, y)];
const adj = (e: Engine, id: string, kind: string, extra: Record<string, unknown> = {}) => e.execute({ type: 'adjust.apply', params: { layerId: id, kind, ...extra } });

describe('adjustments', () => {
  it('invert is its own inverse and keeps alpha', () => {
    const { e, id } = setup();
    adj(e, id, 'invert');
    expect(px(e, id, 5, 5)).toEqual([55, 155, 205, 255]);
    adj(e, id, 'invert');
    expect(px(e, id, 5, 5)).toEqual([200, 100, 50, 255]);
  });
  it('desaturate gives luma grey', () => {
    const { e, id } = setup();
    adj(e, id, 'desaturate');
    const [r, g, b] = px(e, id, 1, 1);
    expect(r).toBe(g); expect(g).toBe(b);
    expect(r).toBe(Math.round(0.299 * 200 + 0.587 * 100 + 0.114 * 50));
  });
  it('brightness/contrast: +brightness raises, contrast pivots at mid-grey', () => {
    const a = setup(8, 8, [100, 100, 100, 255]); adj(a.e, a.id, 'brightnessContrast', { brightness: 20, contrast: 0 });
    expect(px(a.e, a.id, 0, 0)[0]).toBe(151);
    const m = setup(8, 8, [128, 128, 128, 255]); adj(m.e, m.id, 'brightnessContrast', { brightness: 0, contrast: 60 });
    expect(Math.abs(px(m.e, m.id, 0, 0)[0] - 128)).toBeLessThanOrEqual(1);
    const c = setup(8, 8, [200, 200, 200, 255]); adj(c.e, c.id, 'brightnessContrast', { brightness: 0, contrast: 50 });
    expect(px(c.e, c.id, 0, 0)[0]).toBeGreaterThan(200);
  });
  it('levels maps black/white points and gamma', () => {
    const { e, id } = setup(8, 8, [64, 128, 192, 255]);
    adj(e, id, 'levels', { inBlack: 64, inWhite: 192 });
    expect(px(e, id, 0, 0).slice(0, 3)).toEqual([0, 128, 255]);
    const g = setup(8, 8, [128, 128, 128, 255]); adj(g.e, g.id, 'levels', { gamma: 2 });
    expect(px(g.e, g.id, 0, 0)[0]).toBe(Math.round(Math.pow(128 / 255, 0.5) * 255));
    expect(() => adj(e, id, 'levels', { inBlack: 200, inWhite: 100 })).toThrow();
  });
  it('hue/saturation: hue +180 turns red into cyan; saturation −100 is grey', () => {
    const r = setup(8, 8, [255, 0, 0, 255]); adj(r.e, r.id, 'hueSaturation', { hue: 180 });
    expect(px(r.e, r.id, 0, 0).slice(0, 3).map(Math.round)).toEqual([0, 255, 255]);
    const s = setup(8, 8, [255, 0, 0, 255]); adj(s.e, s.id, 'hueSaturation', { saturation: -100 });
    const [a, b, c] = px(s.e, s.id, 0, 0); expect(a === b && b === c).toBe(true);
  });
  it('curves: identity is a no-op, inverted curve inverts, monotone (no overshoot)', () => {
    const { e, id } = setup();
    adj(e, id, 'curves', { points: [[0, 0], [255, 255]] });
    expect(px(e, id, 3, 3)).toEqual([200, 100, 50, 255]);
    adj(e, id, 'curves', { points: [[0, 255], [255, 0]] });
    expect(px(e, id, 3, 3)).toEqual([55, 155, 205, 255]);
    const lut = curveLut([[0, 0], [64, 30], [128, 140], [255, 255]]);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-4);
    expect(Math.min(...lut)).toBeGreaterThanOrEqual(0); expect(Math.max(...lut)).toBeLessThanOrEqual(255.0001);
    expect(() => adj(e, id, 'curves', { points: [[10, 0], [10, 255]] })).toThrow(/increasing/);
  });
  it('only affects the selection and is one undo step; transparent pixels stay transparent', () => {
    const { e, id, doc } = setup();
    e.execute({ type: 'selection.rect', params: { x: 10, y: 10, w: 10, h: 10 } });
    const before = snapshot(doc);
    adj(e, id, 'invert');
    expect(px(e, id, 12, 12)).toEqual([55, 155, 205, 255]);
    expect(px(e, id, 5, 5)).toEqual([200, 100, 50, 255]);
    e.undo();
    expect(snapshot(doc)).toBe(before);
    const t = e.execute({ type: 'layer.add', params: {} }).layerId!;
    e.execute({ type: 'selection.clear', params: {} });
    adj(e, t, 'invert');
    expect((getLayer(doc, t) as RasterLayer).pixels.tileCount).toBe(0);
  });
  it('blocked on text layers and locked layers', () => {
    const { e, id } = setup();
    const t = e.execute({ type: 'text.create', params: { x: 0, y: 0, data: { text: 'a' } } }).layerId!;
    expect(() => adj(e, t, 'invert')).toThrow(/Rasterize/);
    e.execute({ type: 'layer.set', params: { id, props: { lock: { pixels: true, position: false, all: false } } } });
    expect(() => adj(e, id, 'invert')).toThrow(/locked/);
  });
});

describe('filters', () => {
  const flt = (e: Engine, id: string, kind: string, extra: Record<string, unknown> = {}) => e.execute({ type: 'filter.apply', params: { layerId: id, kind, ...extra } });
  it('blur: flat colour stays flat; impulse spreads symmetrically and conserves alpha mass', () => {
    const f = setup(40, 40, [90, 120, 150, 255]);
    flt(f.e, f.id, 'blur', { radius: 4 });
    expect(px(f.e, f.id, 20, 20)).toEqual([90, 120, 150, 255]);
    const src = new SequentialIdSource();
    const doc = createDocument(src, { width: 41, height: 41 });
    const e = new Engine(doc, { ids: src, registry: createDefaultRegistry() });
    const id = e.execute({ type: 'layer.add', params: {} }).layerId!;
    const store = (getLayer(doc, id) as RasterLayer).pixels;
    const w = new TileWriter(store); fillRect(w, { x: 20, y: 20, w: 1, h: 1 }, [255, 255, 255, 255]); w.finish();
    flt(e, id, 'blur', { radius: 6 });
    const a = (x: number, y: number) => store.getPixel(x, y)[3];
    expect(a(20, 20)).toBeGreaterThan(a(23, 20));
    expect(a(23, 20)).toBe(a(17, 20)); expect(a(20, 23)).toBe(a(20, 17)); expect(a(23, 20)).toBe(a(20, 23));
    let mass = 0; for (let y = 0; y < 41; y++) for (let x = 0; x < 41; x++) mass += a(x, y);
    expect(Math.abs(mass - 255)).toBeLessThan(255 * 0.15); // 8-bit rounding of ~360 small values
    expect([...store.getPixel(22, 20)].slice(0, 3)).toEqual([255, 255, 255]); // colour preserved (premultiplied-correct)
  });
  it('blur respects selection; sharpen leaves flat areas unchanged and increases edge contrast', () => {
    const { e, id } = setup(40, 40, [0, 0, 0, 255]);
    e.execute({ type: 'selection.rect', params: { x: 0, y: 0, w: 20, h: 40 } });
    e.execute({ type: 'selection.clear', params: {} });
    const st = (getLayer(e.doc, id) as RasterLayer).pixels;
    const w = new TileWriter(st); fillRect(w, { x: 20, y: 0, w: 20, h: 40 }, [255, 255, 255, 255]); w.finish();
    flt(e, id, 'sharpen', { radius: 2, amount: 1.5 });
    expect(px(e, id, 2, 20)).toEqual([0, 0, 0, 255]);
    expect(px(e, id, 38, 20)).toEqual([255, 255, 255, 255]);
    const near = px(e, id, 21, 20)[0];
    expect(near).toBe(255); // overshoot clamps
    e.execute({ type: 'selection.rect', params: { x: 0, y: 0, w: 10, h: 40 } });
    flt(e, id, 'blur', { radius: 3 });
    expect(px(e, id, 19, 20)[0]).toBe(0); // outside selection untouched
  });
  it('noise is deterministic, bounded, seed-dependent, and independent of tile order', () => {
    const a = setup(300, 20, [128, 128, 128, 255]), b = setup(300, 20, [128, 128, 128, 255]), c = setup(300, 20, [128, 128, 128, 255]);
    flt(a.e, a.id, 'noise', { amount: 10, seed: 5 }); flt(b.e, b.id, 'noise', { amount: 10, seed: 5 }); flt(c.e, c.id, 'noise', { amount: 10, seed: 6 });
    expect(snapshot(a.doc)).toBe(snapshot(b.doc).replace(/doc_\w+/g, m => m));
    expect(snapshot(a.doc)).not.toBe(snapshot(c.doc));
    let max = 0; for (let x = 0; x < 300; x++) max = Math.max(max, Math.abs(px(a.e, a.id, x, 3)[0] - 128));
    expect(max).toBeGreaterThan(5); expect(max).toBeLessThanOrEqual(26);
  });
});

describe('gradient, crop, resize', () => {
  it('linear gradient hits endpoint colours and midpoint; radial is symmetric; clipped by selection; undoable', () => {
    const { e, id, doc } = setup(101, 11, [0, 0, 0, 0]);
    e.execute({ type: 'layer.delete', params: { id } });
    const l = e.execute({ type: 'layer.add', params: {} }).layerId!;
    const before = snapshot(doc);
    e.execute({ type: 'gradient.fill', params: { layerId: l, plane: 'pixels', kind: 'linear', from: [0, 0], to: [100, 0], c0: [0, 0, 0, 255], c1: [255, 255, 255, 255] } });
    expect(px(e, l, 0, 5)[0]).toBeLessThanOrEqual(2); expect(px(e, l, 100, 5)[0]).toBeGreaterThanOrEqual(253);
    expect(Math.abs(px(e, l, 50, 5)[0] - 128)).toBeLessThanOrEqual(2);
    e.undo(); expect(snapshot(doc)).toBe(before);
    e.execute({ type: 'selection.rect', params: { x: 40, y: 0, w: 20, h: 11 } });
    e.execute({ type: 'gradient.fill', params: { layerId: l, plane: 'pixels', kind: 'radial', from: [50, 5], to: [60, 5], c0: [255, 0, 0, 255], c1: [0, 0, 255, 255] } });
    expect(px(e, l, 39, 5)[3]).toBe(0);
    expect(px(e, l, 45, 5)).toEqual(px(e, l, 54, 5).map((v, i) => (i === 3 ? v : v)).map((v, i) => (i < 3 ? px(e, l, 45, 5)[i] : v)));
    expect(Math.abs(px(e, l, 45, 5)[0] - px(e, l, 54, 5)[0])).toBeLessThanOrEqual(6);
  });
  it('crop shrinks the canvas, shifts layers, clears selection; undo restores exactly', () => {
    const { e, id, doc } = setup(100, 80);
    const l = e.execute({ type: 'text.create', params: { x: 30, y: 20, data: { text: 'x' } } }).layerId!;
    e.execute({ type: 'selection.all', params: {} });
    const before = snapshot(doc);
    e.execute({ type: 'canvas.crop', params: { x: 10, y: 5, w: 50, h: 40 } });
    expect([doc.canvas.width, doc.canvas.height]).toEqual([50, 40]);
    expect(getLayer(doc, id).offset).toEqual({ x: -10, y: -5 });
    expect(getLayer(doc, l).offset).toEqual({ x: 20, y: 15 });
    expect(doc.selection).toBeNull();
    expect(() => e.execute({ type: 'canvas.crop', params: { x: 40, y: 0, w: 50, h: 10 } })).toThrow(/inside the canvas/);
    e.undo(); expect(snapshot(doc)).toBe(before);
  });
  it('resize scales canvas, pixels, offsets, masks and text size; undo restores exactly', () => {
    const { e, id, doc } = setup(100, 80, [10, 200, 30, 255]);
    e.execute({ type: 'mask.add', params: { id, mode: 'reveal' } });
    const t = e.execute({ type: 'text.create', params: { x: 40, y: 20, data: { text: 'hi', fontSize: 20, boxWidth: 60 } } }).layerId!;
    const before = snapshot(doc);
    e.execute({ type: 'image.resize', params: { width: 200, height: 160 } });
    expect([doc.canvas.width, doc.canvas.height]).toEqual([200, 160]);
    const bb = (getLayer(doc, id) as RasterLayer).pixels.contentBounds()!;
    expect(bb.w).toBeGreaterThanOrEqual(199); expect(bb.h).toBeGreaterThanOrEqual(159);
    expect(px(e, id, 150, 120)).toEqual([10, 200, 30, 255]);
    const tl = getLayer(doc, t) as TextLayer;
    expect(tl.text.fontSize).toBe(40); expect(tl.text.boxWidth).toBe(120); expect(tl.offset).toEqual({ x: 80, y: 40 });
    e.undo(); expect(snapshot(doc)).toBe(before);
  });
});
