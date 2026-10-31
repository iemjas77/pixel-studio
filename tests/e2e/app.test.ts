import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ART, activeId, docFingerprint, docToClient, drag, launch, layerNames, layerPixel, newDoc, pickTool, type Launched } from './harness';
import { decodePng, encodePng } from './png';

let L: Launched | null = null;
afterEach(async () => { if (L) { await L.app.close().catch(() => {}); L = null; } });
const shot = (name: string) => L!.page.screenshot({ path: path.join(ART, `${name}.png`) });
const menu = async (name: string, item: string) => {
  await L!.page.click(`[role=menubar] button:text-is("${name}")`);
  await L!.page.click(`[role=menu] [role=menuitem]:has-text("${item}")`);
};
const status = () => L!.page.textContent('[data-testid=status]');
const setBrush = async (size: number) => { await L!.page.fill('[data-testid=brush-size]', String(size)); };

describe('E2E 1: create → paint → undo/redo → save → reopen', () => {
  it('works end to end with identical pixels after reopen', async () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ps-e2e1-'));
    const file = path.join(tmp, 'work.pstudio');
    L = await launch({ tmp, dialogs: [file, file] });
    const { page } = L;
    await newDoc(page, 400, 300, 'white');
    expect(await layerNames(page)).toEqual(['Background']);
    await page.click('[aria-label="New layer"]');
    expect(await layerNames(page)).toEqual(['Background', 'Layer 2']);
    const lid = await activeId(page);

    // red brush stroke on Layer 2
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [220, 30, 40]; s.notify(); });
    await setBrush(20);
    await pickTool(page, 'brush');
    await drag(page, [[50, 50], [200, 120], [350, 60]]);
    const painted = await layerPixel(page, lid, 200, 120);
    expect(painted.slice(0, 3)).toEqual([220, 30, 40]);
    expect(painted[3]).toBe(255);
    expect(await layerPixel(page, lid, 10, 250)).toEqual([0, 0, 0, 0]);
    const fpPainted = await docFingerprint(page);
    const entries = () => page.evaluate(() => (window as any).__ps.store.active.engine.entries.map((e: any) => e.label) as string[]);
    expect(await entries()).toEqual(['New Layer', 'Brush Stroke']); // exactly one entry for the whole drag

    // second stroke then undo/redo
    await drag(page, [[60, 200], [300, 220]]);
    expect(await entries()).toHaveLength(3);
    const fp2 = await docFingerprint(page);
    await page.keyboard.press('Control+z');
    expect(await docFingerprint(page)).toBe(fpPainted);
    expect(await layerPixel(page, lid, 180, 210)).toEqual([0, 0, 0, 0]);
    await page.keyboard.press('Control+Shift+z');
    expect(await docFingerprint(page)).toBe(fp2);
    await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y');
    expect(await docFingerprint(page)).toBe(fp2);
    // redo invalidation via UI
    await page.keyboard.press('Control+z');
    await page.click('[aria-label="New layer"]');
    expect(await page.evaluate(() => (window as any).__ps.store.active.engine.canRedo)).toBe(false);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    await page.keyboard.press('Control+z');
    expect(await docFingerprint(page)).toBe(fpPainted); // back at the post-first-stroke state

    // restore known state: undo extra layer; second stroke is gone (discarded by divergence)
    expect(await page.textContent('[data-testid=savestate]')).toMatch(/Unsaved/);
    const before = await docFingerprint(page);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid=savestate]')!.textContent!));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).subarray(0, 7).toString()).toBe('PSTUDIO');
    expect(fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'))).toEqual([]);
    await shot('e1-saved');

    // close doc and reopen from disk
    await page.keyboard.press('Control+w');
    await page.waitForFunction(() => (window as any).__ps.store.sessions.length === 0);
    await page.keyboard.press('Control+o');
    await page.waitForFunction(() => (window as any).__ps.store.sessions.length === 1);
    expect(await docFingerprint(page)).toBe(before); // exact same layers + tiles
    expect(await layerPixel(page, lid, 200, 120)).toEqual(painted);
    expect(await page.textContent('[data-testid=savestate]')).toMatch(/No changes|Saved/);
    expect(L.errors).toEqual([]);
  }, 120000);
});

