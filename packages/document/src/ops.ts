import { isBlendMode, type TileChanges, type BlendMode } from '@ps/raster';
import { findLayer, walkLayers, containsLayer, countLayers, groupDepth } from './tree';
import {
  MAX_GROUP_DEPTH, MAX_LAYERS, type Guide, type Layer, type Lock, type MaskState, type PsDocument, type Selection, type TextData,
} from './types';

/**
 * Patch operations: the ONLY way document state changes after creation.
 * applyOp mutates the document and returns the exact inverse operation.
 */
export interface LayerProps {
  name?: string; visible?: boolean; lock?: Lock; opacity?: number; blendMode?: BlendMode;
  offset?: { x: number; y: number }; text?: TextData; mask?: MaskState | null; expanded?: boolean;
}
export interface DocProps { name?: string; selection?: Selection | null; guides?: Guide[]; blendSpace?: 'srgb' | 'linear' }

export type Op =
  | { op: 'layer.insert'; parentId: string | null; index: number; layer: Layer }
  | { op: 'layer.remove'; id: string }
  | { op: 'layer.replace'; id: string; layer: Layer }
  | { op: 'layer.set'; id: string; props: LayerProps }
  | { op: 'layer.move'; id: string; parentId: string | null; index: number }
  | { op: 'tiles.apply'; layerId: string; plane: 'pixels' | 'mask'; changes: TileChanges }
  | { op: 'doc.set'; props: DocProps };

export class OpError extends Error {
  constructor(msg: string) { super(msg); this.name = 'OpError'; }
}

export function validateTextData(t: TextData) {
  if (typeof t.text !== 'string' || t.text.length > 100_000) throw new OpError('text: invalid string');
  if (typeof t.fontFamily !== 'string' || t.fontFamily.length === 0 || t.fontFamily.length > 256) throw new OpError('text: invalid fontFamily');
  const num = (v: unknown, lo: number, hi: number, n: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new OpError(`text: ${n} out of range`);
  };
  num(t.fontSize, 1, 4096, 'fontSize'); num(t.fontWeight, 100, 900, 'fontWeight'); num(t.lineHeight, 0.1, 10, 'lineHeight');
  num(t.tracking, -1000, 1000, 'tracking');
  if (t.boxWidth !== null) num(t.boxWidth, 1, 100_000, 'boxWidth');
  if (!Array.isArray(t.color) || t.color.length !== 4) throw new OpError('text: invalid color');
  for (const c of t.color) num(c, 0, 255, 'color');
  if (!['left', 'center', 'right'].includes(t.align)) throw new OpError('text: invalid align');
  if (typeof t.italic !== 'boolean') throw new OpError('text: invalid italic');
}

function listFor(doc: PsDocument, parentId: string | null): Layer[] {
  if (parentId === null) return doc.layers;
  const p = findLayer(doc, parentId);
  if (!p || p.layer.kind !== 'group') throw new OpError(`parent is not a group: ${parentId}`);
  return p.layer.children;
}

function checkUniqueIds(doc: PsDocument, layer: Layer) {
  const seen = new Set<string>();
  for (const l of walkLayers(doc.layers)) seen.add(l.id);
  for (const l of walkLayers([layer])) {
    if (seen.has(l.id)) throw new OpError(`duplicate layer id: ${l.id}`);
    seen.add(l.id);
  }
}

