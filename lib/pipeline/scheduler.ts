import { enqueueDueSources } from '@/lib/ingest';
import { enqueue } from '@/lib/queue';
import { enqueueScorable } from '@/lib/scoring';
import { admin } from '@/lib/supabase/admin';

/**
 * The worker owns scheduling rather than a hosted cron: it has to run
 * continuously for ffmpeg anyway, and free cron tiers cap out at one run per
 * day — far too coarse for a 30-minute discovery loop.
 */
const TICK_INTERVAL_MS = 30 * 60_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60_000;

export interface SchedulerState {
  lastTick: number;
  lastDaily: number;
}

export function initialState(): SchedulerState {
  // Both fire on the first loop: a worker that just started should catch up
  // rather than wait out a full interval.
  return { lastTick: 0, lastDaily: 0 };
}

export interface SchedulerRun {
  ran: string[];
}

/**
 * Enqueues whatever is due. Every job it creates carries a dedupe key, so a
 * restart — or a second worker — re-running this is harmless.
 */
export async function runSchedules(state: SchedulerState): Promise<SchedulerRun> {
  const now = Date.now();
  const ran: string[] = [];

  if (now - state.lastTick >= TICK_INTERVAL_MS) {
    await enqueueDueSources();
    await enqueueScorable();
    state.lastTick = now;
    ran.push('tick');
  }

  if (now - state.lastDaily >= DAILY_INTERVAL_MS) {
    const day = new Date().toISOString().slice(0, 10);

    await enqueue('recompute_baselines', {}, { dedupeKey: `baselines:${day}` });
    await enqueue('cleanup', {}, { dedupeKey: `cleanup:${day}` });
    await enqueueOwnMetrics(day);

    state.lastDaily = now;
    ran.push('daily');
  }

  return { ran };
}

/** How long we keep re-reading our own posts' performance. */
const METRICS_WINDOW_DAYS = 7;

async function enqueueOwnMetrics(day: string): Promise<void> {
  const since = new Date(Date.now() - METRICS_WINDOW_DAYS * 86400_000).toISOString();

  const { data, error } = await admin()
    .from('publications')
    .select('id')
    .eq('status', 'published')
    .gte('published_at', since);
  if (error) throw error;

  for (const pub of data as Array<{ id: string }>) {
    await enqueue(
      'collect_own_metrics',
      { publicationId: pub.id },
      { dedupeKey: `own_metrics:${pub.id}:${day}` },
    );
  }
}
