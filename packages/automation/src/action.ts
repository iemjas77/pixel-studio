import { CommandError, validate, ValidationError, type CommandInput, type CommandRegistry, type Engine, type RecordedCommand } from '@ps/commands';
import { findLayer, walkLayers, type PsDocument } from '@ps/document';

/**
 * Actions are DATA: an ordered list of allow-listed, versioned, schema-validated commands.
 * Nothing in an action file is ever evaluated as code.
 *
 * Layer targets are symbolic so an action can run on any document:
 *   "$active"      the layer that is active at that point of the replay (starts as the document's active layer;
 *                  becomes the layer created by the latest layer-creating step, mirroring the UI)
 *   "$created:N"   the layer created by step N of this action
 *   "$name:Text"   the first layer with that exact name (recorded only for non-active pre-existing layers)
 * Pixel coordinates (strokes, selections, offsets) are absolute document coordinates.
 */
export const ACTION_FORMAT = 'pixel-studio-action';
export const ACTION_VERSION = 1;
export const LIMITS = { maxSteps: 10_000, maxFileBytes: 8 * 1024 * 1024, maxNameLength: 128 };
const REF_KEYS = new Set(['id', 'layerId', 'parentId']);
const REF_RE = /^\$(active|created:\d{1,5}|name:.{1,256})$/;

export interface ActionStep { type: string; version: number; params: Record<string, unknown> }
export interface Action { format: typeof ACTION_FORMAT; version: number; name: string; steps: ActionStep[] }

export interface ReplayReport {
  ok: boolean; executed: number; failedStep?: number; error?: string; activeLayerId: string | null;
}

