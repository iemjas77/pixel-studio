import { useEffect, useRef, useState } from 'react';
import { store, useStore, type Dialog, type RGB, type ToolId } from './store';
import { Viewport } from './Viewport';
import { ActionsPanel, ColorPanel, HistoryPanel, LayersPanel, PropertiesPanel } from './panels';
import { runBatch, type BatchReport } from '@ps/automation';
import { makeBatchIO, type BatchFormat } from './batch';
import { Close, Logo, ToolIcons } from './icons';
import { SHORTCUT_LIST, installShortcuts } from './shortcuts';

// ------------------------------------------------------------------ Menu bar
interface Item { label: string; run?: () => void; disabled?: boolean; shortcut?: string; sep?: boolean; sub?: Item[] }

function useMenus(): { name: string; items: Item[] }[] {
  const st = store;
  const s = st.active; const l = st.activeLayer;
  const has = !!s;
  const rasterL = !!l && l.kind === 'raster';
  return [
    { name: 'File', items: [
      { label: 'New…', shortcut: 'Ctrl+N', run: () => { st.dialog = { kind: 'new' }; st.notify(); } },
      { label: 'Open…', shortcut: 'Ctrl+O', run: () => void st.openFromDialog('document') },
      { label: 'Place Image as Layer…', disabled: !has, run: () => void st.placeImage() },
      { label: '', sep: true },
      { label: 'Save', shortcut: 'Ctrl+S', disabled: !has, run: () => void st.save(false) },
      { label: 'Save As…', shortcut: 'Ctrl+Shift+S', disabled: !has, run: () => void st.save(true) },
      { label: 'Export flattened PNG…', disabled: !has, run: () => void st.exportAs('png') },
      { label: 'Export flattened JPEG…', disabled: !has, run: () => { st.dialog = { kind: 'export', fmt: 'jpg' }; st.notify(); } },
      { label: 'Export flattened WebP…', disabled: !has, run: () => { st.dialog = { kind: 'export', fmt: 'webp' }; st.notify(); } },
      { label: 'Export flattened TIFF…', disabled: !has, run: () => void st.exportAs('tif') },
      { label: 'Export flattened PSD (composite only)…', disabled: !has, run: () => void st.exportAs('psd') },
      { label: 'Batch…', disabled: !st.actions.length, run: () => { st.dialog = { kind: 'batch' }; st.notify(); } },
      { label: '', sep: true },
      { label: 'Close document', shortcut: 'Ctrl+W', disabled: !has, run: () => void st.requestCloseSession(st.activeIndex) },
    ] },
    { name: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !s?.engine.canUndo, run: () => st.undo() },
      { label: 'Redo', shortcut: 'Ctrl+Shift+Z', disabled: !s?.engine.canRedo, run: () => st.redo() },
      { label: '', sep: true },
      { label: 'Fill with foreground', shortcut: 'Alt+Delete', disabled: !has, run: () => st.fillSelection(st.fg) },
      { label: 'Fill with background', shortcut: 'Ctrl+Delete', disabled: !has, run: () => st.fillSelection(st.bg) },
      { label: 'Clear', shortcut: 'Delete', disabled: !has, run: () => st.clearSelection() },
      { label: '', sep: true },
      { label: 'Select all', shortcut: 'Ctrl+A', disabled: !has, run: () => st.selectAll() },
      { label: 'Deselect', shortcut: 'Ctrl+D', disabled: !s?.doc.selection, run: () => st.deselect() },
    ] },
    { name: 'Layer', items: [
      { label: 'New layer', disabled: !has, run: () => st.addLayer() },
      { label: 'Duplicate layer', shortcut: 'Ctrl+J', disabled: !l, run: () => st.duplicateLayer() },
      { label: 'Delete layer', disabled: !l, run: () => st.deleteLayer() },
      { label: 'Group layer', disabled: !l, run: () => st.groupLayer() },
      { label: '', sep: true },
      { label: 'Add mask: reveal all', disabled: !l || !!l.mask, run: () => st.addMask('reveal') },
      { label: 'Add mask: hide all', disabled: !l || !!l.mask, run: () => st.addMask('hide') },
      { label: 'Add mask: from selection', disabled: !l || !!l.mask || !s?.doc.selection, run: () => st.addMask('selection') },
      { label: 'Delete mask', disabled: !l?.mask, run: () => st.exec({ type: 'mask.delete', params: { id: l!.id } }) },
      { label: 'Apply mask', disabled: !l?.mask || !rasterL, run: () => st.exec({ type: 'mask.apply', params: { id: l!.id } }) },
      { label: '', sep: true },
      { label: 'Rasterize text', disabled: l?.kind !== 'text', run: () => st.exec({ type: 'text.rasterize', params: { id: l!.id } }) },
      { label: '', sep: true },
      { label: 'Flip horizontal', disabled: !rasterL, run: () => st.transform('flipH') },
      { label: 'Flip vertical', disabled: !rasterL, run: () => st.transform('flipV') },
      { label: 'Rotate 90° clockwise', disabled: !rasterL, run: () => st.transform('rot90cw') },
      { label: 'Rotate 90° counter-clockwise', disabled: !rasterL, run: () => st.transform('rot90ccw') },
      { label: 'Rotate 180°', disabled: !rasterL, run: () => st.transform('rot180') },
      { label: 'Scale…', disabled: !rasterL, run: () => { st.dialog = { kind: 'scale' }; st.notify(); } },
    ] },
    { name: 'View', items: [
      { label: 'Zoom in', shortcut: 'Ctrl+=', disabled: !has, run: () => st.zoomStep(1) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', disabled: !has, run: () => st.zoomStep(-1) },
      { label: 'Fit on screen', shortcut: 'Ctrl+0', disabled: !has, run: () => st.fit() },
      { label: 'Actual pixels (100%)', shortcut: 'Ctrl+1', disabled: !has, run: () => st.actualSize() },
      { label: '', sep: true },
      { label: `Compositing: ${st.gpuMode === 'auto' ? '✓ ' : ''}GPU (experimental, CPU fallback)`, disabled: !st.gpu, run: () => st.setGpuMode('auto') },
      { label: `Compositing: ${st.gpuMode === 'cpu' ? '✓ ' : ''}CPU reference only`, run: () => st.setGpuMode('cpu') },
      { label: `Blend in linear light (document) ${s?.doc.canvas.blendSpace === 'linear' ? '✓' : ''}`, disabled: !has, run: () => st.exec({ type: 'doc.blendSpace', params: { space: s?.doc.canvas.blendSpace === 'linear' ? 'srgb' : 'linear' } }) },
    ] },
    { name: 'Help', items: [
      { label: 'Keyboard shortcuts', run: () => { st.dialog = { kind: 'shortcuts' }; st.notify(); } },
      { label: 'About Pixel Studio', run: () => { st.dialog = { kind: 'about' }; st.notify(); } },
    ] },
  ];
}

