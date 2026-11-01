import {
  TileStore, TileWriter, StrokeSession, DEFAULT_BRUSH, BLEND_MODES, fillRect, clearRect, applyMaskToPixels,
  mapPixels, invert, desaturate, brightnessContrast, levels, curves, hueSaturation, addNoise, convolveFilter, gradientFill, MAX_TRANSFORM_PIXELS,
  transformStore, exactTransform, scaleAbout, replaceStoreContent, type Clip, type TileDiff, type BrushParams,
} from '@ps/raster';
import {
  absoluteOffset, cloneLayer, createGroupLayer, createRasterLayer, createTextLayer, DEFAULT_TEXT, findLayer, getLayer,
  type Layer, type MaskState, type PsDocument, type Selection, type TextData, type RasterLayer,
} from '@ps/document';
import { CommandError, CommandRegistry, type CommandDef, type HandlerContext } from './engine';
import { S } from './schema';

// ---------- helpers ----------
const blocked = (m: string) => new CommandError('blocked', m);
const color3 = S.arr(S.int(0, 255), 3, 3);
const color4 = S.arr(S.int(0, 255), 4, 4);
const layerId = S.str(64, { min: 1 });

function selectionClip(sel: Selection | null): Clip | null {
  if (!sel) return null;
  const { x, y, w, h } = sel;
  return (px, py) => (px >= x && px < x + w && py >= y && py < y + h ? 1 : 0);
}
function requireLayer(doc: PsDocument, id: string): Layer {
  const l = findLayer(doc, id)?.layer;
  if (!l) throw blocked(`Layer not found: ${id}`);
  return l;
}
function ensureEditablePixels(doc: PsDocument, id: string, plane: 'pixels' | 'mask' = 'pixels') {
  const l = requireLayer(doc, id);
  if (l.lock.all || l.lock.pixels) throw blocked(`“${l.name}” is locked.`);
  if (!l.visible) throw blocked(`“${l.name}” is hidden. Show the layer to edit it.`);
  if (plane === 'mask') {
    if (!l.mask) throw blocked(`“${l.name}” has no layer mask.`);
  } else if (l.kind === 'text') {
    throw blocked('This is an editable text layer. Rasterize it first (Layer ▸ Rasterize Text) to paint on it.');
  } else if (l.kind !== 'raster') throw blocked(`Cannot edit pixels of a ${l.kind} layer.`);
  return l;
}
function storeOf(l: Layer, plane: 'pixels' | 'mask'): TileStore {
  if (plane === 'mask') return l.mask!.tiles;
  return (l as RasterLayer).pixels;
}
/** Apply a TileDiff to the real layer store via tx (scratch store was used for computation). */
function commitDiff(ctx: HandlerContext, id: string, plane: 'pixels' | 'mask', diff: TileDiff) {
  if (diff.after.size === 0) return;
  ctx.tx.apply({ op: 'tiles.apply', layerId: id, plane, changes: diff.after });
}
const planeSchema = S.enum(['pixels', 'mask']);
const brushSchema = S.obj({
  size: S.num(0.5, 2048), hardness: S.opt(S.num(0, 1)), opacity: S.opt(S.num(0, 1)), flow: S.opt(S.num(0, 1)),
  spacing: S.opt(S.num(0.01, 2)), color: S.opt(color3), pressureSize: S.opt(S.bool()), pressureOpacity: S.opt(S.bool()),
});
export function fullBrush(b: Partial<BrushParams> & { size: number }): BrushParams {
  return { ...DEFAULT_BRUSH, ...b } as BrushParams;
}

const fixName = (t: string) => (t.replace(/\s+/g, ' ').trim().slice(0, 24) || 'Text');

// ---------- definitions ----------
const defs: CommandDef[] = [];
const def = <P>(d: CommandDef & { execute(ctx: HandlerContext, p: P): void }) => { defs.push(d as CommandDef); };

