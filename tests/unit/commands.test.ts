import { describe, expect, it } from 'vitest';
import { CommandError, Engine, createDefaultRegistry, fullBrush } from '@ps/commands';
import { createDocument, findLayer, getLayer, type RasterLayer } from '@ps/document';
import { StrokeSession, TileStore, type TileChanges } from '@ps/raster';
import { ids, snapshot } from '../helpers';

function setup(opts: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  const src = ids();
  const doc = createDocument(src, { width: 600, height: 400, background: 'white' });
  const e = new Engine(doc, { ids: src, registry: createDefaultRegistry(), ...opts });
  return { doc, e };
}
const stroke = (layerId: string, pts: number[][], extra: Record<string, unknown> = {}) => ({
  type: 'paint.stroke', params: { layerId, plane: 'pixels', mode: 'paint', brush: { size: 12, color: [255, 0, 0] }, points: pts, ...extra },
});

describe('command engine', () => {
  it('one history entry per command; undo/redo restore exact state', () => {
    const { doc, e } = setup();
    const s0 = snapshot(doc);
    const bg = doc.layers[0].id;
    const { layerId } = e.execute({ type: 'layer.add', params: { name: 'Paint' } });
    const s1 = snapshot(doc);
    e.execute(stroke(layerId!, [[10, 10], [300, 200], [590, 20]]));
    const s2 = snapshot(doc);
    e.execute({ type: 'layer.set', params: { id: layerId!, props: { opacity: 0.4, blendMode: 'multiply' } } });
    const s3 = snapshot(doc);
    e.execute({ type: 'layer.duplicate', params: { id: bg } });
    const s4 = snapshot(doc);
    expect(e.entries.length).toBe(4);
    const states = [s0, s1, s2, s3, s4];
    for (let i = 4; i > 0; i--) { expect(snapshot(doc)).toBe(states[i]); e.undo(); }
    expect(snapshot(doc)).toBe(s0);
    expect(e.canUndo).toBe(false);
    for (let i = 1; i <= 4; i++) { e.redo(); expect(snapshot(doc)).toBe(states[i]); }
    expect(e.canRedo).toBe(false);
  });

  it('redo branch is discarded after a divergent edit', () => {
    const { doc, e } = setup();
    e.execute({ type: 'layer.add', params: {} });
    e.execute({ type: 'layer.add', params: {} });
    e.undo(); e.undo();
    expect(e.canRedo).toBe(true);
    e.execute({ type: 'doc.rename', params: { name: 'X' } });
    expect(e.canRedo).toBe(false);
    expect(e.entries.length).toBe(1);
    expect(doc.name).toBe('X');
  });

  it('transaction rollback: a failing command in a batch leaves the document bit-identical', () => {
    const { doc, e } = setup();
    const before = snapshot(doc);
    expect(() => e.executeBatch('bad', [
      { type: 'layer.add', params: { name: 'A' } },
      { type: 'doc.rename', params: { name: 'Renamed' } },
      { type: 'layer.delete', params: { id: 'nope' } },
    ])).toThrow(CommandError);
    expect(snapshot(doc)).toBe(before);
    expect(e.entries.length).toBe(0);
    expect(e.isDirty).toBe(false);
  });

  it('rollback also happens when an op throws mid-execution (invalid move)', () => {
    const { doc, e } = setup();
    const { layerId } = e.execute({ type: 'layer.add', params: {} });
    const before = snapshot(doc);
    expect(() => e.executeBatch('x', [
      { type: 'doc.rename', params: { name: 'Changed' } },
      { type: 'layer.move', params: { id: layerId!, index: 99 } },
    ])).toThrow(/out of range/);
    expect(snapshot(doc)).toBe(before);
  });

  it('validates parameters strictly and rejects unknown commands/params', () => {
    const { e } = setup();
    expect(() => e.execute({ type: 'nope', params: {} })).toThrow(/unknown command/);
    expect(() => e.execute({ type: 'layer.set', params: { id: 'x', props: { opacity: 5 } } })).toThrow(/opacity/);
    expect(() => e.execute({ type: 'layer.add', params: { evil: 1 } })).toThrow(/unknown parameter/);
    expect(() => e.execute({ type: 'selection.rect', params: { x: 0.5, y: 0, w: 1, h: 1 } })).toThrow(/integer/);
    expect(() => e.execute({ type: 'paint.stroke', params: { layerId: 'a', plane: 'pixels', mode: 'paint', brush: { size: 5 }, points: [] } })).toThrow(/shorter/);
    expect(e.entries.length).toBe(0);
  });

  it('locks, hidden layers and text layers block pixel edits with clear messages', () => {
    const { doc, e } = setup();
    const bg = doc.layers[0].id;
    e.execute({ type: 'layer.set', params: { id: bg, props: { lock: { pixels: true, position: false, all: false } } } });
    expect(() => e.execute(stroke(bg, [[1, 1]]))).toThrow(/locked/);
    e.execute({ type: 'layer.set', params: { id: bg, props: { lock: { pixels: false, position: true, all: false } } } });
    expect(() => e.execute({ type: 'layer.offset', params: { id: bg, dx: 1, dy: 0 } })).toThrow(/locked/);
    const t = e.execute({ type: 'text.create', params: { x: 5, y: 5, data: { text: 'Hello' } } }).layerId!;
    expect(() => e.execute(stroke(t, [[1, 1]]))).toThrow(/Rasterize/);
    expect(() => e.execute({ type: 'transform.apply', params: { layerId: t, kind: 'flipH' } })).toThrow(/Rasterize/);
    e.execute({ type: 'layer.set', params: { id: bg, props: { visible: false } } });
    e.execute({ type: 'layer.set', params: { id: bg, props: { lock: { pixels: false, position: false, all: false } } } });
    expect(() => e.execute(stroke(bg, [[1, 1]]))).toThrow(/hidden/);
  });

  it('history is bounded by entry count and by byte budget; oldest evicted first', () => {
    let { e } = setup({ maxHistoryEntries: 5 });
    for (let i = 0; i < 12; i++) e.execute({ type: 'doc.rename', params: { name: `n${i}` } });
    expect(e.entries.length).toBe(5);
    expect(e.entries[0].label).toBe('Rename Document');
    for (let i = 0; i < 5; i++) e.undo();
    expect(e.doc.name).toBe('n6'); // 12 renames, last 5 undone → n6 (older steps evicted)
    ({ e } = setup({ maxHistoryBytes: 300_000 }));
    const bg = e.doc.layers[0].id;
    for (let i = 0; i < 20; i++) e.execute(stroke(bg, [[i * 20, 10], [i * 20 + 15, 380]], { brush: { size: 40, color: [i * 10, 0, 0] } }));
    // each stroke's tile diff (>1 MB) alone exceeds the budget → only the newest entry survives
    expect(e.entries.length).toBe(1);
    expect(e.ptr).toBe(0);
    e.undo();
    expect(e.canUndo).toBe(false);
  });

  it('dirty tracking follows undo/redo and save points', () => {
    const { e } = setup();
    expect(e.isDirty).toBe(false);
    e.execute({ type: 'layer.add', params: {} });
    expect(e.isDirty).toBe(true);
    e.markSaved(); expect(e.isDirty).toBe(false);
    e.undo(); expect(e.isDirty).toBe(true);
    e.redo(); expect(e.isDirty).toBe(false);
    e.undo(); e.execute({ type: 'doc.rename', params: { name: 'z' } }); // saved state now unreachable
    e.undo(); e.redo(); e.undo();
    expect(e.isDirty).toBe(true);
  });

  it('live stroke recorded with engine.record is byte-identical to replaying the command', () => {
    const a = setup(), b = setup();
    const la = a.e.execute({ type: 'layer.add', params: {} }).layerId!;
    const lb = b.e.execute({ type: 'layer.add', params: {} }).layerId!;
    const pts = Array.from({ length: 40 }, (_, i) => [20 + i * 13.7, 50 + Math.cos(i / 4) * 80, 0.2 + (i % 9) / 10]);
    const brush = fullBrush({ size: 21, hardness: 0.3, opacity: 0.8, flow: 0.7, color: [10, 120, 250], pressureSize: true });
    // live path (what the UI does)
    const layer = getLayer(a.doc, la) as RasterLayer;
    const sess = new StrokeSession(layer.pixels, brush, 'paint');
    for (const p of pts) sess.addPoint(p[0], p[1], p[2]);
    const diff = sess.finish();
    a.e.record({ type: 'paint.stroke', params: { layerId: la, plane: 'pixels', mode: 'paint', brush, points: pts } }, 'Brush Stroke',
      [{ op: 'tiles.apply', layerId: la, plane: 'pixels', changes: diff.after }], [{ op: 'tiles.apply', layerId: la, plane: 'pixels', changes: diff.before }]);
    // semantic replay path
    b.e.execute({ type: 'paint.stroke', params: { layerId: lb, plane: 'pixels', mode: 'paint', brush, points: pts } });
    const pa = (getLayer(a.doc, la) as RasterLayer).pixels, pb = (getLayer(b.doc, lb) as RasterLayer).pixels;
    expect([...pa.tiles.keys()].sort()).toEqual([...pb.tiles.keys()].sort());
    for (const [k, v] of pa.tiles) expect(v).toEqual(pb.tiles.get(k));
    // and the recorded live entry undoes exactly
    const after = snapshot(a.doc);
    a.e.undo();
    expect((getLayer(a.doc, la) as RasterLayer).pixels.tileCount).toBe(0);
    a.e.redo();
    expect(snapshot(a.doc)).toBe(after);
  });

  it('a stroke on a doc with a selection is clipped; undo restores', () => {
    const { doc, e } = setup();
    const id = doc.layers[0].id;
    e.execute({ type: 'selection.rect', params: { x: 100, y: 100, w: 50, h: 50 } });
    const before = snapshot(doc);
    e.execute(stroke(id, [[0, 125], [599, 125]], { brush: { size: 20, color: [255, 0, 0] } }));
    const px = (x: number, y: number) => [...(getLayer(doc, id) as RasterLayer).pixels.getPixel(x, y)];
    expect(px(99, 125)).toEqual([255, 255, 255, 255]);
    expect(px(100, 125)).toEqual([255, 0, 0, 255]);
    expect(px(149, 125)).toEqual([255, 0, 0, 255]);
    expect(px(150, 125)).toEqual([255, 255, 255, 255]);
    e.undo();
    expect(snapshot(doc)).toBe(before);
  });

  it('masks: reveal/hide/from-selection, paint on mask, apply bakes alpha, all undoable', () => {
    const { doc, e } = setup();
    const id = doc.layers[0].id;
    const s0 = snapshot(doc);
    e.execute({ type: 'mask.add', params: { id, mode: 'reveal' } });
    const l = getLayer(doc, id);
    expect(l.mask!.tiles.tileCount).toBe(0); // reveal-all costs no tiles
    e.execute({ type: 'paint.stroke', params: { layerId: id, plane: 'mask', mode: 'paint', brush: { size: 30, hardness: 1, color: [0, 0, 0] }, points: [[100, 100]] } });
    expect(l.mask!.tiles.getPixel(100, 100)[0]).toBe(0);
    expect(l.mask!.tiles.getPixel(300, 300)[0]).toBe(255);
    const withMask = snapshot(doc);
    e.execute({ type: 'mask.apply', params: { id } });
    expect(getLayer(doc, id).mask).toBeNull();
    expect((getLayer(doc, id) as RasterLayer).pixels.getPixel(100, 100)[3]).toBe(0);
    expect((getLayer(doc, id) as RasterLayer).pixels.getPixel(300, 300)[3]).toBe(255);
    e.undo();
    expect(snapshot(doc)).toBe(withMask);
    e.undo(); e.undo();
    expect(snapshot(doc)).toBe(s0);
    expect(() => e.execute({ type: 'mask.add', params: { id, mode: 'selection' } })).toThrow(/selection/);
    e.execute({ type: 'selection.rect', params: { x: 10, y: 10, w: 20, h: 20 } });
    e.execute({ type: 'mask.add', params: { id, mode: 'selection' } });
    const m = getLayer(doc, id).mask!.tiles;
    expect(m.getPixel(10, 10)[0]).toBe(255); expect(m.getPixel(9, 10)[0]).toBe(0); expect(m.getPixel(29, 29)[0]).toBe(255); expect(m.getPixel(30, 30)[0]).toBe(0);
  });

  it('transforms: flipH twice and rot90 ×4 are identity; mask follows; scale changes size', () => {
    const { doc, e } = setup();
    const id = e.execute({ type: 'layer.add', params: {} }).layerId!;
    e.execute(stroke(id, [[100, 100], [220, 150]], { brush: { size: 9, color: [0, 0, 255] } }));
    const base = (getLayer(doc, id) as RasterLayer).pixels;
    const ref = new Map([...base.tiles].map(([k, v]) => [k, v.slice()]));
    const same = () => {
      const p = (getLayer(doc, id) as RasterLayer).pixels;
      expect([...p.tiles.keys()].sort()).toEqual([...ref.keys()].sort());
      for (const [k, v] of ref) expect(p.tiles.get(k)).toEqual(v);
    };
    e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'flipH' } });
    expect((getLayer(doc, id) as RasterLayer).pixels.getPixel(100, 100)[3]).toBeLessThan(255); // moved
    e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'flipH' } });
    same();
    for (let i = 0; i < 4; i++) e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'rot90cw' } });
    same();
    for (let i = 0; i < 2; i++) e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'rot180' } });
    same();
    e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'rot90cw' } });
    e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'rot90ccw' } });
    same();
    const b0 = (getLayer(doc, id) as RasterLayer).pixels.contentBounds()!;
    e.execute({ type: 'transform.apply', params: { layerId: id, kind: 'scale', sx: 2, sy: 1 } });
    const b1 = (getLayer(doc, id) as RasterLayer).pixels.contentBounds()!;
    expect(Math.abs(b1.w - 2 * b0.w)).toBeLessThanOrEqual(2);
    expect(b1.h).toBeLessThanOrEqual(b0.h + 1);
    e.undo(); same();
  });

  it('group, duplicate, reorder, delete are undoable and keep ids stable', () => {
    const { doc, e } = setup();
    const a = e.execute({ type: 'layer.add', params: { name: 'A' } }).layerId!;
    const b = e.execute({ type: 'layer.add', params: { name: 'B' } }).layerId!;
    const s = snapshot(doc);
    const g = e.execute({ type: 'layer.group', params: { id: a } }).layerId!;
    expect(findLayer(doc, a)!.parent!.id).toBe(g);
    e.execute({ type: 'layer.move', params: { id: b, parentId: g, index: 1 } });
    expect(findLayer(doc, b)!.parent!.id).toBe(g);
    expect(() => e.execute({ type: 'layer.move', params: { id: g, parentId: g, index: 0 } })).toThrow();
    e.execute({ type: 'layer.delete', params: { id: g } });
    expect(findLayer(doc, a)).toBeNull();
    e.undo(); e.undo(); e.undo();
    expect(snapshot(doc)).toBe(s);
    e.redo(); e.redo(); e.redo();
    expect(findLayer(doc, a)).toBeNull();
  });

  it('text layers: create, update (name follows text), rasterize via service, undo restores editable text', () => {
    const { doc, e } = setup();
    const t = e.execute({ type: 'text.create', params: { x: 10, y: 10, data: { text: 'Hello', fontFamily: 'Georgia' } } }).layerId!;
    expect(getLayer(doc, t).name).toBe('Hello');
    e.execute({ type: 'text.update', params: { id: t, patch: { text: 'World', boxWidth: 200 } } });
    const l = getLayer(doc, t);
    expect(l.kind === 'text' && l.text.text).toBe('World');
    expect(l.kind === 'text' && l.text.boxWidth).toBe(200);
    expect(l.name).toBe('World');
    expect(l.kind === 'text' && l.text.fontFamily).toBe('Georgia');
    expect(() => e.execute({ type: 'text.rasterize', params: { id: t } })).toThrow(/rasterizer/);
    const before = snapshot(doc);
    e.services.rasterizeText = () => new TileStore('RGBA8');
    e.execute({ type: 'text.rasterize', params: { id: t } });
    expect(getLayer(doc, t).kind).toBe('raster');
    e.undo();
    expect(snapshot(doc)).toBe(before);
    expect(getLayer(doc, t).kind).toBe('text');
  });

  it('emits dirty rects for tile edits and "all" for structural edits', () => {
    const { doc, e } = setup();
    const events: any[] = [];
    e.subscribe(ev => events.push(ev));
    e.execute(stroke(doc.layers[0].id, [[300, 300]]));
    expect(events[0].dirty.all).toBe(false);
    expect(events[0].dirty.rects.length).toBeGreaterThan(0);
    e.execute({ type: 'layer.add', params: {} });
    expect(events[1].dirty.all).toBe(true);
    e.undo();
    expect(events[2].kind).toBe('undo');
  });
});
void ({} as TileChanges);