describe('E2E 2: import → layers → mask → text → export', () => {
  it('composites an imported PNG with a masked layer and text, exports flattened PNG with expected pixels', async () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ps-e2e2-'));
    // 120×80 source: horizontal red ramp, vertical green ramp, opaque
    const W = 120, H = 80, src = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; src[i] = Math.round((x / (W - 1)) * 255); src[i + 1] = Math.round((y / (H - 1)) * 255); src[i + 2] = 64; src[i + 3] = 255; }
    const imgPath = path.join(tmp, 'source.png'); fs.writeFileSync(imgPath, encodePng(W, H, src));
    const out = path.join(tmp, 'out.png');
    L = await launch({ tmp, dialogs: [imgPath, out] });
    const { page } = L;
    await page.keyboard.press('Control+o');
    await page.waitForFunction(() => (window as any).__ps.store.sessions.length === 1);
    expect(await page.textContent('[data-testid=docinfo]')).toContain('120 × 80');
    const base = await activeId(page);
    // pixel-exact import (opaque PNG round-trips through Chromium decoder)
    expect(await layerPixel(page, base, 60, 40)).toEqual(Array.from(src.subarray((40 * W + 60) * 4, (40 * W + 60) * 4 + 4)));

    // new layer filled solid blue, with a hide-all mask revealing only a painted spot
    await page.click('[aria-label="New layer"]');
    const top = await activeId(page);
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [0, 0, 255]; s.notify(); });
    await pickTool(page, 'marquee');
    await drag(page, [[0, 0], [120, 80]]);
    await page.keyboard.press('Alt+Delete'); // fill selection with foreground
    expect(await layerPixel(page, top, 5, 5)).toEqual([0, 0, 255, 255]);
    await page.keyboard.press('Control+d');
    await page.click('[data-testid=layers] [data-layer-id="' + top + '"]');
    await page.click('.props button:text-is("hide all")');
    expect(await layerPixel(page, top, 5, 5, 'mask')).toEqual([0]);
    // layer now invisible through mask: composite equals base
    expect(await page.evaluate(() => (window as any).__ps.store.active.cache.sample(5, 5))).toEqual(Array.from(src.subarray((5 * W + 5) * 4, (5 * W + 5) * 4 + 4)));
    // paint white on mask to reveal blue in a disc at (30,20)
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [255, 255, 255]; s.brush = { ...s.brush, size: 16, hardness: 1 }; s.notify(); });
    await pickTool(page, 'brush');
    expect(await page.locator('.optionsbar .tag').textContent()).toContain('layer mask');
    await drag(page, [[30, 20], [31, 20]], 2);
    expect(await layerPixel(page, top, 30, 20, 'mask')).toEqual([255]);
    expect(await layerPixel(page, top, 100, 70, 'mask')).toEqual([0]);
    expect(await page.evaluate(() => (window as any).__ps.store.active.cache.sample(30, 20))).toEqual([0, 0, 255, 255]);
    // layer-level opacity through the Properties slider (one history entry)
    const nEntries = await page.evaluate(() => (window as any).__ps.store.active.engine.entries.length);
    await page.locator('[data-testid=opacity]').fill('50');
    await page.locator('[data-testid=opacity]').dispatchEvent('pointerup');
    await page.waitForFunction((n) => (window as any).__ps.store.active.engine.entries.length === n + 1, nEntries);
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.opacity)).toBe(0.5);
    await page.locator('[data-testid=opacity]').fill('100'); await page.locator('[data-testid=opacity]').dispatchEvent('pointerup');

    // text layer: stays editable
    await pickTool(page, 'text');
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [255, 255, 0]; s.textDefaults = { fontFamily: 'sans-serif', fontSize: 28, fontWeight: 700 }; s.notify(); });
    const pos = await docToClient(page, 4, 40);
    await page.mouse.click(pos.x, pos.y);
    await page.waitForSelector('[data-testid=text-content]');
    await page.fill('[data-testid=text-content]', 'HELLO');
    await page.locator('[data-testid=text-content]').blur();
    await page.waitForFunction(() => (window as any).__ps.store.activeLayer?.kind === 'text' && (window as any).__ps.store.activeLayer.text.text === 'HELLO');
    const textLayer = await page.evaluate(() => { const l = (window as any).__ps.store.activeLayer; return { kind: l.kind, text: l.text.text, font: l.text.fontFamily, name: l.name }; });
    expect(textLayer).toMatchObject({ kind: 'text', text: 'HELLO', font: 'sans-serif', name: 'HELLO' });
    await shot('e2-composite');
    // painting on text is refused with an actionable message, document unchanged
    const fpText = await docFingerprint(page);
    await pickTool(page, 'brush');
    await drag(page, [[10, 10], [50, 10]], 3);
    expect(await status()).toMatch(/Rasterize/);
    expect(await docFingerprint(page)).toBe(fpText);

    // export flattened PNG
    await menu('File', 'Export flattened PNG');
    await page.waitForFunction(() => /Exported flattened PNG/.test(document.querySelector('[data-testid=status]')!.textContent!));
    const png = decodePng(new Uint8Array(fs.readFileSync(out)));
    expect([png.width, png.height]).toEqual([W, H]);
    const px = (x: number, y: number) => Array.from(png.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(px(30, 20)).toEqual([0, 0, 255, 255]);                                  // revealed through mask
    expect(px(100, 70)).toEqual(Array.from(src.subarray((70 * W + 100) * 4, (70 * W + 100) * 4 + 4))); // masked area shows imported image
    expect(px(5, 5)).toEqual(Array.from(src.subarray((5 * W + 5) * 4, (5 * W + 5) * 4 + 4)));
    let yellow = 0;
    for (let y = 30; y < 80; y++) for (let x = 0; x < 80; x++) { const p = px(x, y); if (p[0] > 230 && p[1] > 230 && p[2] < 40) yellow++; }
    expect(yellow).toBeGreaterThan(40); // text pixels in text colour
    expect(L.errors).toEqual([]);
  }, 120000);
});

