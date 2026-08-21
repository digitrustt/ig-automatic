export type Platform = 'instagram' | 'tiktok' | 'youtube' | 'facebook';

export type SourceKind =
  | 'ig_hashtag_graph'
  | 'ig_account_graph'
  | 'ig_hashtag_apify'
  | 'ig_account_apify'
  | 'tt_hashtag_apify'
  | 'yt_channel'
  | 'yt_channel_top'
  | 'yt_playlist';

export type PostStatus =
  | 'discovered'
  | 'tracking'
  | 'selected'
  | 'rejected'
  | 'rendering'
  | 'ready'
  | 'published'
  | 'failed';

export type RenditionStatus = 'pending' | 'rendering' | 'ready' | 'failed';

export type PublicationStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'skipped_shadow';

export type JobKind =
  | 'ingest'
  | 'score'
  | 'render'
  | 'publish'
  | 'collect_own_metrics'
  | 'recompute_baselines'
  | 'cleanup'
  | 'clip';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Config {
  id: true;
  autopilot_enabled: boolean;
  shadow_mode: boolean;
  min_score: number;
  max_posts_per_day: number;
  min_source_age_hours: number;
  max_source_age_hours: number;
  updated_at: string;
}

export interface Account {
  id: string;
  platform: Platform;
  handle: string;
  platform_user_id: string;
  access_token: string | null;
  token_expires_at: string | null;
  niche: string;
  daily_post_limit: number;
  enabled: boolean;
  created_at: string;
}

export interface Source {
  id: string;
  kind: SourceKind;
  handle: string;
  niche: string;
  enabled: boolean;
  poll_interval_minutes: number;
  /** Skip videos below this view count; null takes everything. */
  min_view_count: number | null;
  /** Spread this source's videos across these niches; null uses `niche`. */
  niche_pool: string[] | null;
  last_polled_at: string | null;
  created_at: string;
}

export interface Post {
  id: string;
  platform: Platform;
  external_id: string;
  source_id: string | null;
  niche: string;
  author_handle: string | null;
  permalink: string | null;
  media_type: string | null;
  media_url: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  phash: string | null;
  audio_fp: string | null;
  first_seen_at: string;
  score: number | null;
  scored_at: string | null;
  status: PostStatus;
  reject_reason: string | null;
}

export interface MetricSnapshot {
  id: number;
  post_id: string;
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

export type VelocityMetric = 'views' | 'likes';

export interface NicheBaseline {
  niche: string;
  metric: VelocityMetric;
  /** Mean of ln(1 + velocity). */
  mean_velocity: number;
  /** Stddev of ln(1 + velocity). */
  stddev_velocity: number;
  sample_size: number;
  computed_at: string;
}

export interface Rendition {
  id: string;
  post_id: string;
  storage_path: string | null;
  public_url: string | null;
  hook_text: string | null;
  caption: string | null;
  hashtags: string[] | null;
  duration_seconds: number | null;
  start_seconds: number | null;
  end_seconds: number | null;
  transcript: string | null;
  status: RenditionStatus;
  error: string | null;
  created_at: string;
}

export interface Publication {
  id: string;
  rendition_id: string;
  account_id: string;
  scheduled_for: string;
  published_at: string | null;
  external_id: string | null;
  permalink: string | null;
  status: PublicationStatus;
  error: string | null;
  created_at: string;
}

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: JobKind;
  payload: P;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  error: string | null;
  dedupe_key: string | null;
  created_at: string;
}
