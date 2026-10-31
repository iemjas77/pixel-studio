import { Inflate, deflateSync } from 'fflate';
import { TILE_SIZE, TileStore, parseTileKey, tileByteLength, type PixelFormat } from '@ps/raster';
import {
  MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, MAX_GROUP_DEPTH, MAX_LAYERS, SCHEMA_VERSION, isBlendModeValue,
  type Layer, type PsDocument, type TextData, type MaskState, type Guide, type Selection, type Lock,
} from './docmodel';
import { crc32 } from './crc32';
import { PsFormatError } from './errors';

export const MAGIC = new Uint8Array([0x50, 0x53, 0x54, 0x55, 0x44, 0x49, 0x4f, 0x00]); // "PSTUDIO\0"
export const FORMAT_MAJOR = 1;
export const FORMAT_MINOR = 0;
const HEADER_SIZE = 28;

export const LIMITS = {
  maxFileBytes: 2 * 1024 ** 3,
  maxManifestBytes: 64 * 1024 * 1024,
  maxTiles: 1_000_000,
  maxTileCoord: 1_000_000,
  maxPreviewSide: 1024,
};

export interface Preview { width: number; height: number; rgba: Uint8Array }
export interface ReadResult { doc: PsDocument; warnings: string[]; preview: Preview | null; formatVersion: { major: number; minor: number } }

// ---------------------------------------------------------------- write
interface TileEntry { layer: string; plane: 'pixels' | 'mask'; tx: number; ty: number; off: number; len: number; crc: number }

const KNOWN_LAYER_KEYS = new Set(['id', 'kind', 'name', 'visible', 'lock', 'opacity', 'blendMode', 'offset', 'mask', 'text', 'children', 'expanded']);
const KNOWN_DOC_KEYS = new Set(['schemaVersion', 'id', 'name', 'canvas', 'layers', 'selection', 'guides']);
const KNOWN_MANIFEST_KEYS = new Set(['format', 'writer', 'document', 'tiles', 'preview']);

export function writePstudio(doc: PsDocument, opts: { preview?: Preview | null; appVersion?: string; compressionLevel?: number } = {}): Uint8Array {
  const blobs: Uint8Array[] = [];
  const tiles: TileEntry[] = [];
  let off = 0;
  const addBlob = (data: Uint8Array) => {
    const comp = deflateSync(data, { level: (opts.compressionLevel ?? 3) as 3 });
    const e = { off, len: comp.length, crc: crc32(comp) };
    blobs.push(comp); off += comp.length;
    return e;
  };
  const emitStore = (layer: string, plane: 'pixels' | 'mask', store: TileStore) => {
    const keys = [...store.tiles.keys()].map(k => [k, ...parseTileKey(k)] as [string, number, number]);
    keys.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    for (const [k, tx, ty] of keys) tiles.push({ layer, plane, tx, ty, ...addBlob(store.tiles.get(k)!) });
  };
  const layerJson = (l: Layer): Record<string, unknown> => {
    if (l.kind === 'opaque') return structuredClone(l.raw);
    const j: Record<string, unknown> = {
      id: l.id, kind: l.kind, name: l.name, visible: l.visible, lock: l.lock, opacity: l.opacity, blendMode: l.blendMode, offset: l.offset,
    };
    if (l.mask) {
      j.mask = { enabled: l.mask.enabled, linked: l.mask.linked, fill: l.mask.tiles.fill };
      emitStore(l.id, 'mask', l.mask.tiles);
    }
    if (l.kind === 'raster') emitStore(l.id, 'pixels', l.pixels);
    if (l.kind === 'text') j.text = l.text;
    if (l.kind === 'group') { j.expanded = l.expanded; j.children = l.children.map(layerJson); }
    if (l.unknown) for (const [k, v] of Object.entries(l.unknown)) if (!(k in j)) j[k] = v;
    return j;
  };
  const document: Record<string, unknown> = {
    schemaVersion: doc.schemaVersion, id: doc.id, name: doc.name, canvas: doc.canvas,
    selection: doc.selection, guides: doc.guides, layers: doc.layers.map(layerJson),
  };
  const extras = doc.unknown ?? {};
  for (const [k, v] of Object.entries(extras)) if (k !== '__manifest' && !(k in document)) document[k] = v;
  let preview: Record<string, unknown> | null = null;
  if (opts.preview) {
    const p = opts.preview;
    preview = { width: p.width, height: p.height, ...addBlob(p.rgba) };
  }
  const manifest: Record<string, unknown> = {
    format: 'pstudio', writer: { app: 'Pixel Studio', version: opts.appVersion ?? '0.1.0-preview.0' },
    document, tiles, preview,
  };
  const mx = (extras as Record<string, unknown>).__manifest as Record<string, unknown> | undefined;
  if (mx) for (const [k, v] of Object.entries(mx)) if (!(k in manifest)) manifest[k] = v;
  const mbytes = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(HEADER_SIZE + mbytes.length + off);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint16(8, FORMAT_MAJOR, true); dv.setUint16(10, FORMAT_MINOR, true);
  dv.setUint32(12, mbytes.length, true); dv.setUint32(16, crc32(mbytes), true); dv.setUint32(20, off, true);
  dv.setUint32(24, crc32(out, 0, 24), true);
  out.set(mbytes, HEADER_SIZE);
  let p = HEADER_SIZE + mbytes.length;
  for (const b of blobs) { out.set(b, p); p += b.length; }
  return out;
}

