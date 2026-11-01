import { describe, expect, it } from 'vitest';
import { Engine, createDefaultRegistry } from '@ps/commands';
import { createDocument, renderPreview } from '@ps/document';
import { MAGIC, PsFormatError, crc32, readPstudio, writePstudio } from '@ps/codecs';
import { deflateSync } from 'fflate';
import { ids, snapshot, allLayers } from '../helpers';

function sampleDoc() {
  const src = ids();
  const doc = createDocument(src, { width: 700, height: 500, background: [250, 240, 230, 255], name: 'Sample ünï' });
  const e = new Engine(doc, { ids: src, registry: createDefaultRegistry() });
  const l = e.execute({ type: 'layer.add', params: { name: 'Paint' } }).layerId!;
  e.execute({ type: 'paint.stroke', params: { layerId: l, plane: 'pixels', mode: 'paint', brush: { size: 30, hardness: 0.5, color: [200, 30, 40] }, points: [[-40, -20], [300, 260], [720, 500]] } });
  e.execute({ type: 'mask.add', params: { id: l, mode: 'reveal' } });
  e.execute({ type: 'paint.stroke', params: { layerId: l, plane: 'mask', mode: 'paint', brush: { size: 50, hardness: 1, color: [0, 0, 0] }, points: [[300, 260]] } });
  e.execute({ type: 'layer.set', params: { id: l, props: { opacity: 0.65, blendMode: 'overlay' } } });
  e.execute({ type: 'text.create', params: { x: 40, y: 60, data: { text: 'مرحبا Hello 你好', fontFamily: 'Noto Sans', fontSize: 33, color: [10, 20, 30, 255], boxWidth: 300, tracking: 1.5 } } });
  e.execute({ type: 'layer.group', params: { id: l } });
  e.execute({ type: 'selection.rect', params: { x: 5, y: 6, w: 100, h: 90 } });
  return doc;
}

