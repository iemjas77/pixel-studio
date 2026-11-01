import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ART, docFingerprint, launch, newDoc, type Launched } from './harness';
import { decodePng, encodePng } from './png';

let L: Launched | null = null;
afterEach(async () => { if (L) { await L.app.close().catch(() => {}); L = null; } });
const solid = (w: number, h: number, c: number[]) => { const a = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) a.set(c, i * 4); return a; };
const menu = async (name: string, item: string) => {
  await L!.page.click(`[role=menubar] button:text-is("${name}")`);
  await L!.page.click(`[role=menu] [role=menuitem]:has-text("${item}")`);
};

describe('E2E 3: record Action → replay → save/load → batch', () => {
  it('records in the UI, replays undoably on another document, round-trips through a file and runs a batch with per-file errors', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e3-'));
    const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out'); fs.mkdirSync(inDir); fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(inDir, 'blue.png'), encodePng(50, 40, solid(50, 40, [0, 0, 255, 255])));
    fs.writeFileSync(path.join(inDir, 'green.png'), encodePng(30, 20, solid(30, 20, [0, 255, 0, 255])));
    fs.writeFileSync(path.join(inDir, 'bad.png'), Buffer.from('not an image at all'));
    fs.writeFileSync(path.join(inDir, 'notes.txt'), 'ignored: unsupported extension');
    const actionFile = path.join(tmp, 'tint.psaction'), tif = path.join(tmp, 'flat.tif');
    L = await launch({ tmp, dialogs: [actionFile, actionFile, inDir, outDir, tif] });
    const { page } = L;
    await newDoc(page, 200, 150, 'white');

    // ---- record ----
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [255, 0, 0]; s.notify(); });
    await page.click('[data-testid=act-record]');
    await page.click('[aria-label="New layer"]');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Alt+Delete');
    await page.locator('[data-testid=opacity]').fill('50');
    await page.locator('[data-testid=opacity]').dispatchEvent('pointerup');
    await page.waitForFunction(() => (window as any).__ps.store.active.engine.entries.some((e: any) => e.label === 'Layer Opacity'));
    await page.click('[data-testid=act-stop]');
    await page.fill('[data-testid=action-name]', 'Red tint');
    await page.click('[data-testid=action-save]');
    const action = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__ps.store.actions[0])));
    expect(action.name).toBe('Red tint');
    expect(action.steps.map((s: any) => s.type)).toEqual(['layer.add', 'selection.all', 'edit.fill', 'layer.set']);
    expect(action.steps[2].params.layerId).toBe('$created:0');
    expect(action.steps[3].params.id).toBe('$created:0');

    // ---- replay on a different document: one undo step ----
    await newDoc(page, 120, 90, 'white');
    const fpBefore = await docFingerprint(page);
    const n = await page.evaluate(() => (window as any).__ps.store.active.engine.entries.length);
    await page.click('[data-testid=act-play]');
    await page.waitForFunction((n) => (window as any).__ps.store.active.engine.entries.length === n + 1, n);
    const after = await page.evaluate(() => { const s = (window as any).__ps.store.active; return { layers: s.doc.layers.length, op: s.doc.layers[1].opacity, label: s.engine.entries.at(-1).label, px: s.cache.sample(60, 40) }; });
    expect(after.layers).toBe(2); expect(after.op).toBe(0.5); expect(after.label).toBe('Action: Red tint');
    expect(after.px).toEqual([255, 128, 128, 255]);
    await page.keyboard.press('Control+z');
    expect(await docFingerprint(page)).toBe(fpBefore);

    // ---- save to file, delete, load back; also reject a hostile file ----
    await page.click('.actionbtns button:text-is("Save…")');
    await page.waitForFunction(() => /Saved action/.test(document.querySelector('[data-testid=status]')!.textContent!));
    expect(JSON.parse(fs.readFileSync(actionFile, 'utf8')).steps).toHaveLength(4);
    await page.click('.actionbtns button:text-is("Delete")');
    expect(await page.evaluate(() => (window as any).__ps.store.actions.length)).toBe(0);
    await page.click('.actionbtns button:text-is("Load…")');
    await page.waitForFunction(() => (window as any).__ps.store.actions.length === 1);
    expect(await page.evaluate(() => (window as any).__ps.store.actions[0])).toEqual(action);

    // ---- batch ----
    const liveFp = await docFingerprint(page);
    await page.click('[data-testid=act-batch]');
    await page.click('[data-testid=batch-in]');
    await page.waitForFunction(() => /3 supported file/.test(document.querySelector('[data-testid=batch-summary]')!.textContent!));
    await page.click('[data-testid=batch-out]');
    await page.selectOption('select[aria-label="Output format"]', 'png');
    await page.fill('input[aria-label="Output name template"]', '{name}_tinted');
    await page.selectOption('select[aria-label="Overwrite policy"]', 'skip');
    await page.click('[data-testid=batch-run]');
    await page.waitForSelector('[data-testid=batch-report]');
    let rep = (await page.textContent('[data-testid=batch-report]'))!;
    expect(rep).toMatch(/2 ok · 1 failed · 0 skipped/);
    expect(rep).toMatch(/bad\.png → failed/);
    expect(rep).toMatch(/blue\.png → ok \(blue_tinted\.png\)/);
    await page.screenshot({ path: path.join(ART, 'batch-report.png') });
    expect(fs.readdirSync(outDir).sort()).toEqual(['blue_tinted.png', 'green_tinted.png']);
    const b = decodePng(new Uint8Array(fs.readFileSync(path.join(outDir, 'blue_tinted.png'))));
    const g = decodePng(new Uint8Array(fs.readFileSync(path.join(outDir, 'green_tinted.png'))));
    expect([b.width, b.height]).toEqual([50, 40]); expect([g.width, g.height]).toEqual([30, 20]);
    const close = (a: number[], e: number[]) => a.forEach((v, i) => expect(Math.abs(v - e[i])).toBeLessThanOrEqual(1));
    close(Array.from(b.rgba.subarray(0, 4)), [128, 0, 128, 255]);
    close(Array.from(g.rgba.subarray(4 * (10 * 30 + 15), 4 * (10 * 30 + 15) + 4)), [128, 128, 0, 255]);
    // second run with policy "skip": nothing overwritten
    const mtime = fs.statSync(path.join(outDir, 'blue_tinted.png')).mtimeMs;
    await page.click('[data-testid=batch-run]');
    await page.waitForFunction(() => /0 ok · 1 failed · 2 skipped/.test((document.querySelector('[data-testid=batch-report]')?.textContent ?? '')));
    expect(fs.statSync(path.join(outDir, 'blue_tinted.png')).mtimeMs).toBe(mtime);
    // policy "rename"
    await page.selectOption('select[aria-label="Overwrite policy"]', 'rename');
    await page.click('[data-testid=batch-run]');
    await page.waitForFunction(() => /2 ok · 1 failed/.test((document.querySelector('[data-testid=batch-report]')?.textContent ?? '')));
    expect(fs.readdirSync(outDir).sort()).toEqual(['blue_tinted-1.png', 'blue_tinted.png', 'green_tinted-1.png', 'green_tinted.png']);
    await page.keyboard.press('Escape');
    // the interactive document was never touched by the batch
    expect(await docFingerprint(page)).toBe(liveFp);

    // ---- flattened TIFF export validated by Pillow ----
    await menu('File', 'Export flattened TIFF');
    await page.waitForFunction(() => /Exported flattened TIF/.test(document.querySelector('[data-testid=status]')!.textContent!));
    const info = execFileSync('python3', ['-I', '-c', 'import sys,PIL.Image as I; im=I.open(sys.argv[1]); im.load(); print(im.format, im.mode, im.size[0], im.size[1])', tif]).toString().trim();
    expect(info).toBe('TIFF RGBA 120 90');
    expect(L.errors).toEqual([]);
  }, 180000);

  it('refuses hostile action files with a clear list of problems and executes nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e3b-'));
    const evil = path.join(tmp, 'evil.psaction');
    fs.writeFileSync(evil, JSON.stringify({ format: 'pixel-studio-action', version: 1, name: 'evil', steps: [
      { type: 'layer.add', version: 1, params: {} }, { type: 'shell.exec', version: 1, params: { cmd: 'calc' } }, { type: 'layer.set', version: 1, params: { id: '$created:5', props: {} }, run: 'x' },
    ] }));
    L = await launch({ tmp, dialogs: [evil] });
    const { page } = L;
    await newDoc(page, 50, 50);
    const fp = await docFingerprint(page);
    await page.click('.actionbtns button:text-is("Load…")');
    await page.waitForSelector('[data-testid=dialog-message]');
    const m = (await page.textContent('[data-testid=dialog-message]'))!;
    expect(m).toMatch(/unsupported operation “shell.exec”/);
    expect(m).toMatch(/unknown field “run”/);
    expect(m).toMatch(/Nothing was imported or executed/);
    expect(await page.evaluate(() => (window as any).__ps.store.actions.length)).toBe(0);
    expect(await docFingerprint(page)).toBe(fp);
  }, 120000);
});
