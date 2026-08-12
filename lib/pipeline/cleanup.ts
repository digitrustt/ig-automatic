import { RENDITIONS_BUCKET } from '@/lib/storage';
import { admin } from '@/lib/supabase/admin';

/**
 * Once a Reel is live, Instagram serves its own copy — our file is only needed
 * until the container has been pulled. Storage is the tightest free-tier quota,
 * so this is the shortest retention in the system.
 */
const RENDITION_RETENTION_DAYS = 3;

/** Must comfortably exceed the 14-day baseline window that reads them. */
const SNAPSHOT_RETENTION_DAYS = 21;

/** Finished queue rows are only kept long enough to debug a bad run. */
const JOB_RETENTION_DAYS = 7;

export interface CleanupResult {
  filesDeleted: number;
  snapshotsDeleted: number;
  jobsDeleted: number;
}

/**
 * Keeps the project inside the free tiers. Post rows themselves are never
 * deleted — they hold the perceptual hashes that stop us reposting the same
 * clip a month later, and they cost a few hundred bytes each.
 */
export async function cleanup(): Promise<CleanupResult> {
  const [filesDeleted, snapshotsDeleted, jobsDeleted] = await Promise.all([
    dropSettledRenditionFiles(),
    pruneSnapshots(),
    pruneFinishedJobs(),
  ]);

  return { filesDeleted, snapshotsDeleted, jobsDeleted };
}

async function dropSettledRenditionFiles(): Promise<number> {
  const cutoff = new Date(
    Date.now() - RENDITION_RETENTION_DAYS * 86400_000,
  ).toISOString();

  // Only renditions whose publication has reached a terminal state — a file
  // still waiting on a scheduled slot must survive.
  const { data, error } = await admin()
    .from('publications')
    .select('rendition_id, renditions(storage_path)')
    .in('status', ['published', 'skipped_shadow'])
    .lt('created_at', cutoff);
  if (error) throw error;

  const rows = data as unknown as Array<{
    rendition_id: string;
    renditions: { storage_path: string | null } | null;
  }>;

  const paths = rows
    .map((r) => r.renditions?.storage_path)
    .filter((p): p is string => Boolean(p));
  if (paths.length === 0) return 0;

  const { error: removeErr } = await admin()
    .storage.from(RENDITIONS_BUCKET)
    .remove(paths);
  if (removeErr) throw removeErr;

  // Null the pointer so a retry does not try to publish a file that is gone.
  const { error: updateErr } = await admin()
    .from('renditions')
    .update({ storage_path: null, public_url: null })
    .in(
      'id',
      rows.map((r) => r.rendition_id),
    );
  if (updateErr) throw updateErr;

  return paths.length;
}

async function pruneSnapshots(): Promise<number> {
  const cutoff = new Date(
    Date.now() - SNAPSHOT_RETENTION_DAYS * 86400_000,
  ).toISOString();

  const { data, error } = await admin()
    .from('metric_snapshots')
    .delete()
    .lt('captured_at', cutoff)
    .select('id');
  if (error) throw error;

  return (data ?? []).length;
}

async function pruneFinishedJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - JOB_RETENTION_DAYS * 86400_000).toISOString();

  const { data, error } = await admin()
    .from('jobs')
    .delete()
    .in('status', ['done', 'failed'])
    .lt('created_at', cutoff)
    .select('id');
  if (error) throw error;

  return (data ?? []).length;
}