// ------------------------------------------------------------------ validation / (de)serialisation
export function validateAction(raw: unknown, registry: CommandRegistry): { action: Action | null; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { action: null, errors: ['Action file must be a JSON object.'] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['format', 'version', 'name', 'steps'].includes(k)) errors.push(`Unknown top-level field “${k}”.`);
  if (o.format !== ACTION_FORMAT) errors.push('Not a Pixel Studio action file.');
  if (o.version !== ACTION_VERSION) errors.push(`Unsupported action version ${String(o.version)} (this build reads version ${ACTION_VERSION}).`);
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > LIMITS.maxNameLength) errors.push('Action needs a name (1–128 characters).');
  if (!Array.isArray(o.steps)) errors.push('Action has no steps array.');
  else if (o.steps.length > LIMITS.maxSteps) errors.push(`Too many steps (limit ${LIMITS.maxSteps}).`);
  if (errors.length) return { action: null, errors };
  const steps = o.steps as unknown[];
  steps.forEach((st, i) => {
    const at = `Step ${i + 1}`;
    if (typeof st !== 'object' || st === null) { errors.push(`${at}: must be an object.`); return; }
    const s = st as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!['type', 'version', 'params'].includes(k)) errors.push(`${at}: unknown field “${k}”.`);
    const def = typeof s.type === 'string' ? registry.get(s.type) : undefined;
    if (!def) { errors.push(`${at}: unsupported operation “${String(s.type)}”.`); return; }
    if (def.recordable === false) { errors.push(`${at}: “${def.type}” cannot be used in actions.`); return; }
    if (s.version !== def.version) { errors.push(`${at}: “${def.type}” version ${String(s.version)} is not supported (need ${def.version}).`); return; }
    if (typeof s.params !== 'object' || s.params === null || Array.isArray(s.params)) { errors.push(`${at}: params must be an object.`); return; }
    try {
      const refCheck = substituteRefs(s.params as Record<string, unknown>, () => 'ly_placeholder', i);
      validate(def.schema, refCheck);
    } catch (e) {
      errors.push(`${at} (${def.type}): ${e instanceof ValidationError || e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (errors.length) return { action: null, errors };
  return { action: { format: ACTION_FORMAT, version: ACTION_VERSION, name: (o.name as string).trim(), steps: steps as ActionStep[] }, errors: [] };
}

export function parseActionJson(text: string, registry: CommandRegistry): { action: Action | null; errors: string[] } {
  if (text.length > LIMITS.maxFileBytes) return { action: null, errors: ['Action file is too large.'] };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { action: null, errors: ['Action file is not valid JSON.'] }; }
  return validateAction(raw, registry);
}
export const serializeAction = (a: Action) => JSON.stringify(a, null, 2);

function substituteRefs(params: Record<string, unknown>, resolve: (ref: string) => string, stepIndex: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (REF_KEYS.has(k) && typeof v === 'string' && v.startsWith('$')) {
      if (!REF_RE.test(v)) throw new Error(`invalid layer reference “${v}”`);
      const m = /^\$created:(\d+)$/.exec(v);
      if (m && Number(m[1]) >= stepIndex) throw new Error(`reference “${v}” points to a step that has not run yet`);
      out[k] = resolve(v);
    } else out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ replay
const CREATES_LAYER = new Set(['layer.add', 'layer.duplicate', 'layer.group', 'text.create', 'layer.placePixels']);

/** Run an action as ONE undoable history entry; all-or-nothing. */
export function replayAction(engine: Engine, action: Action, opts: { activeLayerId: string | null }): ReplayReport {
  const { errors } = validateAction(action, engine.registry);
  if (errors.length) return { ok: false, executed: 0, error: errors.join('\n'), activeLayerId: opts.activeLayerId };
  let active = opts.activeLayerId ?? topLayerId(engine.doc);
  const created = new Map<number, string>();
  let executed = 0;
  const cmds: CommandInput[] = action.steps.map(s => ({ type: s.type, params: s.params }));
  try {
    engine.executeBatch(`Action: ${action.name}`, cmds, (cmd, i, prior) => {
      if (i > 0) {
        const prev = prior[i - 1];
        if (prev?.layerId) { created.set(i - 1, prev.layerId); active = prev.layerId; }
        executed = i;
      }
      const params = substituteRefs(cmd.params, ref => resolveRef(engine.doc, ref, active, created), i);
      return { type: cmd.type, params };
    });
    executed = action.steps.length;
    // final created id (last step)
    return { ok: true, executed, activeLayerId: lastCreated(engine, action, active) };
  } catch (e) {
    return { ok: false, executed: 0, failedStep: executed + 1, error: `Step ${executed + 1} (${action.steps[executed]?.type}): ${(e as Error).message}`, activeLayerId: opts.activeLayerId };
  }
}
function lastCreated(engine: Engine, action: Action, fallback: string | null): string | null {
  const last = action.steps[action.steps.length - 1];
  if (!last || !CREATES_LAYER.has(last.type)) return fallback && findLayer(engine.doc, fallback) ? fallback : topLayerId(engine.doc);
  const e = engine.entries[engine.ptr];
  const ins = [...(e?.forward ?? [])].reverse().find(o => o.op === 'layer.insert');
  return ins && ins.op === 'layer.insert' ? ins.layer.id : fallback;
}
const topLayerId = (doc: PsDocument) => (doc.layers.length ? doc.layers[doc.layers.length - 1].id : null);
function resolveRef(doc: PsDocument, ref: string, active: string | null, created: Map<number, string>): string {
  if (ref === '$active') {
    if (!active || !findLayer(doc, active)) throw new CommandError('blocked', 'This action needs an active layer, but the document has none.');
    return active;
  }
  const c = /^\$created:(\d+)$/.exec(ref);
  if (c) {
    const id = created.get(Number(c[1]));
    if (!id) throw new CommandError('blocked', `Step ${Number(c[1]) + 1} did not create a layer.`);
    return id;
  }
  const name = ref.slice('$name:'.length);
  for (const l of walkLayers(doc.layers)) if (l.name === name) return l.id;
  throw new CommandError('blocked', `No layer named “${name}” in this document.`);
}

// ------------------------------------------------------------------ recording
export class ActionRecorder {
  private steps: ActionStep[] = [];
  private entryOfStep: number[] = [];
  private createdBy = new Map<string, number>(); // layer id -> step index that created it
  private stash: { step: ActionStep; entryId: number; created?: [string, number] }[] = [];
  private off: (() => void) | null = null;
  readonly skipped: string[] = [];
  constructor(private engine: Engine, private getActiveLayerId: () => string | null) {}
  get stepCount() { return this.steps.length; }
  get recording() { return this.off !== null; }

  start() {
    if (this.off) return;
    this.off = this.engine.subscribe(ev => {
      const e = this.engine;
      if (ev.kind === 'commit') this.onCommit(e.entries[e.ptr]);
      else if (ev.kind === 'undo') this.onUndo(e.entries[e.ptr + 1]);
      else if (ev.kind === 'redo') this.onRedo(e.entries[e.ptr]);
      else if (ev.kind === 'jump' || ev.kind === 'replace') this.skipped.push('History navigation during recording is not recorded; the action may be incomplete.');
    });
  }
  stop(name: string): Action {
    this.off?.(); this.off = null;
    return { format: ACTION_FORMAT, version: ACTION_VERSION, name, steps: this.steps.map(s => ({ ...s, params: structuredClone(s.params) })) };
  }

  private mapRefs(params: Record<string, unknown>, doc: PsDocument): Record<string, unknown> {
    const out: Record<string, unknown> = structuredClone(params);
    const active = this.getActiveLayerId();
    for (const k of REF_KEYS) {
      const v = out[k];
      if (typeof v !== 'string') continue;
      const made = this.createdBy.get(v);
      if (made !== undefined) out[k] = `$created:${made}`;
      else if (v === active) out[k] = '$active';
      else {
        const l = findLayer(doc, v)?.layer;
        if (!l) throw new Error('target layer no longer exists');
        out[k] = `$name:${l.name}`;
      }
    }
    return out;
  }
  private onCommit(entry: { id: number; commands: RecordedCommand[]; forward: { op: string; layer?: { id: string } }[] }) {
    for (const c of entry.commands) {
      const def = this.engine.registry.get(c.type);
      if (!def || def.recordable === false) { this.skipped.push(`“${c.type}” cannot be recorded and was skipped.`); continue; }
      try {
        const params = this.mapRefs(c.params, this.engine.doc);
        const idx = this.steps.length;
        this.steps.push({ type: c.type, version: c.version, params });
        this.entryOfStep.push(entry.id);
        if (CREATES_LAYER.has(c.type)) {
          const ins = [...entry.forward].reverse().find(o => o.op === 'layer.insert');
          if (ins?.layer) this.createdBy.set(ins.layer.id, idx);
        }
      } catch (e) { this.skipped.push(`“${c.type}” skipped: ${(e as Error).message}.`); }
    }
  }
  private onUndo(entry: { id: number } | undefined) {
    if (!entry) return;
    while (this.entryOfStep.length && this.entryOfStep[this.entryOfStep.length - 1] === entry.id) {
      this.entryOfStep.pop();
      const step = this.steps.pop()!;
      const made = [...this.createdBy].find(([, i]) => i === this.steps.length);
      if (made) this.createdBy.delete(made[0]);
      this.stash.push({ step, entryId: entry.id, created: made });
    }
  }
  private onRedo(entry: { id: number } | undefined) {
    if (!entry) return;
    for (let i = this.stash.length - 1; i >= 0; i--) {
      const s = this.stash[i];
      if (s.entryId !== entry.id) continue;
      this.stash.splice(i, 1);
      this.steps.push(s.step); this.entryOfStep.push(s.entryId);
      if (s.created) this.createdBy.set(s.created[0], this.steps.length - 1);
    }
  }
}