def<{ name?: string; parentId?: string | null; index?: number }>({
  type: 'layer.add', version: 1, label: () => 'New Layer',
  schema: S.obj({ name: S.opt(S.str(256)), parentId: S.opt({ t: 'str', max: 64 }), index: S.opt(S.int(0, 100000)) }),
  execute(ctx, p) {
    const n = ctx.doc.layers.length;
    const layer = createRasterLayer(ctx.ids, p.name ?? `Layer ${n + 1}`);
    const list = p.parentId ? (getLayer(ctx.doc, p.parentId) as any).children as Layer[] : ctx.doc.layers;
    if (!list) throw blocked('Parent is not a group.');
    ctx.tx.apply({ op: 'layer.insert', parentId: p.parentId ?? null, index: Math.min(p.index ?? list.length, list.length), layer });
    ctx.result.layerId = layer.id;
  },
});

def<{ id: string }>({
  type: 'layer.delete', version: 1, label: (_p, d) => 'Delete Layer', schema: S.obj({ id: layerId }),
  check(doc, p) { const l = requireLayer(doc, p.id); if (l.lock.all) throw blocked(`“${l.name}” is locked.`); },
  execute(ctx, p) { ctx.tx.apply({ op: 'layer.remove', id: p.id }); },
});

def<{ id: string }>({
  type: 'layer.duplicate', version: 1, label: () => 'Duplicate Layer', schema: S.obj({ id: layerId }),
  check(doc, p) { requireLayer(doc, p.id); },
  execute(ctx, p) {
    const loc = findLayer(ctx.doc, p.id)!;
    const copy = cloneLayer(loc.layer, ctx.ids, ' copy');
    ctx.tx.apply({ op: 'layer.insert', parentId: loc.parent?.id ?? null, index: loc.index + 1, layer: copy });
    ctx.result.layerId = copy.id;
  },
});

def<{ id: string; parentId?: string | null; index: number }>({
  type: 'layer.move', version: 1, label: () => 'Reorder Layer',
  schema: S.obj({ id: layerId, parentId: S.opt({ t: 'str', max: 64 }), index: S.int(0, 100000) }),
  check(doc, p) { const l = requireLayer(doc, p.id); if (l.lock.all) throw blocked(`“${l.name}” is locked.`); },
  execute(ctx, p) {
    const loc = findLayer(ctx.doc, p.id)!;
    const parentId = p.parentId === undefined ? (loc.parent?.id ?? null) : p.parentId;
    ctx.tx.apply({ op: 'layer.move', id: p.id, parentId, index: p.index });
  },
});

def<{ id: string }>({
  type: 'layer.group', version: 1, label: () => 'Group Layer', schema: S.obj({ id: layerId }),
  check(doc, p) { requireLayer(doc, p.id); },
  execute(ctx, p) {
    const loc = findLayer(ctx.doc, p.id)!;
    const g = createGroupLayer(ctx.ids, 'Group', [loc.layer]);
    const parentId = loc.parent?.id ?? null;
    ctx.tx.apply({ op: 'layer.remove', id: p.id });
    ctx.tx.apply({ op: 'layer.insert', parentId, index: loc.index, layer: g });
    ctx.result.layerId = g.id;
  },
});

const lockSchema = S.obj({ pixels: S.bool(), position: S.bool(), all: S.bool() });
def<{ id: string; props: Record<string, any> }>({
  type: 'layer.set', version: 1,
  label: (p) => {
    const k = Object.keys(p.props);
    if (k.length === 1) return ({ name: 'Rename Layer', visible: p.props.visible ? 'Show Layer' : 'Hide Layer', opacity: 'Layer Opacity', blendMode: 'Blend Mode', lock: 'Lock Layer' } as any)[k[0]] ?? 'Layer Properties';
    return 'Layer Properties';
  },
  schema: S.obj({ id: layerId, props: S.obj({
    name: S.opt(S.str(256)), visible: S.opt(S.bool()), opacity: S.opt(S.num(0, 1)), blendMode: S.opt(S.enum(BLEND_MODES)), lock: S.opt(lockSchema),
  }) }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    const onlyLockOrVis = Object.keys(p.props).every(k => k === 'lock' || k === 'visible');
    if (l.lock.all && !onlyLockOrVis) throw blocked(`“${l.name}” is locked.`);
  },
  execute(ctx, p) { ctx.tx.apply({ op: 'layer.set', id: p.id, props: p.props }); },
});

