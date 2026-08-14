import { getConfig } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { publishFacebookReel } from '@/lib/facebook/publish';
import { fetchReelInsights, publishReel } from '@/lib/instagram/publish';
import { downloadTo } from '@/lib/media/download';
import { withTempDir } from '@/lib/media/ffmpeg';
import { enqueue } from '@/lib/queue';
import { refreshSignedUrl } from '@/lib/storage';
import { admin } from '@/lib/supabase/admin';
import type { Account, Publication, Rendition } from '@/lib/types/db';

/** Hours (UTC) we are willing to post at, earliest first. */
function postingHours(): number[] {
  const raw = process.env.POSTING_HOURS || '11,17,20';
  return raw
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
}

export interface ScheduleResult {
  publicationId?: string;
  skipped?: string;
}

/**
 * Books a rendition into the next free posting slot. Slots are spread across
 * the day rather than fired on discovery: a burst of five Reels in ten minutes
 * reads as automation to both the audience and the platform.
 */
export async function scheduleRendition(
  renditionId: string,
  accountId: string,
): Promise<ScheduleResult> {
  const config = await getConfig();

  const { data: account, error: accErr } = await admin()
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (accErr) throw accErr;

  const acc = account as Account;
  if (!acc.enabled) return { skipped: 'account_disabled' };

  const { data: rendition, error: rendErr } = await admin()
    .from('renditions')
    .select('post_id')
    .eq('id', renditionId)
    .single();
  if (rendErr) throw rendErr;

  const dailyLimit = Math.min(acc.daily_post_limit, config.max_posts_per_day);

  // Concurrent schedulers can read the same free slot before either writes.
  // A unique index rejects the loser, so treat that as "someone took it" and
  // look again rather than trusting the first answer.
  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt++) {
    const slot = await nextFreeSlot(accountId, dailyLimit, rendition.post_id);
    if (!slot) return { skipped: 'daily_limit_reached' };

    const { data, error } = await admin()
      .from('publications')
      .insert({
        rendition_id: renditionId,
        account_id: accountId,
        scheduled_for: slot.toISOString(),
        status: 'scheduled',
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') continue; // slot taken between read and write
      throw error;
    }

    await enqueue(
      'publish',
      { publicationId: data.id },
      { runAfter: slot, dedupeKey: `push:${data.id}` },
    );

    return { publicationId: data.id as string };
  }

  return { skipped: 'no_free_slot' };
}

/** Enough to outlast a handful of schedulers competing for the same day. */
const MAX_SLOT_ATTEMPTS = 10;

/**
 * How early a run may still publish its slot.
 *
 * The worker wakes on a two-hour cycle, so a job for 18:00 is picked up at
 * 18:00 at the earliest — but clock skew between the runner and the database
 * should not push a post to the next cycle two hours later.
 */
const SLOT_TOLERANCE_MS = 60_000;

/** How far ahead a clip may be booked before we give up on finding a slot. */
const SCHEDULING_HORIZON_DAYS = 14;

/**
 * Finds the next free posting slot, skipping days that already carry a clip
 * from the same source video.
 *
 * One long video yields half a dozen clips at once, and slots are filled in
 * the order clips are made — so without this the whole day becomes one
 * creator, and often one segment of one video, told three times. Spreading
 * them means every day mixes sources, which is what a followed account looks
 * like rather than a dump.
 */
async function nextFreeSlot(
  accountId: string,
  dailyLimit: number,
  postId: string,
): Promise<Date | null> {
  const hours = postingHours();
  const now = Date.now();

  for (let dayOffset = 0; dayOffset <= SCHEDULING_HORIZON_DAYS; dayOffset++) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + dayOffset);
    day.setUTCHours(0, 0, 0, 0);

    const dayEnd = new Date(day);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const { data, error } = await admin()
      .from('publications')
      .select('scheduled_for, renditions(post_id)')
      .eq('account_id', accountId)
      .neq('status', 'failed')
      .gte('scheduled_for', day.toISOString())
      .lt('scheduled_for', dayEnd.toISOString());
    if (error) throw error;

    const booked = data as unknown as Array<{
      scheduled_for: string;
      renditions: { post_id: string } | null;
    }>;

    if (booked.length >= dailyLimit) continue;
    if (booked.some((b) => b.renditions?.post_id === postId)) continue;

    const takenHours = new Set(
      booked.map((b) => new Date(b.scheduled_for).getUTCHours()),
    );

    for (const hour of hours) {
      if (takenHours.has(hour)) continue;
      const slot = new Date(day);
      slot.setUTCHours(hour);
      if (slot.getTime() > now) return slot;
    }
  }

  return null;
}

export interface PushResult {
  publicationId: string;
  status: 'published' | 'skipped_shadow' | 'deferred';
  permalink?: string | null;
}

