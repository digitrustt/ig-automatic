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

export interface YouTubeIngestResult {
  source: string;
  fetched: number;
  queued: number;
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
  const videos = await listChannelVideos(source.handle, 5);
  const cutoff = Date.now() - MAX_VIDEO_AGE_DAYS * 86400_000;

  let queued = 0;

  for (const video of videos) {
    if (video.durationSeconds < MIN_VIDEO_SECONDS) continue;
    if (video.uploadedAt && new Date(video.uploadedAt).getTime() < cutoff) continue;

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
