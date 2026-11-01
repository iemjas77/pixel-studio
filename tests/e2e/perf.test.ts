import { afterEach, describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ART, launch, type Launched } from './harness';

let L: Launched | null = null;
afterEach(async () => { if (L) { await L.app.close().catch(() => {}); L = null; } });

/** Records in-app measurements (software GL under Xvfb: NOT representative of a hardware GPU). Writes e2e-artifacts/perf.json. */
describe('M5: in-app performance record', () => {
  it('measures document creation, first paint of the visible tiles, brush event cost and memory', async () => {
    L = await launch();
    const res = await L.page.evaluate(async () => {
      const { store, raster } = (window as any).__ps;
      const out: Record<string, any> = { gpuAvailable: !!store.gpu };
      const mem = () => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576);
      for (const [w, h] of [[2000, 1500], [4000, 3000], [8000, 6000]]) {
        const key = `${w}x${h}`;
        const r: Record<string, number> = {};
        let t = performance.now();
        store.newDocument({ name: key, width: w, height: h, ppi: 72, background: 'white' });
        r.createMs = Math.round(performance.now() - t);
        store.exec({ type: 'layer.add', params: {} });
        const s = store.active;
        // visible region at fit zoom: ~1400x800 css px → tiles covering 1400/z x 800/z doc px
        for (const mode of ['gpu', 'cpu']) {
          store.setGpuMode(mode === 'gpu' ? 'auto' : 'cpu');
          s.cache.invalidateAll();
          const z = Math.min(1400 / w, 800 / h);
          const tilesX = Math.min(Math.ceil(w / 256), Math.ceil(1400 / z / 256)), tilesY = Math.min(Math.ceil(h / 256), Math.ceil(800 / z / 256));
          t = performance.now();
          for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) s.cache.getTile(tx, ty);
          r[`firstPaint_${mode}_ms`] = Math.round(performance.now() - t);
          r[`tiles`] = tilesX * tilesY;
        }
        store.setGpuMode('auto');
        // brush: 300 pointer events, 40 px soft brush, measuring pure engine cost per event
        const layer = store.activeLayer;
        const sess = new raster.StrokeSession(layer.pixels, { ...raster.DEFAULT_BRUSH, size: 40, hardness: 0.5, color: [255, 0, 0] }, 'paint');
        const times: number[] = [];
        for (let i = 0; i < 300; i++) { const t0 = performance.now(); sess.addPoint(100 + i * 5, 200 + Math.sin(i / 10) * 80, 1); times.push(performance.now() - t0); }
        sess.cancel();
        times.sort((a, b) => a - b);
        r.brushEvent_p50_ms = +times[150].toFixed(2); r.brushEvent_p95_ms = +times[285].toFixed(2); r.brushEvent_max_ms = +times[299].toFixed(2);
        // flatten for export
        t = performance.now();
        r.jsHeapMB = mem();
        out[key] = r;
        store.closeSession(store.activeIndex);
      }
      return out;
    });
    fs.writeFileSync(path.join(ART, 'perf.json'), JSON.stringify(res, null, 2));
    console.log('PERF', JSON.stringify(res));
  }, 300000);
});