function MenuBar() {
  useStore();
  const menus = useMenus();
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, []);
  return (
    <div className="menubar" role="menubar" ref={ref}>
      <span className="brand"><Logo /><b>Pixel Studio</b></span>
      {menus.map((m, i) => (
        <div key={m.name} className="menu">
          <button role="menuitem" aria-haspopup="menu" aria-expanded={open === i} className={open === i ? 'open' : ''}
            onClick={() => setOpen(open === i ? null : i)} onMouseEnter={() => open !== null && setOpen(i)}>{m.name}</button>
          {open === i && (
            <div className="dropdown" role="menu" aria-label={m.name}>
              {m.items.map((it, j) => it.sep ? <hr key={j} /> : (
                <button key={j} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(null); it.run?.(); }}>
                  <span>{it.label}</span><kbd>{it.shortcut}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="preview-badge" title="Engineering preview: CPU reference engine, sRGB 8-bit, no colour management">Engineering preview</span>
    </div>
  );
}

// ------------------------------------------------------------------ Tool rail
const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'move', label: 'Move', key: 'V' }, { id: 'marquee', label: 'Rectangular Marquee', key: 'M' }, { id: 'brush', label: 'Brush', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' }, { id: 'text', label: 'Text', key: 'T' }, { id: 'eyedropper', label: 'Eyedropper', key: 'I' },
  { id: 'hand', label: 'Hand', key: 'H' }, { id: 'zoom', label: 'Zoom', key: 'Z' },
];
function ToolRail() {
  const st = useStore();
  return (
    <nav className="toolrail" aria-label="Tools" role="toolbar" aria-orientation="vertical">
      {TOOLS.map(t => (
        <button key={t.id} className={'tool' + (st.tool === t.id ? ' active' : '')} aria-label={`${t.label} (${t.key})`} aria-pressed={st.tool === t.id}
          title={`${t.label} (${t.key})`} data-testid={`tool-${t.id}`} onClick={() => { st.tool = t.id; st.notify(); }}>{ToolIcons[t.id]}</button>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ Options bar
function Num({ label, value, min, max, step = 1, onChange, suffix = '', testid }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string; testid?: string }) {
  return (
    <label className="opt">{label}
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={e => onChange(+e.target.value)} />
      <input type="number" min={min} max={max} step={step} value={Math.round(value * 100) / 100} aria-label={`${label} value`} data-testid={testid} onChange={e => { const v = +e.target.value; if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v))); }} />{suffix}
    </label>
  );
}
function OptionsBar() {
  const st = useStore();
  const b = st.brush;
  const set = (p: Partial<typeof b>) => { st.brush = { ...st.brush, ...p }; st.notify(); };
  const s = st.active;
  return (
    <div className="optionsbar" role="toolbar" aria-label="Tool options">
      {(st.tool === 'brush' || st.tool === 'eraser') && <>
        <strong className="optname">{st.tool === 'brush' ? 'Brush' : 'Eraser'}</strong>
        <Num label="Size" value={b.size} min={1} max={500} onChange={v => set({ size: v })} suffix="px" testid="brush-size" />
        <Num label="Hardness" value={Math.round(b.hardness * 100)} min={0} max={100} onChange={v => set({ hardness: v / 100 })} suffix="%" />
        <Num label="Opacity" value={Math.round(b.opacity * 100)} min={1} max={100} onChange={v => set({ opacity: v / 100 })} suffix="%" testid="brush-opacity" />
        <Num label="Flow" value={Math.round(b.flow * 100)} min={1} max={100} onChange={v => set({ flow: v / 100 })} suffix="%" />
        <Num label="Spacing" value={Math.round(b.spacing * 100)} min={1} max={200} onChange={v => set({ spacing: v / 100 })} suffix="%" />
        <label className="opt chk"><input type="checkbox" checked={b.pressureSize} onChange={e => set({ pressureSize: e.target.checked })} />Pressure→size</label>
        <label className="opt chk"><input type="checkbox" checked={b.pressureOpacity} onChange={e => set({ pressureOpacity: e.target.checked })} />Pressure→flow</label>
        {s?.editTarget === 'mask' && <span className="tag">Painting on layer mask (black hides, white reveals)</span>}
      </>}
      {st.tool === 'marquee' && <>
        <strong className="optname">Rectangular Marquee</strong>
        <button className="btn small" disabled={!s} onClick={() => st.selectAll()}>Select all</button>
        <button className="btn small" disabled={!s?.doc.selection} onClick={() => st.deselect()}>Deselect</button>
        <span className="muted">{s?.doc.selection ? `Selection ${s.doc.selection.w}×${s.doc.selection.h} at ${s.doc.selection.x}, ${s.doc.selection.y}` : 'Drag on the canvas to select. Add/subtract, feather and other shapes are planned (M9).'}</span>
      </>}
      {st.tool === 'move' && <>
        <strong className="optname">Move</strong>
        <span className="muted">Drag to move the active layer · arrow keys nudge 1 px (Shift 10)</span>
        <button className="btn small" disabled={!s} onClick={() => st.transform('flipH')}>Flip H</button>
        <button className="btn small" disabled={!s} onClick={() => st.transform('flipV')}>Flip V</button>
        <button className="btn small" disabled={!s} onClick={() => st.transform('rot90cw')}>Rotate 90°</button>
        <button className="btn small" disabled={!s} onClick={() => { st.dialog = { kind: 'scale' }; st.notify(); }}>Scale…</button>
      </>}
      {st.tool === 'text' && <>
        <strong className="optname">Text</strong>
        <label className="opt">Font<input type="text" value={st.textDefaults.fontFamily} aria-label="Default font family" onChange={e => { st.textDefaults = { ...st.textDefaults, fontFamily: e.target.value || 'Arial' }; st.notify(); }} /></label>
        <Num label="Size" value={st.textDefaults.fontSize} min={4} max={400} onChange={v => { st.textDefaults = { ...st.textDefaults, fontSize: v }; st.notify(); }} suffix="px" />
        <span className="muted">Click the canvas to add text; click existing text to edit it in Properties.</span>
      </>}
      {st.tool === 'eyedropper' && <><strong className="optname">Eyedropper</strong><span className="muted">Click to sample the composite into the foreground colour (Alt: background).</span></>}
      {st.tool === 'hand' && <><strong className="optname">Hand</strong><span className="muted">Drag to pan. Hold Space with any tool to pan temporarily.</span></>}
      {st.tool === 'zoom' && <><strong className="optname">Zoom</strong>
        <span className="muted">Click to zoom in, Alt+click to zoom out.</span>
        <button className="btn small" disabled={!s} onClick={() => st.fit()}>Fit</button>
        <button className="btn small" disabled={!s} onClick={() => st.actualSize()}>100%</button></>}
    </div>
  );
}

// ------------------------------------------------------------------ Tabs + status
function Tabs() {
  const st = useStore();
  return (
    <div className="tabs" role="tablist" aria-label="Open documents">
      {st.sessions.map((s, i) => (
        <div key={s.doc.id} className={'tab' + (i === st.activeIndex ? ' active' : '')} role="tab" aria-selected={i === st.activeIndex} data-testid="doc-tab">
          <button className="tabname" onClick={() => st.switchTo(i)}>{s.name}{s.engine.isDirty ? ' •' : ''}</button>
          <button className="icon-btn" aria-label={`Close ${s.name}`} onClick={() => void st.requestCloseSession(i)}><Close /></button>
        </div>
      ))}
    </div>
  );
}
function StatusBar() {
  const st = useStore();
  const s = st.active;
  const sel = s?.doc.selection;
  return (
    <footer className="statusbar" role="status" aria-live="polite">
      <span className={'msg ' + st.status.kind} data-testid="status">{st.status.text}</span>
      {s && <>
        <span data-testid="docinfo">{s.doc.canvas.width} × {s.doc.canvas.height} px · {s.doc.canvas.resolutionPpi} ppi · {s.doc.canvas.mode}/{s.doc.canvas.bitDepth} · {s.doc.canvas.profile.assumed ? 'sRGB (assumed, unmanaged)' : s.doc.canvas.profile.name}</span>
        {sel && <span>Sel {sel.w}×{sel.h}</span>}
        <span data-testid="backend" title="Compositing backend">{st.backendLabel}</span>
        <span id="ps-cursor" className="cursorpos">–</span>
        <span className="zoomctl">
          <button className="icon-btn txt" aria-label="Zoom out" onClick={() => st.zoomStep(-1)}>−</button>
          <span data-testid="zoom">{Math.round(s.view.zoom * 1000) / 10}%</span>
          <button className="icon-btn txt" aria-label="Zoom in" onClick={() => st.zoomStep(1)}>+</button>
          <button className="icon-btn txt" onClick={() => st.fit()}>Fit</button>
        </span>
        <span data-testid="savestate" className={s.engine.isDirty ? 'dirty' : 'clean'}>{s.engine.isDirty ? (s.lastAutosaveTime ? `Unsaved · autosaved ${new Date(s.lastAutosaveTime).toLocaleTimeString()}` : 'Unsaved changes') : (s.path ? 'Saved' : 'No changes')}</span>
      </>}
    </footer>
  );
}

// ------------------------------------------------------------------ Dialogs
function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current?.querySelector<HTMLElement>('input,button.primary,button'); el?.focus(); }, []);
  return (
    <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title} ref={ref} data-testid="dialog">
        <h2>{title}</h2>{children}
      </div>
    </div>
  );
}

function NewDialog() {
  const st = store;
  const [name, setName] = useState('Untitled');
  const [w, setW] = useState(1920), [h, setH] = useState(1080), [ppi, setPpi] = useState(72);
  const [bg, setBg] = useState<'white' | 'transparent' | 'fg'>('white');
  const bad = !(w >= 1 && h >= 1 && w <= 16384 && h <= 16384 && w * h <= 100_000_000);
  const presets: [string, number, number][] = [['HD 1920×1080', 1920, 1080], ['Square 2000', 2000, 2000], ['A4 @300ppi', 2480, 3508], ['4K 3840×2160', 3840, 2160], ['Web 1200×630', 1200, 630]];
  return (
    <Modal title="New document" onClose={() => st.closeDialog()}>
      <form onSubmit={e => { e.preventDefault(); if (bad) return; st.dialog = null; st.newDocument({ name, width: w, height: h, ppi, background: bg === 'fg' ? (st.fg as RGB) : bg }); }}>
        <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} aria-label="Document name" /></label>
        <div className="presets">{presets.map(p => <button type="button" key={p[0]} className="btn small" onClick={() => { setW(p[1]); setH(p[2]); if (p[0].includes('300')) setPpi(300); }}>{p[0]}</button>)}</div>
        <div className="grid2">
          <label className="field"><span>Width (px)</span><input type="number" value={w} onChange={e => setW(+e.target.value)} aria-label="Width" data-testid="new-w" /></label>
          <label className="field"><span>Height (px)</span><input type="number" value={h} onChange={e => setH(+e.target.value)} aria-label="Height" data-testid="new-h" /></label>
          <label className="field"><span>Resolution (ppi)</span><input type="number" value={ppi} onChange={e => setPpi(+e.target.value)} aria-label="Resolution" /></label>
          <label className="field"><span>Background</span>
            <select value={bg} onChange={e => setBg(e.target.value as typeof bg)} aria-label="Background"><option value="white">White</option><option value="transparent">Transparent</option><option value="fg">Foreground colour</option></select></label>
        </div>
        <p className="muted small">RGB · 8 bit · sRGB (assumed, unmanaged). Preview build limits: 16 384 px per side, 100 megapixels.</p>
        {bad && <p className="warn">Size must be 1–16 384 px per side and ≤ 100 megapixels.</p>}
        <div className="row end"><button type="button" className="btn" onClick={() => st.closeDialog()}>Cancel</button><button className="btn primary" disabled={bad} data-testid="new-ok">Create</button></div>
      </form>
    </Modal>
  );
}
function ScaleDialog() {
  const st = store;
  const [sx, setSx] = useState(100), [sy, setSy] = useState(100), [link, setLink] = useState(true);
  const ok = sx >= 1 && sy >= 1 && sx <= 1000 && sy <= 1000;
  return (
    <Modal title="Scale layer" onClose={() => st.closeDialog()}>
      <form onSubmit={e => { e.preventDefault(); if (!ok) return; st.dialog = null; st.scaleLayer(sx / 100, sy / 100); }}>
        <div className="grid2">
          <label className="field"><span>Width %</span><input type="number" value={sx} aria-label="Width percent" onChange={e => { setSx(+e.target.value); if (link) setSy(+e.target.value); }} /></label>
          <label className="field"><span>Height %</span><input type="number" value={sy} aria-label="Height percent" onChange={e => { setSy(+e.target.value); if (link) setSx(+e.target.value); }} /></label>
        </div>
        <label className="opt chk"><input type="checkbox" checked={link} onChange={e => setLink(e.target.checked)} />Keep proportions</label>
        <p className="muted small">Bilinear resampling about the layer’s centre. Reference quality: downscaling by more than 2× may alias.</p>
        <div className="row end"><button type="button" className="btn" onClick={() => st.closeDialog()}>Cancel</button><button className="btn primary" disabled={!ok}>Scale</button></div>
      </form>
    </Modal>
  );
}
function ExportDialog({ fmt }: { fmt: 'jpg' | 'webp' }) {
  const [q, setQ] = useState(90);
  return (
    <Modal title={`Export flattened ${fmt.toUpperCase()}`} onClose={() => store.closeDialog()}>
      <p className="muted small">Exports the visible composite as one flattened image. Layers, masks and editable text are not included — use Save to keep them.</p>
      <label className="field"><span>Quality {q}</span><input type="range" min={1} max={100} value={q} onChange={e => setQ(+e.target.value)} aria-label="Quality" /></label>
      <div className="row end"><button className="btn" onClick={() => store.closeDialog()}>Cancel</button><button className="btn primary" onClick={() => { store.dialog = null; void store.exportAs(fmt, q / 100); }}>Export…</button></div>
    </Modal>
  );
}

