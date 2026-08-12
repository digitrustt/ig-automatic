import type { Platform, Source } from '@/lib/types/db';

/** Normalized shape every source adapter must produce. */
export interface RawPost {
  platform: Platform;
  externalId: string;
  authorHandle?: string | null;
  permalink?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  caption?: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  metrics: RawMetrics;
}

/**
 * Any field may be null: the official IG Hashtag Search API, for example,
 * exposes neither view counts nor the author's username.
 */
export interface RawMetrics {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
}

export interface SourceAdapter {
  kind: Source['kind'];
  fetch(source: Source): Promise<RawPost[]>;
}
