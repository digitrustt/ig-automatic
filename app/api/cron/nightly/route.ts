import { NextResponse } from 'next/server';
import { assertCron } from '@/lib/cron-auth';
import { errorMessage } from '@/lib/errors';
import { enqueue } from '@/lib/queue';
import { admin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How long we keep re-reading our own posts' performance. */
const METRICS_WINDOW_DAYS = 7;

/**
 * Nightly maintenance: rebuild the niche baselines the scoring threshold is
 * relative to, and re-read the performance of our own recent posts.
 */
export async function GET(request: Request) {
  const denied = assertCron(request);
  if (denied) return denied;

  try {
    await enqueue(
      'recompute_baselines',
      {},
      { dedupeKey: `baselines:${new Date().toISOString().slice(0, 10)}` },
    );

    const since = new Date(
      Date.now() - METRICS_WINDOW_DAYS * 86400_000,
    ).toISOString();

    const { data, error } = await admin()
      .from('publications')
      .select('id')
      .eq('status', 'published')
      .gte('published_at', since);
    if (error) throw error;

    const publications = data as Array<{ id: string }>;
    for (const pub of publications) {
      await enqueue(
        'collect_own_metrics',
        { publicationId: pub.id },
        { dedupeKey: `own_metrics:${pub.id}:${new Date().toISOString().slice(0, 10)}` },
      );
    }

    return NextResponse.json({ ok: true, metricsQueued: publications.length });
  } catch (err) {
    const message = errorMessage(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
