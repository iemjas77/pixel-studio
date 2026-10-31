import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile, type AtomicFs } from '../../apps/desktop/src/atomic';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-atomic-'));

describe('atomicWriteFile', () => {
  it('creates and replaces files; leaves no temp files', () => {
    const d = tmp(); const f = path.join(d, 'a.pstudio');
    atomicWriteFile(f, new Uint8Array([1, 2, 3]));
    atomicWriteFile(f, new Uint8Array([9, 9, 9, 9]));
    expect([...fs.readFileSync(f)]).toEqual([9, 9, 9, 9]);
    expect(fs.readdirSync(d)).toEqual(['a.pstudio']);
  });
  it.each(['write', 'fsync', 'rename'])('failure during %s keeps the original intact and cleans up', (stage) => {
    const d = tmp(); const f = path.join(d, 'a.pstudio');
    fs.writeFileSync(f, 'ORIGINAL');
    const bad: AtomicFs = {
      ...fs,
      writeSync: ((...a: any[]) => { if (stage === 'write') { (fs.writeSync as any)(a[0], a[1], a[2], 2); throw new Error('disk full'); } return (fs.writeSync as any)(...a); }) as any,
      fsyncSync: ((fd: number) => { if (stage === 'fsync') throw new Error('io error'); fs.fsyncSync(fd); }) as any,
      renameSync: ((a: string, b: string) => { if (stage === 'rename') throw new Error('locked'); fs.renameSync(a, b); }) as any,
    };
    expect(() => atomicWriteFile(f, new Uint8Array(5000).fill(7), bad)).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(fs.readdirSync(d)).toEqual(['a.pstudio']);
  });
  it('handles partial writes (short writeSync returns)', () => {
    const d = tmp(); const f = path.join(d, 'p.bin');
    const short: AtomicFs = { ...fs, writeSync: ((fd: number, buf: Uint8Array, off: number, len: number) => fs.writeSync(fd, buf, off, Math.min(len, 3))) as any };
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    atomicWriteFile(f, data, short);
    expect([...fs.readFileSync(f)]).toEqual([...data]);
  });
});
