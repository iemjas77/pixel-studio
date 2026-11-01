import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFlatPsd, writeFlatTiff } from '@ps/codecs';

const have = (cmd: string, args: string[]) => spawnSync(cmd, args).status === 0;
const hasPIL = have('python3', ['-c', 'import PIL']);
const hasIM = have('identify', ['-version']);

function sample(w = 37, h = 23) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = (x * 7) & 255; rgba[i + 1] = (y * 11) & 255; rgba[i + 2] = (x * y) & 255;
    rgba[i + 3] = x < 5 ? 0 : x < 10 ? 128 : 255;
  }
  // transparent pixels carry no colour in the composite
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] === 0) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 0; }
  return { w, h, rgba };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ix-'));
const PY = `
import sys, PIL.Image as I
im = I.open(sys.argv[1]); im.load()
print(im.format, im.mode, im.size[0], im.size[1], im.info.get('dpi'))
open(sys.argv[2], 'wb').write(im.convert('RGBA').tobytes())
`;

describe.skipIf(!hasPIL)('flattened TIFF/PSD validated by an independent reader (Pillow)', () => {
  for (const [fmt, write] of [['tif', writeFlatTiff], ['psd', writeFlatPsd]] as const) {
    it(`${fmt}: Pillow decodes it with identical RGBA pixels`, () => {
      const { w, h, rgba } = sample();
      const d = tmp(); const f = path.join(d, `a.${fmt}`), raw = path.join(d, 'raw.bin');
      fs.writeFileSync(f, write({ width: w, height: h, rgba, ppi: 300 }));
      const info = execFileSync('python3', ['-I', '-c', PY, f, raw]).toString().trim();
      expect(info).toMatch(fmt === 'tif' ? /^TIFF RGBA 37 23/ : /^PSD (RGBA|RGB) 37 23/);
      const got = fs.readFileSync(raw);
      if (fmt === 'tif') expect(Buffer.compare(got, Buffer.from(rgba))).toBe(0);
      else {
        // PSD plugin may drop/keep alpha depending on version: RGB channels must always match where alpha > 0
        let bad = 0;
        for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] > 0) for (let c = 0; c < 3; c++) if (got[i * 4 + c] !== rgba[i * 4 + c]) bad++;
        expect(bad).toBe(0);
      }
      if (fmt === 'tif') expect(info).toContain('300');
    });
  }
});

describe.skipIf(!hasIM)('flattened TIFF/PSD validated by ImageMagick identify', () => {
  it('tif and psd are recognised with correct geometry and depth', () => {
    const { w, h, rgba } = sample(64, 40);
    const d = tmp();
    fs.writeFileSync(path.join(d, 'a.tif'), writeFlatTiff({ width: w, height: h, rgba, ppi: 72 }));
    fs.writeFileSync(path.join(d, 'a.psd'), writeFlatPsd({ width: w, height: h, rgba, ppi: 72 }));
    const t = execFileSync('identify', ['-format', '%m %w %h %z %[channels]', path.join(d, 'a.tif')]).toString();
    expect(t).toMatch(/^TIFF 64 40 8 /);
    const p = execFileSync('identify', ['-format', '%m %w %h %z', path.join(d, 'a.psd') + '[0]']).toString();
    expect(p).toMatch(/^PSD 64 40 8/);
  });
});

describe('writers (no external tool needed)', () => {
  it('reject mismatched buffers and over-large PSD', () => {
    expect(() => writeFlatTiff({ width: 2, height: 2, rgba: new Uint8Array(3), ppi: 72 })).toThrow();
    expect(() => writeFlatPsd({ width: 40000, height: 1, rgba: new Uint8Array(160000), ppi: 72 })).toThrow(/30000/);
  });
});
