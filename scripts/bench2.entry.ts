import { createDocument, SequentialIdSource, flattenDocument, renderPreview } from '@ps/document';
import { Engine, createDefaultRegistry } from '@ps/commands';
import { writePstudio, readPstudio } from '@ps/codecs';
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
const t = <T,>(name: string, fn: () => T): T => { const s = performance.now(); const r = fn(); console.log(`${name}: ${(performance.now() - s).toFixed(0)} ms  (rss ${mb()} MB)`); return r; };
console.log(`baseline rss ${mb()} MB`);
for (const [w, h] of [[4000, 3000], [8000, 6000]]) {
  console.log(`--- ${w}×${h} (${(w * h / 1e6).toFixed(0)} Mpx), white background layer`);
  const src = new SequentialIdSource();
  const doc = t('create + fill', () => createDocument(src, { width: w, height: h, background: 'white' }));
  const e = new Engine(doc, { ids: src, registry: createDefaultRegistry() });
  const id = doc.layers[0].id;
  t('1 brush stroke 100px over 2000px (command)', () => e.execute({ type: 'paint.stroke', params: { layerId: id, plane: 'pixels', mode: 'paint', brush: { size: 100, color: [255, 0, 0] }, points: [[100, 100], [2100, 400]] } }));
  t('undo', () => e.undo());
  t('flatten', () => flattenDocument(doc));
  t('preview 256', () => renderPreview(doc, 256));
  const bytes = t('serialize .pstudio', () => writePstudio(doc));
  console.log(`file size ${(bytes.length / 1048576).toFixed(1)} MB`);
  t('parse .pstudio', () => readPstudio(bytes));
}
