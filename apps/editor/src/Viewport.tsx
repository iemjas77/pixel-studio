import { useEffect, useRef } from 'react';
import { StrokeSession, type Rect } from '@ps/raster';
import { absoluteOffset, findLayer, type Layer } from '@ps/document';
import { drawDocument } from './viewport';
import { store, useStore, type ToolId } from './store';

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; panX: number; panY: number }
  | { kind: 'stroke'; sess: StrokeSession; layerId: string; plane: 'pixels' | 'mask'; mode: 'paint' | 'erase'; off: { x: number; y: number }; pts: number[][]; brush: ReturnType<typeof store.brushParams> }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move'; layerId: string; startX: number; startY: number; orig: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'eyedrop'; alt: boolean }
  | { kind: 'gradient'; x0: number; y0: number; x1: number; y1: number };

const CURSORS: Record<ToolId, string> = { gradient: 'crosshair', move: 'move', marquee: 'crosshair', brush: 'none', eraser: 'none', text: 'text', eyedropper: 'crosshair', hand: 'grab', zoom: 'zoom-in' };

export function Viewport() {
  useStore();
  const wrap = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);

  // ---- rendering ----
  useEffect(() => {
    const draw = () => {
      const m = main.current, o = over.current, w = wrap.current;
      if (!m || !o || !w) return;
      const dpr = window.devicePixelRatio || 1;
      const cw = w.clientWidth, ch = w.clientHeight;
      if (m.width !== Math.round(cw * dpr) || m.height !== Math.round(ch * dpr)) {
        for (const c of [m, o]) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); c.style.width = cw + 'px'; c.style.height = ch + 'px'; }
      }
      store.viewSize = { w: cw, h: ch };
      const s = store.active;
      const g = m.getContext('2d')!, og = o.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); og.setTransform(dpr, 0, 0, dpr, 0, 0);
      og.clearRect(0, 0, cw, ch);
      if (!s) { g.fillStyle = '#101113'; g.fillRect(0, 0, cw, ch); return; }
      if (s.needsFit && cw > 0) store.fit();
      drawDocument(g, s.cache, s.doc, s.view, cw, ch);
      drawOverlay(og, cw, ch);
    };
    const drawOverlay = (g: CanvasRenderingContext2D, _cw: number, _ch: number) => {
      const s = store.active!;
      const z = s.view.zoom;
      const rectPath = (r: Rect) => { g.beginPath(); g.rect(Math.round(s.view.panX + r.x * z) + 0.5, Math.round(s.view.panY + r.y * z) + 0.5, Math.round(r.w * z), Math.round(r.h * z)); };
      const ants = (r: Rect) => {
        rectPath(r); g.lineWidth = 1; g.setLineDash([]); g.strokeStyle = '#fff'; g.stroke();
        g.setLineDash([5, 5]); g.strokeStyle = '#000'; g.stroke(); g.setLineDash([]);
      };
      if (s.doc.selection) ants(s.doc.selection);
      const gs = gesture.current;
      if (gs?.kind === 'marquee') ants(normRect(gs.x0, gs.y0, gs.x1, gs.y1));
      if (gs?.kind === 'gradient') { g.beginPath(); g.moveTo(s.view.panX + gs.x0 * z, s.view.panY + gs.y0 * z); g.lineTo(s.view.panX + gs.x1 * z, s.view.panY + gs.y1 * z); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); }
      // text layer bounds
      const l = store.activeLayer;
      if (l?.kind === 'text' && (store.tool === 'text' || store.tool === 'move')) {
        const b = s.text.get(l.id, l.text).bounds;
        if (b) {
          const o = absoluteOffset(s.doc, l.id);
          g.strokeStyle = '#3ddcc8'; g.lineWidth = 1; g.setLineDash([3, 3]);
          g.strokeRect(Math.round(s.view.panX + (o.x + b.x) * z) + 0.5, Math.round(s.view.panY + (o.y + b.y) * z) + 0.5, Math.round(b.w * z), Math.round(b.h * z));
          g.setLineDash([]);
        }
      }
      // brush cursor
      const h = hover.current;
      if (h && (store.tool === 'brush' || store.tool === 'eraser') && !store.spaceDown) {
        const rad = Math.max(0.5, (store.brush.size * z) / 2);
        const sx = s.view.panX + h.x * z, sy = s.view.panY + h.y * z;
        g.beginPath(); g.arc(sx, sy, rad, 0, Math.PI * 2); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.85)'; g.stroke();
        g.beginPath(); g.arc(sx, sy, rad + 1, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
      }
    };
    const off = store.onRedraw(draw);
    const ro = new ResizeObserver(() => store.requestRedraw());
    if (wrap.current) ro.observe(wrap.current);
    store.requestRedraw();
    return () => { off(); ro.disconnect(); };
  }, []);

  // ---- wheel ----
  useEffect(() => {
    const el = over.current!;
    const onWheel = (e: WheelEvent) => {
      const s = store.active; if (!s) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * 0.0025);
        store.zoomTo(s.view.zoom * f, e.clientX - r.left, e.clientY - r.top);
      } else {
        s.view = { ...s.view, panX: s.view.panX - (e.shiftKey ? e.deltaY : e.deltaX), panY: s.view.panY - (e.shiftKey ? 0 : e.deltaY) };
        s.needsFit = false; store.requestRedraw();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toDoc = (e: { clientX: number; clientY: number }) => {
    const s = store.active!;
    const r = over.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - s.view.panX) / s.view.zoom, y: (e.clientY - r.top - s.view.panY) / s.view.zoom, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const finishGesture = (cancel: boolean) => {
    const g = gesture.current; gesture.current = null;
    const s = store.active;
    if (!g || !s) return;
    if (g.kind === 'stroke') {
      if (cancel) {
        g.sess.cancel(); s.cache.invalidateAll();
      } else {
        const diff = g.sess.finish();
        if (diff.after.size) {
          s.engine.record(
            { type: 'paint.stroke', params: { layerId: g.layerId, plane: g.plane, mode: g.mode, brush: g.brush, points: g.pts } },
            g.mode === 'erase' ? 'Eraser' : 'Brush Stroke',
            [{ op: 'tiles.apply', layerId: g.layerId, plane: g.plane, changes: diff.after }],
            [{ op: 'tiles.apply', layerId: g.layerId, plane: g.plane, changes: diff.before }],
          );
        }
      }
    } else if (g.kind === 'move') {
      const l = findLayer(s.doc, g.layerId)?.layer;
      if (l) l.offset = { ...g.orig };
      s.cache.invalidateAll();
      if (!cancel && (g.dx || g.dy)) store.exec({ type: 'layer.offset', params: { id: g.layerId, dx: g.dx, dy: g.dy } });
    } else if (g.kind === 'gradient') {
      const l = store.activeLayer;
      if (!cancel && l && Math.hypot(g.x1 - g.x0, g.y1 - g.y0) >= 2) {
        store.exec({ type: 'gradient.fill', params: { layerId: l.id, plane: s.editTarget, kind: store.gradientKind, from: [Math.round(g.x0 * 10) / 10, Math.round(g.y0 * 10) / 10], to: [Math.round(g.x1 * 10) / 10, Math.round(g.y1 * 10) / 10], c0: [...store.fg, 255], c1: [...store.bg, 255] } });
      }
    } else if (g.kind === 'marquee') {
      if (!cancel) {
        const r = normRect(g.x0, g.y0, g.x1, g.y1);
        if (r.w < 1 || r.h < 1) { if (s.doc.selection) store.deselect(); }
        else store.exec({ type: 'selection.rect', params: { x: r.x, y: r.y, w: r.w, h: r.h } });
      }
    }
    store.notify();
  };

  const onDown = (e: React.PointerEvent) => {
    const s = store.active; if (!s) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toDoc(e);
    let tool: ToolId = store.tool;
    if (store.spaceDown || e.button === 1) tool = 'hand';
    else if (e.button !== 0) return;
    switch (tool) {
      case 'hand': gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, panX: s.view.panX, panY: s.view.panY }; break;
      case 'zoom': store.zoomStep(e.altKey ? -1 : 1, p.sx, p.sy); break;
      case 'eyedropper': gesture.current = { kind: 'eyedrop', alt: e.altKey }; sampleColor(Math.floor(p.x), Math.floor(p.y), e.altKey); break;
      case 'gradient': {
        const l = store.activeLayer;
        if (!l) { store.setStatus('Select a layer first.', 'error'); break; }
        const why = store.paintBlockReason(l.id, s.editTarget);
        if (why) { store.setStatus(why, 'error'); break; }
        gesture.current = { kind: 'gradient', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        break;
      }
      case 'marquee': gesture.current = { kind: 'marquee', x0: Math.round(p.x), y0: Math.round(p.y), x1: Math.round(p.x), y1: Math.round(p.y) }; break;
      case 'move': {
        const l = store.activeLayer;
        if (!l) { store.setStatus('Select a layer to move.', 'error'); break; }
        try { s.engine.registry.get('layer.offset')!.check!(s.doc, { id: l.id }); } catch (err) { store.setStatus((err as Error).message, 'error'); break; }
        gesture.current = { kind: 'move', layerId: l.id, startX: p.x, startY: p.y, orig: { ...l.offset }, dx: 0, dy: 0 };
        break;
      }
      case 'text': textClick(p.x, p.y); break;
      case 'brush': case 'eraser': {
        const l = store.activeLayer;
        if (!l) { store.setStatus('Select a layer to paint on.', 'error'); break; }
        const plane = s.editTarget;
        const why = store.paintBlockReason(l.id, plane);
        if (why) { store.setStatus(why, 'error'); break; }
        const tiles = plane === 'mask' ? l.mask!.tiles : (l as Extract<Layer, { kind: 'raster' }>).pixels;
        const off = absoluteOffset(s.doc, l.id);
        const mode = tool === 'eraser' ? 'erase' : 'paint';
        const color = plane === 'mask' ? store.fg : store.fg; // on masks the colour's luma is used: black hides, white reveals
        const brush = store.brushParams(color);
        const sel = s.doc.selection;
        const clip = sel ? (x: number, y: number) => (x >= sel.x && x < sel.x + sel.w && y >= sel.y && y < sel.y + sel.h ? 1 : 0) : null;
        const sess = new StrokeSession(tiles, brush, mode, clip, off);
        const pr = pressureOf(e);
        const g: Gesture = { kind: 'stroke', sess, layerId: l.id, plane, mode, off, pts: [], brush };
        gesture.current = g;
        addStrokePoint(g, p.x, p.y, pr);
        flushStroke(g);
        break;
      }
    }
    store.requestRedraw();
  };

  const pressureOf = (e: { pointerType: string; pressure: number }) => (e.pointerType === 'pen' ? Math.max(0.01, e.pressure) : 1);
  const addStrokePoint = (g: Extract<Gesture, { kind: 'stroke' }>, x: number, y: number, pr: number) => {
    const last = g.pts[g.pts.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < 0.4 && Math.abs(last[2] - pr) < 0.02) return;
    g.pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(pr * 1000) / 1000]);
    const q = g.pts[g.pts.length - 1];
    g.sess.addPoint(q[0] - g.off.x, q[1] - g.off.y, q[2]);
  };
  const flushStroke = (g: Extract<Gesture, { kind: 'stroke' }>) => {
    const r = g.sess.takeDirtyRect();
    const s = store.active;
    if (r && s) s.cache.invalidateRect({ x: r.x + g.off.x, y: r.y + g.off.y, w: r.w, h: r.h });
  };

  const onMove = (e: React.PointerEvent) => {
    const s = store.active; if (!s) return;
    const p = toDoc(e);
    hover.current = { x: p.x, y: p.y };
    store.cursorDoc = { x: Math.floor(p.x), y: Math.floor(p.y) };
    const g = gesture.current;
    if (g) {
      switch (g.kind) {
        case 'pan': s.view = { ...s.view, panX: g.panX + e.clientX - g.sx, panY: g.panY + e.clientY - g.sy }; s.needsFit = false; break;
        case 'stroke': {
          const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
          for (const ce of evs.length ? evs : [e.nativeEvent]) {
            const q = toDoc(ce);
            addStrokePoint(g, q.x, q.y, pressureOf(ce));
          }
          flushStroke(g);
          break;
        }
        case 'marquee': g.x1 = Math.round(p.x); g.y1 = Math.round(p.y); break;
        case 'gradient': g.x1 = p.x; g.y1 = p.y; break;
        case 'move': {
          g.dx = Math.round(p.x - g.startX); g.dy = Math.round(p.y - g.startY);
          const l = findLayer(s.doc, g.layerId)?.layer;
          if (l) { l.offset = { x: g.orig.x + g.dx, y: g.orig.y + g.dy }; s.cache.invalidateAll(); }
          break;
        }
        case 'eyedrop': sampleColor(Math.floor(p.x), Math.floor(p.y), g.alt); break;
      }
    }
    store.requestRedraw();
    statusCursor();
  };
  const statusCursor = () => { const el = document.getElementById('ps-cursor'); if (el && store.cursorDoc) el.textContent = `${store.cursorDoc.x}, ${store.cursorDoc.y} px`; };

  const sampleColor = (x: number, y: number, alt: boolean) => {
    const c = store.active?.cache.sample(x, y);
    if (!c || c[3] === 0) return;
    if (alt) store.bg = [c[0], c[1], c[2]]; else store.fg = [c[0], c[1], c[2]];
    store.notify();
  };

  const textClick = (x: number, y: number) => {
    const s = store.active!;
    // hit-test existing text layers (top-most first)
    const hit = [...s.doc.layers].reverse().find(l => {
      if (l.kind !== 'text' || !l.visible) return false;
      const b = s.text.get(l.id, l.text).bounds;
      return !!b && x >= l.offset.x + b.x && x <= l.offset.x + b.x + b.w && y >= l.offset.y + b.y && y <= l.offset.y + b.y + b.h;
    });
    if (hit) { store.selectLayer(hit.id); store.textFocusRequest++; store.notify(); return; }
    const r = store.exec({ type: 'text.create', params: { x: Math.round(x), y: Math.round(y), data: { text: 'Text', color: [...store.fg, 255], ...store.textDefaults } } });
    if (r?.layerId) { s.activeLayerId = r.layerId; s.editTarget = 'pixels'; store.textFocusRequest++; store.notify(); }
  };

  const onUp = (_e: React.PointerEvent) => finishGesture(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && gesture.current) finishGesture(true); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const tool: ToolId = store.spaceDown ? 'hand' : store.tool;
  let cursor = CURSORS[tool];
  if ((tool === 'brush' || tool === 'eraser') && store.brush.size * (store.active?.view.zoom ?? 1) < 4) cursor = 'crosshair';
  if (tool === 'hand' && gesture.current?.kind === 'pan') cursor = 'grabbing';

  return (
    <div className="viewport" ref={wrap} data-testid="viewport">
      <canvas ref={main} className="vp-main" aria-hidden="true" />
      <canvas
        ref={over} className="vp-over" style={{ cursor }} data-testid="canvas" tabIndex={0}
        aria-label={store.active ? `Canvas of ${store.active.name}` : 'Canvas (no document open)'}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => finishGesture(true)}
        onPointerLeave={() => { hover.current = null; store.requestRedraw(); }}
      />
      {!store.active && (
        <div className="empty-state">
          <h2>Pixel Studio</h2>
          <p>Create a document or open an image to start.</p>
          <div className="row">
            <button className="btn primary" onClick={() => { store.dialog = { kind: 'new' }; store.notify(); }}>New document…</button>
            <button className="btn" onClick={() => void store.openFromDialog('document')}>Open…</button>
          </div>
        </div>
      )}
    </div>
  );
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}
