import type { GroupLayer, Layer, PsDocument } from './types';

export interface LayerLocation { layer: Layer; parent: GroupLayer | null; list: Layer[]; index: number }

export function findLayer(doc: PsDocument, id: string): LayerLocation | null {
  const walk = (list: Layer[], parent: GroupLayer | null): LayerLocation | null => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return { layer: l, parent, list, index: i };
      if (l.kind === 'group') { const r = walk(l.children, l); if (r) return r; }
    }
    return null;
  };
  return walk(doc.layers, null);
}
export function getLayer(doc: PsDocument, id: string): Layer {
  const r = findLayer(doc, id);
  if (!r) throw new Error(`layer not found: ${id}`);
  return r.layer;
}
export function* walkLayers(list: Layer[]): Generator<Layer> {
  for (const l of list) { yield l; if (l.kind === 'group') yield* walkLayers(l.children); }
}
export function countLayers(doc: PsDocument) { let n = 0; for (const _ of walkLayers(doc.layers)) n++; return n; }
export function containsLayer(group: GroupLayer, id: string): boolean {
  for (const l of walkLayers(group.children)) if (l.id === id) return true;
  return false;
}
export function groupDepth(list: Layer[]): number {
  let d = 0;
  for (const l of list) if (l.kind === 'group') d = Math.max(d, 1 + groupDepth(l.children));
  return d;
}
