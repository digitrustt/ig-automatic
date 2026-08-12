import type { Source } from '@/lib/types/db';
import type { RawPost, SourceAdapter } from './types';

const APIFY_BASE = 'https://api.apify.com/v2';

/** Shape of an Instagram item as returned by the common Apify IG actors. */
interface ApifyIgItem {
  id?: string;
  shortCode?: string;
  type?: string; // Image | Video | Sidecar
  productType?: string; // clips = Reel
  caption?: string;
  url?: string;
  videoUrl?: string;
  displayUrl?: string;
  timestamp?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  ownerUsername?: string;
  videoDuration?: number;
}

interface RunActorOptions {
  actorId: string;
  input: Record<string, unknown>;
  timeoutSeconds?: number;
}

/**
 * Runs an actor and returns its dataset in one call. Apify caps run-sync at
 * 300s; anything slower needs the async run + poll flow instead.
 */
async function runActor<T>({
  actorId,
  input,
  timeoutSeconds = 240,
}: RunActorOptions): Promise<T[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set');

  const url = new URL(
    `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`,
  );
  url.searchParams.set('token', token);
  url.searchParams.set('timeout', String(timeoutSeconds));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutSeconds + 30) * 1000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify ${actorId} failed (${res.status}): ${body.slice(0, 300)}`);
  }

  return (await res.json()) as T[];
}

function mapIgItem(item: ApifyIgItem): RawPost | null {
  const externalId = item.id ?? item.shortCode;
  if (!externalId) return null;

  const isReel = item.productType === 'clips' || item.type === 'Video';

  return {
    platform: 'instagram',
    externalId,
    authorHandle: item.ownerUsername ?? null,
    permalink:
      item.url ?? (item.shortCode ? `https://www.instagram.com/p/${item.shortCode}/` : null),
    mediaType: isReel ? 'REELS' : (item.type ?? null),
    mediaUrl: item.videoUrl ?? item.displayUrl ?? null,
    thumbnailUrl: item.displayUrl ?? null,
    caption: item.caption ?? null,
    publishedAt: item.timestamp ?? null,
    durationSeconds: item.videoDuration ?? null,
    metrics: {
      // Actors disagree on which field carries plays; take whichever is present.
      views: item.videoPlayCount ?? item.videoViewCount ?? null,
      likes: item.likesCount ?? null,
      comments: item.commentsCount ?? null,
    },
  };
}

export const apifyHashtagAdapter: SourceAdapter = {
  kind: 'ig_hashtag_apify',

  async fetch(source: Source): Promise<RawPost[]> {
    const items = await runActor<ApifyIgItem>({
      actorId: process.env.APIFY_IG_HASHTAG_ACTOR || 'apify~instagram-hashtag-scraper',
      input: {
        hashtags: [source.handle.replace(/^#/, '')],
        resultsLimit: 50,
      },
    });

    return items.map(mapIgItem).filter((p): p is RawPost => p !== null);
  },
};

export const apifyAccountAdapter: SourceAdapter = {
  kind: 'ig_account_apify',

  async fetch(source: Source): Promise<RawPost[]> {
    const items = await runActor<ApifyIgItem>({
      actorId: process.env.APIFY_IG_PROFILE_ACTOR || 'apify~instagram-profile-scraper',
      input: {
        usernames: [source.handle.replace(/^@/, '')],
        resultsLimit: 30,
      },
    });

    return items.map(mapIgItem).filter((p): p is RawPost => p !== null);
  },
};