describe('E2E 4: unsupported / corrupt import keeps the existing document', () => {
  it('shows a clear error and changes nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ps-e2e4-'));
    // 1) valid pstudio, truncated   2) garbage "png"   3) future-major pstudio
    const { writePstudio, crc32 } = await import('@ps/codecs');
    const { createDocument, SequentialIdSource } = await import('@ps/document');
    const good = writePstudio(createDocument(new SequentialIdSource(), { width: 20, height: 20, background: 'white' }));
    const trunc = path.join(tmp, 'trunc.pstudio'); fs.writeFileSync(trunc, good.subarray(0, good.length - 20));
    const junk = path.join(tmp, 'junk.png'); fs.writeFileSync(junk, Buffer.from('this is definitely not an image'));
    const future = Buffer.from(good); future.writeUInt16LE(2, 8); future.writeUInt32LE(crc32(future.subarray(0, 24)), 24);
    const fut = path.join(tmp, 'future.pstudio'); fs.writeFileSync(fut, future);
    L = await launch({ tmp, dialogs: [trunc, junk, fut] });
    const { page } = L;
    await newDoc(page, 200, 100, 'white');
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [10, 200, 10]; s.notify(); });
    await pickTool(page, 'brush');
    await drag(page, [[20, 20], [150, 60]]);
    const fp = await docFingerprint(page);
    const entries = await page.evaluate(() => (window as any).__ps.store.active.engine.entries.length);
    const msgs: string[] = [];
    for (const expected of [/truncated/i, /not a supported image|corrupt/i, /not supported/i]) {
      await page.keyboard.press('Control+o');
      await page.waitForSelector('[data-testid=dialog-message]');
      const m = (await page.textContent('[data-testid=dialog-message]'))!;
      msgs.push(m);
      expect(m).toMatch(expected);
      expect(m).toMatch(/not changed/);
      await shot(`e4-error-${msgs.length}`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid=dialog]', { state: 'detached' });
      expect(await page.evaluate(() => (window as any).__ps.store.sessions.length)).toBe(1);
      expect(await docFingerprint(page)).toBe(fp);
      expect(await page.evaluate(() => (window as any).__ps.store.active.engine.entries.length)).toBe(entries);
    }
    expect(L.errors).toEqual([]);
  }, 120000);
});

