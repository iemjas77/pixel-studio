import { Engine, createDefaultRegistry, type Services } from '@ps/commands';
import type { PsDocument } from '@ps/document';
import { replayAction, type Action } from './action';

export interface BatchJob { id: string; name: string }
export type OverwritePolicy = 'skip' | 'overwrite' | 'rename';

/** Everything environment-specific (files, decoders, encoders) lives behind this interface. */
export interface BatchIO {
  load(job: BatchJob): Promise<{ doc: PsDocument; services?: Services; warnings?: string[] }>;
  save(job: BatchJob, doc: PsDocument, services: Services | undefined, policy: OverwritePolicy): Promise<{ output: string; skipped: boolean }>;
}
export interface JobResult { job: BatchJob; status: 'ok' | 'skipped' | 'failed' | 'cancelled'; output?: string; error?: string; warnings?: string[]; ms?: number }
export interface BatchReport { results: JobResult[]; ok: number; failed: number; skipped: number; cancelled: number; cancelledRun: boolean }
export interface BatchOptions {
  action: Action;
  concurrency?: number;      // default 2, clamped 1..8
  overwrite: OverwritePolicy;
  signal?: { aborted: boolean };
  onProgress?: (done: number, total: number, last: JobResult) => void;
}

/**
 * Runs `action` on every job. Each job loads into its OWN document + Engine (no shared state), so a failing or
 * cancelled job can never touch the interactive document or other jobs. Failures are reported per file.
 */
export async function runBatch(jobs: BatchJob[], io: BatchIO, o: BatchOptions): Promise<BatchReport> {
  const results: JobResult[] = new Array(jobs.length);
  const conc = Math.max(1, Math.min(8, o.concurrency ?? 2));
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      let r: JobResult;
      if (o.signal?.aborted) r = { job, status: 'cancelled' };
      else r = await runOne(job, io, o);
      results[i] = r;
      done++;
      o.onProgress?.(done, jobs.length, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
  const count = (s: JobResult['status']) => results.filter(r => r.status === s).length;
  return { results, ok: count('ok'), failed: count('failed'), skipped: count('skipped'), cancelled: count('cancelled'), cancelledRun: !!o.signal?.aborted };
}

async function runOne(job: BatchJob, io: BatchIO, o: BatchOptions): Promise<JobResult> {
  const t0 = Date.now();
  try {
    const { doc, services, warnings } = await io.load(job);
    if (o.signal?.aborted) return { job, status: 'cancelled' };
    const engine = new Engine(doc, { registry: createDefaultRegistry(), services: services ?? {}, maxHistoryEntries: 5 });
    const rep = replayAction(engine, o.action, { activeLayerId: doc.layers.length ? doc.layers[doc.layers.length - 1].id : null });
    if (!rep.ok) return { job, status: 'failed', error: rep.error, warnings, ms: Date.now() - t0 };
    if (o.signal?.aborted) return { job, status: 'cancelled' };
    const out = await io.save(job, engine.doc, services, o.overwrite);
    return { job, status: out.skipped ? 'skipped' : 'ok', output: out.output, warnings, ms: Date.now() - t0 };
  } catch (e) {
    return { job, status: 'failed', error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}
