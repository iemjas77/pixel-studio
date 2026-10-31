/** Tiny declarative parameter schema used to validate every command before execution. */
export type Schema =
  | { t: 'str'; min?: number; max?: number; opt?: boolean }
  | { t: 'num'; min?: number; max?: number; int?: boolean; opt?: boolean }
  | { t: 'bool'; opt?: boolean }
  | { t: 'enum'; v: readonly string[]; opt?: boolean }
  | { t: 'arr'; item: Schema; min?: number; max: number; opt?: boolean }
  | { t: 'obj'; props: Record<string, Schema>; opt?: boolean }
  | { t: 'null'; opt?: boolean };

export const S = {
  str: (max = 1000, o: Partial<Extract<Schema, { t: 'str' }>> = {}): Schema => ({ t: 'str', max, ...o }),
  num: (min = -1e9, max = 1e9, o: Partial<Extract<Schema, { t: 'num' }>> = {}): Schema => ({ t: 'num', min, max, ...o }),
  int: (min = -1e9, max = 1e9, o: Partial<Extract<Schema, { t: 'num' }>> = {}): Schema => ({ t: 'num', min, max, int: true, ...o }),
  bool: (): Schema => ({ t: 'bool' }),
  enum: (v: readonly string[]): Schema => ({ t: 'enum', v }),
  arr: (item: Schema, max: number, min = 0): Schema => ({ t: 'arr', item, max, min }),
  obj: (props: Record<string, Schema>): Schema => ({ t: 'obj', props }),
  opt: (s: Schema): Schema => ({ ...s, opt: true }) as Schema,
};

export class ValidationError extends Error {
  constructor(public path: string, msg: string) { super(`${path || '<root>'}: ${msg}`); this.name = 'ValidationError'; }
}

export function validate(s: Schema, v: unknown, path = ''): void {
  switch (s.t) {
    case 'str':
      if (typeof v !== 'string') throw new ValidationError(path, 'expected string');
      if (s.max !== undefined && v.length > s.max) throw new ValidationError(path, `string longer than ${s.max}`);
      if (s.min !== undefined && v.length < s.min) throw new ValidationError(path, `string shorter than ${s.min}`);
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(path, 'expected finite number');
      if (s.int && !Number.isInteger(v)) throw new ValidationError(path, 'expected integer');
      if (s.min !== undefined && v < s.min) throw new ValidationError(path, `must be ≥ ${s.min}`);
      if (s.max !== undefined && v > s.max) throw new ValidationError(path, `must be ≤ ${s.max}`);
      return;
    case 'bool': if (typeof v !== 'boolean') throw new ValidationError(path, 'expected boolean'); return;
    case 'null': if (v !== null) throw new ValidationError(path, 'expected null'); return;
    case 'enum': if (typeof v !== 'string' || !s.v.includes(v)) throw new ValidationError(path, `expected one of ${s.v.join('|')}`); return;
    case 'arr': {
      if (!Array.isArray(v)) throw new ValidationError(path, 'expected array');
      if (v.length > s.max) throw new ValidationError(path, `array longer than ${s.max}`);
      if (s.min !== undefined && v.length < s.min) throw new ValidationError(path, `array shorter than ${s.min}`);
      for (let i = 0; i < v.length; i++) validate(s.item, v[i], `${path}[${i}]`);
      return;
    }
    case 'obj': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(path, 'expected object');
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!(k in s.props)) throw new ValidationError(`${path}.${k}`, 'unknown parameter');
      for (const [k, sub] of Object.entries(s.props)) {
        if (o[k] === undefined) { if (!sub.opt) throw new ValidationError(`${path}.${k}`, 'required'); continue; }
        validate(sub, o[k], `${path}.${k}`);
      }
      return;
    }
  }
}