def<{ id: string; dx: number; dy: number }>({
  type: 'layer.offset', version: 1, label: () => 'Move Layer',
  schema: S.obj({ id: layerId, dx: S.int(-1e6, 1e6), dy: S.int(-1e6, 1e6) }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    if (l.lock.all || l.lock.position) throw blocked(`“${l.name}” position is locked.`);
  },
  execute(ctx, p) {
    if (p.dx === 0 && p.dy === 0) return;
    const l = getLayer(ctx.doc, p.id);
    ctx.tx.apply({ op: 'layer.set', id: p.id, props: { offset: { x: l.offset.x + p.dx, y: l.offset.y + p.dy } } });
  },
});

// ----- masks -----
def<{ id: string; mode: 'reveal' | 'hide' | 'selection' }>({
  type: 'mask.add', version: 1, label: () => 'Add Layer Mask',
  schema: S.obj({ id: layerId, mode: S.enum(['reveal', 'hide', 'selection']) }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    if (l.mask) throw blocked(`“${l.name}” already has a mask.`);
    if (l.kind === 'opaque') throw blocked('Cannot add a mask to an unsupported layer.');
    if (p.mode === 'selection' && !doc.selection) throw blocked('Make a selection first.');
  },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.id);
    const mask: MaskState = { tiles: new TileStore('A8', p.mode === 'reveal' ? 255 : 0), enabled: true, linked: true };
    if (p.mode === 'selection') {
      const s = ctx.doc.selection!;
      const o = absoluteOffset(ctx.doc, p.id);
      const w = new TileWriter(mask.tiles);
      fillRect(w, { x: s.x - o.x, y: s.y - o.y, w: s.w, h: s.h }, [255, 255, 255, 255]);
      w.finish();
    }
    void l;
    ctx.tx.apply({ op: 'layer.set', id: p.id, props: { mask } });
  },
});
def<{ id: string }>({
  type: 'mask.delete', version: 1, label: () => 'Delete Layer Mask', schema: S.obj({ id: layerId }),
  check(doc, p) { const l = requireLayer(doc, p.id); if (!l.mask) throw blocked('Layer has no mask.'); },
  execute(ctx, p) { ctx.tx.apply({ op: 'layer.set', id: p.id, props: { mask: null } }); },
});
def<{ id: string; enabled: boolean }>({
  type: 'mask.enable', version: 1, label: (p) => (p.enabled ? 'Enable Layer Mask' : 'Disable Layer Mask'),
  schema: S.obj({ id: layerId, enabled: S.bool() }),
  check(doc, p) { const l = requireLayer(doc, p.id); if (!l.mask) throw blocked('Layer has no mask.'); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.id);
    ctx.tx.apply({ op: 'layer.set', id: p.id, props: { mask: { ...l.mask!, enabled: p.enabled } } });
  },
});
def<{ id: string }>({
  type: 'mask.apply', version: 1, label: () => 'Apply Layer Mask', schema: S.obj({ id: layerId }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    if (!l.mask) throw blocked('Layer has no mask.');
    if (l.kind !== 'raster') throw blocked('Only raster layers can have a mask applied. Rasterize text first.');
    if (l.lock.all || l.lock.pixels) throw blocked(`“${l.name}” is locked.`);
  },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.id) as RasterLayer;
    if (l.mask!.enabled) {
      const scratch = l.pixels.clone();
      const w = new TileWriter(scratch);
      applyMaskToPixels(w, l.mask!.tiles);
      commitDiff(ctx, p.id, 'pixels', w.finish());
    }
    ctx.tx.apply({ op: 'layer.set', id: p.id, props: { mask: null } });
  },
});

