import { useEffect, useRef, useState } from 'react';
import { BLEND_MODES, type TileStore } from '@ps/raster';
import { findLayer, walkLayers, type GroupLayer, type Layer, type TextData } from '@ps/document';
import { store, useStore, type DocSession, type RGB } from './store';
import { Copy, Eye, Folder, Lock, MaskIcon, Plus, Swap, TextIcon, Trash } from './icons';
import { fontAvailable } from './text';

const hex = (c: RGB) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const parseHex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function Panel({ title, children, grow, actions }: { title: string; children: React.ReactNode; grow?: boolean; actions?: React.ReactNode }) {
  return (
    <section className={'panel' + (grow ? ' grow' : '')} aria-label={title}>
      <header><h3>{title}</h3><div className="panel-actions">{actions}</div></header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------ Color
export function ColorPanel() {
  const st = useStore();
  const swatches: RGB[] = [[0, 0, 0], [255, 255, 255], [239, 68, 68], [249, 115, 22], [234, 179, 8], [34, 197, 94], [20, 184, 166], [59, 130, 246], [139, 92, 246], [236, 72, 153], [120, 113, 108], [214, 211, 209]];
  const ch = (i: number, v: number) => { const c = [...st.fg] as RGB; c[i] = Math.max(0, Math.min(255, v | 0)); st.fg = c; st.notify(); };
  return (
    <Panel title="Color">
      <div className="color-top">
        <div className="fgbg">
          <label className="sw bgsw" title="Background colour"><input type="color" aria-label="Background colour" value={hex(st.bg)} onChange={e => { st.bg = parseHex(e.target.value); st.notify(); }} /><span style={{ background: hex(st.bg) }} /></label>
          <label className="sw fgsw" title="Foreground colour"><input type="color" aria-label="Foreground colour" data-testid="fg-color" value={hex(st.fg)} onChange={e => { st.fg = parseHex(e.target.value); st.notify(); }} /><span style={{ background: hex(st.fg) }} /></label>
          <button className="icon-btn swapbtn" aria-label="Swap foreground and background (X)" title="Swap (X)" onClick={() => { [st.fg, st.bg] = [st.bg, st.fg]; st.notify(); }}><Swap /></button>
        </div>
        <div className="rgb">
          {(['R', 'G', 'B'] as const).map((n, i) => (
            <label key={n}>{n}
              <input type="range" min={0} max={255} value={st.fg[i]} aria-label={`Foreground ${n}`} onChange={e => ch(i, +e.target.value)} />
              <input type="number" min={0} max={255} value={st.fg[i]} aria-label={`Foreground ${n} value`} onChange={e => ch(i, +e.target.value)} />
            </label>
          ))}
          <label>#<input type="text" className="hexin" aria-label="Foreground hex" value={hex(st.fg).slice(1)} maxLength={6} onChange={e => { if (/^[0-9a-fA-F]{6}$/.test(e.target.value)) { st.fg = parseHex('#' + e.target.value); st.notify(); } }} /></label>
        </div>
      </div>
      <div className="swatches" role="group" aria-label="Swatches">
        {swatches.map((c, i) => <button key={i} className="swatch" style={{ background: hex(c) }} aria-label={`Set foreground ${hex(c)}`} onClick={() => { st.fg = c; st.notify(); }} />)}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ Thumbs
function Thumb({ tiles, ox, oy, w, h, fill = 0, mask = false }: { tiles: TileStore; ox: number; oy: number; w: number; h: number; fill?: number; mask?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = store.getVersion();
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const S = 32;
    const g = c.getContext('2d')!;
    const img = g.createImageData(S, S);
    const sc = Math.max(w, h) / S;
    const px = new Uint8Array(4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = Math.floor((x + 0.5) * sc), dy = Math.floor((y + 0.5) * sc);
      const i = (y * S + x) * 4;
      const inside = dx < w && dy < h;
      const checker = ((x >> 2) + (y >> 2)) & 1 ? 150 : 200;
      let r = checker, gg = checker, b = checker;
      if (inside) {
        tiles.getPixel(dx - ox, dy - oy, px);
        if (mask) { r = gg = b = px[0]; }
        else { const a = px[3] / 255; r = px[0] * a + checker * (1 - a); gg = px[1] * a + checker * (1 - a); b = px[2] * a + checker * (1 - a); }
      } else { r = gg = b = 40; }
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [tiles, ox, oy, w, h, fill, mask, version]);
  return <canvas ref={ref} width={32} height={32} className="thumb" aria-hidden="true" />;
}

// ------------------------------------------------------------------ Layers
interface Row { layer: Layer; depth: number; parent: GroupLayer | null; index: number }
function flatten(list: Layer[], depth: number, parent: GroupLayer | null, s: DocSession, out: Row[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i];
    out.push({ layer: l, depth, parent, index: i });
    if (l.kind === 'group' && !s.collapsed.has(l.id)) flatten(l.children, depth + 1, l, s, out);
  }
}

export function LayersPanel() {
  const st = useStore();
  const s = st.active;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: 'above' | 'below' | 'into' } | null>(null);
  const drag = useRef<string | null>(null);
  if (!s) return <Panel title="Layers" grow><p className="muted pad">No document.</p></Panel>;
  const rows: Row[] = [];
  flatten(s.doc.layers, 0, null, s, rows);
  const { width, height } = s.doc.canvas;

  const doDrop = (target: Row, pos: 'above' | 'below' | 'into') => {
    const id = drag.current; drag.current = null; setDrop(null);
    if (!id || id === target.layer.id) return;
    const src = findLayer(s.doc, id)!;
    let parentId: string | null; let index: number;
    if (pos === 'into' && target.layer.kind === 'group') { parentId = target.layer.id; index = target.layer.children.length; }
    else {
      parentId = target.parent ? target.parent.id : null;
      index = pos === 'above' ? target.index + 1 : target.index;
    }
    const sameList = (src.parent?.id ?? null) === parentId;
    if (sameList && src.index < index) index -= 1;
    st.exec({ type: 'layer.move', params: { id, parentId: parentId ?? undefined, index } as Record<string, unknown> });
  };

  return (
    <Panel title="Layers" grow actions={<>
      <button className="icon-btn" aria-label="New layer" title="New layer" onClick={() => st.addLayer()}><Plus /></button>
      <button className="icon-btn" aria-label="Group layer" title="Group layer" onClick={() => st.groupLayer()}><Folder /></button>
      <button className="icon-btn" aria-label="Add layer mask (reveal all)" title="Add mask" onClick={() => st.addMask('reveal')}><MaskIcon /></button>
      <button className="icon-btn" aria-label="Duplicate layer" title="Duplicate (Ctrl+J)" onClick={() => st.duplicateLayer()}><Copy /></button>
      <button className="icon-btn" aria-label="Delete layer" title="Delete layer" onClick={() => st.deleteLayer()}><Trash /></button>
    </>}>
      <ul className="layers" role="listbox" aria-label="Layer list" data-testid="layers">
        {rows.map(r => {
          const l = r.layer; const active = s.activeLayerId === l.id;
          const od = drop?.id === l.id ? drop.pos : null;
          return (
            <li key={l.id} role="option" aria-selected={active} data-layer-id={l.id} data-testid={`layer-row`}
              className={'layer' + (active ? ' active' : '') + (od ? ` drop-${od}` : '') + (!l.visible ? ' hidden-layer' : '')}
              style={{ paddingLeft: 6 + r.depth * 16 }} draggable
              onDragStart={e => { drag.current = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', l.id); }}
              onDragOver={e => { e.preventDefault(); const b = e.currentTarget.getBoundingClientRect(); const f = (e.clientY - b.top) / b.height; setDrop({ id: l.id, pos: l.kind === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below' }); }}
              onDragLeave={() => setDrop(null)}
              onDrop={e => { e.preventDefault(); doDrop(r, drop?.id === l.id ? drop.pos : 'above'); }}
              onClick={() => st.selectLayer(l.id, 'pixels')}
              onDoubleClick={() => setRenaming(l.id)}>
              <button className="icon-btn vis" aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`} aria-pressed={l.visible} onClick={e => { e.stopPropagation(); st.exec({ type: 'layer.set', params: { id: l.id, props: { visible: !l.visible } } }); }}><Eye on={l.visible} /></button>
              {l.kind === 'group' && <button className="icon-btn twist" aria-label={s.collapsed.has(l.id) ? 'Expand group' : 'Collapse group'} onClick={e => { e.stopPropagation(); s.collapsed.has(l.id) ? s.collapsed.delete(l.id) : s.collapsed.add(l.id); st.notify(); }}>{s.collapsed.has(l.id) ? '▸' : '▾'}</button>}
              <span className={'thumbwrap' + (active && s.editTarget === 'pixels' ? ' target' : '')}>
                {l.kind === 'raster' && <Thumb tiles={l.pixels} ox={l.offset.x} oy={l.offset.y} w={width} h={height} />}
                {l.kind === 'text' && <Thumb tiles={s.text.get(l.id, l.text).store} ox={l.offset.x} oy={l.offset.y} w={width} h={height} />}
                {l.kind === 'group' && <span className="thumb icon"><Folder /></span>}
                {l.kind === 'opaque' && <span className="thumb icon" title="Unsupported layer kind (preserved)">?</span>}
              </span>
              {l.mask && (
                <button className={'thumbwrap maskthumb' + (active && s.editTarget === 'mask' ? ' target' : '') + (!l.mask.enabled ? ' off' : '')} aria-label={`Edit mask of ${l.name}`} title="Layer mask (click to paint on mask)"
                  onClick={e => { e.stopPropagation(); st.selectLayer(l.id, 'mask'); }}>
                  <Thumb tiles={l.mask.tiles} ox={l.offset.x} oy={l.offset.y} w={width} h={height} mask />
                </button>
              )}
              {renaming === l.id
                ? <input className="rename" autoFocus defaultValue={l.name} aria-label="Layer name" onClick={e => e.stopPropagation()}
                    onBlur={e => { setRenaming(null); if (e.target.value && e.target.value !== l.name) st.exec({ type: 'layer.set', params: { id: l.id, props: { name: e.target.value } } }); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                : <span className="lname">{l.kind === 'text' && <TextIcon />}{l.name}</span>}
              {(l.lock.all || l.lock.pixels || l.lock.position) && <span className="lockmark" title="Locked"><Lock /></span>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ Properties
export function PropertiesPanel() {
  const st = useStore();
  const s = st.active; const l = st.activeLayer;
  const timer = useRef<number | undefined>(undefined);
  if (!s || !l) return <Panel title="Properties"><p className="muted pad">Select a layer.</p></Panel>;
  const set = (props: Record<string, unknown>) => st.exec({ type: 'layer.set', params: { id: l.id, props } });
  const commitSoon = (ms = 700) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => st.commitPreview(), ms); };
  const commitNow = () => { window.clearTimeout(timer.current); st.commitPreview(); };
  return (
    <Panel title="Properties">
      <div className="props" key={l.id}>
        <label className="field"><span>Name</span>
          <input type="text" value={l.name} aria-label="Layer name" onChange={e => st.previewLayer(l.id, { name: e.target.value })} onBlur={commitNow} onKeyDown={e => { if (e.key === 'Enter') commitNow(); }} />
        </label>
        <label className="field"><span>Opacity</span>
          <input type="range" min={0} max={100} value={Math.round(l.opacity * 100)} aria-label="Layer opacity" data-testid="opacity"
            onChange={e => { st.previewLayer(l.id, { opacity: +e.target.value / 100 }); commitSoon(900); }} onPointerUp={commitNow} onKeyUp={commitNow} onBlur={commitNow} />
          <output>{Math.round(l.opacity * 100)}%</output>
        </label>
        <label className="field"><span>Blend</span>
          <select value={l.blendMode} aria-label="Blend mode" data-testid="blend" onChange={e => set({ blendMode: e.target.value })}>
            {BLEND_MODES.map(m => <option key={m} value={m}>{m.replace('-', ' ')}</option>)}
          </select>
        </label>
        <div className="field"><span>Lock</span>
          <div className="seg">
            {(['pixels', 'position', 'all'] as const).map(k => (
              <button key={k} aria-pressed={l.lock[k]} className={l.lock[k] ? 'on' : ''} onClick={() => set({ lock: { ...l.lock, [k]: !l.lock[k] } })}>{k}</button>
            ))}
          </div>
        </div>
        {l.mask && (
          <div className="field"><span>Mask</span>
            <div className="seg">
              <button aria-pressed={s.editTarget === 'mask'} className={s.editTarget === 'mask' ? 'on' : ''} onClick={() => st.selectLayer(l.id, s.editTarget === 'mask' ? 'pixels' : 'mask')}>edit mask</button>
              <button onClick={() => st.exec({ type: 'mask.enable', params: { id: l.id, enabled: !l.mask!.enabled } })}>{l.mask.enabled ? 'disable' : 'enable'}</button>
              <button disabled={l.kind !== 'raster'} title={l.kind !== 'raster' ? 'Rasterize the text layer first' : 'Bake mask into pixels'} onClick={() => st.exec({ type: 'mask.apply', params: { id: l.id } })}>apply</button>
              <button onClick={() => st.exec({ type: 'mask.delete', params: { id: l.id } })}>delete</button>
            </div>
          </div>
        )}
        {!l.mask && l.kind !== 'opaque' && (
          <div className="field"><span>Mask</span>
            <div className="seg">
              <button onClick={() => st.addMask('reveal')}>reveal all</button>
              <button onClick={() => st.addMask('hide')}>hide all</button>
              <button disabled={!s.doc.selection} title={s.doc.selection ? '' : 'Make a selection first'} onClick={() => st.addMask('selection')}>from selection</button>
            </div>
          </div>
        )}
        {l.kind === 'text' && <TextProps layer={l} commitSoon={commitSoon} commitNow={commitNow} />}
        <p className="muted small">{l.kind} layer · origin {l.offset.x}, {l.offset.y}{s.editTarget === 'mask' ? ' · editing mask' : ''}</p>
      </div>
    </Panel>
  );
}

function TextProps({ layer, commitSoon, commitNow }: { layer: Extract<Layer, { kind: 'text' }>; commitSoon: (ms?: number) => void; commitNow: () => void }) {
  const t = layer.text;
  const st = store;
  const ta = useRef<HTMLTextAreaElement>(null);
  const focus = st.textFocusRequest;
  useEffect(() => { if (focus > 0) { ta.current?.focus(); ta.current?.select(); } }, [focus, layer.id]);
  const patch = (p: Partial<TextData>, soon = true) => { st.previewLayer(layer.id, { text: { ...t, ...p } }); if (soon) commitSoon(); };
  const missing = !fontAvailable(t.fontFamily);
  const FONTS = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana', 'Trebuchet MS', 'Courier New', 'Segoe UI', 'Calibri', 'Impact', 'Noto Sans', 'DejaVu Sans', 'sans-serif', 'serif', 'monospace'];
  const colHex = '#' + t.color.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
  return (
    <div className="textprops" data-testid="text-props">
      <textarea ref={ta} aria-label="Text content" data-testid="text-content" value={t.text} rows={3} onChange={e => patch({ text: e.target.value })} onBlur={commitNow}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitNow(); }} />
      <label className="field"><span>Font</span>
        <input list="fontlist" type="text" value={t.fontFamily} aria-label="Font family" onChange={e => e.target.value && patch({ fontFamily: e.target.value })} onBlur={commitNow} />
        <datalist id="fontlist">{FONTS.map(f => <option key={f} value={f} />)}</datalist>
      </label>
      {missing && <p className="warn small" role="status">“{t.fontFamily}” isn’t installed. The font name is kept; a substitute is shown.</p>}
      <div className="grid2">
        <label className="field"><span>Size</span><input type="number" min={1} max={4096} value={t.fontSize} aria-label="Font size" onChange={e => +e.target.value >= 1 && patch({ fontSize: +e.target.value })} onBlur={commitNow} /></label>
        <label className="field"><span>Weight</span>
          <select value={t.fontWeight} aria-label="Font weight" onChange={e => { patch({ fontWeight: +e.target.value }, false); commitNow(); }}>
            {[300, 400, 500, 600, 700, 800, 900].map(w => <option key={w} value={w}>{w}</option>)}
          </select></label>
        <label className="field"><span>Leading</span><input type="number" step={0.05} min={0.5} max={5} value={t.lineHeight} aria-label="Line height" onChange={e => +e.target.value > 0 && patch({ lineHeight: +e.target.value })} onBlur={commitNow} /></label>
        <label className="field"><span>Tracking</span><input type="number" step={0.5} min={-100} max={100} value={t.tracking} aria-label="Tracking" onChange={e => patch({ tracking: +e.target.value })} onBlur={commitNow} /></label>
        <label className="field"><span>Box width</span><input type="number" min={0} max={20000} value={t.boxWidth ?? 0} aria-label="Box width (0 = point text)" title="0 = point text" onChange={e => patch({ boxWidth: +e.target.value > 0 ? +e.target.value : null })} onBlur={commitNow} /></label>
        <label className="field"><span>Color</span><input type="color" value={colHex} aria-label="Text colour" onChange={e => { const c = parseHex(e.target.value); patch({ color: [...c, t.color[3]] as TextData['color'] }, false); commitSoon(400); }} onBlur={commitNow} /></label>
      </div>
      <div className="seg">
        {(['left', 'center', 'right'] as const).map(a => <button key={a} aria-pressed={t.align === a} className={t.align === a ? 'on' : ''} onClick={() => { patch({ align: a }, false); commitNow(); }}>{a}</button>)}
        <button aria-pressed={t.italic} className={t.italic ? 'on' : ''} onClick={() => { patch({ italic: !t.italic }, false); commitNow(); }}><i>italic</i></button>
      </div>
      <button className="btn small" onClick={() => st.exec({ type: 'text.rasterize', params: { id: layer.id } })} title="Convert to pixels. This removes editability (undoable).">Rasterize text…</button>
    </div>
  );
}

// ------------------------------------------------------------------ History
export function HistoryPanel() {
  const st = useStore();
  const s = st.active;
  if (!s) return <Panel title="History"><p className="muted pad">No document.</p></Panel>;
  const e = s.engine;
  return (
    <Panel title="History" actions={<>
      <button className="icon-btn txt" disabled={!e.canUndo} onClick={() => st.undo()} aria-label="Undo">Undo</button>
      <button className="icon-btn txt" disabled={!e.canRedo} onClick={() => st.redo()} aria-label="Redo">Redo</button>
    </>}>
      <ol className="history" aria-label="History states" data-testid="history">
        <li className={e.ptr === -1 ? 'cur' : ''}><button onClick={() => st.jump(-1)}>Original</button></li>
        {e.entries.map((h, i) => (
          <li key={h.id} className={(i === e.ptr ? 'cur ' : '') + (i > e.ptr ? 'future' : '')}><button onClick={() => st.jump(i)}>{h.label}</button></li>
        ))}
      </ol>
    </Panel>
  );
}

void walkLayers;
