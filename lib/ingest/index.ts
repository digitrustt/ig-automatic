import { getConfig } from '@/lib/config';
import { enqueue } from '@/lib/queue';
import { admin } from '@/lib/supabase/admin';
import type { Source } from '@/lib/types/db';
import { apifyAccountAdapter, apifyHashtagAdapter } from './apify';
import { instagramBusinessDiscoveryAdapter } from './instagram-business-discovery';
import { instagramGraphAdapter } from './instagram-graph';
import type { RawPost, SourceAdapter } from './types';

const ADAPTERS: SourceAdapter[] = [
  instagramGraphAdapter,
  instagramBusinessDiscoveryAdapter,
  apifyHashtagAdapter,
  apifyAccountAdapter,
];

const registry = new Map(ADAPTERS.map((a) => [a.kind, a]));

export interface IngestResult {
  source: string;
  fetched: number;
  kept: number;
  newPosts: number;
}

/**
 * Pulls one source, upserts what it found, and records a metric snapshot for
 * every post seen. Snapshots are what later make velocity scoring possible, so
 * they are written even for posts we already knew about.
 */
export async function ingestSource(source: Source): Promise<IngestResult> {
  const adapter = registry.get(source.kind);
  if (!adapter) throw new Error(`No adapter registered for kind ${source.kind}`);

  const config = await getConfig();
  const raw = await adapter.fetch(source);
  const kept = raw.filter(
    (p) =>
      isUsableVideo(p) &&
      withinAgeWindow(p, config.min_source_age_hours, config.max_source_age_hours),
  );

  let newPosts = 0;

  for (const post of kept) {
    const { data, error } = await admin()
      .from('posts')
      .upsert(
        {
          platform: post.platform,
          external_id: post.externalId,
          source_id: source.id,
          niche: source.niche,
          author_handle: post.authorHandle ?? null,
          permalink: post.permalink ?? null,
          media_type: post.mediaType ?? null,
          media_url: post.mediaUrl ?? null,
          thumbnail_url: post.thumbnailUrl ?? null,
          caption: post.caption ?? null,
          published_at: post.publishedAt ?? null,
          duration_seconds: post.durationSeconds ?? null,
        },
        { onConflict: 'platform,external_id', ignoreDuplicates: false },
      )
      .select('id, first_seen_at, status')
      .single();

    if (error) throw error;

    // A row whose first_seen_at is this run's insert is genuinely new.
    const isNew = Date.now() - new Date(data.first_seen_at).getTime() < 60_000;
    if (isNew) newPosts++;

    await admin().from('metric_snapshots').insert({
      post_id: data.id,
      views: post.metrics.views ?? null,
      likes: post.metrics.likes ?? null,
      comments: post.metrics.comments ?? null,
      shares: post.metrics.shares ?? null,
      saves: post.metrics.saves ?? null,
    });

    // 'tracking' means: seen at least once, awaiting enough snapshots to score.
    // The second snapshot arrives on the source's next poll, which is why the
    // poll interval doubles as the velocity measurement window.
    if (data.status === 'discovered') {
      await admin().from('posts').update({ status: 'tracking' }).eq('id', data.id);
    }
  }

  await admin()
    .from('sources')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('id', source.id);

  return { source: `${source.kind}:${source.handle}`, fetched: raw.length, kept: kept.length, newPosts };
}

/**
 * Only downloadable video is worth storing.
 *
 * Photos and carousels cannot become a Reel, and Instagram withholds
 * `media_url` for a large share of other people's video — roughly half of what
 * business_discovery returns. Keeping those rows would do more than waste
 * space: they would enter the niche baseline, and engagement on a photo obeys
 * different norms than engagement on a video, which skews every later z-score.
 */
function isUsableVideo(post: RawPost): boolean {
  const isVideo = post.mediaType === 'VIDEO' || post.mediaType === 'REELS';
  return isVideo && Boolean(post.mediaUrl);
}

function withinAgeWindow(post: RawPost, minHours: number, maxHours: number): boolean {
  if (!post.publishedAt) return false;
  const ageHours = (Date.now() - new Date(post.publishedAt).getTime()) / 3600_000;
  return ageHours >= minHours && ageHours <= maxHours;
}

/** Enqueues an ingest job for every source whose poll interval has elapsed. */
export async function enqueueDueSources(): Promise<number> {
  const { data, error } = await admin()
    .from('sources')
    .select('*')
    .eq('enabled', true);
  if (error) throw error;

  const due = (data as Source[]).filter((s) => {
    if (!s.last_polled_at) return true;
    const elapsed = Date.now() - new Date(s.last_polled_at).getTime();
    return elapsed >= s.poll_interval_minutes * 60_000;
  });

  for (const source of due) {
    await enqueue(
      'ingest',
      { sourceId: source.id },
      { dedupeKey: `ingest:${source.id}:${Math.floor(Date.now() / 600_000)}` },
    );
  }

  return due.length;
}