// ---------------------------------------------------------------- read
const bad = (m: string) => new PsFormatError('invalid-manifest', m);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function inflateExact(data: Uint8Array, size: number, what: string): Uint8Array {
  const out = new Uint8Array(size);
  let n = 0;
  try {
    const inf = new Inflate();
    inf.ondata = (chunk) => {
      if (n + chunk.length > size) throw new PsFormatError('limit-exceeded', `${what}: decompressed data exceeds declared size (possible decompression bomb)`);
      out.set(chunk, n); n += chunk.length;
    };
    inf.push(data, true);
  } catch (e) {
    if (e instanceof PsFormatError) throw e;
    throw new PsFormatError('corrupt-tile', `${what}: invalid compressed data`);
  }
  if (n !== size) throw new PsFormatError('corrupt-tile', `${what}: decompressed ${n} bytes, expected ${size}`);
  return out;
}

export function readPstudio(bytes: Uint8Array): ReadResult {
  const warnings: string[] = [];
  if (bytes.length > LIMITS.maxFileBytes) throw new PsFormatError('limit-exceeded', 'file too large');
  if (bytes.length < HEADER_SIZE) throw new PsFormatError('truncated', 'file shorter than header');
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC[i]) throw new PsFormatError('bad-magic', 'not a Pixel Studio document');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc32(bytes, 0, 24) !== dv.getUint32(24, true)) throw new PsFormatError('crc-mismatch', 'header checksum mismatch');
  const major = dv.getUint16(8, true), minor = dv.getUint16(10, true);
  if (major !== FORMAT_MAJOR) {
    throw new PsFormatError('unsupported-version', `file format ${major}.${minor} is not supported by this version (supports ${FORMAT_MAJOR}.x). Update Pixel Studio to open it.`);
  }
  const mlen = dv.getUint32(12, true), mcrc = dv.getUint32(16, true), blen = dv.getUint32(20, true);
  if (mlen > LIMITS.maxManifestBytes) throw new PsFormatError('limit-exceeded', 'manifest too large');
  if (HEADER_SIZE + mlen + blen > bytes.length) throw new PsFormatError('truncated', 'file is truncated (declared sections exceed file size)');
  if (HEADER_SIZE + mlen + blen < bytes.length) warnings.push('Trailing bytes after the data area were ignored.');
  const mraw = bytes.subarray(HEADER_SIZE, HEADER_SIZE + mlen);
  if (crc32(mraw) !== mcrc) throw new PsFormatError('crc-mismatch', 'manifest checksum mismatch');
  const blobArea = bytes.subarray(HEADER_SIZE + mlen, HEADER_SIZE + mlen + blen);
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mraw)); } catch { throw bad('manifest is not valid UTF-8 JSON'); }
  if (!isObj(manifest) || manifest.format !== 'pstudio') throw bad('manifest format tag missing');
  const m = migrateManifest(manifest, major, minor);

  const d = m.document;
  if (!isObj(d)) throw bad('document missing');
  const doc = parseDocument(d, warnings);
  // index layers
  const layerById = new Map<string, Layer>();
  const index = (ls: Layer[], depth: number) => {
    if (depth > MAX_GROUP_DEPTH) throw new PsFormatError('limit-exceeded', 'group nesting too deep');
    for (const l of ls) {
      if (layerById.has(l.id)) throw bad(`duplicate layer id ${l.id}`);
      layerById.set(l.id, l);
      if (layerById.size > MAX_LAYERS) throw new PsFormatError('limit-exceeded', 'too many layers');
      if (l.kind === 'group') index(l.children, depth + 1);
    }
  };
  index(doc.layers, 0);

  const tiles = m.tiles;
  if (!Array.isArray(tiles)) throw bad('tiles must be an array');
  if (tiles.length > LIMITS.maxTiles) throw new PsFormatError('limit-exceeded', 'too many tiles');
  const seen = new Set<string>();
  const readBlob = (e: Record<string, unknown>, what: string) => {
    const off = e.off, len = e.len, crc = e.crc;
    if (!Number.isInteger(off) || !Number.isInteger(len) || !Number.isInteger(crc) || (off as number) < 0 || (len as number) < 0) throw bad(`${what}: bad blob reference`);
    if ((off as number) + (len as number) > blobArea.length) throw new PsFormatError('truncated', `${what}: blob outside data area`);
    const comp = blobArea.subarray(off as number, (off as number) + (len as number));
    if (crc32(comp) !== crc) throw new PsFormatError('crc-mismatch', `${what}: checksum mismatch`);
    return comp;
  };
  for (const raw of tiles) {
    if (!isObj(raw)) throw bad('tile entry must be an object');
    const { layer, plane, tx, ty } = raw as { layer: unknown; plane: unknown; tx: unknown; ty: unknown };
    if (typeof layer !== 'string' || (plane !== 'pixels' && plane !== 'mask')) throw bad('tile entry: bad layer/plane');
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || Math.abs(tx as number) > LIMITS.maxTileCoord || Math.abs(ty as number) > LIMITS.maxTileCoord) throw bad('tile entry: bad coordinates');
    const l = layerById.get(layer);
    if (!l) throw bad(`tile references unknown layer ${layer}`);
    let store: TileStore;
    if (plane === 'pixels') {
      if (l.kind !== 'raster') throw bad(`pixels tile on non-raster layer ${layer}`);
      store = l.pixels;
    } else {
      if (l.kind === 'opaque' || !l.mask) throw bad(`mask tile on layer without mask ${layer}`);
      store = l.mask.tiles;
    }
    const key = `${layer}|${plane}|${tx},${ty}`;
    if (seen.has(key)) throw bad(`duplicate tile ${key}`);
    seen.add(key);
    const comp = readBlob(raw, `tile ${key}`);
    const data = inflateExact(comp, tileByteLength(store.format as PixelFormat), `tile ${key}`);
    store.tiles.set(`${tx},${ty}`, data);
  }
  let preview: Preview | null = null;
  if (isObj(m.preview)) {
    const p = m.preview;
    const w = p.width, h = p.height;
    if (Number.isInteger(w) && Number.isInteger(h) && (w as number) > 0 && (h as number) > 0 && (w as number) <= LIMITS.maxPreviewSide && (h as number) <= LIMITS.maxPreviewSide) {
      try { preview = { width: w as number, height: h as number, rgba: inflateExact(readBlob(p, 'preview'), (w as number) * (h as number) * 4, 'preview') }; }
      catch (e) { warnings.push(`Embedded preview ignored: ${(e as Error).message}`); }
    } else warnings.push('Embedded preview has invalid dimensions and was ignored.');
  }
  // preserve unknown manifest-level keys
  const mx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!KNOWN_MANIFEST_KEYS.has(k)) mx[k] = v;
  if (Object.keys(mx).length) { doc.unknown = { ...(doc.unknown ?? {}), __manifest: mx }; warnings.push('File contains data from a newer version; it is preserved but not editable.'); }
  return { doc, warnings, preview, formatVersion: { major, minor } };
}

