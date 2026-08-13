import { generateCopy } from '@/lib/ai/copy';
import { errorMessage } from '@/lib/errors';
import { downloadTo } from '@/lib/media/download';
import { probe, withTempDir } from '@/lib/media/ffmpeg';
import { DUPLICATE_THRESHOLD, hammingDistance, videoPhash } from '@/lib/media/phash';
import { remix } from '@/lib/media/transform';
import { enqueue } from '@/lib/queue';
import { uploadRendition } from '@/lib/storage';
import { admin } from '@/lib/supabase/admin';
import type { Post } from '@/lib/types/db';
import { accountForNiche, accountsForNiche, recentHooks } from './targeting';

export interface RenderResult {
  postId: string;
  renditionId?: string;
  skipped?: string;
}

/**
 * Turns a selected source post into our own edit: download, fingerprint,
 * generate copy, burn the hook and branding in, and store the result.
 */
export async function renderPost(postId: string): Promise<RenderResult> {
  const { data: post, error } = await admin()
    .from('posts')
    .select('*')
    .eq('id', postId)
    .single();
  if (error) throw error;

  const p = post as Post;
  if (p.status !== 'selected') {
    return { postId, skipped: `status_${p.status}` };
  }
  if (!p.media_url) {
    await reject(postId, 'no_media_url');
    return { postId, skipped: 'no_media_url' };
  }

  const account = await accountForNiche(p.niche);
  if (!account) {
    return { postId, skipped: 'no_account_for_niche' };
  }

  await admin().from('posts').update({ status: 'rendering' }).eq('id', postId);

  try {
    return await withTempDir(async (dir) => {
      const source = await downloadTo(p.media_url!, dir);
      const info = await probe(source);

      const phash = await videoPhash(source, info.durationSeconds, dir);
      const duplicateOf = await findDuplicate(phash, postId);
      if (duplicateOf) {
        await admin().from('posts').update({ phash }).eq('id', postId);
        await reject(postId, `duplicate_of:${duplicateOf}`);
        return { postId, skipped: 'duplicate' };
      }

      const copy = await generateCopy({
        post: p,
        brandHandle: `@${account.handle}`,
        recentHooks: await recentHooks(account.id),
      });

      const { outputPath, info: outInfo } = await remix(source, dir, {
        hookText: copy.hook,
        brandHandle: `@${account.handle}`,
      });

      const upload = await uploadRendition(outputPath, `${postId}.mp4`);

      const { data: rendition, error: insertErr } = await admin()
        .from('renditions')
        .insert({
          post_id: postId,
          storage_path: upload.storagePath,
          public_url: upload.publicUrl,
          hook_text: copy.hook,
          caption: copy.caption,
          hashtags: copy.hashtags,
          duration_seconds: outInfo.durationSeconds,
          status: 'ready',
        })
        .select('id')
        .single();
      if (insertErr) throw insertErr;

      await admin()
        .from('posts')
        .update({ status: 'ready', phash })
        .eq('id', postId);

      for (const target of await accountsForNiche(p.niche)) {
        await enqueue(
          'publish',
          { renditionId: rendition.id, accountId: target.id },
          { dedupeKey: `publish:${rendition.id}:${target.id}` },
        );
      }

      return { postId, renditionId: rendition.id as string };
    });
  } catch (err) {
    await admin()
      .from('posts')
      .update({
        status: 'failed',
        reject_reason: errorMessage(err).slice(0, 500),
      })
      .eq('id', postId);
    throw err;
  }
}

async function reject(postId: string, reason: string): Promise<void> {
  await admin()
    .from('posts')
    .update({ status: 'rejected', reject_reason: reason })
    .eq('id', postId);
}

/**
 * Compares against every fingerprint we hold. Hamming distance needs a full
 * scan — fine at this scale, and the alternative (a BK-tree or pg_bktree) is
 * not worth its complexity until the table is in the millions.
 */
async function findDuplicate(phash: string, selfId: string): Promise<string | null> {
  const { data, error } = await admin()
    .from('posts')
    .select('id, phash')
    .not('phash', 'is', null)
    .neq('id', selfId);
  if (error) throw error;

  for (const row of data as Array<{ id: string; phash: string }>) {
    if (hammingDistance(phash, row.phash) <= DUPLICATE_THRESHOLD) return row.id;
  }
  return null;
}
