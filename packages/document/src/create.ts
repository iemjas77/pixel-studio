import { TileStore, TileWriter, fillRect } from '@ps/raster';
import type { Canvas, Layer, Lock, PsDocument, RasterLayer, TextData, TextLayer, MaskState } from './types';
import { SCHEMA_VERSION } from './types';
import type { IdSource } from './ids';

export const noLock = (): Lock => ({ pixels: false, position: false, all: false });

export function createDocument(ids: IdSource, opts: {
  name?: string; width: number; height: number; resolutionPpi?: number;
  background?: 'transparent' | 'white' | [number, number, number, number];
}): PsDocument {
  const canvas: Canvas = {
    width: opts.width, height: opts.height, resolutionPpi: opts.resolutionPpi ?? 72,
    mode: 'RGB', bitDepth: 8, profile: { name: 'sRGB IEC61966-2.1 (assumed, unmanaged)', assumed: true },
  };
  const doc: PsDocument = {
    schemaVersion: SCHEMA_VERSION, id: ids.next('doc'), name: opts.name ?? 'Untitled', canvas,
    layers: [], selection: null, guides: [],
  };
  const bg = opts.background ?? 'transparent';
  if (bg !== 'transparent') {
    const l = createRasterLayer(ids, 'Background');
    const rgba: [number, number, number, number] = bg === 'white' ? [255, 255, 255, 255] : bg;
    const w = new TileWriter(l.pixels);
    fillRect(w, { x: 0, y: 0, w: opts.width, h: opts.height }, rgba);
    w.finish();
    doc.layers.push(l);
  }
  return doc;
}

function base(ids: IdSource, prefix: string, name: string) {
  return {
    id: ids.next(prefix), name, visible: true, lock: noLock(), opacity: 1,
    blendMode: 'normal' as const, offset: { x: 0, y: 0 }, mask: null as MaskState | null,
  };
}
export function createRasterLayer(ids: IdSource, name: string): RasterLayer {
  return { ...base(ids, 'ly', name), kind: 'raster', pixels: new TileStore('RGBA8') };
}
export const DEFAULT_TEXT: TextData = {
  text: 'Text', fontFamily: 'Arial', fontSize: 48, fontWeight: 400, italic: false,
  color: [0, 0, 0, 255], align: 'left', lineHeight: 1.2, tracking: 0, boxWidth: null,
};
export function createTextLayer(ids: IdSource, name: string, text: TextData, x: number, y: number): TextLayer {
  const b = base(ids, 'ly', name);
  b.offset = { x, y };
  return { ...b, kind: 'text', text: { ...text } };
}
export function createGroupLayer(ids: IdSource, name: string, children: Layer[]): Layer {
  return { ...base(ids, 'ly', name), kind: 'group', children, expanded: true };
}

/** Deep-copy a layer with fresh ids. Tile arrays are shared (copy-on-write makes this safe). */
export function cloneLayer(layer: Layer, ids: IdSource, nameSuffix = ''): Layer {
  const common = {
    ...layer,
    id: ids.next('ly'),
    name: layer.name + nameSuffix,
    lock: { ...layer.lock },
    offset: { ...layer.offset },
    mask: layer.mask ? { ...layer.mask, tiles: layer.mask.tiles.clone() } : null,
    unknown: layer.unknown ? structuredClone(layer.unknown) : undefined,
  };
  switch (layer.kind) {
    case 'raster': return { ...common, kind: 'raster', pixels: layer.pixels.clone() };
    case 'text': return { ...common, kind: 'text', text: { ...layer.text, color: [...layer.text.color] as TextData['color'] } };
    case 'group': return { ...common, kind: 'group', expanded: layer.expanded, children: layer.children.map(c => cloneLayer(c, ids)) };
    case 'opaque': return { ...common, kind: 'opaque', originalKind: layer.originalKind, raw: structuredClone(layer.raw) };
  }
}
