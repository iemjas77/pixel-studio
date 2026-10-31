import * as nodefs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Minimal fs surface so tests can inject failures. */
export interface AtomicFs {
  openSync: typeof nodefs.openSync; writeSync: typeof nodefs.writeSync; fsyncSync: typeof nodefs.fsyncSync;
  closeSync: typeof nodefs.closeSync; renameSync: typeof nodefs.renameSync; unlinkSync: typeof nodefs.unlinkSync;
}

/**
 * Safe replace: write to a temp file in the same directory, fsync, then rename over the target.
 * On any failure the target is untouched and the temp file is removed.
 */
export function atomicWriteFile(target: string, data: Uint8Array, fs: AtomicFs = nodefs): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o644);
    let off = 0;
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
