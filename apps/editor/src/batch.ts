import { writePstudio } from '@ps/codecs';
import { renderPreview } from '@ps/document';
import type { BatchIO, BatchJob, OverwritePolicy } from '@ps/automation';
import { TextCache, rasterizeText } from './text';
import { docFromBytes, exportFlattened, type ExportFormat } from './io';

export type BatchFormat = 'pstudio' | ExportFormat;
export const EXT: Record<BatchFormat, string> = { pstudio: 'pstudio', png: 'png', jpg: 'jpg', webp: 'webp', tif: 'tif', psd: 'psd' };

/** Renderer-side BatchIO: files go through the narrow main-process batch IPC (approved folders only). */
export function makeBatchIO(o: { inDir: string; outDir: string; format: BatchFormat; quality: number; template: string }): BatchIO {
  const texts = new Map<string, TextCache>();
  return {
    async load(job: BatchJob) {
      const bytes = await window.pixelStudio!.batchRead({ dir: o.inDir, name: job.name });
      const { doc, warnings } = await docFromBytes(job.name, bytes);
      const tc = new TextCache(); texts.set(job.id, tc);
      return { doc, warnings, services: { rasterizeText } };
    },
    async save(job, doc, _services, policy: OverwritePolicy) {
      const tc = texts.get(job.id) ?? new TextCache();
      const bytes = o.format === 'pstudio'
        ? writePstudio(doc, { preview: renderPreview(doc, 256, tc.resolver) })
        : await exportFlattened(doc, o.format, o.quality, tc.resolver);
      texts.delete(job.id);
      const stem = job.name.replace(/\.[^.]+$/, '');
      const name = `${o.template.replace(/\{name\}/g, stem)}.${EXT[o.format]}`;
      const r = await window.pixelStudio!.batchWrite({ dir: o.outDir, name, bytes, policy });
      return { output: r.name, skipped: r.skipped };
    },
  };
}