// ----- painting -----
def<{ layerId: string; plane: 'pixels' | 'mask'; mode: 'paint' | 'erase'; brush: any; points: number[][] }>({
  type: 'paint.stroke', version: 1, label: (p) => (p.mode === 'erase' ? 'Eraser' : 'Brush Stroke'),
  schema: S.obj({
    layerId, plane: planeSchema, mode: S.enum(['paint', 'erase']), brush: brushSchema,
    points: S.arr(S.arr(S.num(-1e7, 1e7), 3, 2), 500000, 1),
  }),
  check(doc, p) { ensureEditablePixels(doc, p.layerId, p.plane); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId);
    const scratch = storeOf(l, p.plane).clone();
    const off = absoluteOffset(ctx.doc, p.layerId);
    const s = new StrokeSession(scratch, fullBrush(p.brush), p.mode, selectionClip(ctx.doc.selection), off);
    for (const pt of p.points) s.addPoint(pt[0] - off.x, pt[1] - off.y, pt[2] ?? 1);
    commitDiff(ctx, p.layerId, p.plane, s.finish());
  },
});

def<{ layerId: string; plane: 'pixels' | 'mask'; color: number[]; region: 'selection' | 'layer' }>({
  type: 'edit.fill', version: 1, label: () => 'Fill',
  schema: S.obj({ layerId, plane: planeSchema, color: color4, region: S.enum(['selection', 'layer']) }),
  check(doc, p) { ensureEditablePixels(doc, p.layerId, p.plane); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId);
    const off = absoluteOffset(ctx.doc, p.layerId);
    const scratch = storeOf(l, p.plane).clone();
    const w = new TileWriter(scratch);
    const sel = ctx.doc.selection;
    const c = ctx.doc.canvas;
    const docRect = p.region === 'selection' && sel ? sel : { x: 0, y: 0, w: c.width, h: c.height };
    // 'layer' region on pixels: whole canvas rect (layers are unbounded; canvas extent is the natural fill area)
    fillRect(w, { x: docRect.x - off.x, y: docRect.y - off.y, w: docRect.w, h: docRect.h }, p.color as any);
    commitDiff(ctx, p.layerId, p.plane, w.finish());
  },
});

def<{ layerId: string; plane: 'pixels' | 'mask' }>({
  type: 'edit.clear', version: 1, label: () => 'Clear', schema: S.obj({ layerId, plane: planeSchema }),
  check(doc, p) { ensureEditablePixels(doc, p.layerId, p.plane); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId);
    const off = absoluteOffset(ctx.doc, p.layerId);
    const scratch = storeOf(l, p.plane).clone();
    const w = new TileWriter(scratch);
    const sel = ctx.doc.selection;
    const c = ctx.doc.canvas;
    const r = sel ?? { x: -1e5, y: -1e5, w: 2e5 + c.width, h: 2e5 + c.height };
    const b = sel ? { x: r.x - off.x, y: r.y - off.y, w: r.w, h: r.h } : { x: r.x - off.x, y: r.y - off.y, w: r.w, h: r.h };
    clearRect(w, b);
    commitDiff(ctx, p.layerId, p.plane, w.finish());
  },
});

// ----- selection -----
def<{ x: number; y: number; w: number; h: number }>({
  type: 'selection.rect', version: 1, label: () => 'Rectangular Marquee',
  schema: S.obj({ x: S.int(-1e6, 1e6), y: S.int(-1e6, 1e6), w: S.int(1, 1e6), h: S.int(1, 1e6) }),
  execute(ctx, p) {
    // clamp to canvas
    const c = ctx.doc.canvas;
    const x0 = Math.max(0, p.x), y0 = Math.max(0, p.y), x1 = Math.min(c.width, p.x + p.w), y1 = Math.min(c.height, p.y + p.h);
    if (x1 <= x0 || y1 <= y0) throw blocked('Selection is outside the canvas.');
    ctx.tx.apply({ op: 'doc.set', props: { selection: { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 } } });
  },
});
def<Record<string, never>>({
  type: 'selection.all', version: 1, label: () => 'Select All', schema: S.obj({}),
  execute(ctx) { const c = ctx.doc.canvas; ctx.tx.apply({ op: 'doc.set', props: { selection: { kind: 'rect', x: 0, y: 0, w: c.width, h: c.height } } }); },
});
def<Record<string, never>>({
  type: 'selection.clear', version: 1, label: () => 'Deselect', schema: S.obj({}),
  execute(ctx) { if (ctx.doc.selection) ctx.tx.apply({ op: 'doc.set', props: { selection: null } }); },
});

