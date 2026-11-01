import { useSyncExternalStore } from 'react';
import { Engine, CommandError, createDefaultRegistry, fullBrush, type CommandInput, type CommandResult } from '@ps/commands';
import {
  RandomIdSource, createDocument, findLayer, getLayer, renderPreview, type Layer, type PsDocument, type RasterLayer, type Selection, type LayerProps,
} from '@ps/document';
import { DEFAULT_BRUSH, TileStore, type BrushParams } from '@ps/raster';
import { PsFormatError, readPstudio, writePstudio } from '@ps/codecs';
import { CompositeCache, fitView, zoomAt, type ViewState, MIN_ZOOM, MAX_ZOOM } from './viewport';
import { TextCache, rasterizeText } from './text';
import { GpuCompositor } from './gpu';
import { ActionRecorder, parseActionJson, replayAction, serializeAction, type Action } from '@ps/automation';
import { UserError, decodeImage, exportFlattened, sniffKind, type ExportFormat } from './io';
import type { PixelStudioApi } from '../../desktop/src/preload';

declare global { interface Window { pixelStudio?: PixelStudioApi; __ps?: unknown } }

export type ToolId = 'move' | 'marquee' | 'brush' | 'eraser' | 'text' | 'eyedropper' | 'hand' | 'zoom';
export type RGB = [number, number, number];

export type Dialog =
  | { kind: 'new' } | { kind: 'batch' } | { kind: 'nameAction' } | { kind: 'scale' } | { kind: 'about' } | { kind: 'shortcuts' }
  | { kind: 'export'; fmt: 'jpg' | 'webp' }
  | { kind: 'message'; title: string; message: string }
  | { kind: 'confirm'; title: string; message: string; buttons: { label: string; primary?: boolean; run: () => void | Promise<void> }[] }
  | { kind: 'recover'; items: { id: string; name: string; time: number }[] };

export class DocSession {
  readonly engine: Engine;
  path: string | null = null;
  activeLayerId: string | null = null;
  editTarget: 'pixels' | 'mask' = 'pixels';
  view: ViewState = { zoom: 1, panX: 0, panY: 0 };
  needsFit = true;
  collapsed = new Set<string>();
  readonly text = new TextCache();
  readonly cache: CompositeCache;
  lastAutosaveEntry = -1;
  lastAutosaveTime: number | null = null;
  /** Live (uncommitted) preview of layer props, restored before the real command runs. */
  preview: { layerId: string; original: Record<string, unknown> } | null = null;
  constructor(doc: PsDocument, readonly displayName: string) {
    this.engine = new Engine(doc, { registry: createDefaultRegistry(), ids: new RandomIdSource(), services: {} });
    this.engine.services.rasterizeText = rasterizeText;
    this.cache = new CompositeCache(() => this.engine.doc, this.text.resolver);
    this.cache.gpu = gpuForNewSession();
    this.activeLayerId = doc.layers.length ? doc.layers[doc.layers.length - 1].id : null;
  }
  get doc() { return this.engine.doc; }
  get name() { return this.engine.doc.name; }
}

type Listener = () => void;
let gpuForNewSession: () => GpuCompositor | null = () => null;
let toastSeq = 0;