/** Pushes a scheduled publication to whichever platform it targets. */
export async function pushPublication(publicationId: string): Promise<PushResult> {
  const config = await getConfig();

  const { data, error } = await admin()
    .from('publications')
    .select('*, renditions(*), accounts(*)')
    .eq('id', publicationId)
    .single();
  if (error) throw error;

  const pub = data as Publication & { renditions: Rendition; accounts: Account };
  if (pub.status !== 'scheduled') {
    return { publicationId, status: 'deferred' };
  }

  // The queue decides when a job runs, but the publication owns its time.
  // Move a slot in the database and the job keeps its original delay, which
  // is how several posts once went out an hour early and minutes apart. Trust
  // the row, not the job, and hand the job back if the slot has not arrived.
  const due = new Date(pub.scheduled_for).getTime();
  if (due > Date.now() + SLOT_TOLERANCE_MS) {
    await enqueue(
      'publish',
      { publicationId },
      {
        runAfter: new Date(due),
        dedupeKey: `push:${publicationId}:${due}`,
      },
    );
    return { publicationId, status: 'deferred' };
  }

  // Two independent brakes: the kill-switch and the dry run. Shadow mode is
  // the one that stays on until the scoring has proven itself on real data.
  if (!config.autopilot_enabled || config.shadow_mode) {
    await admin()
      .from('publications')
      .update({
        status: 'skipped_shadow',
        error: config.shadow_mode ? 'shadow_mode' : 'autopilot_disabled',
      })
      .eq('id', publicationId);
    return { publicationId, status: 'skipped_shadow' };
  }

  if (!pub.accounts.access_token) {
    throw new Error(`Account ${pub.accounts.handle} has no access token`);
  }
  if (!pub.renditions.storage_path) {
    throw new Error(`Rendition ${pub.rendition_id} has no stored file`);
  }

  await admin()
    .from('publications')
    .update({ status: 'publishing' })
    .eq('id', publicationId);

  try {
    const caption = buildCaption(pub.renditions);
    const result =
      pub.accounts.platform === 'facebook'
        ? await pushToFacebook(pub.accounts, pub.renditions.storage_path, caption)
        : await pushToInstagram(pub.accounts, pub.renditions.storage_path, caption);

    await admin()
      .from('publications')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        external_id: result.mediaId,
        permalink: result.permalink,
        error: null,
      })
      .eq('id', publicationId);

    await admin()
      .from('posts')
      .update({ status: 'published' })
      .eq('id', pub.renditions.post_id);

    // First read after the insights have settled; the rest is a cron.
    await enqueue(
      'collect_own_metrics',
      { publicationId },
      {
        runAfter: new Date(Date.now() + 60 * 60 * 1000),
        dedupeKey: `own_metrics:${publicationId}:first`,
      },
    );

    return { publicationId, status: 'published', permalink: result.permalink };
  } catch (err) {
    await admin()
      .from('publications')
      .update({
        status: 'failed',
        error: errorMessage(err).slice(0, 1000),
      })
      .eq('id', publicationId);
    throw err;
  }
}

interface PushOutcome {
  mediaId: string;
  permalink: string | null;
}

/** Instagram fetches the file itself, so it only needs a signed URL. */
async function pushToInstagram(
  account: Account,
  storagePath: string,
  caption: string,
): Promise<PushOutcome> {
  // The URL stored at render time may have outlived its signature.
  const videoUrl = await refreshSignedUrl(storagePath);

  return publishReel({
    igUserId: account.platform_user_id,
    accessToken: account.access_token!,
    videoUrl,
    caption,
  });
}

/**
 * Facebook will not fetch from a URL — the bytes have to be pushed to it — so
 * the clip makes a round trip through the runner's disk on its way out.
 */
async function pushToFacebook(
  account: Account,
  storagePath: string,
  caption: string,
): Promise<PushOutcome> {
  const videoUrl = await refreshSignedUrl(storagePath);

  return withTempDir(async (dir) => {
    const file = await downloadTo(videoUrl, dir, 'reel.mp4');
    const result = await publishFacebookReel({
      pageId: account.platform_user_id,
      accessToken: account.access_token!,
      videoPath: file,
      description: caption,
    });
    return { mediaId: result.videoId, permalink: result.permalink };
  });
}

function buildCaption(rendition: Rendition): string {
  const tags = (rendition.hashtags ?? []).map((t) => `#${t}`).join(' ');
  return [rendition.caption?.trim(), tags].filter(Boolean).join('\n\n').slice(0, 2200);
}

/** Records how one of our own posts is performing — the feedback loop. */
export async function collectOwnMetrics(publicationId: string): Promise<void> {
  const { data, error } = await admin()
    .from('publications')
    .select('external_id, accounts(access_token)')
    .eq('id', publicationId)
    .single();
  if (error) throw error;

  const pub = data as unknown as {
    external_id: string | null;
    accounts: { access_token: string | null };
  };
  if (!pub.external_id || !pub.accounts.access_token) return;

  const metrics = await fetchReelInsights(pub.external_id, pub.accounts.access_token);

  await admin().from('publication_metrics').insert({
    publication_id: publicationId,
    views: metrics.views,
    likes: metrics.likes,
    comments: metrics.comments,
    shares: metrics.shares,
    saves: metrics.saves,
    follows: metrics.follows,
  });
}