// ----- transforms -----
const TRANSFORMS = ['flipH', 'flipV', 'rot90cw', 'rot90ccw', 'rot180', 'scale'] as const;
def<{ layerId: string; kind: (typeof TRANSFORMS)[number]; sx?: number; sy?: number }>({
  type: 'transform.apply', version: 1,
  label: (p: any) => ({ flipH: 'Flip Horizontal', flipV: 'Flip Vertical', rot90cw: 'Rotate 90° CW', rot90ccw: 'Rotate 90° CCW', rot180: 'Rotate 180°', scale: 'Scale' } as Record<string, string>)[p.kind],
  schema: S.obj({ layerId, kind: S.enum(TRANSFORMS), sx: S.opt(S.num(0.01, 100)), sy: S.opt(S.num(0.01, 100)) }),
  check(doc, p) {
    const l = requireLayer(doc, p.layerId);
    if (l.lock.all || l.lock.pixels || l.lock.position) throw blocked(`“${l.name}” is locked.`);
    if (l.kind !== 'raster') throw blocked(l.kind === 'text' ? 'Text layers cannot be transformed yet. Rasterize the text layer first.' : `Cannot transform a ${l.kind} layer.`);
    if (p.kind === 'scale' && (p.sx === undefined || p.sy === undefined)) throw blocked('Scale needs sx and sy.');
  },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId) as RasterLayer;
    const b = l.pixels.contentBounds();
    if (!b) throw blocked('Layer is empty – nothing to transform.');
    const m = p.kind === 'scale'
      ? scaleAbout(p.sx!, p.sy!, Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2))
      : exactTransform(p.kind, b);
    const interp = p.kind === 'scale' ? 'bilinear' : 'nearest';
    const apply = (store: TileStore, within: typeof b | null) => {
      const next = transformStore(store, m, interp, within);
      const scratch = store.clone();
      return replaceStoreContent(scratch, next);
    };
    const pd = apply(l.pixels, b);
    if (l.mask) {
      const md = apply(l.mask.tiles, null);
      commitDiff(ctx, p.layerId, 'mask', md);
    }
    commitDiff(ctx, p.layerId, 'pixels', pd);
  },
});

