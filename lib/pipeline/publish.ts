import { getConfig } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { fetchReelInsights, publishReel } from '@/lib/instagram/publish';
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

  const dailyLimit = Math.min(acc.daily_post_limit, config.max_posts_per_day);
  const slot = await nextFreeSlot(accountId, dailyLimit);
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
  if (error) throw error;

  await enqueue(
    'publish',
    { publicationId: data.id },
    { runAfter: slot, dedupeKey: `push:${data.id}` },
  );

  return { publicationId: data.id as string };
}

/**
 * Walks today's and tomorrow's posting hours, returning the first that is in
 * the future and not already booked. Returns null once the daily cap is spent
 * on both days.
 */
async function nextFreeSlot(
  accountId: string,
  dailyLimit: number,
): Promise<Date | null> {
  const hours = postingHours();
  const now = Date.now();

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + dayOffset);
    day.setUTCHours(0, 0, 0, 0);

    const dayEnd = new Date(day);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const { data, error } = await admin()
      .from('publications')
      .select('scheduled_for')
      .eq('account_id', accountId)
      .neq('status', 'failed')
      .gte('scheduled_for', day.toISOString())
      .lt('scheduled_for', dayEnd.toISOString());
    if (error) throw error;

    const booked = data as Array<{ scheduled_for: string }>;
    if (booked.length >= dailyLimit) continue;

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

/** Pushes a scheduled publication to Instagram. */
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
    // The URL stored at render time may have outlived its signature.
    const videoUrl = await refreshSignedUrl(pub.renditions.storage_path);
    const caption = buildCaption(pub.renditions);

    const result = await publishReel({
      igUserId: pub.accounts.platform_user_id,
      accessToken: pub.accounts.access_token,
      videoUrl,
      caption,
    });

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
