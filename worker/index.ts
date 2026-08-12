import { errorMessage } from '@/lib/errors';
import { dispatch } from '@/lib/pipeline/dispatch';
import { initialState, runSchedules } from '@/lib/pipeline/scheduler';
import { claimJobs, completeJob, failJob, reapStaleJobs } from '@/lib/queue';

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 2);

/**
 * `loop` stays resident (a VM or a local machine). `batch` drains the queue
 * once and exits, which is the shape scheduled CI runners want — they bill by
 * the minute, so idling in a sleep loop burns the free quota for nothing.
 */
const MODE = (process.env.WORKER_MODE || 'batch') as 'loop' | 'batch';

/** Wall-clock ceiling for one batch run. */
const MAX_BATCH_MS = Number(process.env.MAX_BATCH_MS || 20 * 60_000);

/** How long to wait when the queue came back empty (loop mode only). */
const IDLE_DELAY_MS = 5_000;
/** How often to release jobs whose worker died mid-flight. */
const REAP_INTERVAL_MS = 5 * 60_000;

let running = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: 'info' | 'error', message: string, extra?: unknown): void {
  const line = { ts: new Date().toISOString(), level, worker: WORKER_ID, message, extra };
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(line));
}

/** Claims and runs up to CONCURRENCY jobs. Returns how many it handled. */
async function drainBatch(): Promise<number> {
  const jobs = await claimJobs(WORKER_ID, CONCURRENCY);
  if (jobs.length === 0) return 0;

  await Promise.all(
    jobs.map(async (job) => {
      const startedAt = Date.now();
      try {
        const result = await dispatch(job);
        await completeJob(job.id);
        log('info', `${job.kind} done`, { id: job.id, ms: Date.now() - startedAt, result });
      } catch (err) {
        await failJob(job, err);
        log('error', `${job.kind} failed`, {
          id: job.id,
          attempt: job.attempts,
          error: errorMessage(err),
        });
      }
    }),
  );

  return jobs.length;
}

/**
 * One pass: release dead workers' jobs, enqueue anything the schedule says is
 * due, then work the queue until it is empty or the time budget runs out.
 */
async function runBatch(): Promise<void> {
  const deadline = Date.now() + MAX_BATCH_MS;

  const reaped = await reapStaleJobs();
  if (reaped > 0) log('info', `reaped ${reaped} stale jobs`);

  // Every job the scheduler creates is dedupe-keyed, so a fresh state object
  // on each run re-enqueues nothing that is already pending.
  const { ran } = await runSchedules(initialState());
  if (ran.length > 0) log('info', `scheduled: ${ran.join(', ')}`);

  let handledTotal = 0;
  while (Date.now() < deadline) {
    const handled = await drainBatch();
    if (handled === 0) break;
    handledTotal += handled;
  }

  log('info', `batch finished`, {
    jobs: handledTotal,
    timedOut: Date.now() >= deadline,
  });
}

async function runLoop(): Promise<void> {
  const schedules = initialState();
  let lastReap = 0;

  while (running) {
    try {
      if (Date.now() - lastReap > REAP_INTERVAL_MS) {
        const reaped = await reapStaleJobs();
        if (reaped > 0) log('info', `reaped ${reaped} stale jobs`);
        lastReap = Date.now();
      }

      // The worker is its own cron — see lib/pipeline/scheduler.ts.
      const { ran } = await runSchedules(schedules);
      if (ran.length > 0) log('info', `scheduled: ${ran.join(', ')}`);

      const handled = await drainBatch();
      // Only back off when there was nothing to do; a full batch means the
      // queue is deep and the next claim should happen immediately.
      if (handled === 0) await sleep(IDLE_DELAY_MS);
    } catch (err) {
      log('error', 'loop error', { error: errorMessage(err) });
      await sleep(IDLE_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  log('info', `worker started`, { mode: MODE, concurrency: CONCURRENCY });

  if (MODE === 'batch') await runBatch();
  else await runLoop();

  log('info', 'worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('info', `${signal} received, finishing current batch`);
    running = false;
  });
}

main().catch((err) => {
  log('error', 'fatal', { error: err instanceof Error ? err.stack : errorMessage(err) });
  process.exit(1);
});