export class EditorStore {
  sessions: DocSession[] = [];
  activeIndex = -1;
  tool: ToolId = 'brush';
  fg: RGB = [20, 20, 24];
  bg: RGB = [255, 255, 255];
  brush: Omit<BrushParams, 'color'> = { size: 24, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.1, pressureSize: false, pressureOpacity: false };
  status: { text: string; kind: 'info' | 'error'; id: number } = { text: 'Ready', kind: 'info', id: 0 };
  dialog: Dialog | null = null;
  spaceDown = false;
  cursorDoc: { x: number; y: number } | null = null;
  private version = 0;
  private listeners = new Set<Listener>();
  private redrawers = new Set<() => void>();
  private rafPending = false;
  private pixelHandoff: TileStore | null = null;
  textFocusRequest = 0;
  // ---------- actions ----------
  actions: Action[] = loadActions();
  selectedAction = 0;
  recorder: { rec: ActionRecorder; session: DocSession } | null = null;
  lastRecordNotes: string[] = [];
  startRecording() {
    const s = this.active;
    if (!s) return this.setStatus('Open a document to record an action.', 'error');
    this.commitPreview();
    const rec = new ActionRecorder(s.engine, () => s.activeLayerId);
    rec.start();
    this.recorder = { rec, session: s };
    this.setStatus('Recording action… perform edits, then press Stop.');
  }
  stopRecording(name: string | null) {
    if (!this.recorder) return;
    const { rec } = this.recorder;
    const action = rec.stop(name || 'Untitled action');
    this.lastRecordNotes = [...new Set(rec.skipped)];
    this.recorder = null;
    if (name === null) { this.setStatus('Recording discarded.'); return; }
    if (!action.steps.length) { this.showMessage('Nothing recorded', 'No recordable steps were performed.' + (this.lastRecordNotes.length ? '\n\n' + this.lastRecordNotes.join('\n') : '')); return; }
    this.actions.push(action); this.selectedAction = this.actions.length - 1; saveActions(this.actions);
    this.setStatus(`Recorded “${action.name}” (${action.steps.length} steps)${this.lastRecordNotes.length ? ' – some steps were skipped' : ''}`);
    if (this.lastRecordNotes.length) this.showMessage('Recorded with notes', this.lastRecordNotes.join('\n'));
  }
  playAction(i = this.selectedAction) {
    const s = this.active; const a = this.actions[i];
    if (!s || !a) return;
    this.commitPreview();
    const rep = replayAction(s.engine, a, { activeLayerId: s.activeLayerId });
    if (rep.ok) { if (rep.activeLayerId) s.activeLayerId = rep.activeLayerId; this.notify(); this.setStatus(`Played “${a.name}” (${rep.executed} steps) – one undo step`); }
    else this.showMessage('Action failed – document unchanged', rep.error ?? 'Unknown error');
  }
  deleteAction(i: number) { this.actions.splice(i, 1); this.selectedAction = Math.max(0, Math.min(this.selectedAction, this.actions.length - 1)); saveActions(this.actions); this.notify(); }
  async saveActionFile(i = this.selectedAction) {
    const a = this.actions[i]; if (!a || !window.pixelStudio) return;
    try {
      const r = await window.pixelStudio.exportFile({ bytes: new TextEncoder().encode(serializeAction(a)), suggestedName: `${a.name}.psaction`, ext: 'psaction' });
      this.setStatus(r ? `Saved action → ${r.name}` : 'Cancelled');
    } catch (e) { this.fail(e); }
  }
  async loadActionFile() {
    if (!window.pixelStudio) return;
    try {
      const f = await window.pixelStudio.openFile('action');
      if (!f) return;
      const reg = this.active?.engine.registry ?? createDefaultRegistry();
      const r = parseActionJson(new TextDecoder().decode(f.bytes), reg);
      if (!r.action) { this.showMessage('Cannot load action', r.errors.slice(0, 12).join('\n') + (r.errors.length > 12 ? `\n…and ${r.errors.length - 12} more` : '') + '\n\nNothing was imported or executed.'); return; }
      this.actions.push(r.action); this.selectedAction = this.actions.length - 1; saveActions(this.actions);
      this.setStatus(`Loaded action “${r.action.name}” (${r.action.steps.length} steps)`);
    } catch (e) { this.fail(e); }
  }

  /** GPU compositing backend (null when WebGL2 is unavailable); user may force CPU. */
  gpu: GpuCompositor | null = (() => { try { const g = new GpuCompositor(); return g.available ? g : null; } catch { return null; } })();
  gpuMode: 'auto' | 'cpu' = 'auto';
  get backendLabel() { return this.gpuMode === 'auto' && this.gpu?.available ? (this.gpu.lastBackend === 'gpu' ? 'GPU' : 'GPU (idle)') : this.gpu && this.gpuMode === 'auto' ? 'CPU (GPU lost)' : 'CPU'; }
  setGpuMode(m: 'auto' | 'cpu') {
    this.gpuMode = m;
    for (const s of this.sessions) { s.cache.gpu = m === 'auto' ? this.gpu : null; s.cache.invalidateAll(); }
    this.setStatus(m === 'auto' ? (this.gpu ? 'Compositing: GPU (CPU fallback on failure)' : 'GPU unavailable; using CPU reference compositor') : 'Compositing: CPU reference');
  }
  textDefaults = { fontFamily: 'Arial', fontSize: 48, fontWeight: 400 };

