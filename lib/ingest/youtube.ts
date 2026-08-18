import { enqueue } from '@/lib/queue';
import { admin } from '@/lib/supabase/admin';
import type { Source } from '@/lib/types/db';
import { listChannelVideos } from '@/lib/youtube/ytdlp';

/** Ignore anything too short to yield a standalone clip. */
const MIN_VIDEO_SECONDS = 180;

/** How far back to pick up videos on the first poll of a channel. */
const MAX_VIDEO_AGE_DAYS = 14;

/**
 * Videos to start clipping per poll.
 *
 * One video yields several clips — days of posting — so there is no reason to
 * work through a backlog at once, and every reason not to: transcription and
 * segment selection are metered per minute, and firing a channel's whole
 * recent history in one batch exhausts the allowance and fails all of them.
 * The rest are picked up on later polls.
 */
const MAX_VIDEOS_PER_POLL = 1;

/**
 * Stop clipping once this many finished clips are waiting to go out.
 *
 * Supply and demand are wildly mismatched here: one video yields several
 * clips, a handful of tracked channels publish daily, and the account posts a
 * few times a day. Without a brake the pipeline would render clips by the
 * hundred for a handful published — burning the transcription allowance, the
 * storage quota and the CI minutes on work that expires before it airs.
 *
 * Roughly a week of posting, so a channel going quiet never starves the queue.
 */
const MAX_UNPUBLISHED_CLIPS = 56;

/**
 * How deep into the ranked archive one poll looks.
 *
 * Videos already clipped are skipped, so the window has to reach past them to
 * find the next unseen one — a handful would stall on the same top results
 * forever.
 */
const ARCHIVE_PAGE_SIZE = 40;

export interface YouTubeIngestResult {
  source: string;
  fetched: number;
  queued: number;
  skipped?: string;
}

/**
 * Clips waiting for their slot in one niche. Every finished clip is scheduled
 * straight away, so this is the queue of work already done and not yet aired.
 *
 * Counted per niche rather than across the board because each niche feeds its
 * own account on its own daily schedule. A shared counter lets a well-supplied
 * niche fill the quota and starve the others of new material indefinitely.
 */
async function backlogSize(niche: string): Promise<number> {
  const { count, error } = await admin()
    .from('publications')
    .select('id, renditions!inner(posts!inner(niche))', { count: 'exact', head: true })
    .eq('status', 'scheduled')
    .eq('renditions.posts.niche', niche);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Tracks a channel and queues every new upload for clipping.
 *
 * Deliberately skips scoring. Velocity ranking exists to find the rare post
 * worth reposting out of hundreds of mediocre ones; a channel worth tracking
 * publishes few videos and they all perform. The selection that matters here
 * happens inside the video, and the transcript — not engagement — is what
 * decides it.
 */
export async function ingestYouTubeChannel(
  source: Source,
): Promise<YouTubeIngestResult> {
  const backlog = await backlogSize(source.niche);
  if (backlog >= MAX_UNPUBLISHED_CLIPS) {
    await admin()
      .from('sources')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', source.id);
    return {
      source: `yt_channel:${source.handle}`,
      fetched: 0,
      queued: 0,
      skipped: `backlog_${backlog}`,
    };
  }

  // An archive source works down the most-viewed uploads instead of the
  // newest, so the age window that keeps new-upload sources fresh would
  // reject everything it finds.
  const archive = source.kind === 'yt_channel_top';
  const videos = await listChannelVideos(
    source.handle,
    archive ? ARCHIVE_PAGE_SIZE : 5,
    archive ? 'popular' : 'latest',
  );
  const cutoff = Date.now() - MAX_VIDEO_AGE_DAYS * 86400_000;

  let queued = 0;

  for (const video of videos) {
    if (video.durationSeconds < MIN_VIDEO_SECONDS) continue;
    if (!archive && video.uploadedAt && new Date(video.uploadedAt).getTime() < cutoff) {
      continue;
    }

    const { data, error } = await admin()
      .from('posts')
      .upsert(
        {
          platform: 'youtube',
          external_id: video.videoId,
          source_id: source.id,
          niche: source.niche,
          author_handle: source.handle.replace(/^@/, ''),
          permalink: video.url,
          media_type: 'YOUTUBE',
          media_url: video.url,
          caption: video.title,
          published_at: video.uploadedAt,
          duration_seconds: video.durationSeconds,
        },
        { onConflict: 'platform,external_id', ignoreDuplicates: false },
      )
      .select('id, status')
      .single();
    if (error) throw error;

    // Only a video we have not clipped yet is worth queueing; the dedupe key
    // makes a repeated poll a no-op even if the status has not moved on.
    if (data.status === 'discovered' || data.status === 'tracking') {
      if (queued >= MAX_VIDEOS_PER_POLL) continue;

      await admin().from('posts').update({ status: 'selected' }).eq('id', data.id);
      // Generous retries: the failures worth surviving here are rate limits
      // and transient CDN errors, both of which pass on their own.
      const id = await enqueue(
        'clip',
        { postId: data.id },
        { dedupeKey: `clip:${data.id}`, maxAttempts: 5 },
      );
      if (id) queued++;
    }
  }

  await admin()
    .from('sources')
    .update({ last_polled_at: new Date().toISOString() })
    .eq('id', source.id);

  return { source: `yt_channel:${source.handle}`, fetched: videos.length, queued };
}
