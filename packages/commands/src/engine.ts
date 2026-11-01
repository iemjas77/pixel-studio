import { applyOp, findLayer, absoluteOffset, opBytes, type IdSource, type Op, type PsDocument, RandomIdSource } from '@ps/document';
import { TILE_SIZE, parseTileKey, type Rect, type TileStore } from '@ps/raster';
import { validate, ValidationError, type Schema } from './schema';
import type { TextData } from '@ps/document';

export interface CommandInput { type: string; params: Record<string, unknown> }
export interface CommandResult { layerId?: string }
export interface RecordedCommand { type: string; version: number; params: Record<string, unknown> }

export class CommandError extends Error {
  constructor(public code: 'unknown-command' | 'invalid-params' | 'blocked' | 'failed', msg: string) { super(msg); this.name = 'CommandError'; }
}

export interface Services {
  /** Rasterize text into layer-local RGBA8 tiles. Provided by the host (Canvas 2D in the app). */
  rasterizeText?: (t: TextData) => TileStore;
  /** One-shot supply of decoded pixels for `layer.placePixels`. */
  takePixels?: () => TileStore | null;
}

export class Tx {
  readonly ops: Op[] = [];
  readonly inverse: Op[] = [];
  constructor(readonly doc: PsDocument) {}
  apply(op: Op) {
    const inv = applyOp(this.doc, op);
    this.ops.push(op);
    this.inverse.unshift(inv);
  }
  rollback() {
    for (const inv of this.inverse) applyOp(this.doc, inv);
    this.ops.length = 0; this.inverse.length = 0;
  }
}

export interface HandlerContext {
  doc: PsDocument; tx: Tx; ids: IdSource; services: Services;
  /** Handlers set this to report created ids to the caller. */
  result: CommandResult;
}
export interface CommandDef {
  type: string;
  version: number;
  /** false = needs host-supplied data; cannot be replayed from params alone (Actions skip it). */
  recordable?: boolean;
  schema: Schema;
  label(p: any, doc: PsDocument): string;
  /** Throw CommandError('blocked', …) when preconditions (locks, wrong layer kind…) fail. */
  check?(doc: PsDocument, p: any): void;
  execute(ctx: HandlerContext, p: any): void;
}

export class CommandRegistry {
  private defs = new Map<string, CommandDef>();
  register(d: CommandDef) {
    if (this.defs.has(d.type)) throw new Error(`duplicate command ${d.type}`);
    this.defs.set(d.type, d);
  }
  get(type: string) { return this.defs.get(type); }
  list() { return [...this.defs.values()]; }
}

export interface HistoryEntry {
  id: number; label: string; commands: RecordedCommand[]; forward: Op[]; inverse: Op[]; bytes: number; time: number;
}
export interface DirtyInfo { all: boolean; rects: Rect[]; selection: boolean; structure: boolean }
export type EngineEvent = { kind: 'commit' | 'undo' | 'redo' | 'jump' | 'replace'; dirty: DirtyInfo };

export interface EngineOptions {
  ids?: IdSource;
  registry: CommandRegistry;
  services?: Services;
  maxHistoryBytes?: number;
  maxHistoryEntries?: number;
}

export class Engine {
  doc: PsDocument;
  readonly ids: IdSource;
  readonly registry: CommandRegistry;
  services: Services;
  entries: HistoryEntry[] = [];
  /** index of the last applied entry (-1 = base state) */
  ptr = -1;
  maxHistoryBytes: number;
  maxHistoryEntries: number;
  private nextId = 1;
  private baseId = 0;
  private savedId: number | null = 0;
  private listeners = new Set<(e: EngineEvent) => void>();

  constructor(doc: PsDocument, o: EngineOptions) {
    this.doc = doc;
    this.ids = o.ids ?? new RandomIdSource();
    this.registry = o.registry;
    this.services = o.services ?? {};
    this.maxHistoryBytes = o.maxHistoryBytes ?? 256 * 1024 * 1024;
    this.maxHistoryEntries = o.maxHistoryEntries ?? 500;
  }

