import { describe, expect, it } from 'vitest';
import { TILE_SIZE, TileStore, TileWriter, fillRect } from '@ps/raster';

describe('TileStore', () => {
  it('is sparse: no tiles until written, reads give zeros', () => {
    const s = new TileStore('RGBA8');
    expect(s.tileCount).toBe(0);
    expect([...s.getPixel(10, 10)]).toEqual([0, 0, 0, 0]);
    expect(s.readRegion(-5, -5, 10, 10).every(v => v === 0)).toBe(true);
    expect(s.tileCount).toBe(0);
  });

  it('writes across tile boundaries and negative coordinates', () => {
    const s = new TileStore('RGBA8');
    const w = new TileWriter(s);
    fillRect(w, { x: TILE_SIZE - 2, y: -3, w: 5, h: 6 }, [10, 20, 30, 255]);
    const d = w.finish();
    // touches tiles (0,-1),(1,-1),(0,0),(1,0)
    expect(s.tileCount).toBe(4);
    expect(d.before.size).toBe(4);
    expect([...s.getPixel(TILE_SIZE - 2, -3)]).toEqual([10, 20, 30, 255]);
    expect([...s.getPixel(TILE_SIZE + 2, 2)]).toEqual([10, 20, 30, 255]);
    expect([...s.getPixel(TILE_SIZE + 3, 2)]).toEqual([0, 0, 0, 0]);
    expect([...s.getPixel(TILE_SIZE - 3, 0)]).toEqual([0, 0, 0, 0]);
    expect(s.contentBounds()).toEqual({ x: TILE_SIZE - 2, y: -3, w: 5, h: 6 });
  });

  it('readRegion matches getPixel everywhere in a window spanning 4 tiles', () => {
    const s = new TileStore('RGBA8');
    const w = new TileWriter(s);
    for (let i = 0; i < 40; i++) fillRect(w, { x: 200 + i * 3, y: 250 + i, w: 2, h: 2 }, [i * 5 % 256, 7, 9, 255]);
    w.finish();
    const r = s.readRegion(190, 240, 140, 80);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 140; x++) {
      const px = s.getPixel(190 + x, 240 + y);
      const i = (y * 140 + x) * 4;
      expect([r[i], r[i + 1], r[i + 2], r[i + 3]]).toEqual([...px]);
    }
  });

  it('copy-on-write: original tile arrays are never mutated; unchanged tiles are not recorded', () => {
    const s = new TileStore('RGBA8');
    let w = new TileWriter(s);
    fillRect(w, { x: 0, y: 0, w: 4, h: 4 }, [1, 2, 3, 255]);
    w.finish();
    const orig = s.get(0, 0)!;
    const copy = orig.slice();
    w = new TileWriter(s);
    fillRect(w, { x: 0, y: 0, w: 4, h: 4 }, [200, 2, 3, 255]);
    const d = w.finish();
    expect(orig).toEqual(copy); // untouched
    expect(d.before.get('0,0')).toBe(orig);
    expect(s.get(0, 0)).not.toBe(orig);
    // no-op rewrite is dropped from diff and keeps original reference
    w = new TileWriter(s);
    const cur = s.get(0, 0)!;
    fillRect(w, { x: 0, y: 0, w: 4, h: 4 }, [200, 2, 3, 255]);
    const d2 = w.finish();
    expect(d2.before.size).toBe(0);
    expect(s.get(0, 0)).toBe(cur);
  });

  it('drops tiles that become fully transparent (sparse allocation stays honest)', () => {
    const s = new TileStore('RGBA8');
    const w = new TileWriter(s);
    w.tile(3, 3); // touched but never written
    w.finish();
    expect(s.tileCount).toBe(0);
  });

  it('applyChanges returns an exact inverse', () => {
    const s = new TileStore('A8');
    const t = new Uint8Array(TILE_SIZE * TILE_SIZE).fill(7);
    const inv = s.applyChanges(new Map([['1,2', t]]));
    expect(s.get(1, 2)).toBe(t);
    const inv2 = s.applyChanges(inv);
    expect(s.tileCount).toBe(0);
    expect(inv2.get('1,2')).toBe(t);
    expect(() => s.applyChanges(new Map([['0,0', new Uint8Array(3)]]))).toThrow(/expected/);
  });

  it('A8 store with fill 255 reads 255 for absent tiles and stays sparse', () => {
    const s = new TileStore('A8', 255);
    expect(s.getPixel(5000, -5000)[0]).toBe(255);
    expect(s.readRegion(0, 0, 4, 4).every(v => v === 255)).toBe(true);
    const w = new TileWriter(s);
    fillRect(w, { x: 0, y: 0, w: 2, h: 2 }, [0, 0, 0, 255]); // paint 0 (hide)
    w.finish();
    expect(s.tileCount).toBe(1);
    expect(s.getPixel(0, 0)[0]).toBe(0);
    expect(s.getPixel(2, 2)[0]).toBe(255);
    const w2 = new TileWriter(s);
    fillRect(w2, { x: 0, y: 0, w: 2, h: 2 }, [255, 255, 255, 255]);
    w2.finish();
    expect(s.tileCount).toBe(0); // back to fill → tile dropped
  });
});