/** Migration policy: same-major files are accepted; older minors are upgraded here. v1.0 → identity. */
export function migrateManifest(m: Record<string, unknown>, _major: number, _minor: number): Record<string, unknown> {
  return m;
}

function num(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw bad(`${what} must be a number in [${lo}, ${hi}]`);
  return v;
}
function int(v: unknown, lo: number, hi: number, what: string): number {
  const n = num(v, lo, hi, what);
  if (!Number.isInteger(n)) throw bad(`${what} must be an integer`);
  return n;
}
function str(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} must be a string (≤ ${max})`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw bad(`${what} must be boolean`);
  return v;
}

function parseDocument(d: Record<string, unknown>, warnings: string[]): PsDocument {
  const c = d.canvas;
  if (!isObj(c)) throw bad('canvas missing');
  const width = int(c.width, 1, MAX_CANVAS_SIDE, 'canvas.width'), height = int(c.height, 1, MAX_CANVAS_SIDE, 'canvas.height');
  if (width * height > MAX_CANVAS_PIXELS) throw new PsFormatError('limit-exceeded', `canvas ${width}×${height} exceeds ${MAX_CANVAS_PIXELS / 1e6} Mpx limit`);
  if (c.mode !== 'RGB') throw new PsFormatError('unsupported-feature', `colour mode ${String(c.mode)} is not supported (RGB only)`);
  if (c.bitDepth !== 8) throw new PsFormatError('unsupported-feature', `${String(c.bitDepth)}-bit documents are not supported (8-bit only)`);
  const prof = isObj(c.profile) ? c.profile : { name: 'sRGB IEC61966-2.1 (assumed, unmanaged)', assumed: true };
  const doc: PsDocument = {
    schemaVersion: SCHEMA_VERSION,
    id: str(d.id, 64, 'document.id'), name: str(d.name, 256, 'document.name'),
    canvas: {
      width, height, resolutionPpi: num(c.resolutionPpi, 1, 100000, 'canvas.resolutionPpi'), mode: 'RGB', bitDepth: 8,
      profile: { name: str(prof.name, 256, 'profile.name'), assumed: bool(prof.assumed, 'profile.assumed') },
    },
    layers: [], selection: null, guides: [],
  };
  if (d.selection !== null && d.selection !== undefined) {
    const s = d.selection;
    if (!isObj(s) || s.kind !== 'rect') throw new PsFormatError('unsupported-feature', 'unsupported selection type');
    doc.selection = { kind: 'rect', x: int(s.x, -1e7, 1e7, 'selection.x'), y: int(s.y, -1e7, 1e7, 'selection.y'), w: int(s.w, 1, 1e7, 'selection.w'), h: int(s.h, 1, 1e7, 'selection.h') } as Selection;
  }
  if (d.guides !== undefined) {
    if (!Array.isArray(d.guides) || d.guides.length > 10000) throw bad('guides invalid');
    doc.guides = d.guides.map((g): Guide => {
      if (!isObj(g) || (g.orientation !== 'h' && g.orientation !== 'v')) throw bad('guide invalid');
      return { orientation: g.orientation, position: num(g.position, -1e7, 1e7, 'guide.position') };
    });
  }
  if (!Array.isArray(d.layers)) throw bad('layers must be an array');
  doc.layers = d.layers.map(l => parseLayer(l, warnings, 0));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!KNOWN_DOC_KEYS.has(k)) extra[k] = v;
  if (Object.keys(extra).length) doc.unknown = extra;
  return doc;
}

function parseLayer(j: unknown, warnings: string[], depth: number): Layer {
  if (depth > MAX_GROUP_DEPTH) throw new PsFormatError('limit-exceeded', 'group nesting too deep');
  if (!isObj(j)) throw bad('layer must be an object');
  const id = str(j.id, 64, 'layer.id');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw bad(`layer.id has invalid characters: ${id}`);
  const name = typeof j.name === 'string' ? j.name.slice(0, 256) : '';
  const kind = j.kind;
  if (kind !== 'raster' && kind !== 'text' && kind !== 'group') {
    warnings.push(`Layer “${name || id}” has unsupported kind “${String(kind)}”; it is preserved but not rendered or editable.`);
    return {
      kind: 'opaque', originalKind: String(kind), raw: structuredClone(j), id, name: name || id, visible: false,
      lock: { pixels: true, position: true, all: true }, opacity: 1, blendMode: 'normal', offset: { x: 0, y: 0 }, mask: null,
    };
  }
  const lockJ = isObj(j.lock) ? j.lock : { pixels: false, position: false, all: false };
  const lock: Lock = { pixels: bool(lockJ.pixels, 'lock.pixels'), position: bool(lockJ.position, 'lock.position'), all: bool(lockJ.all, 'lock.all') };
  if (!isObj(j.offset)) throw bad('layer.offset missing');
  const base = {
    id, name, visible: bool(j.visible, 'layer.visible'), lock, opacity: num(j.opacity, 0, 1, 'layer.opacity'),
    blendMode: (isBlendModeValue(j.blendMode) ? j.blendMode : (() => { throw bad(`unknown blend mode ${String(j.blendMode)}`); })()),
    offset: { x: int(j.offset.x, -1e7, 1e7, 'offset.x'), y: int(j.offset.y, -1e7, 1e7, 'offset.y') },
    mask: null as MaskState | null,
  };
  if (j.mask !== undefined && j.mask !== null) {
    if (!isObj(j.mask)) throw bad('mask invalid');
    base.mask = { tiles: new TileStore('A8', int(j.mask.fill ?? 0, 0, 255, 'mask.fill')), enabled: bool(j.mask.enabled, 'mask.enabled'), linked: bool(j.mask.linked, 'mask.linked') };
  }
  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) if (!KNOWN_LAYER_KEYS.has(k)) unknown[k] = v;
  const u = Object.keys(unknown).length ? { unknown } : {};
  if (kind === 'raster') return { ...base, ...u, kind, pixels: new TileStore('RGBA8') };
  if (kind === 'text') return { ...base, ...u, kind, text: parseText(j.text) };
  if (!Array.isArray(j.children)) throw bad('group.children must be an array');
  return { ...base, ...u, kind: 'group', expanded: typeof j.expanded === 'boolean' ? j.expanded : true, children: j.children.map(c => parseLayer(c, warnings, depth + 1)) };
}

function parseText(t: unknown): TextData {
  if (!isObj(t)) throw bad('text data missing');
  if (!Array.isArray(t.color) || t.color.length !== 4) throw bad('text.color invalid');
  if (t.align !== 'left' && t.align !== 'center' && t.align !== 'right') throw bad('text.align invalid');
  return {
    text: str(t.text, 100000, 'text.text'), fontFamily: str(t.fontFamily, 256, 'text.fontFamily'), fontSize: num(t.fontSize, 1, 4096, 'text.fontSize'),
    fontWeight: num(t.fontWeight, 100, 900, 'text.fontWeight'), italic: bool(t.italic, 'text.italic'),
    color: t.color.map(c => int(c, 0, 255, 'text.color')) as TextData['color'], align: t.align,
    lineHeight: num(t.lineHeight, 0.1, 10, 'text.lineHeight'), tracking: num(t.tracking, -1000, 1000, 'text.tracking'),
    boxWidth: t.boxWidth === null ? null : num(t.boxWidth, 1, 100000, 'text.boxWidth'),
  };
}
void TILE_SIZE;
