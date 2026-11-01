import { store, type ToolId } from './store';

/** Single default shortcut map ("Pixel Studio" preset). Editable mappings are planned (M10). */
export const TOOL_KEYS: Record<string, ToolId> = { g: 'gradient', v: 'move', m: 'marquee', b: 'brush', e: 'eraser', t: 'text', i: 'eyedropper', h: 'hand', z: 'zoom' };

export const SHORTCUT_LIST: [string, string][] = [
  ['B / E / G / V / M / T / I / H / Z', 'Brush / Eraser / Gradient / Move / Marquee / Text / Eyedropper / Hand / Zoom'],
  ['X  ·  D', 'Swap colours  ·  default colours'],
  ['[  ]', 'Decrease / increase brush size'],
  ['Ctrl+N / O / S / Shift+S / W', 'New / Open / Save / Save As / Close'],
  ['Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y', 'Undo · Redo · Redo'],
  ['Ctrl+A · Ctrl+D', 'Select all · Deselect'],
  ['Ctrl+J', 'Duplicate layer'],
  ['Delete', 'Clear selection (or whole layer) '],
  ['Alt+Delete · Ctrl+Delete', 'Fill with foreground · background colour'],
  ['Arrow keys (Move tool)', 'Nudge layer 1 px (Shift: 10 px)'],
  ['Ctrl+0 · Ctrl+1 · Ctrl+= · Ctrl+-', 'Fit · 100 % · Zoom in · Zoom out'],
  ['Space (hold) · middle mouse', 'Pan'],
  ['Ctrl+wheel · wheel', 'Zoom at cursor · scroll'],
  ['Esc', 'Cancel current gesture / close dialog'],
];

export function installShortcuts() {
  const down = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape' && store.dialog) { store.closeDialog(); return; }
    if (store.dialog) return;
    if (e.code === 'Space' && !typing && !e.repeat) { store.spaceDown = true; store.notify(); e.preventDefault(); return; }
    if (typing && !(mod && ['s', 'o', 'n'].includes(k))) return;
    if (mod) {
      let handled = true;
      switch (k) {
        case 'n': store.dialog = { kind: 'new' }; store.notify(); break;
        case 'o': void store.openFromDialog('document'); break;
        case 's': void store.save(e.shiftKey); break;
        case 'w': if (store.active) void store.requestCloseSession(store.activeIndex); break;
        case 'z': e.shiftKey ? store.redo() : store.undo(); break;
        case 'y': store.redo(); break;
        case 'a': store.selectAll(); break;
        case 'd': store.deselect(); break;
        case 'j': store.duplicateLayer(); break;
        case '0': store.fit(); break;
        case '1': store.actualSize(); break;
        case '=': case '+': store.zoomStep(1); break;
        case '-': store.zoomStep(-1); break;
        case 'delete': case 'backspace': store.fillSelection(store.bg); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (e.altKey) store.fillSelection(store.fg); else store.clearSelection();
      return;
    }
    if (e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) { store.fillSelection(store.fg); return; }
    const tool = TOOL_KEYS[k];
    if (tool) { store.tool = tool; store.notify(); e.preventDefault(); return; }
    if (k === 'x') { [store.fg, store.bg] = [store.bg, store.fg]; store.notify(); return; }
    if (k === 'd') { store.fg = [0, 0, 0]; store.bg = [255, 255, 255]; store.notify(); return; }
    if (e.key === '[') { store.brush.size = Math.max(1, Math.round(store.brush.size * 0.85 - 1)); store.notify(); return; }
    if (e.key === ']') { store.brush.size = Math.min(2048, Math.round(store.brush.size * 1.15 + 1)); store.notify(); return; }
    if (store.tool === 'move' && e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const l = store.activeLayer;
      if (!l) return;
      e.preventDefault();
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]!;
      store.exec({ type: 'layer.offset', params: { id: l.id, dx: d[0], dy: d[1] } });
    }
  };
  const up = (e: KeyboardEvent) => { if (e.code === 'Space' && store.spaceDown) { store.spaceDown = false; store.notify(); } };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
}