describe('workspace tools and panels', () => {
  it('layers, visibility, blend, move, marquee+clip, flip, groups, history jump — all via real UI', async () => {
    L = await launch();
    const { page } = L;
    await newDoc(page, 300, 200, 'white');
    // add layer, paint a block, move it, flip it
    await page.click('[aria-label="New layer"]');
    const a = await activeId(page);
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [255, 0, 0]; s.brush = { ...s.brush, size: 30, hardness: 1 }; s.notify(); });
    await pickTool(page, 'brush');
    await drag(page, [[40, 40], [41, 40]], 2);
    expect((await layerPixel(page, a, 40, 40)).slice(0, 3)).toEqual([255, 0, 0]);
    await pickTool(page, 'move');
    await drag(page, [[40, 40], [100, 90]], 6);
    expect((await layerPixel(page, a, 100, 90)).slice(0, 3)).toEqual([255, 0, 0]);
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.offset)).toEqual({ x: 60, y: 50 });
    expect(await page.evaluate(() => (window as any).__ps.store.active.engine.entries.at(-1).label)).toBe('Move Layer');
    // arrow-key nudge
    await page.locator('[data-testid=canvas]').focus();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.offset)).toEqual({ x: 61, y: 60 });
    // flip horizontal through the Layer menu
    const bbBefore = await page.evaluate(() => (window as any).__ps.store.activeLayer.pixels.contentBounds());
    await menu('Layer', 'Flip horizontal');
    const bbAfter = await page.evaluate(() => (window as any).__ps.store.activeLayer.pixels.contentBounds());
    expect(bbAfter.w).toBe(bbBefore.w);
    // blend mode + visibility via UI
    await page.selectOption('[data-testid=blend]', 'multiply');
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.blendMode)).toBe('multiply');
    await page.click(`[data-layer-id="${a}"] button[aria-label^="Hide"]`);
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.visible)).toBe(false);
    expect(await page.evaluate(() => (window as any).__ps.store.active.cache.sample(100, 90))).toEqual([255, 255, 255, 255]);
    await page.click(`[data-layer-id="${a}"] button[aria-label^="Show"]`);
    // multiply red over white = red
    expect(await page.evaluate(() => (window as any).__ps.store.active.cache.sample(100, 90))).toEqual([255, 0, 0, 255]);
    // duplicate / group / delete
    await page.keyboard.press('Control+j');
    expect((await layerNames(page)).length).toBe(3);
    await page.click('[aria-label="Group layer"]');
    expect(await page.evaluate(() => (window as any).__ps.store.active.doc.layers.some((l: any) => l.kind === 'group'))).toBe(true);
    // marquee selection clips the brush
    await pickTool(page, 'marquee');
    await drag(page, [[200, 100], [250, 150]], 4);
    expect(await page.evaluate(() => (window as any).__ps.store.active.doc.selection)).toEqual({ kind: 'rect', x: 200, y: 100, w: 50, h: 50 });
    await page.click('[aria-label="New layer"]');
    const c = await activeId(page);
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [0, 0, 0]; s.brush = { ...s.brush, size: 100 }; s.notify(); });
    await pickTool(page, 'brush');
    await drag(page, [[150, 125], [300, 125]], 6);
    expect((await layerPixel(page, c, 199, 125))[3]).toBe(0);
    expect((await layerPixel(page, c, 225, 125))[3]).toBe(255);
    expect((await layerPixel(page, c, 250, 125))[3]).toBe(0);
    // history panel jump back to "Original" and forward again
    const final = await docFingerprint(page);
    await page.click('[data-testid=history] li:first-child button');
    expect(await layerNames(page)).toEqual(['Background']);
    const n = await page.evaluate(() => (window as any).__ps.store.active.engine.entries.length);
    await page.click(`[data-testid=history] li:nth-child(${n + 1}) button`);
    expect(await docFingerprint(page)).toBe(final);
    // zoom / fit
    await page.keyboard.press('Control+1');
    expect(await page.textContent('[data-testid=zoom]')).toBe('100%');
    await page.keyboard.press('Control+0');
    await shot('workspace');
    expect(L.errors).toEqual([]);
  }, 120000);

  it('rasterize text, eraser and eyedropper work and are undoable', async () => {
    L = await launch();
    const { page } = L;
    await newDoc(page, 240, 160, 'white');
    await pickTool(page, 'text');
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [0, 0, 0]; s.textDefaults = { fontFamily: 'sans-serif', fontSize: 60, fontWeight: 700 }; s.notify(); });
    const p = await docToClient(page, 20, 20);
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('[data-testid=text-content]');
    await page.fill('[data-testid=text-content]', 'MMM');
    await page.locator('[data-testid=text-content]').blur();
    await page.waitForFunction(() => (window as any).__ps.store.activeLayer?.text?.text === 'MMM');
    await menu('Layer', 'Rasterize text');
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.kind)).toBe('raster');
    const id = await activeId(page);
    const solid = await page.evaluate(() => { const l = (window as any).__ps.store.activeLayer; const b = l.pixels.contentBounds(); return b; });
    expect(solid).not.toBeNull();
    // eraser removes pixels
    await page.evaluate(() => { const s = (window as any).__ps.store; s.brush = { ...s.brush, size: 300, hardness: 1 }; s.notify(); });
    await pickTool(page, 'eraser');
    await drag(page, [[100, 60], [101, 60]], 2);
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.pixels.tileCount)).toBe(0);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.pixels.tileCount)).toBeGreaterThan(0);
    await page.keyboard.press('Control+z'); // un-rasterize → editable text again
    expect(await page.evaluate(() => (window as any).__ps.store.activeLayer.kind)).toBe('text');
    // eyedropper samples the composite into fg
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [1, 2, 3]; s.notify(); });
    await pickTool(page, 'eyedropper');
    const bgPt = await docToClient(page, 230, 150);
    await page.mouse.click(bgPt.x, bgPt.y);
    expect(await page.evaluate(() => (window as any).__ps.store.fg)).toEqual([255, 255, 255]);
    void id;
    expect(L.errors).toEqual([]);
  }, 120000);
});

