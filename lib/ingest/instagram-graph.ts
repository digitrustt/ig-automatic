import { graphGet } from '@/lib/instagram/graph';
import { admin } from '@/lib/supabase/admin';
import type { Source } from '@/lib/types/db';
import type { RawPost, SourceAdapter } from './types';

interface HashtagSearchResponse {
  data: Array<{ id: string }>;
}

interface HashtagMediaResponse {
  data: Array<{
    id: string;
    caption?: string;
    media_type?: string;
    media_url?: string;
    thumbnail_url?: string;
    permalink?: string;
    timestamp?: string;
    like_count?: number;
    comments_count?: number;
  }>;
}

// Hashtag ids are stable forever, and the search endpoint counts against the
// 30-unique-hashtags-per-7-days quota, so resolutions are cached in-process.
const hashtagIdCache = new Map<string, string>();

async function resolveHashtagId(
  igUserId: string,
  token: string,
  hashtag: string,
): Promise<string> {
  const cached = hashtagIdCache.get(hashtag);
  if (cached) return cached;

  const res = await graphGet<HashtagSearchResponse>('/ig_hashtag_search', token, {
    user_id: igUserId,
    q: hashtag.replace(/^#/, ''),
  });

  const id = res.data?.[0]?.id;
  if (!id) throw new Error(`Hashtag not found: ${hashtag}`);

  hashtagIdCache.set(hashtag, id);
  return id;
}

/**
 * Official IG Hashtag Search API.
 *
 * Hard limits worth knowing before relying on this as a primary source:
 *  - 30 unique hashtags per IG user per rolling 7 days.
 *  - Returns only public posts, only the last 24h for recent_media.
 *  - No view counts and no author username are exposed, so velocity here is
 *    computed from likes + comments only. The Apify adapter fills that gap.
 */
export const instagramGraphAdapter: SourceAdapter = {
  kind: 'ig_hashtag_graph',

  async fetch(source: Source): Promise<RawPost[]> {
    const { data: account, error } = await admin()
      .from('accounts')
      .select('platform_user_id, access_token')
      .eq('platform', 'instagram')
      .eq('enabled', true)
      .limit(1)
      .single();

    if (error || !account?.access_token) {
      throw new Error('No enabled Instagram account with a token to query as');
    }

    const hashtagId = await resolveHashtagId(
      account.platform_user_id,
      account.access_token,
      source.handle,
    );

    const res = await graphGet<HashtagMediaResponse>(
      `/${hashtagId}/top_media`,
      account.access_token,
      {
        user_id: account.platform_user_id,
        fields:
          'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
        limit: '50',
      },
    );

    return (res.data ?? []).map((m) => ({
      platform: 'instagram' as const,
      externalId: m.id,
      authorHandle: null, // not exposed by this endpoint
      permalink: m.permalink ?? null,
      mediaType: m.media_type ?? null,
      mediaUrl: m.media_url ?? null,
      thumbnailUrl: m.thumbnail_url ?? null,
      caption: m.caption ?? null,
      publishedAt: m.timestamp ?? null,
      metrics: {
        views: null,
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
      },
    }));
  },
};
