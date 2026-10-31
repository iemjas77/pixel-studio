import { findLayer } from './tree';
import type { PsDocument } from './types';

/** Doc-space origin of a layer (sum of its own and ancestors' offsets). */
export function absoluteOffset(doc: PsDocument, id: string): { x: number; y: number } {
  const loc = findLayer(doc, id);
  if (!loc) throw new Error(`layer not found: ${id}`);
  let x = loc.layer.offset.x, y = loc.layer.offset.y;
  let p = loc.parent;
  while (p) { x += p.offset.x; y += p.offset.y; p = findLayer(doc, p.id)?.parent ?? null; }
  return { x, y };
}
