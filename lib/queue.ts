import { errorMessage } from '@/lib/errors';
import { admin } from '@/lib/supabase/admin';
import type { Job, JobKind } from '@/lib/types/db';

interface EnqueueOptions {
  runAfter?: Date;
  /** Unique key that makes re-enqueueing the same work a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<string | null> {
  const { error, data } = await admin()
    .from('jobs')
    .insert({
      kind,
      payload,
      run_after: (opts.runAfter ?? new Date()).toISOString(),
      dedupe_key: opts.dedupeKey ?? null,
      max_attempts: opts.maxAttempts ?? 3,
    })
    .select('id')
    .single();

  // 23505 = unique_violation on dedupe_key: the job is already pending.
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data.id as string;
}

export async function claimJobs(worker: string, limit = 1): Promise<Job[]> {
  const { data, error } = await admin().rpc('claim_jobs', {
    p_worker: worker,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as Job[];
}

export async function completeJob(id: string): Promise<void> {
  const { error } = await admin()
    .from('jobs')
    .update({ status: 'done', error: null })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Fails a job, retrying with exponential backoff until max_attempts is spent.
 */
export async function failJob(job: Job, err: unknown): Promise<void> {
  const message = errorMessage(err);
  const exhausted = job.attempts >= job.max_attempts;

  const backoffMinutes = Math.min(60, 2 ** job.attempts);
  const runAfter = new Date(Date.now() + backoffMinutes * 60_000);

  const { error } = await admin()
    .from('jobs')
    .update({
      status: exhausted ? 'failed' : 'queued',
      error: message.slice(0, 2000),
      locked_at: null,
      locked_by: null,
      run_after: runAfter.toISOString(),
    })
    .eq('id', job.id);
  if (error) throw error;
}

export async function reapStaleJobs(timeoutMinutes = 30): Promise<number> {
  const { data, error } = await admin().rpc('reap_stale_jobs', {
    p_timeout_minutes: timeoutMinutes,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}
