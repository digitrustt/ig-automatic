import { generateCopy } from '@/lib/ai/copy';
import { findDuplicate } from '@/lib/ai/dedupe';
import { checkOnScreenText } from '@/lib/ai/guard';
import { selectSegments, type Segment } from '@/lib/ai/segments';
import { extractAudio, transcribe, windowText, type Transcript } from '@/lib/ai/transcribe';
import { errorMessage } from '@/lib/errors';
import { withTempDir } from '@/lib/media/ffmpeg';
import { writeCaptionFile, wordsBetween } from '@/lib/media/captions';
import { remix } from '@/lib/media/transform';
import { enqueue } from '@/lib/queue';
import { uploadRendition } from '@/lib/storage';
import { admin } from '@/lib/supabase/admin';
import type { Account, Post } from '@/lib/types/db';
import { accountForNiche, accountsForNiche, recentHooks } from './targeting';
import { downloadAudio, downloadSection } from '@/lib/youtube/ytdlp';

export interface ClipResult {
  postId: string;
  clips: number;
  skipped?: string;
}

/**
 * Turns one long video into several publishable clips.
 *
 * Audio is fetched and transcribed once for the whole video; only the spans
 * that survive selection are downloaded as video. On a 45-minute upload that is
 * the difference between moving a gigabyte and moving a few dozen megabytes.
 */
/**
 * How many clips to take from one video.
 *
 * Set per source, because it is the pacing dial for a back catalogue: a
 * hundred-video playlist yielding two clips each lasts months, and the same
 * playlist yielding six is spent before the account finds its audience.
 */
/** Every clip already cut, to compare a new one against. */
async function publishedTranscripts(): Promise<
  Array<{ id: string; transcript: string | null }>
> {
  const { data, error } = await admin()
    .from('renditions')
    .select('id, transcript')
    .not('transcript', 'is', null);
  if (error) throw error;
  return data as Array<{ id: string; transcript: string | null }>;
}

async function clipsPerVideo(sourceId: string | null): Promise<number> {
  const fallback = Number(process.env.MAX_CLIPS_PER_VIDEO || 6);
  if (!sourceId) return fallback;

  const { data } = await admin()
    .from('sources')
    .select('max_clips_per_video')
    .eq('id', sourceId)
    .single();

  return (data as { max_clips_per_video: number | null } | null)?.max_clips_per_video ?? fallback;
}

export async function clipVideo(postId: string): Promise<ClipResult> {
  const { data: post, error } = await admin()
    .from('posts')
    .select('*')
    .eq('id', postId)
    .single();
  if (error) throw error;

  const p = post as Post & { transcript: Transcript | null };
  if (!p.media_url) return { postId, clips: 0, skipped: 'no_url' };

  const account = await accountForNiche(p.niche);
  if (!account) return { postId, clips: 0, skipped: 'no_account' };

  await admin().from('posts').update({ status: 'rendering' }).eq('id', postId);

  try {
    return await withTempDir(async (dir) => {
      const transcript = p.transcript ?? (await transcribeVideo(p, dir));

      const segments = await selectSegments({
        transcript,
        title: p.caption ?? undefined,
        maxSegments: await clipsPerVideo(p.source_id),
      });

      if (segments.length === 0) {
        await admin()
          .from('posts')
          .update({ status: 'rejected', reject_reason: 'no_segments_found' })
          .eq('id', postId);
        return { postId, clips: 0, skipped: 'no_segments' };
      }

      let made = 0;
      for (const segment of segments) {
        try {
          if (await renderClip(p, account, transcript, segment, dir, made)) made++;
        } catch (err) {
          // One bad span should not cost the whole video; the rest still ship.
          console.warn(
            JSON.stringify({
              level: 'warn',
              message: 'clip failed',
              postId,
              start: segment.start,
              error: errorMessage(err),
            }),
          );
        }
      }

      await admin()
        .from('posts')
        .update({ status: made > 0 ? 'ready' : 'failed' })
        .eq('id', postId);

      return { postId, clips: made };
    });
  } catch (err) {
    await admin()
      .from('posts')
      .update({ status: 'failed', reject_reason: errorMessage(err).slice(0, 500) })
      .eq('id', postId);
    throw err;
  }
}

/** Transcribes the whole video once and caches it on the post. */
async function transcribeVideo(post: Post, dir: string): Promise<Transcript> {
  const audioFile = await downloadAudio(post.media_url!, dir);
  const speech = await extractAudio(audioFile, dir);
  const transcript = await transcribe(speech, process.env.TRANSCRIBE_LANGUAGE || 'pl');

  await admin().from('posts').update({ transcript }).eq('id', post.id);
  return transcript;
}

async function renderClip(
  post: Post,
  account: Account,
  transcript: Transcript,
  segment: Segment,
  dir: string,
  index: number,
): Promise<boolean> {
  const source = await downloadSection({
    url: post.media_url!,
    dir,
    startSeconds: segment.start,
    endSeconds: segment.end,
    filename: `section-${index}.mp4`,
  });

  const words = wordsBetween(transcript.words, segment.start, segment.end);
  const captionFile = await writeCaptionFile(words, dir, {
    offsetSeconds: segment.start,
    fontName: process.env.CAPTION_FONT,
  });

  const spoken = windowText(transcript.words, segment.start, segment.end);

  const copy = await generateCopy({
    post: { ...post, caption: spoken || post.caption },
    brandHandle: `@${account.handle}`,
    recentHooks: await recentHooks(account.id),
  });

  // The same call turns up in several people's best-of playlists, so the same
  // material reaches us as different videos with different ids. Checked before
  // rendering, which is the expensive step.
  const duplicate = findDuplicate(spoken, await publishedTranscripts());
  if (duplicate) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'clip skipped as duplicate',
        postId: post.id,
        start: segment.start,
        duplicateOf: duplicate,
      }),
    );
    return false;
  }

  // The segment's own hook is written against the clip's content; the copy
  // generator only sees a transcript window, so prefer the former.
  const hookText = segment.hook || copy.hook;

  // Checked here rather than at publish time: the guard's whole job is to
  // stop the text before it is burned into pixels, after which it can only
  // be fixed by re-rendering. What counts as unacceptable depends on the
  // account — see lib/ai/guard.ts.
  const guard = checkOnScreenText(hookText, account.niche);
  if (!guard.ok) {
    throw new Error(`Hook rejected (${guard.reason}): ${hookText.slice(0, 80)}`);
  }

  const { outputPath, info } = await remix(source, dir, {
    hookText,
    brandHandle: `@${account.handle}`,
    captionFile,
    maxDurationSeconds: segment.end - segment.start,
  });

  const key = `${post.id}-${index}.mp4`;
  const upload = await uploadRendition(outputPath, key);

  const { data: rendition, error } = await admin()
    .from('renditions')
    .insert({
      post_id: post.id,
      storage_path: upload.storagePath,
      public_url: upload.publicUrl,
      hook_text: hookText,
      caption: copy.caption,
      hashtags: copy.hashtags,
      duration_seconds: info.durationSeconds,
      start_seconds: segment.start,
      end_seconds: segment.end,
      transcript: spoken,
      status: 'ready',
    })
    .select('id')
    .single();
  if (error) throw error;

  // One publication per platform: the same clip goes to Instagram and to the
  // Facebook Page, each scheduled and retried independently.
  for (const target of await accountsForNiche(post.niche)) {
    await enqueue(
      'publish',
      { renditionId: rendition.id, accountId: target.id },
      { dedupeKey: `publish:${rendition.id}:${target.id}` },
    );
  }

  return true;
}
