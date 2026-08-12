import type { MetricSnapshot, VelocityMetric } from '@/lib/types/db';

export interface Velocity {
  metric: VelocityMetric;
  /** Units per hour. */
  value: number;
  /** How the value was derived — a two-point delta beats a lifetime average. */
  basis: 'delta' | 'lifetime';
  hoursObserved: number;
}

/** Minimum spacing between snapshots before a delta means anything. */
const MIN_DELTA_HOURS = 0.75;

/**
 * Picks the strongest metric the snapshots actually carry. Views are the truest
 * viral signal; likes are the fallback for sources (like the official IG
 * Hashtag API) that never expose plays.
 */
function pickMetric(snapshots: MetricSnapshot[]): VelocityMetric | null {
  if (snapshots.some((s) => s.views != null)) return 'views';
  if (snapshots.some((s) => s.likes != null)) return 'likes';
  return null;
}

/**
 * Velocity is the whole point of the system: a post with 400k views is not
 * interesting, a post that gained 400k views in six hours is. Absolute counts
 * only tell you what already peaked.
 */
export function computeVelocity(
  snapshots: MetricSnapshot[],
  publishedAt: string | null,
): Velocity | null {
  const metric = pickMetric(snapshots);
  if (!metric) return null;

  const points = snapshots
    .filter((s) => s[metric] != null)
    .map((s) => ({ at: new Date(s.captured_at).getTime(), value: Number(s[metric]) }))
    .sort((a, b) => a.at - b.at);

  if (points.length === 0) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const spanHours = (last.at - first.at) / 3600_000;

  // Two real observations far enough apart: measure the actual climb rate.
  if (points.length >= 2 && spanHours >= MIN_DELTA_HOURS) {
    const delta = last.value - first.value;
    // Counts can wobble downward when a platform corrects its own numbers.
    const rate = Math.max(0, delta) / spanHours;
    return { metric, value: rate, basis: 'delta', hoursObserved: spanHours };
  }

  // Single observation: fall back to average rate since publication. Weaker,
  // because it flattens a spike that already ended, but better than nothing.
  if (!publishedAt) return null;
  const ageHours = (last.at - new Date(publishedAt).getTime()) / 3600_000;
  if (ageHours < MIN_DELTA_HOURS) return null;

  return {
    metric,
    value: last.value / ageHours,
    basis: 'lifetime',
    hoursObserved: ageHours,
  };
}

export interface Baseline {
  mean: number;
  stddev: number;
  sampleSize: number;
}

/** Below this the distribution is too thin to trust a z-score from it. */
export const MIN_BASELINE_SAMPLE = 30;

/**
 * Engagement is heavy-tailed, so the z-score is taken in log space. Baselines
 * must be computed the same way or the two are not comparable.
 */
export function zScore(velocity: number, baseline: Baseline): number | null {
  if (baseline.sampleSize < MIN_BASELINE_SAMPLE) return null;
  if (baseline.stddev <= 0) return null;
  return (Math.log1p(velocity) - baseline.mean) / baseline.stddev;
}

export function summarize(values: number[]): Baseline {
  const logs = values.map((v) => Math.log1p(Math.max(0, v)));
  const n = logs.length;
  if (n === 0) return { mean: 0, stddev: 0, sampleSize: 0 };

  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const variance = logs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;

  return { mean, stddev: Math.sqrt(variance), sampleSize: n };
}