describe('recovery', () => {
  it('autosaves dirty documents and offers explicit recovery after an unclean exit', async () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ps-e2e-rec-'));
    L = await launch({ tmp });
    let { page } = L;
    await newDoc(page, 200, 150, 'white');
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [0, 128, 255]; s.notify(); });
    await pickTool(page, 'brush');
    await drag(page, [[30, 30], [160, 100]]);
    const fp = await docFingerprint(page);
    await page.evaluate(() => (window as any).__ps.store.autosaveTick());
    const rec = path.join(L.userData, 'recovery');
    await expect.poll(() => fs.readdirSync(rec).filter(f => f.endsWith('.pstudio')).length).toBe(1);
    expect(await page.textContent('[data-testid=savestate]')).toMatch(/autosaved/);
    // simulate crash: kill the process without graceful close
    const pid = L.app.process().pid!;
    process.kill(pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 800));
    const userData = L.userData; L = null;
    L = await launch({ tmp, userData });
    ({ page } = L);
    await page.waitForSelector('[data-testid=dialog]');
    expect(await page.textContent('[data-testid=dialog]')).toMatch(/Recover unsaved documents/);
    await shot('recovery-dialog');
    await page.click('button:text-is("Recover")');
    await page.waitForFunction(() => (window as any).__ps.store.sessions.length === 1);
    // recovered content equals the autosaved state (ids are preserved by the format)
    expect(await docFingerprint(page)).toBe(fp);
    expect(await page.textContent('[data-testid=savestate]')).toMatch(/Unsaved/);
    expect(fs.readdirSync(rec).filter(f => f.endsWith('.pstudio'))).toEqual([]);
  }, 120000);
});