// ----- text -----
const textPatch = {
  text: S.opt(S.str(100000)), fontFamily: S.opt(S.str(256, { min: 1 })), fontSize: S.opt(S.num(1, 4096)), fontWeight: S.opt(S.int(100, 900)),
  italic: S.opt(S.bool()), color: S.opt(color4), align: S.opt(S.enum(['left', 'center', 'right'])), lineHeight: S.opt(S.num(0.1, 10)),
  tracking: S.opt(S.num(-1000, 1000)), /** 0 = point text (no box) */ boxWidth: S.opt(S.num(0, 100000)),
};
def<{ name?: string; x: number; y: number; data: Partial<TextData> }>({
  type: 'text.create', version: 1, label: () => 'Type Layer',
  schema: S.obj({ name: S.opt(S.str(256)), x: S.int(-1e6, 1e6), y: S.int(-1e6, 1e6), data: S.obj(textPatch) }),
  execute(ctx, p) {
    const data: TextData = { ...DEFAULT_TEXT, ...p.data, color: (p.data.color ?? DEFAULT_TEXT.color) as TextData['color'], boxWidth: p.data.boxWidth ? p.data.boxWidth : null };
    const layer = createTextLayer(ctx.ids, p.name ?? fixName(data.text), data, p.x, p.y);
    ctx.tx.apply({ op: 'layer.insert', parentId: null, index: ctx.doc.layers.length, layer });
    ctx.result.layerId = layer.id;
  },
});
def<{ id: string; patch: Partial<TextData> }>({
  type: 'text.update', version: 1, label: () => 'Edit Text', schema: S.obj({ id: layerId, patch: S.obj(textPatch) }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    if (l.kind !== 'text') throw blocked('Not a text layer.');
    if (l.lock.all) throw blocked(`“${l.name}” is locked.`);
  },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.id);
    if (l.kind !== 'text') return;
    const next: TextData = { ...l.text, ...(p.patch as Partial<TextData>) } as TextData;
    if (p.patch.boxWidth !== undefined) next.boxWidth = p.patch.boxWidth ? p.patch.boxWidth : null;
    const props: any = { text: next };
    if (p.patch.text !== undefined && l.name === fixName(l.text.text)) props.name = fixName(next.text);
    ctx.tx.apply({ op: 'layer.set', id: p.id, props });
  },
});
def<{ id: string }>({
  type: 'text.rasterize', version: 1, label: () => 'Rasterize Text', schema: S.obj({ id: layerId }),
  check(doc, p) {
    const l = requireLayer(doc, p.id);
    if (l.kind !== 'text') throw blocked('Not a text layer.');
    if (l.lock.all) throw blocked(`“${l.name}” is locked.`);
  },
  execute(ctx, p) {
    if (!ctx.services.rasterizeText) throw new CommandError('failed', 'Text rasterizer unavailable in this environment.');
    const l = getLayer(ctx.doc, p.id);
    if (l.kind !== 'text') return;
    const pixels = ctx.services.rasterizeText(l.text);
    const r: RasterLayer = {
      kind: 'raster', id: l.id, name: l.name, visible: l.visible, lock: { ...l.lock }, opacity: l.opacity, blendMode: l.blendMode,
      offset: { ...l.offset }, mask: l.mask, unknown: l.unknown, pixels,
    };
    ctx.tx.apply({ op: 'layer.replace', id: p.id, layer: r });
  },
});

// ----- adjustments, filters, gradient (destructive, reference engine) -----
const ADJ = ['invert', 'desaturate', 'brightnessContrast', 'levels', 'hueSaturation', 'curves'] as const;
const adjSchema = S.obj({
  layerId, kind: S.enum(ADJ), brightness: S.opt(S.num(-100, 100)), contrast: S.opt(S.num(-100, 100)),
  inBlack: S.opt(S.int(0, 254)), inWhite: S.opt(S.int(1, 255)), gamma: S.opt(S.num(0.1, 10)), outBlack: S.opt(S.int(0, 255)), outWhite: S.opt(S.int(0, 255)),
  hue: S.opt(S.num(-180, 180)), saturation: S.opt(S.num(-100, 100)), lightness: S.opt(S.num(-100, 100)),
  points: S.opt(S.arr(S.arr(S.num(0, 255), 2, 2), 16, 2)),
});
def<any>({
  type: 'adjust.apply', version: 1,
  label: (p: any) => ({ invert: 'Invert', desaturate: 'Desaturate', brightnessContrast: 'Brightness/Contrast', levels: 'Levels', hueSaturation: 'Hue/Saturation', curves: 'Curves' } as Record<string, string>)[p.kind],
  schema: adjSchema,
  check(doc, p) {
    ensureEditablePixels(doc, p.layerId, 'pixels');
    if (p.kind === 'levels' && (p.inBlack ?? 0) >= (p.inWhite ?? 255)) throw blocked('Levels: input black must be below input white.');
    if (p.kind === 'curves') {
      const xs = (p.points ?? [[0, 0], [255, 255]]).map((q: number[]) => q[0]);
      if (xs.some((x: number, i: number) => i > 0 && x <= xs[i - 1])) throw blocked('Curves: point x-values must be strictly increasing.');
    }
  },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId) as RasterLayer;
    const fn = p.kind === 'invert' ? invert : p.kind === 'desaturate' ? desaturate
      : p.kind === 'brightnessContrast' ? brightnessContrast(p.brightness ?? 0, p.contrast ?? 0)
      : p.kind === 'levels' ? levels({ inBlack: p.inBlack ?? 0, inWhite: p.inWhite ?? 255, gamma: p.gamma ?? 1, outBlack: p.outBlack ?? 0, outWhite: p.outWhite ?? 255 })
      : p.kind === 'hueSaturation' ? hueSaturation(p.hue ?? 0, p.saturation ?? 0, p.lightness ?? 0)
      : curves((p.points ?? [[0, 0], [255, 255]]) as [number, number][]);
    const scratch = l.pixels.clone(); const w = new TileWriter(scratch);
    mapPixels(w, fn, selectionClip(ctx.doc.selection), absoluteOffset(ctx.doc, p.layerId));
    commitDiff(ctx, p.layerId, 'pixels', w.finish());
  },
});