function NameActionDialog() {
  const st = store;
  const [name, setName] = useState(`Action ${st.actions.length + 1}`);
  return (
    <Modal title="Save recorded action" onClose={() => st.closeDialog()}>
      <form onSubmit={e => { e.preventDefault(); st.dialog = null; st.stopRecording(name.trim() || 'Untitled action'); }}>
        <label className="field"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} aria-label="Action name" data-testid="action-name" /></label>
        <p className="muted small">Steps record allow-listed commands with symbolic layer targets; pixel coordinates are absolute.</p>
        <div className="row end">
          <button type="button" className="btn" onClick={() => { st.dialog = null; st.stopRecording(null); }}>Discard</button>
          <button type="button" className="btn" onClick={() => st.closeDialog()}>Keep recording</button>
          <button className="btn primary" data-testid="action-save">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function BatchDialog() {
  const st = store;
  const [ai, setAi] = useState(st.selectedAction);
  const [inp, setInp] = useState<{ dir: string; files: { name: string }[] } | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [fmt, setFmt] = useState<BatchFormat>('png');
  const [template, setTemplate] = useState('{name}');
  const [policy, setPolicy] = useState<'skip' | 'overwrite' | 'rename'>('rename');
  const [conc, setConc] = useState(2);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const sig = useRef({ aborted: false });
  const action = st.actions[ai];
  const ready = !!(action && inp && inp.files.length && out && /^[^\\/:*?"<>|]*$/.test(template) && template.length > 0);
  const run = async () => {
    if (!ready || !action || !inp || !out) return;
    sig.current = { aborted: false }; setRunning(true); setReport(null); setProgress({ done: 0, total: inp.files.length });
    const io = makeBatchIO({ inDir: inp.dir, outDir: out, format: fmt, quality: 0.92, template });
    const rep = await runBatch(inp.files.map((f, i) => ({ id: `j${i}`, name: f.name })), io, {
      action, overwrite: policy, concurrency: conc, signal: sig.current, onProgress: (done, total) => setProgress({ done, total }),
    });
    setReport(rep); setRunning(false);
  };
  return (
    <Modal title="Batch" wide onClose={() => { if (!running) st.closeDialog(); }}>
      <div className="grid2">
        <label className="field"><span>Action</span><select value={ai} onChange={e => setAi(+e.target.value)} aria-label="Batch action">{st.actions.map((a, i) => <option key={i} value={i}>{a.name}</option>)}</select></label>
        <label className="field"><span>Output format</span><select value={fmt} onChange={e => setFmt(e.target.value as BatchFormat)} aria-label="Output format">
          <option value="pstudio">.pstudio (layers kept)</option><option value="png">PNG (flattened)</option><option value="jpg">JPEG (flattened)</option><option value="webp">WebP (flattened)</option><option value="tif">TIFF (flattened)</option><option value="psd">PSD (flattened composite)</option></select></label>
        <div className="field"><span>Input folder</span><button className="btn small" disabled={running} data-testid="batch-in" onClick={async () => { const r = await window.pixelStudio?.pickFolder('in'); if (r) setInp(r); }}>Choose…</button></div>
        <div className="field"><span>Output folder</span><button className="btn small" disabled={running} data-testid="batch-out" onClick={async () => { const r = await window.pixelStudio?.pickFolder('out'); if (r) setOut(r.dir); }}>Choose…</button></div>
        <label className="field"><span>Naming</span><input value={template} onChange={e => setTemplate(e.target.value)} aria-label="Output name template" /></label>
        <label className="field"><span>If file exists</span><select value={policy} onChange={e => setPolicy(e.target.value as typeof policy)} aria-label="Overwrite policy"><option value="rename">Rename (name-1)</option><option value="skip">Skip</option><option value="overwrite">Overwrite</option></select></label>
        <label className="field"><span>Parallel jobs</span><input type="number" min={1} max={4} value={conc} onChange={e => setConc(Math.max(1, Math.min(4, +e.target.value || 1)))} aria-label="Parallel jobs" /></label>
      </div>
      <p className="muted small" data-testid="batch-summary">{inp ? `${inp.files.length} supported file(s) in ${inp.dir}` : 'No input folder chosen.'} · {out ? `→ ${out}` : 'No output folder chosen.'} · Name template uses {'{name}'}. Each file runs in its own isolated document; the open documents are never touched.</p>
      {progress && <progress value={progress.done} max={progress.total} aria-label="Batch progress" />}
      {report && (
        <div data-testid="batch-report">
          <p><b>{report.cancelledRun ? 'Cancelled' : 'Finished'}:</b> {report.ok} ok · {report.failed} failed · {report.skipped} skipped · {report.cancelled} cancelled</p>
          <ul className="recover">{report.results.map(r => <li key={r.job.id}><span>{r.job.name} <span className="muted small">→ {r.status}{r.output ? ` (${r.output})` : ''}{r.error ? `: ${r.error}` : ''}</span></span></li>)}</ul>
        </div>
      )}
      <div className="row end">
        {running ? <button className="btn" onClick={() => { sig.current.aborted = true; }} data-testid="batch-cancel">Cancel batch</button>
          : <><button className="btn" onClick={() => st.closeDialog()}>Close</button><button className="btn primary" disabled={!ready} onClick={() => void run()} data-testid="batch-run">Run</button></>}
      </div>
    </Modal>
  );
}

function Dialogs() {
  const st = useStore();
  const d: Dialog | null = st.dialog;
  if (!d) return null;
  switch (d.kind) {
    case 'new': return <NewDialog />;
    case 'scale': return <ScaleDialog />;
    case 'batch': return <BatchDialog />;
    case 'nameAction': return <NameActionDialog />;
    case 'export': return <ExportDialog fmt={d.fmt} />;
    case 'about': return (
      <Modal title="About Pixel Studio" onClose={() => st.closeDialog()}>
        <p><b>Pixel Studio</b> — engineering preview 0.1.0</p>
        <p className="muted small">An original raster editor. This preview uses a TypeScript reference raster engine and CPU compositor, 8-bit RGB with sRGB assumed (no ICC management), and has no PSD support. See docs/HANDOVER.md for the full status.</p>
        <div className="row end"><button className="btn primary" onClick={() => st.closeDialog()}>Close</button></div>
      </Modal>);
    case 'shortcuts': return (
      <Modal title="Keyboard shortcuts" wide onClose={() => st.closeDialog()}>
        <table className="shortcuts"><tbody>{SHORTCUT_LIST.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
        <div className="row end"><button className="btn primary" onClick={() => st.closeDialog()}>Close</button></div>
      </Modal>);
    case 'message': return (
      <Modal title={d.title} onClose={() => st.closeDialog()}>
        <p className="pre" data-testid="dialog-message">{d.message}</p>
        <div className="row end"><button className="btn primary" onClick={() => st.closeDialog()}>OK</button></div>
      </Modal>);
    case 'confirm': return (
      <Modal title={d.title} onClose={() => st.closeDialog()}>
        <p>{d.message}</p>
        <div className="row end">{d.buttons.map(b => <button key={b.label} className={'btn' + (b.primary ? ' primary' : '')} onClick={async () => { st.dialog = null; st.notify(); await b.run(); }}>{b.label}</button>)}</div>
      </Modal>);
    case 'recover': return (
      <Modal title="Recover unsaved documents" onClose={() => st.closeDialog()}>
        <p>Pixel Studio found autosaved copies from a previous session:</p>
        <ul className="recover">{d.items.map(it => (
          <li key={it.id}><span>{it.name} <span className="muted small">{new Date(it.time).toLocaleString()}</span></span>
            <button className="btn small primary" onClick={() => { st.dialog = null; void st.recover(it.id, it.name); }}>Recover</button>
            <button className="btn small" onClick={async () => { await window.pixelStudio?.recovery.discard(it.id); const rest = d.items.filter(x => x.id !== it.id); st.dialog = rest.length ? { kind: 'recover', items: rest } : null; st.notify(); }}>Discard</button></li>
        ))}</ul>
        <div className="row end"><button className="btn" onClick={() => st.closeDialog()}>Decide later</button></div>
      </Modal>);
  }
}

// ------------------------------------------------------------------ App
export function App() {
  const st = useStore();
  useEffect(() => {
    const off = installShortcuts();
    const t = window.setInterval(() => void store.autosaveTick(), 15000);
    const offClose = window.pixelStudio?.onRequestClose(() => void store.handleWindowClose());
    void store.checkRecovery();
    // drag-and-drop open
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      await store.openBytes(f.name, new Uint8Array(await f.arrayBuffer()), null);
    };
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { off(); window.clearInterval(t); offClose?.(); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);
  return (
    <div className="app">
      <MenuBar />
      <OptionsBar />
      <div className="workspace">
        <ToolRail />
        <main className="center">
          <Tabs />
          <Viewport />
        </main>
        <aside className="dock" aria-label="Panels">
          <ColorPanel />
          <PropertiesPanel />
          <LayersPanel />
          <HistoryPanel />
          <ActionsPanel />
        </aside>
      </div>
      <StatusBar />
      <Dialogs />
      {st.status.kind === 'error' && <div className="toast" role="alert" key={st.status.id}>{st.status.text}</div>}
    </div>
  );
}
