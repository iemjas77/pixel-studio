import { afterEach, describe, expect, it } from 'vitest';
import { launch, type Launched } from './harness';

let L: Launched | null = null;
afterEach(async () => { if (L) { await L.app.close().catch(() => {}); L = null; } });

/** Runs inside the renderer: builds deterministic noisy scenes, composes on CPU reference and GPU, returns max diffs. */
const GOLDEN = () => {
  const { raster, GpuCompositor } = (window as any).__ps;
  const { TileStore, TileWriter, composeRegion, BLEND_MODES } = raster;
  let seed = 1234567;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = (w: number, h: number, ox: number, oy: number, alphaMode: 'mixed' | 'opaque') => {
    const s = new TileStore('RGBA8'); const wr = new TileWriter(s);
    const d = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = rnd() * 256; d[i * 4 + 1] = rnd() * 256; d[i * 4 + 2] = rnd() * 256;
      const r = rnd();
      d[i * 4 + 3] = alphaMode === 'opaque' ? 255 : r < 0.15 ? 0 : r < 0.3 ? 255 : Math.floor(rnd() * 256);
    }
    s.writeRegion(wr, ox, oy, w, h, d); wr.finish(); return s;
  };
  const mask = (w: number, h: number) => {
    const s = new TileStore('A8', 255); const wr = new TileWriter(s);
    const d = new Uint8Array(w * h); for (let i = 0; i < d.length; i++) d[i] = rnd() < 0.2 ? 0 : Math.floor(rnd() * 256);
    s.writeRegion(wr, 0, 0, w, h, d); wr.finish(); return s;
  };
  const node = (pixels: any, o: any = {}) => ({ visible: true, opacity: 1, blend: 'normal', offsetX: 0, offsetY: 0, pixels, ...o });
  const gpu = new GpuCompositor();
  const W = 300, H = 200; // spans two tile columns when placed at x=200
  const base = noise(W, H, 0, 0, 'opaque'), baseT = noise(W, H, 0, 0, 'mixed');
  const top = noise(W, H, 0, 0, 'mixed'), m = mask(W, H);
  const diff = (a: Uint8Array, b: Uint8Array) => { let mx = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; if (d > 1) n++; } return { max: mx, over1: n }; };
  const results: Record<string, any> = {};
  for (const linear of [false, true]) {
    for (const backdrop of ['opaque', 'translucent']) {
      for (const mode of BLEND_MODES) {
        const nodes = [node(backdrop === 'opaque' ? base : baseT), node(top, { blend: mode, opacity: 0.73, mask: m, maskEnabled: true, offsetX: 7, offsetY: -3 })];
        const a = composeRegion(nodes, 190, 10, 160, 120, { linear });
        const b = gpu.compose(nodes, 190, 10, 160, 120, { linear });
        results[`${linear ? 'lin' : 'srgb'}/${backdrop}/${mode}`] = { ...diff(a, b), backend: gpu.lastBackend };
      }
    }
  }
  // nested group with blend modes + group opacity/mask + hidden layer
  const grp = { visible: true, opacity: 0.6, blend: 'overlay', offsetX: 5, offsetY: 4, children: [node(noise(120, 90, 0, 0, 'mixed'), { blend: 'multiply', opacity: 0.8 }), node(noise(120, 90, 10, 10, 'mixed'), { blend: 'soft-light' }), node(top, { visible: false })], mask: m, maskEnabled: true };
  const nodes = [node(base), node(baseT, { blend: 'screen', opacity: 0.5 }), grp];
  for (const linear of [false, true]) {
    const a = composeRegion(nodes, 0, 0, 200, 150, { linear }), b = gpu.compose(nodes, 0, 0, 200, 150, { linear });
    results[`group/${linear ? 'lin' : 'srgb'}`] = { ...diff(a, b), backend: gpu.lastBackend };
  }
  const leakBefore = gpu.liveResources;
  gpu.dispose();
  return { results, leak: { before: leakBefore, after: gpu.liveResources }, available: gpu.available };
};