  subscribe(fn: (e: EngineEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(kind: EngineEvent['kind'], ops: Op[]) {
    const dirty = this.dirtyOf(ops);
    for (const l of this.listeners) l({ kind, dirty });
  }

  get canUndo() { return this.ptr >= 0; }
  get canRedo() { return this.ptr < this.entries.length - 1; }
  get currentId() { return this.ptr >= 0 ? this.entries[this.ptr].id : this.baseId; }
  get isDirty() { return this.savedId !== this.currentId; }
  markSaved() { this.savedId = this.currentId; }
  get historyBytes() { return this.entries.reduce((n, e) => n + e.bytes, 0); }

  /** Execute a registered command atomically; one history entry on success. */
  execute(cmd: CommandInput): CommandResult {
    const def = this.registry.get(cmd.type);
    if (!def) throw new CommandError('unknown-command', `unknown command: ${cmd.type}`);
    try { validate(def.schema, cmd.params); } catch (e) {
      if (e instanceof ValidationError) throw new CommandError('invalid-params', `${cmd.type}: ${e.message}`);
      throw e;
    }
    def.check?.(this.doc, cmd.params);
    const tx = new Tx(this.doc);
    const result: CommandResult = {};
    try {
      def.execute({ doc: this.doc, tx, ids: this.ids, services: this.services, result }, cmd.params);
    } catch (e) {
      tx.rollback();
      if (e instanceof CommandError) throw e;
      throw new CommandError('failed', `${cmd.type}: ${(e as Error).message}`);
    }
    if (tx.ops.length === 0) return result;
    this.push({
      label: def.label(cmd.params, this.doc), commands: [{ type: def.type, version: def.version, params: structuredClone(cmd.params) }],
      forward: tx.ops, inverse: tx.inverse,
    });
    this.emit('commit', tx.ops);
    return result;
  }

  /** Run several commands as ONE history entry; all-or-nothing. */
  executeBatch(label: string, cmds: CommandInput[], resolve?: (cmd: CommandInput, index: number, prior: CommandResult[]) => CommandInput): CommandResult[] {
    const tx = new Tx(this.doc);
    const results: CommandResult[] = [];
    const recorded: RecordedCommand[] = [];
    try {
      for (let ci = 0; ci < cmds.length; ci++) {
        const cmd = resolve ? resolve(cmds[ci], ci, results) : cmds[ci];
        const def = this.registry.get(cmd.type);
        if (!def) throw new CommandError('unknown-command', `unknown command: ${cmd.type}`);
        try { validate(def.schema, cmd.params); } catch (e) {
          if (e instanceof ValidationError) throw new CommandError('invalid-params', `${cmd.type}: ${e.message}`);
          throw e;
        }
        def.check?.(this.doc, cmd.params);
        const result: CommandResult = {};
        def.execute({ doc: this.doc, tx, ids: this.ids, services: this.services, result }, cmd.params);
        results.push(result);
        recorded.push({ type: def.type, version: def.version, params: structuredClone(cmd.params) });
      }
    } catch (e) {
      tx.rollback();
      if (e instanceof CommandError) throw e;
      throw new CommandError('failed', (e as Error).message);
    }
    if (tx.ops.length === 0) return results;
    this.push({ label, commands: recorded, forward: tx.ops, inverse: tx.inverse });
    this.emit('commit', tx.ops);
    return results;
  }

  /**
   * Record a gesture that was ALREADY applied to the document (live brush stroke).
   * `forward`/`inverse` must be exact; `command` is stored for semantic replay.
   */
  record(command: CommandInput, label: string, forward: Op[], inverse: Op[]) {
    const def = this.registry.get(command.type);
    if (!def) throw new CommandError('unknown-command', command.type);
    validate(def.schema, command.params);
    this.push({ label, commands: [{ type: def.type, version: def.version, params: structuredClone(command.params) }], forward, inverse });
    this.emit('commit', forward);
  }

  private push(e: Omit<HistoryEntry, 'id' | 'bytes' | 'time'>) {
    this.entries.length = this.ptr + 1; // redo invalidation
    // if the saved state was in the discarded redo branch it is unreachable
    if (this.savedId !== null && this.savedId !== this.baseId && !this.entries.some(x => x.id === this.savedId)) this.savedId = null;
    const bytes = e.forward.reduce((n, o) => n + opBytes(o), 0) + e.inverse.reduce((n, o) => n + opBytes(o), 0);
    this.entries.push({ ...e, id: this.nextId++, bytes, time: Date.now() });
    this.ptr = this.entries.length - 1;
    this.evict();
  }

  private evict() {
    while (this.entries.length > 1 && (this.entries.length > this.maxHistoryEntries || this.historyBytes > this.maxHistoryBytes) && this.ptr >= 1) {
      const gone = this.entries.shift()!;
      this.baseId = gone.id;
      this.ptr--;
    }
    if (this.savedId !== null && this.savedId < this.baseId) this.savedId = null;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const e = this.entries[this.ptr];
    for (const op of e.inverse) applyOp(this.doc, op);
    this.ptr--;
    this.emit('undo', e.inverse);
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    const e = this.entries[this.ptr + 1];
    for (const op of e.forward) applyOp(this.doc, op);
    this.ptr++;
    this.emit('redo', e.forward);
    return true;
  }
  /** Move to the state after entry index `target` (-1 = base). */
  jumpTo(target: number) {
    if (target < -1 || target >= this.entries.length) throw new RangeError('history index out of range');
    const ops: Op[] = [];
    while (this.ptr > target) { const e = this.entries[this.ptr]; for (const op of e.inverse) { applyOp(this.doc, op); ops.push(op); } this.ptr--; }
    while (this.ptr < target) { const e = this.entries[this.ptr + 1]; for (const op of e.forward) { applyOp(this.doc, op); ops.push(op); } this.ptr++; }
    this.emit('jump', ops);
  }

  /** Replace the document (open file). Clears history. */
  replaceDocument(doc: PsDocument) {
    this.doc = doc; this.entries = []; this.ptr = -1; this.baseId = 0; this.nextId = 1; this.savedId = 0;
    for (const l of this.listeners) l({ kind: 'replace', dirty: { all: true, rects: [], selection: true, structure: true } });
  }

  private dirtyOf(ops: Op[]): DirtyInfo {
    const d: DirtyInfo = { all: false, rects: [], selection: false, structure: false };
    for (const op of ops) {
      switch (op.op) {
        case 'tiles.apply': {
          const loc = findLayer(this.doc, op.layerId);
          if (!loc) { d.all = true; break; }
          let o = { x: 0, y: 0 };
          try { o = absoluteOffset(this.doc, op.layerId); } catch { /* removed */ }
          for (const k of op.changes.keys()) {
            const [tx, ty] = parseTileKey(k);
            d.rects.push({ x: tx * TILE_SIZE + o.x, y: ty * TILE_SIZE + o.y, w: TILE_SIZE, h: TILE_SIZE });
          }
          break;
        }
        case 'doc.set': if ('selection' in op.props) d.selection = true; if ('name' in op.props) d.structure = true; if ('blendSpace' in op.props) { d.all = true; } break;
        default: d.all = true; d.structure = true;
      }
    }
    return d;
  }
}