describe('.pstudio native format', () => {
  it('roundtrips a complex document exactly (structure + every tile byte)', () => {
    const doc = sampleDoc();
    const bytes = writePstudio(doc, { preview: renderPreview(doc, 128) });
    const r = readPstudio(bytes);
    expect(r.warnings).toEqual([]);
    expect(snapshot(r.doc)).toBe(snapshot(doc));
    expect(r.preview!.width).toBeLessThanOrEqual(128);
    // write → read → write is byte-stable
    expect(writePstudio(r.doc, { preview: r.preview })).toEqual(bytes);
    // text kept editable with original font identity
    const t = allLayers(r.doc).find(l => l.kind === 'text')!;
    expect(t.kind === 'text' && t.text.fontFamily).toBe('Noto Sans');
    expect(t.kind === 'text' && t.text.text).toBe('مرحبا Hello 你好');
  });

  it('writes sparse: only non-empty tiles are stored', () => {
    const doc = createDocument(ids(), { width: 20000, height: 20000 });
    const bytes = writePstudio(doc);
    expect(bytes.length).toBeLessThan(1000);
  });

  it('rejects wrong magic, short files and header/manifest corruption with typed errors', () => {
    const good = writePstudio(sampleDoc());
    const code = (b: Uint8Array) => { try { readPstudio(b); return 'ok'; } catch (e) { return e instanceof PsFormatError ? e.code : `other:${(e as Error).message}`; } };
    expect(code(new Uint8Array(0))).toBe('truncated');
    expect(code(new Uint8Array(100))).toBe('bad-magic');
    expect(code(new TextEncoder().encode('\x89PNG\r\n\x1a\n and some more bytes here....'))).toBe('bad-magic');
    const c1 = good.slice(); c1[13] ^= 0xff; expect(code(c1)).toBe('crc-mismatch'); // header
    const c2 = good.slice(); c2[40] ^= 0x01; expect(code(c2)).toBe('crc-mismatch'); // manifest
    const c3 = good.slice(); c3[c3.length - 5] ^= 0x01; expect(code(c3)).toBe('crc-mismatch'); // tile blob
  });

  it('every truncation point fails cleanly (never crashes, never partial documents)', () => {
    const good = writePstudio(sampleDoc());
    const step = Math.max(1, Math.floor(good.length / 200));
    for (let n = 0; n < good.length; n += step) {
      let err: unknown = null;
      try { readPstudio(good.subarray(0, n)); } catch (e) { err = e; }
      expect(err, `len ${n}`).toBeInstanceOf(PsFormatError);
    }
  });

  it('single-byte flips anywhere are detected or harmless (never throw non-PsFormatError)', () => {
    const good = writePstudio(sampleDoc());
    let rejected = 0;
    for (let i = 0; i < good.length; i += Math.max(1, Math.floor(good.length / 300))) {
      const b = good.slice(); b[i] ^= 0x55;
      try { readPstudio(b); } catch (e) { expect(e).toBeInstanceOf(PsFormatError); rejected++; }
    }
    expect(rejected).toBeGreaterThan(250);
  });

  it('rejects unsupported major version safely and accepts newer minor', () => {
    const good = writePstudio(createDocument(ids(), { width: 10, height: 10 }));
    const patch = (fn: (dv: DataView) => void) => {
      const b = good.slice(); const dv = new DataView(b.buffer); fn(dv); dv.setUint32(24, crc32(b, 0, 24), true); return b;
    };
    expect(() => readPstudio(patch(dv => dv.setUint16(8, 2, true)))).toThrow(/not supported/);
    try { readPstudio(patch(dv => dv.setUint16(8, 2, true))); } catch (e) { expect((e as PsFormatError).code).toBe('unsupported-version'); }
    expect(readPstudio(patch(dv => dv.setUint16(10, 7, true))).formatVersion).toEqual({ major: 1, minor: 7 });
  });

  // build a file around an arbitrary manifest for malformed-content tests
  function craft(manifestMut: (m: any) => void, blobs: Uint8Array[] = []) {
    const base = createDocument(ids(), { width: 300, height: 300, background: 'white' });
    const m = JSON.parse(new TextDecoder().decode(writePstudio(base).subarray(28, 28 + new DataView(writePstudio(base).buffer).getUint32(12, true))));
    m.tiles = [];
    manifestMut(m);
    const mb = new TextEncoder().encode(JSON.stringify(m));
    const blobLen = blobs.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(28 + mb.length + blobLen);
    const dv = new DataView(out.buffer);
    out.set(MAGIC, 0); dv.setUint16(8, 1, true); dv.setUint16(10, 0, true);
    dv.setUint32(12, mb.length, true); dv.setUint32(16, crc32(mb), true); dv.setUint32(20, blobLen, true); dv.setUint32(24, crc32(out, 0, 24), true);
    out.set(mb, 28);
    let p = 28 + mb.length; for (const b of blobs) { out.set(b, p); p += b.length; }
    return out;
  }
  const codeOf = (b: Uint8Array) => { try { readPstudio(b); return 'ok'; } catch (e) { return e instanceof PsFormatError ? e.code : `other:${(e as Error).message}`; } };

  it('decompression bomb: tile whose stream inflates beyond the declared tile size is rejected without allocating it', () => {
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024)); // 64 MiB of zeros, tiny compressed
    expect(bomb.length).toBeLessThan(200_000);
    const t0 = Date.now();
    const b = craft(m => {
      m.tiles = [{ layer: m.document.layers[0].id, plane: 'pixels', tx: 5, ty: 5, off: 0, len: bomb.length, crc: crc32(bomb) }];
    }, [bomb]);
    expect(codeOf(b)).toBe('limit-exceeded');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('short tile data and non-deflate garbage are rejected', () => {
    const short = deflateSync(new Uint8Array(100));
    expect(codeOf(craft(m => { m.tiles = [{ layer: m.document.layers[0].id, plane: 'pixels', tx: 0, ty: 0, off: 0, len: short.length, crc: crc32(short) }]; }, [short]))).toBe('corrupt-tile');
    const junk = new Uint8Array(50).fill(0xab);
    expect(codeOf(craft(m => { m.tiles = [{ layer: m.document.layers[0].id, plane: 'pixels', tx: 0, ty: 0, off: 0, len: junk.length, crc: crc32(junk) }]; }, [junk]))).toBe('corrupt-tile');
  });

  it('rejects invalid manifest content: ranges, duplicates, dangling refs, huge canvas, bad enums', () => {
    expect(codeOf(craft(m => { m.document.canvas.width = 40000; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.document.canvas.width = 30000; m.document.canvas.height = 30000; }))).toBe('limit-exceeded');
    expect(codeOf(craft(m => { m.document.canvas.mode = 'CMYK'; }))).toBe('unsupported-feature');
    expect(codeOf(craft(m => { m.document.canvas.bitDepth = 16; }))).toBe('unsupported-feature');
    expect(codeOf(craft(m => { m.document.layers[0].opacity = 3; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.document.layers[0].blendMode = 'plaid'; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.document.layers.push(structuredClone(m.document.layers[0])); }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.tiles = [{ layer: 'ghost', plane: 'pixels', tx: 0, ty: 0, off: 0, len: 0, crc: 0 }]; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.tiles = [{ layer: m.document.layers[0].id, plane: 'pixels', tx: 0, ty: 0, off: 10, len: 99999, crc: 0 }]; }))).toBe('truncated');
    expect(codeOf(craft(m => { m.tiles = [{ layer: m.document.layers[0].id, plane: 'mask', tx: 0, ty: 0, off: 0, len: 0, crc: 0 }]; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.document.layers[0].id = '../../etc'; }))).toBe('invalid-manifest');
    expect(codeOf(craft(m => { m.document = null; }))).toBe('invalid-manifest');
  });

  it('unknown data is preserved, never silently dropped: extra props, unknown layer kind, unknown manifest keys', () => {
    const b = craft(m => {
      m.document.layers[0].futureProp = { a: [1, 2, 3] };
      m.document.futureDocProp = 'x';
      m.document.layers.push({ id: 'lyr_future', kind: 'shape', name: 'Vector thing', payload: { path: 'M0 0' } });
      m.futureTop = { y: 1 };
    });
    const r = readPstudio(b);
    expect(r.warnings.some(w => /unsupported kind “shape”/.test(w))).toBe(true);
    const opaque = r.doc.layers.find(l => l.id === 'lyr_future')!;
    expect(opaque.kind).toBe('opaque');
    const again = readPstudio(writePstudio(r.doc));
    expect(again.doc.layers[0].unknown).toEqual({ futureProp: { a: [1, 2, 3] } });
    expect(again.doc.unknown?.futureDocProp).toBe('x');
    const op2 = again.doc.layers.find(l => l.id === 'lyr_future')!;
    expect(op2.kind === 'opaque' && op2.raw).toEqual({ id: 'lyr_future', kind: 'shape', name: 'Vector thing', payload: { path: 'M0 0' } });
    expect((again.doc.unknown as any).__manifest.futureTop).toEqual({ y: 1 });
  });
});

describe('format 1.1 blendSpace', () => {
  it('roundtrips canvas.blendSpace, defaults to undefined for old files, rejects bad values', () => {
    const d = createDocument(ids(), { width: 10, height: 10 });
    expect(readPstudio(writePstudio(d)).doc.canvas.blendSpace).toBeUndefined();
    d.canvas.blendSpace = 'linear';
    const r = readPstudio(writePstudio(d));
    expect(r.doc.canvas.blendSpace).toBe('linear');
    expect(r.formatVersion).toEqual({ major: 1, minor: 1 });
    const bad = (() => { d.canvas.blendSpace = 'cmyk' as never; return writePstudio(d); })();
    expect(() => readPstudio(bad)).toThrow(/blendSpace/);
  });
});