export function applyOp(doc: PsDocument, op: Op): Op {
  switch (op.op) {
    case 'layer.insert': {
      const list = listFor(doc, op.parentId);
      if (!Number.isInteger(op.index) || op.index < 0 || op.index > list.length) throw new OpError(`insert index out of range: ${op.index}`);
      checkUniqueIds(doc, op.layer);
      if (countLayers(doc) + countLayers({ ...doc, layers: [op.layer] }) > MAX_LAYERS) throw new OpError('too many layers');
      if (op.layer.kind === 'text') validateTextData(op.layer.text);
      list.splice(op.index, 0, op.layer);
      if (groupDepth(doc.layers) > MAX_GROUP_DEPTH) { list.splice(op.index, 1); throw new OpError('group nesting too deep'); }
      return { op: 'layer.remove', id: op.layer.id };
    }
    case 'layer.remove': {
      const loc = findLayer(doc, op.id);
      if (!loc) throw new OpError(`layer not found: ${op.id}`);
      loc.list.splice(loc.index, 1);
      return { op: 'layer.insert', parentId: loc.parent ? loc.parent.id : null, index: loc.index, layer: loc.layer };
    }
    case 'layer.replace': {
      const loc = findLayer(doc, op.id);
      if (!loc) throw new OpError(`layer not found: ${op.id}`);
      if (op.layer.id !== op.id) throw new OpError('replace must keep layer id');
      if (op.layer.kind === 'text') validateTextData(op.layer.text);
      loc.list[loc.index] = op.layer;
      return { op: 'layer.replace', id: op.id, layer: loc.layer };
    }
    case 'layer.set': {
      const loc = findLayer(doc, op.id);
      if (!loc) throw new OpError(`layer not found: ${op.id}`);
      const l = loc.layer as unknown as Record<string, unknown>;
      const p = op.props as Record<string, unknown>;
      const keys = Object.keys(p);
      for (const key of keys) {
        const v = p[key];
        switch (key) {
          case 'name': if (typeof v !== 'string' || v.length > 256) throw new OpError('invalid name'); break;
          case 'visible': case 'expanded': if (typeof v !== 'boolean') throw new OpError(`invalid ${key}`); break;
          case 'opacity': if (typeof v !== 'number' || !(v >= 0 && v <= 1)) throw new OpError('opacity must be 0..1'); break;
          case 'blendMode': if (!isBlendMode(v)) throw new OpError('invalid blend mode'); break;
          case 'lock': {
            const k = v as Lock;
            if (!k || typeof k.pixels !== 'boolean' || typeof k.position !== 'boolean' || typeof k.all !== 'boolean') throw new OpError('invalid lock');
            break;
          }
          case 'offset': {
            const o = v as { x: number; y: number };
            if (!o || !Number.isInteger(o.x) || !Number.isInteger(o.y) || Math.abs(o.x) > 1e6 || Math.abs(o.y) > 1e6) throw new OpError('invalid offset');
            break;
          }
          case 'text': if (loc.layer.kind !== 'text') throw new OpError('text props on non-text layer'); validateTextData(v as TextData); break;
          case 'mask': if (v !== null && (typeof v !== 'object' || (v as MaskState).tiles?.format !== 'A8')) throw new OpError('invalid mask'); break;
          default: throw new OpError(`unknown layer property: ${key}`);
        }
        if (key === 'expanded' && loc.layer.kind !== 'group') throw new OpError('expanded on non-group');
      }
      const inv: Record<string, unknown> = {};
      for (const key of keys) { inv[key] = l[key]; l[key] = p[key]; }
      return { op: 'layer.set', id: op.id, props: inv as LayerProps };
    }
    case 'layer.move': {
      const loc = findLayer(doc, op.id);
      if (!loc) throw new OpError(`layer not found: ${op.id}`);
      if (op.parentId !== null) {
        if (op.parentId === op.id) throw new OpError('cannot move a group into itself');
        if (loc.layer.kind === 'group' && containsLayer(loc.layer, op.parentId)) throw new OpError('cannot move a group into its own descendant');
      }
      const dest = listFor(doc, op.parentId);
      const prev = { parentId: loc.parent ? loc.parent.id : null, index: loc.index };
      loc.list.splice(loc.index, 1);
      if (!Number.isInteger(op.index) || op.index < 0 || op.index > dest.length) {
        loc.list.splice(loc.index, 0, loc.layer);
        throw new OpError(`move index out of range: ${op.index}`);
      }
      dest.splice(op.index, 0, loc.layer);
      if (groupDepth(doc.layers) > MAX_GROUP_DEPTH) {
        dest.splice(op.index, 1); loc.list.splice(loc.index, 0, loc.layer);
        throw new OpError('group nesting too deep');
      }
      return { op: 'layer.move', id: op.id, parentId: prev.parentId, index: prev.index };
    }
    case 'tiles.apply': {
      const loc = findLayer(doc, op.layerId);
      if (!loc) throw new OpError(`layer not found: ${op.layerId}`);
      const l = loc.layer;
      let store;
      if (op.plane === 'pixels') {
        if (l.kind !== 'raster') throw new OpError('pixels plane requires raster layer');
        store = l.pixels;
      } else {
        if (!l.mask) throw new OpError('layer has no mask');
        store = l.mask.tiles;
      }
      const inv = store.applyChanges(op.changes);
      return { op: 'tiles.apply', layerId: op.layerId, plane: op.plane, changes: inv };
    }
    case 'doc.set': {
      const inv: DocProps = {};
      const p = op.props;
      if ('name' in p) { if (typeof p.name !== 'string' || p.name.length > 256) throw new OpError('invalid name'); inv.name = doc.name; doc.name = p.name; }
      if ('selection' in p) {
        const s = p.selection;
        if (s !== null && s !== undefined) {
          if (s.kind !== 'rect' || ![s.x, s.y, s.w, s.h].every(Number.isInteger) || s.w <= 0 || s.h <= 0) throw new OpError('invalid selection');
        }
        inv.selection = doc.selection; doc.selection = s ?? null;
      }
      if ('blendSpace' in p) {
        if (p.blendSpace !== 'srgb' && p.blendSpace !== 'linear') throw new OpError('invalid blendSpace');
        inv.blendSpace = doc.canvas.blendSpace ?? 'srgb'; doc.canvas.blendSpace = p.blendSpace;
      }
      if ('guides' in p) { inv.guides = doc.guides; doc.guides = p.guides ?? []; }
      return { op: 'doc.set', props: inv };
    }
  }
}

/** Approximate memory held only because history references it (tile payloads). */
export function opBytes(op: Op): number {
  if (op.op !== 'tiles.apply') return 64;
  let n = 64;
  for (const v of op.changes.values()) if (v) n += v.length;
  return n;
}
