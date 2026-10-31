import { describe, expect, it } from 'vitest';
import { DEFAULT_BRUSH, StrokeSession, TILE_SIZE, TileStore, type BrushParams } from '@ps/raster';

const brush = (o: Partial<BrushParams> = {}): BrushParams => ({ ...DEFAULT_BRUSH, size: 10, hardness: 1, color: [255, 0, 0], ...o });
const alpha = (s: TileStore, x: number, y: number) => s.getPixel(x, y)[3];

describe('StrokeSession', () => {
  it('single click makes one dab, centred', () => {
    const s = new TileStore('RGBA8');
    const st = new StrokeSession(s, brush(), 'paint');
    st.addPoint(50.5, 50.5); st.finish();
    expect(alpha(s, 50, 50)).toBe(255);
    expect([...s.getPixel(50, 50)]).toEqual([255, 0, 0, 255]);
    expect(alpha(s, 60, 50)).toBe(0);
  });

  it('interpolates: a fast horizontal drag leaves no gaps', () => {
    const s = new TileStore('RGBA8');
    const st = new StrokeSession(s, brush({ size: 6, spacing: 0.25 }), 'paint');
    st.addPoint(10, 20); st.addPoint(400, 20); st.finish(); // 390px jump in one event
    for (let x = 10; x <= 400; x++) expect(alpha(s, x, 20), `x=${x}`).toBe(255);
  });

  it('crosses tile boundaries seamlessly', () => {
    const s = new TileStore('RGBA8');
    const st = new StrokeSession(s, brush({ size: 8 }), 'paint');
    st.addPoint(TILE_SIZE - 20, TILE_SIZE - 20); st.addPoint(TILE_SIZE + 20, TILE_SIZE + 20); st.finish();
    expect(s.tileCount).toBe(4);
    for (let i = -15; i <= 15; i++) expect(alpha(s, TILE_SIZE + i, TILE_SIZE + i)).toBe(255);
  });

  it('stroke-wide opacity cap: overlapping dabs never exceed opacity', () => {
    const s = new TileStore('RGBA8');
    const st = new StrokeSession(s, brush({ size: 20, opacity: 0.5, spacing: 0.05 }), 'paint');
    st.addPoint(30, 30); st.addPoint(60, 30); st.addPoint(30, 30); st.addPoint(60, 30); st.finish();
    let max = 0;
    for (let x = 20; x < 70; x++) max = Math.max(max, alpha(s, x, 30));
    expect(max).toBe(128); // 0.5 * 255 rounded
  });

  it('low flow builds up within a stroke but stays under opacity', () => {
    const s = new TileStore('RGBA8');
    const st = new StrokeSession(s, brush({ size: 20, flow: 0.2, opacity: 1, spacing: 0.1 }), 'paint');
    st.addPoint(30, 30); const a1 = alpha(s, 30, 30);
    st.addPoint(80, 30); st.finish();
    expect(a1).toBe(51);
    expect(alpha(s, 55, 30)).toBeGreaterThan(a1);
    expect(alpha(s, 55, 30)).toBeLessThanOrEqual(255);
  });

  it('is clipped by selection coverage (doc space, with layer offset)', () => {
    const s = new TileStore('RGBA8');
    // layer is offset by (100,0); selection in doc space x∈[110,120)
    const clip = (x: number, y: number) => (x >= 110 && x < 120 && y >= 0 && y < 100 ? 1 : 0);
    const st = new StrokeSession(s, brush({ size: 40 }), 'paint', clip, { x: 100, y: 0 });
    st.addPoint(15, 20); st.finish();
    expect(alpha(s, 9, 20)).toBe(0);   // doc 109
    expect(alpha(s, 10, 20)).toBe(255); // doc 110
    expect(alpha(s, 19, 20)).toBe(255); // doc 119
    expect(alpha(s, 20, 20)).toBe(0);   // doc 120
  });

  it('eraser reduces alpha and removes tiles that become empty', () => {
    const s = new TileStore('RGBA8');
    let st = new StrokeSession(s, brush({ size: 10 }), 'paint');
    st.addPoint(20, 20); st.finish();
    st = new StrokeSession(s, brush({ size: 30 }), 'erase');
    st.addPoint(20, 20); st.finish();
    expect(s.tileCount).toBe(0);
  });

  it('soft brush has falloff; hard brush has crisp edge', () => {
    const soft = new TileStore('RGBA8'), hard = new TileStore('RGBA8');
    let st = new StrokeSession(soft, brush({ size: 40, hardness: 0 }), 'paint'); st.addPoint(50, 50); st.finish();
    st = new StrokeSession(hard, brush({ size: 40, hardness: 1 }), 'paint'); st.addPoint(50, 50); st.finish();
    expect(alpha(soft, 50, 50)).toBeGreaterThan(alpha(soft, 60, 50));
    expect(alpha(soft, 60, 50)).toBeGreaterThan(alpha(soft, 68, 50));
    expect(alpha(hard, 60, 50)).toBe(255);
  });

  it('paints on A8 mask: paint→luma, erase→0; respects fill', () => {
    const m = new TileStore('A8', 255);
    let st = new StrokeSession(m, brush({ size: 10, color: [0, 0, 0] }), 'paint');
    st.addPoint(20, 20); st.finish();
    expect(m.getPixel(20, 20)[0]).toBe(0);
    expect(m.getPixel(200, 200)[0]).toBe(255);
    st = new StrokeSession(m, brush({ size: 14, color: [255, 255, 255] }), 'paint');
    st.addPoint(20, 20); st.finish();
    expect(m.getPixel(20, 20)[0]).toBe(255);
    expect(m.tileCount).toBe(0);
  });

  it('is deterministic: identical input → byte-identical output', () => {
    const run = () => {
      const s = new TileStore('RGBA8');
      const st = new StrokeSession(s, brush({ size: 17.3, hardness: 0.4, opacity: 0.7, flow: 0.6, spacing: 0.13, pressureSize: true }), 'paint');
      for (let i = 0; i < 60; i++) st.addPoint(20 + i * 7.3, 40 + Math.sin(i / 3) * 25, 0.3 + (i % 7) / 10);
      st.finish();
      return s;
    };
    const a = run(), b = run();
    expect([...a.tiles.keys()].sort()).toEqual([...b.tiles.keys()].sort());
    for (const [k, v] of a.tiles) expect(v).toEqual(b.tiles.get(k));
  });

  it('cancel restores the store exactly', () => {
    const s = new TileStore('RGBA8');
    const st0 = new StrokeSession(s, brush(), 'paint'); st0.addPoint(5, 5); st0.finish();
    const ref = new Map([...s.tiles].map(([k, v]) => [k, v.slice()]));
    const st = new StrokeSession(s, brush({ size: 50 }), 'paint');
    st.addPoint(5, 5); st.addPoint(300, 300); st.cancel();
    expect([...s.tiles.keys()].sort()).toEqual([...ref.keys()].sort());
    for (const [k, v] of ref) expect(s.tiles.get(k)).toEqual(v);
  });
});
