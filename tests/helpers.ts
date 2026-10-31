import { SequentialIdSource, walkLayers, type Layer, type PsDocument } from '@ps/document';
import type { TileStore } from '@ps/raster';

export const ids = () => new SequentialIdSource();

function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function storeHash(s: TileStore | null | undefined): string {
  if (!s) return '-';
  const keys = [...s.tiles.keys()].sort();
  let h = 2166136261;
  for (const k of keys) { h = fnv(h, new TextEncoder().encode(k)); h = fnv(h, s.tiles.get(k)!); }
  return `${s.format}:${s.fill}:${keys.length}:${h.toString(16)}`;
}
/** Deterministic structural + pixel fingerprint of a document. */
export function snapshot(doc: PsDocument): string {
  const lay = (l: Layer): unknown => {
    const base = { id: l.id, kind: l.kind, name: l.name, v: l.visible, lock: l.lock, o: l.opacity, b: l.blendMode, off: l.offset, unk: l.unknown };
    const mask = l.mask ? { en: l.mask.enabled, lk: l.mask.linked, t: storeHash(l.mask.tiles) } : null;
    switch (l.kind) {
      case 'raster': return { ...base, mask, px: storeHash(l.pixels) };
      case 'text': return { ...base, mask, text: l.text };
      case 'group': return { ...base, mask, ch: l.children.map(lay) };
      case 'opaque': return { ...base, raw: l.raw };
    }
  };
  return JSON.stringify({ name: doc.name, canvas: doc.canvas, sel: doc.selection, guides: doc.guides, unk: doc.unknown, layers: doc.layers.map(lay) });
}
export function allLayers(doc: PsDocument) { return [...walkLayers(doc.layers)]; }