def<any>({
  type: 'filter.apply', version: 1,
  label: (p: any) => ({ blur: 'Gaussian Blur', sharpen: 'Sharpen', noise: 'Add Noise' } as Record<string, string>)[p.kind],
  schema: S.obj({ layerId, kind: S.enum(['blur', 'sharpen', 'noise']), radius: S.opt(S.num(0.5, 100)), amount: S.opt(S.num(0, 100)), mono: S.opt(S.bool()), seed: S.opt(S.int(0, 2 ** 31 - 1)) }),
  check(doc, p) { ensureEditablePixels(doc, p.layerId, 'pixels'); if (p.kind === 'sharpen' && (p.amount ?? 1) > 5) throw blocked('Sharpen amount is limited to 5.'); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId) as RasterLayer;
    const scratch = l.pixels.clone(); const w = new TileWriter(scratch);
    const clip = selectionClip(ctx.doc.selection), off = absoluteOffset(ctx.doc, p.layerId);
    if (p.kind === 'noise') mapPixels(w, addNoise(p.amount ?? 10, p.seed ?? 1, p.mono ?? false), clip, off);
    else convolveFilter(w, p.kind, p.radius ?? 2, p.kind === 'sharpen' ? (p.amount ?? 1) : 0, clip, off);
    commitDiff(ctx, p.layerId, 'pixels', w.finish());
  },
});

def<any>({
  type: 'gradient.fill', version: 1, label: () => 'Gradient',
  schema: S.obj({ layerId, plane: planeSchema, kind: S.enum(['linear', 'radial']), from: S.arr(S.num(-1e6, 1e6), 2, 2), to: S.arr(S.num(-1e6, 1e6), 2, 2), c0: color4, c1: color4 }),
  check(doc, p) { ensureEditablePixels(doc, p.layerId, p.plane); },
  execute(ctx, p) {
    const l = getLayer(ctx.doc, p.layerId);
    const off = absoluteOffset(ctx.doc, p.layerId), sel = ctx.doc.selection, c = ctx.doc.canvas;
    const r = sel ?? { x: 0, y: 0, w: c.width, h: c.height };
    const scratch = storeOf(l, p.plane).clone(); const w = new TileWriter(scratch);
    gradientFill(w, { x: r.x - off.x, y: r.y - off.y, w: r.w, h: r.h }, [p.from[0] - off.x, p.from[1] - off.y], [p.to[0] - off.x, p.to[1] - off.y], p.c0, p.c1, p.kind, null, off);
    commitDiff(ctx, p.layerId, p.plane, w.finish());
  },
});

// ----- canvas / image geometry -----
def<{ x: number; y: number; w: number; h: number }>({
  type: 'canvas.crop', version: 1, label: () => 'Crop',
  schema: S.obj({ x: S.int(0, 1e6), y: S.int(0, 1e6), w: S.int(1, 32768), h: S.int(1, 32768) }),
  check(doc, p) { if (p.x + p.w > doc.canvas.width || p.y + p.h > doc.canvas.height) throw blocked('Crop rectangle must lie inside the canvas.'); },
  execute(ctx, p) {
    ctx.tx.apply({ op: 'doc.set', props: { selection: null } });
    ctx.tx.apply({ op: 'doc.set', props: { canvasSize: { width: p.w, height: p.h } } });
    for (const l of [...ctx.doc.layers]) if (p.x || p.y) ctx.tx.apply({ op: 'layer.set', id: l.id, props: { offset: { x: l.offset.x - p.x, y: l.offset.y - p.y } } });
  },
});

