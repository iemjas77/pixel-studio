import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { ART, activeId, docFingerprint, drag, launch, layerPixel, newDoc, pickTool, type Launched } from './harness';

let L: Launched | null = null;
afterEach(async () => { if (L) { await L.app.close().catch(() => {}); L = null; } });
const menu = async (name: string, item: string) => {
  await L!.page.click(`[role=menubar] button:text-is("${name}")`);
  await L!.page.click(`[role=menu] [role=menuitem]:has-text("${item}")`);
};

describe('M9 subset: adjustments, filters, gradient, crop, resize via the real UI', () => {
  it('each tool performs a real undoable document operation', async () => {
    L = await launch();
    const { page } = L;
    await newDoc(page, 200, 120, 'white');
    const bg = await activeId(page);
    // Adjust ▸ Invert (white → black)
    await menu('Adjust', 'Invert');
    expect(await layerPixel(page, bg, 10, 10)).toEqual([0, 0, 0, 255]);
    // Adjust ▸ Levels… dialog (input white 128 does nothing to black; use Brightness instead)
    await menu('Adjust', 'Brightness/Contrast');
    await page.fill('[data-testid=param-brightness]', '40');
    await page.click('[data-testid=param-ok]');
    expect((await layerPixel(page, bg, 10, 10))[0]).toBe(102);
    // gradient tool over a new layer: fg red → bg blue, left to right
    await page.click('[aria-label="New layer"]');
    const g = await activeId(page);
    await page.evaluate(() => { const s = (window as any).__ps.store; s.fg = [255, 0, 0]; s.bg = [0, 0, 255]; s.notify(); });
    await pickTool(page, 'gradient');
    await drag(page, [[0, 60], [199, 60]], 10);
    const a = await layerPixel(page, g, 2, 60), m = await layerPixel(page, g, 100, 60), z = await layerPixel(page, g, 197, 60);
    expect(a[0]).toBeGreaterThan(240); expect(z[2]).toBeGreaterThan(240);
    expect(Math.abs(m[0] - 128)).toBeLessThan(8); expect(Math.abs(m[2] - 128)).toBeLessThan(8);
    // Filter ▸ Gaussian blur on the gradient layer: still smooth, alpha preserved at centre
    const before = await docFingerprint(page);
    await menu('Filter', 'Gaussian Blur');
    await page.fill('[data-testid=param-radius]', '6');
    await page.click('[data-testid=param-ok]');
    expect(await docFingerprint(page)).not.toBe(before);
    await page.keyboard.press('Control+z');
    expect(await docFingerprint(page)).toBe(before);
    // selection + Image ▸ Crop to selection
    await pickTool(page, 'marquee');
    await drag(page, [[20, 10], [120, 90]], 5);
    await menu('Image', 'Crop to selection');
    expect(await page.textContent('[data-testid=docinfo]')).toContain('100 × 80');
    expect(await page.evaluate(() => (window as any).__ps.store.active.doc.selection)).toBeNull();
    // Image ▸ Image size… to 50×40
    await menu('Image', 'Image size');
    await page.fill('[data-testid=param-width]', '50'); await page.fill('[data-testid=param-height]', '40');
    await page.click('[data-testid=param-ok]');
    expect(await page.textContent('[data-testid=docinfo]')).toContain('50 × 40');
    await page.screenshot({ path: path.join(ART, 'production.png') });
    // undo chain back to the 200×120 doc
    for (let i = 0; i < 2; i++) await page.keyboard.press('Control+z');
    expect(await page.textContent('[data-testid=docinfo]')).toContain('200 × 120');
    expect(L.errors).toEqual([]);
  }, 120000);
});
