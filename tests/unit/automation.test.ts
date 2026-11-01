import { describe, expect, it } from 'vitest';
import { Engine, createDefaultRegistry } from '@ps/commands';
import { SequentialIdSource, createDocument, findLayer, getLayer, type RasterLayer } from '@ps/document';
import { ActionRecorder, parseActionJson, replayAction, runBatch, serializeAction, validateAction, type Action, type BatchIO, type BatchJob } from '@ps/automation';
import { TileStore } from '@ps/raster';
import { snapshot } from '../helpers';

const reg = createDefaultRegistry();
function mk(prefix: string, w = 200, h = 120) {
  const ids = new SequentialIdSource();
  const doc = createDocument({ next: (p: string) => `${prefix}${ids.next(p)}`.replace(/_/g, '') && `${p}_${prefix}${ids.next('x').slice(2)}` }, { width: w, height: h, background: 'white' });
  const e = new Engine(doc, { ids: { next: (p: string) => `${p}_${prefix}${ids.next('x').slice(2)}` }, registry: reg });
  return { doc, e };
}
const px = (e: Engine, id: string, x: number, y: number) => [...(getLayer(e.doc, id) as RasterLayer).pixels.getPixel(x, y)];

function recordSample() {
  const { e } = mk('a');
  let active: string | null = e.doc.layers[0].id;
  const rec = new ActionRecorder(e, () => active);
  rec.start();
  const r = e.execute({ type: 'layer.add', params: { name: 'Overlay' } }); active = r.layerId!;
  e.execute({ type: 'edit.fill', params: { layerId: active, plane: 'pixels', color: [255, 0, 0, 255], region: 'layer' } });
  e.execute({ type: 'layer.set', params: { id: active, props: { opacity: 0.5, blendMode: 'multiply' } } });
  e.execute({ type: 'paint.stroke', params: { layerId: active, plane: 'pixels', mode: 'paint', brush: { size: 10, color: [0, 0, 255] }, points: [[10, 10], [150, 80]] } });
  e.execute({ type: 'layer.set', params: { id: e.doc.layers[0].id, props: { name: 'Base' } } }); // non-active pre-existing layer
  return { action: rec.stop('Sample'), rec, e };
}

describe('Actions: record', () => {
  it('records symbolic layer targets and drops undone steps', () => {
    const { action } = recordSample();
    expect(action.steps.map(s => s.type)).toEqual(['layer.add', 'edit.fill', 'layer.set', 'paint.stroke', 'layer.set']);
    expect(action.steps[1].params.layerId).toBe('$created:0');
    expect(action.steps[2].params.id).toBe('$created:0');
    expect(action.steps[4].params.id).toMatch(/^\$name:/);
    // undo while recording removes the step; redo restores it
    const { e } = mk('b');
    let active: string | null = e.doc.layers[0].id;
    const rec = new ActionRecorder(e, () => active);
    rec.start();
    e.execute({ type: 'layer.add', params: {} }); active = e.doc.layers.at(-1)!.id;
    e.execute({ type: 'selection.all', params: {} });
    e.undo();
    expect(rec.stepCount).toBe(1);
    e.redo();
    expect(rec.stepCount).toBe(2);
    expect(rec.stop('x').steps.map(s => s.type)).toEqual(['layer.add', 'selection.all']);
  });
  it('skips non-recordable commands and reports it', () => {
    const { e } = mk('c');
    const rec = new ActionRecorder(e, () => null);
    rec.start();
    e.services.takePixels = () => new TileStore('RGBA8');
    e.execute({ type: 'layer.placePixels', params: { name: 'img', x: 0, y: 0 } });
    expect(rec.stop('x').steps).toEqual([]);
    expect(rec.skipped.join()).toMatch(/cannot be recorded/);
  });
});

