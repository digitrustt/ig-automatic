import { getConfig } from '@/lib/config';
import { enqueue } from '@/lib/queue';
import { admin } from '@/lib/supabase/admin';
import type { MetricSnapshot, Post, VelocityMetric } from '@/lib/types/db';
import { computeVelocity, summarize, zScore, type Baseline } from './velocity';

export interface ScoreResult {
  postId: string;
  score: number | null;
  selected: boolean;
  reason?: string;
}

/** Posts older than this stop being candidates: the wave has already passed. */
const CANDIDATE_MAX_AGE_HOURS = 96;

export async function scorePost(postId: string): Promise<ScoreResult> {
  const config = await getConfig();

  const { data: post, error: postErr } = await admin()
    .from('posts')
    .select('*')
    .eq('id', postId)
    .single();
  if (postErr) throw postErr;

  const p = post as Post;

  const { data: snaps, error: snapErr } = await admin()
    .from('metric_snapshots')
    .select('*')
    .eq('post_id', postId)
    .order('captured_at', { ascending: true });
  if (snapErr) throw snapErr;

  const velocity = computeVelocity(snaps as MetricSnapshot[], p.published_at);
  if (!velocity) {
    return { postId, score: null, selected: false, reason: 'insufficient_snapshots' };
  }

  const baseline = await loadBaseline(p.niche, velocity.metric);
  const z = baseline ? zScore(velocity.value, baseline) : null;

  await admin()
    .from('posts')
    .update({ score: z, scored_at: new Date().toISOString() })
    .eq('id', postId);

  if (z === null) {
    return { postId, score: null, selected: false, reason: 'no_baseline_yet' };
  }

  const ageHours = p.published_at
    ? (Date.now() - new Date(p.published_at).getTime()) / 3600_000
    : Infinity;

  if (ageHours > CANDIDATE_MAX_AGE_HOURS) {
    await reject(postId, 'too_old');
    return { postId, score: z, selected: false, reason: 'too_old' };
  }

  if (z < config.min_score) {
    // Deliberately left in 'tracking': a post can still take off later.
    return { postId, score: z, selected: false, reason: 'below_threshold' };
  }

  if (p.status !== 'tracking' && p.status !== 'discovered') {
    return { postId, score: z, selected: false, reason: `already_${p.status}` };
  }

  await admin().from('posts').update({ status: 'selected' }).eq('id', postId);
  await enqueue('render', { postId }, { dedupeKey: `render:${postId}` });

  return { postId, score: z, selected: true };
}

async function reject(postId: string, reason: string): Promise<void> {
  await admin()
    .from('posts')
    .update({ status: 'rejected', reject_reason: reason })
    .eq('id', postId);
}

async function loadBaseline(
  niche: string,
  metric: VelocityMetric,
): Promise<Baseline | null> {
  const { data, error } = await admin()
    .from('niche_baselines')
    .select('mean_velocity, stddev_velocity, sample_size')
    .eq('niche', niche)
    .eq('metric', metric)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    mean: Number(data.mean_velocity),
    stddev: Number(data.stddev_velocity),
    sampleSize: data.sample_size,
  };
}

/** Sliding window the baselines are built from. */
const BASELINE_WINDOW_DAYS = 14;

/**
 * Rebuilds every niche/metric baseline from recent history. Run nightly: a
 * niche's normal drifts, and a stale baseline quietly turns the threshold into
 * either a firehose or a closed tap.
 */
export async function recomputeBaselines(): Promise<number> {
  const since = new Date(Date.now() - BASELINE_WINDOW_DAYS * 86400_000).toISOString();

  const { data: posts, error } = await admin()
    .from('posts')
    .select('id, niche, published_at')
    .gte('first_seen_at', since);
  if (error) throw error;

  const byNiche = new Map<string, Array<{ id: string; published_at: string | null }>>();
  for (const p of posts as Array<Pick<Post, 'id' | 'niche' | 'published_at'>>) {
    const list = byNiche.get(p.niche) ?? [];
    list.push({ id: p.id, published_at: p.published_at });
    byNiche.set(p.niche, list);
  }

  let written = 0;

  for (const [niche, entries] of byNiche) {
    const buckets: Record<VelocityMetric, number[]> = { views: [], likes: [] };

    for (const entry of entries) {
      const { data: snaps } = await admin()
        .from('metric_snapshots')
        .select('*')
        .eq('post_id', entry.id)
        .order('captured_at', { ascending: true });

      const v = computeVelocity((snaps ?? []) as MetricSnapshot[], entry.published_at);
      if (v) buckets[v.metric].push(v.value);
    }

    for (const metric of ['views', 'likes'] as VelocityMetric[]) {
      const values = buckets[metric];
      if (values.length === 0) continue;

      const stats = summarize(values);
      const { error: upsertErr } = await admin().from('niche_baselines').upsert(
        {
          niche,
          metric,
          mean_velocity: stats.mean,
          stddev_velocity: stats.stddev,
          sample_size: stats.sampleSize,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'niche,metric' },
      );
      if (upsertErr) throw upsertErr;
      written++;
    }
  }

  return written;
}

/** Enqueues a scoring pass for every post currently being tracked. */
export async function enqueueScorable(): Promise<number> {
  const since = new Date(Date.now() - CANDIDATE_MAX_AGE_HOURS * 3600_000).toISOString();

  const { data, error } = await admin()
    .from('posts')
    .select('id')
    .in('status', ['discovered', 'tracking'])
    .gte('first_seen_at', since);
  if (error) throw error;

  for (const row of data as Array<{ id: string }>) {
    await enqueue(
      'score',
      { postId: row.id },
      { dedupeKey: `score:${row.id}:${Math.floor(Date.now() / 1800_000)}` },
    );
  }

  return data.length;
}
