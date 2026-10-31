export interface IdSource { next(prefix: string): string }

const A = '0123456789abcdefghijklmnopqrstuvwxyz';
export class RandomIdSource implements IdSource {
  next(prefix: string): string {
    const b = new Uint8Array(10);
    globalThis.crypto.getRandomValues(b);
    let s = '';
    for (const v of b) s += A[v % 36];
    return `${prefix}_${s}`;
  }
}
/** Deterministic ids for tests/replay. */
export class SequentialIdSource implements IdSource {
  private n = 0;
  next(prefix: string): string { return `${prefix}_${(++this.n).toString(36).padStart(6, '0')}`; }
}
export const ID_PATTERN = /^[a-z]{1,4}_[a-z0-9]{1,32}$/;