  // ---------- subscription ----------
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  notify() { this.version++; for (const l of [...this.listeners]) l(); this.requestRedraw(); this.syncTitle(); }
  onRedraw(fn: () => void) { this.redrawers.add(fn); return () => { this.redrawers.delete(fn); }; }
  requestRedraw() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => { this.rafPending = false; for (const f of [...this.redrawers]) f(); });
  }

  get active(): DocSession | null { return this.sessions[this.activeIndex] ?? null; }
  get activeLayer(): Layer | null {
    const s = this.active;
    if (!s || !s.activeLayerId) return null;
    return findLayer(s.doc, s.activeLayerId)?.layer ?? null;
  }

  setStatus(text: string, kind: 'info' | 'error' = 'info') { this.status = { text, kind, id: ++toastSeq }; this.notify(); }
  showMessage(title: string, message: string) { this.dialog = { kind: 'message', title, message }; this.notify(); }
  closeDialog() { this.dialog = null; this.notify(); }
  fail(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.setStatus(msg, 'error');
  }

  // ---------- sessions ----------
  private attach(s: DocSession) {
    s.engine.subscribe((ev) => {
      if (ev.dirty.all) s.cache.invalidateAll(); else for (const r of ev.dirty.rects) s.cache.invalidateRect(r);
      if (s.activeLayerId && !findLayer(s.doc, s.activeLayerId)) {
        s.activeLayerId = s.doc.layers.length ? s.doc.layers[s.doc.layers.length - 1].id : null;
        s.editTarget = 'pixels';
      }
      const l = s.activeLayerId ? findLayer(s.doc, s.activeLayerId)?.layer : null;
      if (s.editTarget === 'mask' && !l?.mask) s.editTarget = 'pixels';
      if (ev.kind === 'commit') { const e = s.engine.entries[s.engine.ptr]; if (e) this.status = { text: e.label, kind: 'info', id: ++toastSeq }; }
      else if (ev.kind === 'undo') this.status = { text: `Undo: ${s.engine.entries[s.engine.ptr + 1]?.label ?? ''}`, kind: 'info', id: ++toastSeq };
      else if (ev.kind === 'redo') this.status = { text: `Redo: ${s.engine.entries[s.engine.ptr]?.label ?? ''}`, kind: 'info', id: ++toastSeq };
      this.notify();
    });
    this.sessions.push(s);
    this.activeIndex = this.sessions.length - 1;
    this.notify();
  }

  newDocument(o: { name: string; width: number; height: number; ppi: number; background: 'transparent' | 'white' | RGB }) {
    const bg = Array.isArray(o.background) ? ([...o.background, 255] as [number, number, number, number]) : o.background;
    const doc = createDocument(new RandomIdSource(), { name: o.name || 'Untitled', width: o.width, height: o.height, resolutionPpi: o.ppi, background: bg });
    const s = new DocSession(doc, doc.name);
    if (!doc.layers.length) { s.engine.execute({ type: 'layer.add', params: { name: 'Layer 1' } }); s.engine.replaceDocument(s.engine.doc); }
    s.activeLayerId = doc.layers[doc.layers.length - 1].id;
    s.engine.markSaved();
    this.attach(s);
    this.setStatus(`Created “${doc.name}” ${o.width}×${o.height}`);
  }

  async openFromDialog(kind: 'document' | 'image' = 'document') {
    if (!window.pixelStudio) return;
    try {
      const f = await window.pixelStudio.openFile(kind);
      if (!f) return;
      await this.openBytes(f.name, f.bytes, f.path);
    } catch (e) { this.reportOpenError(e); }
  }

  reportOpenError(e: unknown) {
    const msg = e instanceof PsFormatError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);
    this.dialog = { kind: 'message', title: 'Cannot open file', message: `${msg}\n\nYour current documents were not changed.` };
    this.setStatus('Open failed: ' + msg, 'error');
  }

  /** Never touches existing sessions unless the file loads successfully. */
  async openBytes(fileName: string, bytes: Uint8Array, path: string | null) {
    try {
      if (sniffKind(bytes) === 'pstudio') {
        const r = readPstudio(bytes);
        const s = new DocSession(r.doc, r.doc.name);
        s.path = path;
        s.engine.markSaved();
        this.attach(s);
        if (r.warnings.length) this.showMessage('Opened with warnings', r.warnings.join('\n'));
        else this.setStatus(`Opened ${fileName}`);
      } else {
        const img = await decodeImage(bytes);
        const doc = createDocument(new RandomIdSource(), { name: fileName.replace(/\.[^.]+$/, ''), width: img.width, height: img.height });
        const s = new DocSession(doc, doc.name);
        s.engine.services.takePixels = () => img.store;
        const r = s.engine.execute({ type: 'layer.placePixels', params: { name: fileName, x: 0, y: 0 } });
        s.engine.replaceDocument(s.engine.doc);
        s.activeLayerId = r.layerId!;
        s.engine.markSaved();
        this.attach(s);
        this.setStatus(`Imported ${fileName} (${img.width}×${img.height}). Save as .pstudio to keep layers.`);
      }
    } catch (e) { this.reportOpenError(e); }
  }

  async placeImage() {
    const s = this.active;
    if (!s || !window.pixelStudio) return;
    try {
      const f = await window.pixelStudio.openFile('image');
      if (!f) return;
      const img = await decodeImage(f.bytes);
      s.engine.services.takePixels = () => img.store;
      const r = this.exec({ type: 'layer.placePixels', params: { name: f.name.replace(/\.[^.]+$/, ''), x: 0, y: 0 } });
      if (r?.layerId) s.activeLayerId = r.layerId;
      this.notify();
    } catch (e) { this.reportOpenError(e); }
  }

  switchTo(i: number) { if (i >= 0 && i < this.sessions.length) { this.activeIndex = i; this.notify(); } }

  async requestCloseSession(i: number) {
    const s = this.sessions[i];
    if (!s) return;
    if (!s.engine.isDirty) { await this.closeSession(i); return; }
    this.dialog = {
      kind: 'confirm', title: 'Unsaved changes', message: `Save changes to “${s.name}” before closing?`,
      buttons: [
        { label: 'Save', primary: true, run: async () => { this.activeIndex = i; if (await this.save(false)) await this.closeSession(this.sessions.indexOf(s)); } },
        { label: 'Don’t save', run: async () => { await this.closeSession(this.sessions.indexOf(s)); } },
        { label: 'Cancel', run: () => {} },
      ],
    };
    this.notify();
  }

  async closeSession(i: number) {
    const s = this.sessions[i];
    if (!s) return;
    this.sessions.splice(i, 1);
    this.activeIndex = Math.min(this.activeIndex, this.sessions.length - 1);
    try { await window.pixelStudio?.recovery.discard(s.engine.doc.id); } catch { /* ignore */ }
    this.dialog = null;
    this.notify();
  }

  /** Window close requested by main process. */
  async handleWindowClose() {
    const dirty = this.sessions.filter(s => s.engine.isDirty);
    if (!dirty.length) { await window.pixelStudio?.closeApproved(); return; }
    this.dialog = {
      kind: 'confirm', title: 'Unsaved changes', message: `${dirty.length} document${dirty.length > 1 ? 's have' : ' has'} unsaved changes. Quit anyway? (Autosaved recovery copies are kept and offered on next launch.)`,
      buttons: [
        { label: 'Quit', primary: true, run: async () => { await window.pixelStudio?.closeApproved(); } },
        { label: 'Cancel', run: () => {} },
      ],
    };
    this.notify();
  }

  // ---------- saving ----------
  serialize(s: DocSession): Uint8Array {
    return writePstudio(s.doc, { preview: renderPreview(s.doc, 256, s.text.resolver) });
  }
  async save(saveAs: boolean): Promise<boolean> {
    const s = this.active;
    if (!s || !window.pixelStudio) return false;
    try {
      const bytes = this.serialize(s);
      const r = await window.pixelStudio.saveFile({ bytes, path: saveAs ? null : s.path, suggestedName: `${s.name}.pstudio` });
      if (!r) return false;
      s.path = r.path;
      s.engine.markSaved();
      void window.pixelStudio.recovery.discard(s.doc.id);
      this.setStatus(`Saved ${r.name}`);
      return true;
    } catch (e) { this.fail(e); return false; }
  }
  async exportAs(fmt: ExportFormat, quality = 0.92) {
    const s = this.active;
    if (!s || !window.pixelStudio) return;
    try {
      this.setStatus('Exporting flattened image…');
      const bytes = await exportFlattened(s.doc, fmt, quality, s.text.resolver);
      const r = await window.pixelStudio.exportFile({ bytes, suggestedName: `${s.name}.${fmt}`, ext: fmt });
      this.setStatus(r ? `Exported flattened ${fmt.toUpperCase()} → ${r.name}` : 'Export cancelled');
    } catch (e) { this.fail(e); }
  }

  async autosaveTick() {
    if (!window.pixelStudio) return;
    for (const s of this.sessions) {
      const cur = s.engine.currentId;
      if (!s.engine.isDirty || s.lastAutosaveEntry === cur) continue;
      try {
        await window.pixelStudio.recovery.write({ id: s.doc.id, name: s.name, bytes: this.serialize(s) });
        s.lastAutosaveEntry = cur; s.lastAutosaveTime = Date.now();
      } catch (e) { this.fail(e); }
    }
    this.notify();
  }

  async checkRecovery() {
    if (!window.pixelStudio) return;
    try {
      const items = await window.pixelStudio.recovery.list();
      if (items.length) { this.dialog = { kind: 'recover', items }; this.notify(); }
    } catch { /* ignore */ }
  }
  async recover(id: string, name: string) {
    try {
      const bytes = await window.pixelStudio!.recovery.read(id);
      await this.openBytes(`${name} (recovered)`, bytes, null);
      const s = this.active;
      if (s) { // recovered docs are unsaved by definition
        s.engine.markSaved(); s.engine.execute({ type: 'doc.rename', params: { name: s.name } });
      }
      await window.pixelStudio!.recovery.discard(id);
    } catch (e) { this.reportOpenError(e); }
  }

  // ---------- commands ----------
  exec(cmd: CommandInput): CommandResult | null {
    const s = this.active;
    if (!s) return null;
    this.commitPreview();
    try { return s.engine.execute(cmd); } catch (e) {
      if (e instanceof CommandError) this.setStatus(e.message.replace(/^[a-z.]+: /i, ''), 'error'); else this.fail(e);
      return null;
    }
  }
  undo() { this.commitPreview(); this.active?.engine.undo(); }
  jump(i: number) { this.commitPreview(); this.active?.engine.jumpTo(i); }
  redo() { this.commitPreview(); this.active?.engine.redo(); }

  /** Run the registry's precondition check without executing. Returns message or null. */
  paintBlockReason(layerId: string, plane: 'pixels' | 'mask'): string | null {
    const s = this.active;
    if (!s) return 'No document.';
    try {
      s.engine.registry.get('paint.stroke')!.check!(s.doc, { layerId, plane });
      return null;
    } catch (e) { return e instanceof Error ? e.message : String(e); }
  }

  selectLayer(id: string, target: 'pixels' | 'mask' = 'pixels') {
    const s = this.active;
    if (!s) return;
    this.commitPreview();
    s.activeLayerId = id; s.editTarget = target;
    this.notify();
  }

  addLayer() {
    const s = this.active;
    if (!s) return;
    const act = this.activeLayer;
    const loc = act ? findLayer(s.doc, act.id) : null;
    const r = this.exec({ type: 'layer.add', params: { parentId: loc?.parent?.id, index: loc ? loc.index + 1 : undefined } as Record<string, unknown> });
    if (r?.layerId) { s.activeLayerId = r.layerId; s.editTarget = 'pixels'; this.notify(); }
  }
  withActive(fn: (l: Layer) => CommandInput | null) {
    const l = this.activeLayer;
    if (!l) { this.setStatus('Select a layer first.', 'error'); return null; }
    const c = fn(l);
    return c ? this.exec(c) : null;
  }
  duplicateLayer() { const r = this.withActive(l => ({ type: 'layer.duplicate', params: { id: l.id } })); if (r?.layerId && this.active) { this.active.activeLayerId = r.layerId; this.notify(); } }
  deleteLayer() { this.withActive(l => ({ type: 'layer.delete', params: { id: l.id } })); }
  groupLayer() { const r = this.withActive(l => ({ type: 'layer.group', params: { id: l.id } })); if (r?.layerId && this.active) { this.active.activeLayerId = r.layerId; this.notify(); } }
  fillSelection(color: RGB) {
    this.withActive(l => ({ type: 'edit.fill', params: { layerId: l.id, plane: this.active!.editTarget, color: [...color, 255], region: 'selection' } }));
  }
  clearSelection() { this.withActive(l => ({ type: 'edit.clear', params: { layerId: l.id, plane: this.active!.editTarget } })); }
  transform(kind: 'flipH' | 'flipV' | 'rot90cw' | 'rot90ccw' | 'rot180') { this.withActive(l => ({ type: 'transform.apply', params: { layerId: l.id, kind } })); }
  scaleLayer(sx: number, sy: number) { this.withActive(l => ({ type: 'transform.apply', params: { layerId: l.id, kind: 'scale', sx, sy } })); }
  selectAll() { this.exec({ type: 'selection.all', params: {} }); }
  deselect() { this.exec({ type: 'selection.clear', params: {} }); }
  addMask(mode: 'reveal' | 'hide' | 'selection') {
    const r = this.withActive(l => ({ type: 'mask.add', params: { id: l.id, mode } }));
    if (r !== null && this.active) { this.active.editTarget = 'mask'; this.notify(); }
  }

  // ---------- live previews (opacity slider, text typing): one history entry per gesture ----------
  previewLayer(layerId: string, patch: Record<string, unknown>) {
    const s = this.active;
    if (!s) return;
    const l = getLayer(s.doc, layerId) as unknown as Record<string, unknown>;
    if (!s.preview || s.preview.layerId !== layerId) {
      this.cancelPreview();
      s.preview = { layerId, original: {} };
    }
    for (const k of Object.keys(patch)) {
      if (!(k in s.preview.original)) s.preview.original[k] = l[k];
      l[k] = patch[k];
    }
    s.cache.invalidateAll();
    this.notify();
  }
  /** Restore originals and run one real command with the final values. */
  commitPreview() {
    const s = this.active;
    if (!s?.preview) return;
    const { layerId, original } = s.preview;
    const l = getLayer(s.doc, layerId) as unknown as Record<string, unknown>;
    const final: Record<string, unknown> = {};
    for (const k of Object.keys(original)) { final[k] = l[k]; l[k] = original[k]; }
    s.preview = null;
    if (JSON.stringify(final) === JSON.stringify(original)) { s.cache.invalidateAll(); this.notify(); return; }
    if ('text' in final) {
      const t = final.text as Record<string, unknown>;
      this.exec({ type: 'text.update', params: { id: layerId, patch: { ...t, boxWidth: t.boxWidth ?? 0 } } });
    } else this.exec({ type: 'layer.set', params: { id: layerId, props: final as LayerProps } });
    s.cache.invalidateAll();
  }
  cancelPreview() {
    const s = this.active;
    if (!s?.preview) return;
    const l = getLayer(s.doc, s.preview.layerId) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(s.preview.original)) l[k] = v;
    s.preview = null;
    s.cache.invalidateAll();
  }

  // ---------- view ----------
  viewSize = { w: 800, h: 600 };
  fit() { const s = this.active; if (!s) return; s.view = fitView(s.doc, this.viewSize.w, this.viewSize.h); s.needsFit = false; this.notify(); }
  actualSize() { this.zoomTo(1); }
  zoomTo(z: number, cx = this.viewSize.w / 2, cy = this.viewSize.h / 2) {
    const s = this.active; if (!s) return;
    s.view = zoomAt(s.view, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)), cx, cy); s.needsFit = false; this.notify();
  }
  zoomStep(dir: 1 | -1, cx?: number, cy?: number) {
    const s = this.active; if (!s) return;
    const steps = [0.02, 0.05, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
    const z = s.view.zoom;
    const next = dir > 0 ? steps.find(v => v > z * 1.001) ?? MAX_ZOOM : [...steps].reverse().find(v => v < z / 1.001) ?? MIN_ZOOM;
    this.zoomTo(next, cx, cy);
  }

  // ---------- helpers for tools ----------
  brushParams(color: RGB): BrushParams { return fullBrush({ ...DEFAULT_BRUSH, ...this.brush, color }); }
  selection(): Selection | null { return this.active?.doc.selection ?? null; }
  rasterActive(): RasterLayer | null { const l = this.activeLayer; return l && l.kind === 'raster' ? l : null; }

  syncTitle() {
    const s = this.active;
    const t = s ? `${s.name}${s.engine.isDirty ? ' •' : ''} — Pixel Studio` : 'Pixel Studio';
    if (document.title !== t) { document.title = t; void window.pixelStudio?.setTitle(t); }
  }
}

function loadActions(): Action[] {
  try {
    const raw = localStorage.getItem('ps.actions.v1');
    if (!raw) return [];
    const reg = createDefaultRegistry();
    const arr = JSON.parse(raw) as unknown[];
    return arr.map(a => parseActionJson(JSON.stringify(a), reg).action).filter((a): a is Action => !!a);
  } catch { return []; }
}
function saveActions(a: Action[]) { try { localStorage.setItem('ps.actions.v1', JSON.stringify(a)); } catch { /* storage unavailable */ } }

export const store = new EditorStore();
gpuForNewSession = () => (store.gpuMode === 'auto' ? store.gpu : null);
export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
