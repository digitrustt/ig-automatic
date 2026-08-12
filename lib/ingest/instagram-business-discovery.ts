import { graphGet } from '@/lib/instagram/graph';
import { admin } from '@/lib/supabase/admin';
import type { Source } from '@/lib/types/db';
import type { RawPost, SourceAdapter } from './types';

interface DiscoveryResponse {
  business_discovery?: {
    username?: string;
    followers_count?: number;
    media?: {
      data: Array<{
        id: string;
        caption?: string;
        like_count?: number;
        comments_count?: number;
        timestamp?: string;
        permalink?: string;
        media_url?: string;
        thumbnail_url?: string;
        media_product_type?: string;
        media_type?: string;
      }>;
    };
  };
}

/**
 * Official, free competitor-account discovery. Replaces the paid Apify profile
 * scraper for the common case.
 *
 * Limits that shape how it is used:
 *  - The target account must itself be a Business or Creator account. Personal
 *    accounts return an error, so a source that keeps failing is usually a
 *    private or personal target rather than a bug.
 *  - No play counts, so velocity here comes from likes and comments.
 *  - Counts against the same Graph API call budget as everything else, which is
 *    generous but not unlimited — keep poll intervals at hours, not minutes.
 */
export const instagramBusinessDiscoveryAdapter: SourceAdapter = {
  kind: 'ig_account_graph',

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

    const target = source.handle.replace(/^@/, '');
    const mediaFields = [
      'id',
      'caption',
      'like_count',
      'comments_count',
      'timestamp',
      'permalink',
      'media_url',
      'thumbnail_url',
      'media_product_type',
      'media_type',
    ].join(',');

    const res = await graphGet<DiscoveryResponse>(
      `/${account.platform_user_id}`,
      account.access_token,
      {
        fields: `business_discovery.username(${target}){followers_count,media.limit(25){${mediaFields}}}`,
      },
    );

    const discovery = res.business_discovery;
    if (!discovery) {
      throw new Error(`business_discovery returned nothing for @${target}`);
    }

    return (discovery.media?.data ?? []).map((m) => ({
      platform: 'instagram' as const,
      externalId: m.id,
      authorHandle: discovery.username ?? target,
      permalink: m.permalink ?? null,
      mediaType: m.media_product_type === 'CLIPS' ? 'REELS' : (m.media_type ?? null),
      mediaUrl: m.media_url ?? null,
      thumbnailUrl: m.thumbnail_url ?? null,
      caption: m.caption ?? null,
      publishedAt: m.timestamp ?? null,
      metrics: {
        views: null, // not exposed for other people's media
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
      },
    }));
  },
};