describe('Actions: replay', () => {
  it('replays on a different document (different ids) as ONE undoable history entry', () => {
    const { action } = recordSample();
    const { e } = mk('z', 300, 200);
    e.execute({ type: 'layer.set', params: { id: e.doc.layers[0].id, props: { name: 'Base' } } });
    const n = e.entries.length;
    const before = snapshot(e.doc);
    const rep = replayAction(e, action, { activeLayerId: e.doc.layers[0].id });
    expect(rep.ok, rep.error).toBe(true);
    expect(e.entries.length).toBe(n + 1);
    expect(e.entries.at(-1)!.label).toBe('Action: Sample');
    expect(e.doc.layers.length).toBe(2);
    const over = e.doc.layers[1] as RasterLayer;
    expect(over.name).toBe('Overlay'); expect(over.opacity).toBe(0.5); expect(over.blendMode).toBe('multiply');
    expect(px(e, over.id, 100, 100).slice(0, 3)).toEqual([255, 0, 0]);       // fill covers the (larger) canvas
    expect(px(e, over.id, 80, 45)[2]).toBeGreaterThan(200);                 // blue stroke
    e.undo();
    expect(snapshot(e.doc)).toBe(before);
    e.redo();
    expect(e.doc.layers.length).toBe(2);
  });
  it('is atomic: a failing step rolls the whole replay back and reports the step', () => {
    const { e } = mk('y');
    const before = snapshot(e.doc);
    const a: Action = { format: 'pixel-studio-action', version: 1, name: 'bad', steps: [
      { type: 'layer.add', version: 1, params: { name: 'ok' } },
      { type: 'layer.set', version: 1, params: { id: '$name:Missing', props: { opacity: 0.1 } } },
    ] };
    const rep = replayAction(e, a, { activeLayerId: null });
    expect(rep.ok).toBe(false);
    expect(rep.failedStep).toBe(2);
    expect(rep.error).toMatch(/No layer named “Missing”/);
    expect(snapshot(e.doc)).toBe(before);
    expect(e.entries.length).toBe(0);
  });
  it('$active resolves to the document active layer; honours locks (blocked step reports)', () => {
    const { e } = mk('w');
    const id = e.doc.layers[0].id;
    e.execute({ type: 'layer.set', params: { id, props: { lock: { pixels: true, position: false, all: false } } } });
    const a: Action = { format: 'pixel-studio-action', version: 1, name: 'f', steps: [{ type: 'edit.fill', version: 1, params: { layerId: '$active', plane: 'pixels', color: [1, 2, 3, 255], region: 'layer' } }] };
    const rep = replayAction(e, a, { activeLayerId: id });
    expect(rep.ok).toBe(false);
    expect(rep.error).toMatch(/locked/);
  });
});

describe('Actions: validation of untrusted files', () => {
  const base = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ format: 'pixel-studio-action', version: 1, name: 'n', steps, ...extra });
  const errs = (raw: unknown) => validateAction(raw, reg).errors.join('\n');
  it('round-trips through JSON', () => {
    const { action } = recordSample();
    const r = parseActionJson(serializeAction(action), reg);
    expect(r.errors).toEqual([]);
    expect(r.action).toEqual(action);
  });
  it('rejects unsupported operations, versions, extra fields, bad params, forward refs, non-recordable commands', () => {
    expect(errs(base([{ type: 'fs.delete', version: 1, params: {} }]))).toMatch(/unsupported operation “fs.delete”/);
    expect(errs(base([{ type: 'layer.add', version: 9, params: {} }]))).toMatch(/version 9/);
    expect(errs(base([{ type: 'layer.add', version: 1, params: {}, run: 'alert(1)' }]))).toMatch(/unknown field “run”/);
    expect(errs(base([{ type: 'layer.add', version: 1, params: { name: 5 } }]))).toMatch(/expected string/);
    expect(errs(base([{ type: 'layer.set', version: 1, params: { id: '$created:3', props: {} } }]))).toMatch(/has not run yet/);
    expect(errs(base([{ type: 'layer.set', version: 1, params: { id: '$evil', props: {} } }]))).toMatch(/invalid layer reference/);
    expect(errs(base([{ type: 'layer.placePixels', version: 1, params: { name: 'a', x: 0, y: 0 } }]))).toMatch(/cannot be used in actions/);
    expect(errs(base([], { extra: 1 }))).toMatch(/Unknown top-level field/);
    expect(errs({ ...base([]), version: 2 })).toMatch(/Unsupported action version 2/);
    expect(errs({ ...base([]), format: 'other' })).toMatch(/Not a Pixel Studio action/);
    expect(errs(base(new Array(10_001).fill({ type: 'selection.all', version: 1, params: {} })))).toMatch(/Too many steps/);
    expect(parseActionJson('{nope', reg).errors[0]).toMatch(/not valid JSON/);
    expect(parseActionJson('[1,2]', reg).errors[0]).toMatch(/must be a JSON object/);
  });
  it('never executes anything from an imported file: prototype tricks and code strings are inert data', () => {
    const j = '{"format":"pixel-studio-action","version":1,"name":"x","steps":[{"type":"layer.add","version":1,"params":{"name":"__proto__"}}],"__proto__":{"polluted":1}}';
    const r = parseActionJson(j, reg);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.errors.length).toBeGreaterThan(0); // __proto__ own key is an unknown top-level field
  });
});

