/** Separable blend functions per W3C Compositing & Blending Level 1. Inputs/outputs in [0,1]. */
export const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export type BlendFn = (cb: number, cs: number) => number;

const hardLight: BlendFn = (cb, cs) =>
  cs <= 0.5 ? cb * (2 * cs) : cb + (2 * cs - 1) - cb * (2 * cs - 1);

export const BLEND_FUNCTIONS: Record<BlendMode, BlendFn> = {
  normal: (_cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  overlay: (cb, cs) => hardLight(cs, cb),
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  'color-dodge': (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))),
  'color-burn': (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)),
  'hard-light': hardLight,
  'soft-light': (cb, cs) => {
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cb + (2 * cs - 1) * (d - cb);
  },
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
};

export const isBlendMode = (s: unknown): s is BlendMode =>
  typeof s === 'string' && (BLEND_MODES as readonly string[]).includes(s);
