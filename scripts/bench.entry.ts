import { DEFAULT_BRUSH, StrokeSession, TileStore, composeRegion, TileWriter, fillRect } from '@ps/raster';
const t = (name: string, fn: () => void, n = 1) => { const s = performance.now(); for (let i = 0; i < n; i++) fn(); const d = (performance.now() - s) / n; console.log(`${name}: ${d.toFixed(2)} ms`); };
t('stroke 60 pts size 17', () => {
  const s = new TileStore('RGBA8');
  const st = new StrokeSession(s, { ...DEFAULT_BRUSH, size: 17, hardness: 0.4 }, 'paint');
  for (let i = 0; i < 60; i++) st.addPoint(20 + i * 7.3, 40 + Math.sin(i / 3) * 25);
  st.finish();
}, 5);
t('stroke 2000px size 100 hard', () => {
  const s = new TileStore('RGBA8');
  const st = new StrokeSession(s, { ...DEFAULT_BRUSH, size: 100, hardness: 1, spacing: 0.1 }, 'paint');
  for (let i = 0; i < 40; i++) st.addPoint(20 + i * 50, 200);
  st.finish();
}, 3);
const px = new TileStore('RGBA8'); const w = new TileWriter(px); fillRect(w, { x: 0, y: 0, w: 4000, h: 3000 }, [1, 2, 3, 255]); w.finish();
const node = { visible: true, opacity: 0.8, blend: 'multiply' as const, offsetX: 0, offsetY: 0, pixels: px };
t('compose 256x256 x 5 layers multiply', () => composeRegion([node, node, node, node, node], 0, 0, 256, 256), 10);
t('compose 1920x1080 x 3 layers', () => composeRegion([node, node, node], 0, 0, 1920, 1080), 2);