describe('M3: GPU compositor vs CPU reference', () => {
  it('agrees within ≤1/255 for all 12 blend modes (sRGB + linear, opaque + translucent backdrops, masks, offsets, groups)', async () => {
    L = await launch();
    const out = await L.page.evaluate(GOLDEN);
    expect(out.available).toBe(true);
    let worst = 0;
    for (const [k, v] of Object.entries(out.results) as [string, any][]) {
      expect(v.backend, k).toBe('gpu');
      worst = Math.max(worst, v.max);
      expect(v.max, `${k} max diff`).toBeLessThanOrEqual(1);
    }
    console.log('M3 golden: scenes =', Object.keys(out.results).length, ' worst per-channel diff =', worst);
    expect(Object.keys(out.results).length).toBe(2 * 2 * 12 + 2);
    // GPU resources: everything allocated is released by dispose()
    expect(out.leak.after).toBe(0);
  }, 180000);

  it('recovers from GPU context loss: falls back to CPU, then returns to GPU after restore; no leaked resources', async () => {
    L = await launch();
    const out = await L.page.evaluate(async () => {
      const { raster, GpuCompositor } = (window as any).__ps;
      const { TileStore, TileWriter, fillRect } = raster;
      const mk = (c: number[]) => { const s = new TileStore('RGBA8'); const w = new TileWriter(s); fillRect(w, { x: 0, y: 0, w: 32, h: 32 }, c); w.finish(); return s; };
      const nodes = [{ visible: true, opacity: 1, blend: 'normal', offsetX: 0, offsetY: 0, pixels: mk([10, 200, 30, 255]) }, { visible: true, opacity: 0.5, blend: 'multiply', offsetX: 0, offsetY: 0, pixels: mk([200, 100, 50, 255]) }];
      const g = new GpuCompositor();
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const first = g.compose(nodes, 0, 0, 32, 32); const b1 = g.lastBackend;
      g.debugLoseContext(); await sleep(200);
      const during = g.compose(nodes, 0, 0, 32, 32); const b2 = g.lastBackend; const losses = g.contextLosses; const availDuring = g.available;
      g.debugRestoreContext(); await sleep(500);
      const after = g.compose(nodes, 0, 0, 32, 32); const b3 = g.lastBackend;
      const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
      g.dispose();
      return { b1, b2, b3, losses, availDuring, sameDuring: same(first, during), sameAfter: same(first, after), live: g.liveResources };
    });
    expect(out.b1).toBe('gpu');
    expect(out.losses).toBe(1);
    expect(out.availDuring).toBe(false);
    expect(out.b2).toBe('cpu');
    expect(out.sameDuring).toBe(true);
    expect(out.b3).toBe('gpu');
    expect(out.sameAfter).toBe(true);
    expect(out.live).toBe(0);
  }, 120000);

  it('the app composites with the GPU backend, honours the CPU-only switch, and the blend-space command is undoable and saved', async () => {
    L = await launch();
    const { page } = L;
    const r = await page.evaluate(async () => {
      const st = (window as any).__ps.store;
      st.newDocument({ name: 't', width: 300, height: 200, ppi: 72, background: 'white' });
      st.exec({ type: 'layer.add', params: {} });
      st.exec({ type: 'edit.fill', params: { layerId: st.active.activeLayerId, plane: 'pixels', color: [128, 128, 128, 255], region: 'layer' } });
      st.exec({ type: 'layer.set', params: { id: st.active.activeLayerId, props: { blendMode: 'multiply' } } });
      const gpuPx = st.active.cache.sample(10, 10);
      const tile = st.active.cache.getTile(0, 0); // forces GPU compose of the visible tile
      const backend = st.gpu.lastBackend;
      st.setGpuMode('cpu');
      const cpuPx = st.active.cache.sample(10, 10);
      st.setGpuMode('auto');
      st.exec({ type: 'doc.blendSpace', params: { space: 'linear' } });
      const linPx = st.active.cache.sample(10, 10);
      const space = st.active.doc.canvas.blendSpace;
      st.undo();
      return { gpuPx, cpuPx, linPx, backend, space, undone: st.active.doc.canvas.blendSpace ?? 'srgb', tile: !!tile };
    });
    expect(r.backend).toBe('gpu');
    expect(r.gpuPx).toEqual(r.cpuPx);
    expect(r.gpuPx.slice(0, 3)).toEqual([128, 128, 128]); // grey × white (multiply) = grey, in sRGB blend space
    expect(r.space).toBe('linear');
    expect(r.undone).toBe('srgb');
    expect(L.errors).toEqual([]);
  }, 120000);
});
