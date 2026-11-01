import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const ART = path.join(ROOT, 'e2e-artifacts');

export interface Launched { app: ElectronApplication; page: Page; userData: string; tmp: string; errors: string[] }

export async function launch(opts: { dialogs?: (string | null)[]; userData?: string; tmp?: string } = {}): Promise<Launched> {
  fs.mkdirSync(ART, { recursive: true });
  const tmp = opts.tmp ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-'));
  const userData = opts.userData ?? path.join(tmp, 'userdata');
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron'),
    args: [ROOT, '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    env: { ...process.env, PIXEL_STUDIO_E2E: '1', PIXEL_STUDIO_USER_DATA: userData, PIXEL_STUDIO_E2E_DIALOGS: JSON.stringify(opts.dialogs ?? []) } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForSelector('[data-testid=viewport]');
  return { app, page, userData, tmp, errors };
}

export async function newDoc(page: Page, w = 400, h = 300, bg: 'white' | 'transparent' = 'white') {
  await page.keyboard.press('Control+n');
  await page.fill('[data-testid=new-w]', String(w));
  await page.fill('[data-testid=new-h]', String(h));
  await page.selectOption('select[aria-label=Background]', bg);
  await page.click('[data-testid=new-ok]');
  await page.waitForSelector('[data-testid=doc-tab]');
  await page.waitForTimeout(150);
}

/** Map document coordinates to client (window) coordinates using the live view. */
export async function docToClient(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => {
    const st = (window as any).__ps.store; const s = st.active;
    const r = (document.querySelector('[data-testid=canvas]') as HTMLElement).getBoundingClientRect();
    return { x: r.left + s.view.panX + x * s.view.zoom, y: r.top + s.view.panY + y * s.view.zoom };
  }, [x, y] as const);
}

export async function drag(page: Page, pts: [number, number][], steps = 8) {
  const p0 = await docToClient(page, pts[0][0], pts[0][1]);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) { const p = await docToClient(page, x, y); await page.mouse.move(p.x, p.y, { steps }); }
  await page.mouse.up();
}

export const pickTool = (page: Page, id: string) => page.click(`[data-testid=tool-${id}]`);

/** Read pixels of a layer plane from the live document (RGBA straight) for assertions. */
export async function layerPixel(page: Page, layerId: string | null, x: number, y: number, plane: 'pixels' | 'mask' = 'pixels'): Promise<number[]> {
  return page.evaluate(([id, x, y, plane]) => {
    const s = (window as any).__ps.store.active;
    const find = (ls: any[]): any => { for (const l of ls) { if (l.id === (id ?? s.activeLayerId)) return l; if (l.children) { const r = find(l.children); if (r) return r; } } };
    const l = find(s.doc.layers);
    const st = plane === 'mask' ? l.mask.tiles : l.pixels;
    return Array.from(st.getPixel(x - l.offset.x, y - l.offset.y)) as number[];
  }, [layerId, x, y, plane] as const);
}

/** FNV hash over all layer tiles + props: a stable fingerprint of document state. */
export async function docFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (window as any).__ps.store.active;
    let h = 2166136261 >>> 0;
    const feed = (u8: Uint8Array) => { for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; } };
    const enc = new TextEncoder();
    const walk = (ls: any[]) => {
      for (const l of ls) {
        feed(enc.encode(JSON.stringify({ id: l.id, k: l.kind, n: l.name, v: l.visible, o: l.opacity, b: l.blendMode, off: l.offset, t: l.text ?? null, m: l.mask ? [l.mask.enabled, l.mask.tiles.fill] : null })));
        for (const st of [l.pixels, l.mask?.tiles]) if (st) for (const k of [...st.tiles.keys()].sort()) { feed(enc.encode(k)); feed(st.tiles.get(k)); }
        if (l.children) walk(l.children);
      }
    };
    walk(s.doc.layers);
    return `${s.doc.layers.length}:${h.toString(16)}`;
  });
}
export const layerNames = (page: Page) => page.evaluate(() => (window as any).__ps.store.active.doc.layers.map((l: any) => l.name) as string[]);
export const activeId = (page: Page) => page.evaluate(() => (window as any).__ps.store.active.activeLayerId as string);