def<{ width: number; height: number }>({
  type: 'image.resize', version: 1, label: () => 'Image Size',
  schema: S.obj({ width: S.int(1, 32768), height: S.int(1, 32768) }),
  check(doc, p) { if (p.width * p.height > 100_000_000) throw blocked('Preview build limit: 100 megapixels.'); void doc; },
  execute(ctx, p) {
    const sx = p.width / ctx.doc.canvas.width, sy = p.height / ctx.doc.canvas.height;
    const scaleStore = (layerId: string, plane: 'pixels' | 'mask', store: TileStore) => {
      const next = transformStore(store, scaleAbout(sx, sy, 0, 0), 'bilinear', store.fill === 0 ? undefined : undefined);
      commitDiff(ctx, layerId, plane, replaceStoreContent(store.clone(), next));
    };
    const walk = (layers: Layer[]) => {
      for (const l of layers) {
        if (l.kind === 'opaque') continue;
        const off = { x: Math.round(l.offset.x * sx), y: Math.round(l.offset.y * sy) };
        if (l.kind === 'raster') scaleStore(l.id, 'pixels', l.pixels);
        if (l.mask) scaleStore(l.id, 'mask', l.mask.tiles);
        const props: any = { offset: off };
        if (l.kind === 'text') props.text = { ...l.text, fontSize: Math.max(1, Math.min(4096, l.text.fontSize * (sx + sy) / 2)), tracking: l.text.tracking * sx, boxWidth: l.text.boxWidth ? Math.min(100000, Math.max(1, l.text.boxWidth * sx)) : null };
        ctx.tx.apply({ op: 'layer.set', id: l.id, props });
        if (l.kind === 'group') walk(l.children);
      }
    };
    walk([...ctx.doc.layers]);
    ctx.tx.apply({ op: 'doc.set', props: { selection: null } });
    ctx.tx.apply({ op: 'doc.set', props: { canvasSize: { width: p.width, height: p.height } } });
  },
});

// ----- host pixel import -----
// Pixel payloads are supplied out-of-band by the host (services.takePixels), so this command is
// NOT semantically replayable from params alone and is marked non-recordable for Actions.
def<{ name: string; x: number; y: number }>({
  type: 'layer.placePixels', version: 1, recordable: false, label: (p: any) => `Place ${p.name}`,
  schema: S.obj({ name: S.str(256), x: S.int(-1e6, 1e6), y: S.int(-1e6, 1e6) }),
  execute(ctx, p) {
    const pixels = ctx.services.takePixels?.();
    if (!pixels) throw new CommandError('failed', 'No pixel data supplied by host.');
    const layer = createRasterLayer(ctx.ids, p.name);
    layer.pixels = pixels;
    layer.offset = { x: p.x, y: p.y };
    ctx.tx.apply({ op: 'layer.insert', parentId: null, index: ctx.doc.layers.length, layer });
    ctx.result.layerId = layer.id;
  },
});

// ----- document -----
def<{ name: string }>({
  type: 'doc.rename', version: 1, label: () => 'Rename Document', schema: S.obj({ name: S.str(256, { min: 1 }) }),
  execute(ctx, p) { ctx.tx.apply({ op: 'doc.set', props: { name: p.name } }); },
});

def<{ space: 'srgb' | 'linear' }>({
  type: 'doc.blendSpace', version: 1, label: (p: any) => (p.space === 'linear' ? 'Blend in Linear Light' : 'Blend in sRGB'),
  schema: S.obj({ space: S.enum(['srgb', 'linear']) }),
  execute(ctx, p) { if ((ctx.doc.canvas.blendSpace ?? 'srgb') !== p.space) ctx.tx.apply({ op: 'doc.set', props: { blendSpace: p.space } }); },
});

export function createDefaultRegistry(): CommandRegistry {
  const r = new CommandRegistry();
  for (const d of defs) r.register(d);
  return r;
}
void clearRect; void fixName;
