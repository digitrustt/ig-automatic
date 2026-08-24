import { enqueue } from '@/lib/queue';
import { admin } from '@/lib/supabase/admin';
import type { Source } from '@/lib/types/db';
import { describeVideo, listChannelVideos, listPlaylistVideos } from '@/lib/youtube/ytdlp';

/** Ignore anything too short to yield a standalone clip. */
const MIN_VIDEO_SECONDS = 180;

/** How far back to pick up videos on the first poll of a channel. */
const MAX_VIDEO_AGE_DAYS = 14;

/**
 * Refuse anything longer than this.
 *
 * Long-form is the point, so the ceiling is high enough for an interview or a
 * podcast. What it keeps out is the ten-hour compilation: transcribing one
 * costs a day's allowance, selection would run seventy prompt windows, and the
 * result is material already cut from videos we could clip directly.
 */
const MAX_VIDEO_SECONDS = 2 * 3600;

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
 * clips, a dozen tracked sources publish daily, and an account posts eight
 * times a day. Without a brake the pipeline renders clips by the hundred for a
 * handful published — burning the transcription allowance, the storage quota
 * and the CI minutes on work that expires before it airs.
 *
 * Three days deep at four posts a day, deliberately shallow. A clip scheduled a week out was cut
 * from a video that was current when it was made and will not be when it airs,
 * which matters most on exactly the sources worth having. Shallow also means
 * the queue reflects a recent decision: change a source or a setting and it
 * shows up in days rather than after the backlog drains.
 */
const MAX_UNPUBLISHED_CLIPS = 12;

/**
 * How deep into the ranked archive one poll looks.
 *
 * Videos already clipped are skipped, so the window has to reach past them to
 * find the next unseen one — a handful would stall on the same top results
 * forever.
 */
const ARCHIVE_PAGE_SIZE = 40;

/** How much of a playlist one poll considers. */
const PLAYLIST_PAGE_SIZE = 200;

/**
 * How many recent uploads a threshold source looks at.
 *
 * A view threshold is a delayed verdict: a video published an hour ago has not
 * earned its views yet, and rejecting it is not final — the next poll weighs it
 * again. That only works while the video is still in the listing, so a channel
 * publishing several times a day needs a window measured in days, not in
 * uploads.
 */
const THRESHOLD_PAGE_SIZE = 25;

/**
 * The backlog a source is allowed to add to.
 *
 * The general brake exists to stop a source rendering without limit, and a
 * source that states its own clips-per-video is already limited — by that
 * number and by how often it is polled. Left under the general brake such a
 * source never runs at all: the busy channels fill the niche first and it
 * spends every poll being told the queue is full, which is exactly backwards,
 * because it is the one whose output was deliberately rationed.
 *
 * Still bounded, at twice the general depth, so a misconfigured pacing setting
 * cannot quietly become an unbounded one.
 */
function brakeFor(source: Source): number {
  return source.max_clips_per_video
    ? MAX_UNPUBLISHED_CLIPS * 2
    : MAX_UNPUBLISHED_CLIPS;
}

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
  // Counted as clips, not as publications. Every clip goes to Instagram and to
  // a Facebook Page, so counting rows made the queue look twice as deep as it
  // was and the brake bite at half the intended backlog.
  const { data, error } = await admin()
    .from('publications')
    .select('rendition_id, renditions!inner(posts!inner(niche))')
    .eq('status', 'scheduled')
    .eq('renditions.posts.niche', niche);
  if (error) throw error;

  return new Set((data ?? []).map((r) => (r as { rendition_id: string }).rendition_id)).size;
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
  if (backlog >= brakeFor(source)) {
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

  // Archives and playlists are both back catalogues: they are ordered by
  // something other than recency, so the age window that keeps new-upload
  // sources fresh would reject everything they find.
  const archive = source.kind === 'yt_channel_top';
  const playlist = source.kind === 'yt_playlist';
  const single = source.kind === 'yt_video';
  const backCatalogue = archive || playlist || single;
  const threshold = source.min_view_count ?? 0;

  const videos = single
    ? [await describeVideo(source.handle)].filter((v) => v !== null)
    : playlist
    ? await listPlaylistVideos(source.handle, PLAYLIST_PAGE_SIZE)
    : await listChannelVideos(
        source.handle,
        archive ? ARCHIVE_PAGE_SIZE : threshold > 0 ? THRESHOLD_PAGE_SIZE : 5,
        archive ? 'popular' : 'latest',
      );

  const cutoff = Date.now() - MAX_VIDEO_AGE_DAYS * 86400_000;

  // A back catalogue has no natural order to work through, and taking it from
  // the top would publish it in the order somebody else happened to arrange
  // it — and stall on the same videos whenever the queue is full.
  const candidates = backCatalogue ? shuffle(videos) : videos;

  let queued = 0;

  for (const video of candidates) {
    if (video.durationSeconds < MIN_VIDEO_SECONDS) continue;
    if (video.durationSeconds > MAX_VIDEO_SECONDS) continue;
    // Skipped, not recorded: a video under the threshold today may pass
    // tomorrow, and it only gets that second chance if nothing here has
    // written it off.
    if (threshold > 0 && (video.viewCount ?? 0) < threshold) continue;
    if (!backCatalogue && video.uploadedAt && new Date(video.uploadedAt).getTime() < cutoff) {
      continue;
    }

    const { data, error } = await admin()
      .from('posts')
      .upsert(
        {
          platform: 'youtube',
          external_id: video.videoId,
          source_id: source.id,
          niche: nicheFor(video.videoId, source),
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

  return { source: `${source.kind}:${source.handle}`, fetched: videos.length, queued };
}

/**
 * Picks which account's niche a video belongs to.
 *
 * A source can feed several accounts, and spreading its videos between them
 * keeps any one of them from reading as a single channel's rip. The choice is
 * derived from the video id rather than drawn at random: a poll re-reads
 * videos it has already stored, and a fresh draw each time would move a video
 * to another account after its clips were scheduled for this one.
 *
 * Whole videos move, never individual clips — two accounts posting different
 * cuts of the same conversation on the same day looks exactly like what it is.
 */
function nicheFor(videoId: string, source: Source): string {
  const pool = source.niche_pool ?? [];
  if (pool.length === 0) return source.niche;

  let hash = 2166136261;
  for (let i = 0; i < videoId.length; i++) {
    hash ^= videoId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return pool[Math.abs(hash) % pool.length];
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