describe('Batch', () => {
  const action: Action = { format: 'pixel-studio-action', version: 1, name: 'tint', steps: [
    { type: 'layer.add', version: 1, params: { name: 'T' } },
    { type: 'edit.fill', version: 1, params: { layerId: '$created:0', plane: 'pixels', color: [255, 0, 0, 255], region: 'layer' } },
  ] };
  function fakeIO(names: string[], opts: { failLoad?: string; onLoad?: () => void; delay?: number } = {}) {
    const docs = new Map<string, ReturnType<typeof mk>['doc']>();
    const saved: Record<string, string> = {};
    let inflight = 0, maxInflight = 0;
    const io: BatchIO = {
      async load(job) {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        opts.onLoad?.();
        await new Promise(r => setTimeout(r, opts.delay ?? 5));
        if (job.name === opts.failLoad) { inflight--; throw new Error('corrupt input'); }
        const { doc } = mk(job.name.slice(0, 3));
        docs.set(job.id, doc);
        inflight--;
        return { doc };
      },
      async save(job, doc, _s, policy) {
        if (job.name === 'dup.png' && policy === 'skip') return { output: job.name, skipped: true };
        saved[job.id] = snapshot(doc);
        return { output: `out-${job.name}`, skipped: false };
      },
    };
    return { io, docs, saved, stats: () => ({ maxInflight }) };
  }
  const jobs = (names: string[]): BatchJob[] => names.map((n, i) => ({ id: `j${i}`, name: n }));
  it('runs every job in an isolated document; failures are per-file; the interactive document is untouched', async () => {
    const live = mk('live');
    const liveBefore = snapshot(live.doc);
    const names = ['a.png', 'b.png', 'bad.png', 'dup.png', 'e.png'];
    const f = fakeIO(names, { failLoad: 'bad.png' });
    const progress: number[] = [];
    const rep = await runBatch(jobs(names), f.io, { action, overwrite: 'skip', concurrency: 2, onProgress: d => progress.push(d) });
    expect(rep.ok).toBe(3); expect(rep.failed).toBe(1); expect(rep.skipped).toBe(1); expect(rep.cancelled).toBe(0);
    expect(rep.results[2].error).toBe('corrupt input');
    expect(rep.results[0].output).toBe('out-a.png');
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(f.stats().maxInflight).toBeLessThanOrEqual(2);
    expect(snapshot(live.doc)).toBe(liveBefore);
    // each saved doc really got the action applied; separate documents (distinct ids)
    expect(new Set(Object.values(f.saved)).size).toBe(3);
    for (const d of f.docs.values()) if (d.layers.length === 2) expect(d.layers[1].name).toBe('T');
  });
  it('reports action failures per file without stopping the batch', async () => {
    const needsLayer: Action = { ...action, name: 'needs', steps: [{ type: 'layer.set', version: 1, params: { id: '$name:Nope', props: { visible: false } } }] };
    const f = fakeIO(['x.png', 'y.png']);
    const rep = await runBatch(jobs(['x.png', 'y.png']), f.io, { action: needsLayer, overwrite: 'skip' });
    expect(rep.failed).toBe(2);
    expect(rep.results[0].error).toMatch(/No layer named/);
  });
  it('supports cancellation: remaining jobs are reported as cancelled and nothing more is saved', async () => {
    const sig = { aborted: false };
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.png`);
    let loads = 0;
    const f = fakeIO(names, { delay: 15, onLoad: () => { if (++loads === 3) sig.aborted = true; } });
    const rep = await runBatch(jobs(names), f.io, { action, overwrite: 'skip', concurrency: 1, signal: sig });
    expect(rep.cancelledRun).toBe(true);
    expect(rep.cancelled).toBeGreaterThanOrEqual(5);
    expect(rep.ok + rep.cancelled + rep.failed + rep.skipped).toBe(8);
    expect(Object.keys(f.saved).length).toBe(rep.ok);
  });
});
