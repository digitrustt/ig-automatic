-- ig-automatic :: initial schema
-- Discovery -> scoring -> remix -> publish -> feedback

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- config: single-row runtime switches (autopilot kill-switch lives here)
-- ---------------------------------------------------------------------------
create table config (
  id                  boolean primary key default true check (id),
  autopilot_enabled   boolean not null default false,
  shadow_mode         boolean not null default true,
  min_score           numeric not null default 2.0,
  max_posts_per_day   int     not null default 3,
  min_source_age_hours numeric not null default 6,
  max_source_age_hours numeric not null default 72,
  updated_at          timestamptz not null default now()
);
comment on column config.shadow_mode is
  'When true the pipeline renders and queues but never calls the publish API.';
comment on column config.min_score is
  'Velocity z-score threshold a post must clear to enter the render queue.';

insert into config (id) values (true);

-- ---------------------------------------------------------------------------
-- accounts: the IG/TikTok accounts we publish TO
-- ---------------------------------------------------------------------------
create table accounts (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null check (platform in ('instagram', 'tiktok')),
  handle            text not null,
  -- IG: the ig_user_id from the Graph API; TikTok: open_id
  platform_user_id  text not null,
  access_token      text,
  token_expires_at  timestamptz,
  niche             text not null,
  daily_post_limit  int not null default 3,
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (platform, platform_user_id)
);

-- ---------------------------------------------------------------------------
-- sources: where we look for viral content
-- ---------------------------------------------------------------------------
create table sources (
  id                    uuid primary key default gen_random_uuid(),
  -- The two `_graph` kinds are free and official; the `_apify` kinds are paid
  -- fallbacks for reach the Graph API does not expose.
  kind                  text not null check (kind in (
                          'ig_hashtag_graph',   -- IG Hashtag Search API
                          'ig_account_graph',   -- IG business_discovery
                          'ig_hashtag_apify',
                          'ig_account_apify',
                          'tt_hashtag_apify'
                        )),
  handle                text not null,   -- hashtag name (no #) or account username
  niche                 text not null,   -- baseline grouping for z-score
  enabled               boolean not null default true,
  poll_interval_minutes int not null default 180,
  last_polled_at        timestamptz,
  created_at            timestamptz not null default now(),
  unique (kind, handle)
);
create index sources_due_idx on sources (enabled, last_polled_at);

-- ---------------------------------------------------------------------------
-- posts: content discovered in the wild
-- ---------------------------------------------------------------------------
create table posts (
  id               uuid primary key default gen_random_uuid(),
  platform         text not null check (platform in ('instagram', 'tiktok')),
  external_id      text not null,
  source_id        uuid references sources (id) on delete set null,
  niche            text not null,
  author_handle    text,
  permalink        text,
  media_type       text,   -- REELS | VIDEO | IMAGE | CAROUSEL_ALBUM
  media_url        text,   -- CDN url; expires, so re-fetch before download
  thumbnail_url    text,
  caption          text,
  published_at     timestamptz,
  duration_seconds numeric,
  -- dedup fingerprints, filled during the render stage
  phash            text,
  audio_fp         text,
  first_seen_at    timestamptz not null default now(),
  score            numeric,
  scored_at        timestamptz,
  status           text not null default 'discovered' check (status in (
                     'discovered', 'tracking', 'selected', 'rejected',
                     'rendering', 'ready', 'published', 'failed'
                   )),
  reject_reason    text,
  unique (platform, external_id)
);
create index posts_status_score_idx on posts (status, score desc nulls last);
create index posts_niche_idx on posts (niche, published_at desc);
create index posts_phash_idx on posts (phash) where phash is not null;

-- ---------------------------------------------------------------------------
-- metric_snapshots: the time series that makes velocity detection possible
-- ---------------------------------------------------------------------------
create table metric_snapshots (
  id          bigserial primary key,
  post_id     uuid not null references posts (id) on delete cascade,
  captured_at timestamptz not null default now(),
  views       bigint,
  likes       bigint,
  comments    bigint,
  shares      bigint,
  saves       bigint
);
create index metric_snapshots_post_idx on metric_snapshots (post_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- niche_baselines: rolling mean/stddev of log-velocity, recomputed nightly.
-- Keyed by metric too: a niche's views/hour and likes/hour distributions are
-- orders of magnitude apart and must never share a baseline.
-- ---------------------------------------------------------------------------
create table niche_baselines (
  niche           text not null,
  metric          text not null check (metric in ('views', 'likes')),
  mean_velocity   numeric not null,   -- mean of ln(1 + velocity)
  stddev_velocity numeric not null,   -- stddev of ln(1 + velocity)
  sample_size     int not null,
  computed_at     timestamptz not null default now(),
  primary key (niche, metric)
);

-- ---------------------------------------------------------------------------
-- renditions: our remixed version of a source post
-- ---------------------------------------------------------------------------
create table renditions (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid not null references posts (id) on delete cascade,
  storage_path     text,          -- Supabase Storage key
  public_url       text,          -- signed/public URL handed to the IG API
  hook_text        text,
  caption          text,
  hashtags         text[],
  duration_seconds numeric,
  status           text not null default 'pending' check (status in (
                     'pending', 'rendering', 'ready', 'failed'
                   )),
  error            text,
  created_at       timestamptz not null default now()
);
create index renditions_status_idx on renditions (status, created_at);

-- ---------------------------------------------------------------------------
-- publications: what we actually pushed out
-- ---------------------------------------------------------------------------
create table publications (
  id            uuid primary key default gen_random_uuid(),
  rendition_id  uuid not null references renditions (id) on delete cascade,
  account_id    uuid not null references accounts (id) on delete cascade,
  scheduled_for timestamptz not null,
  published_at  timestamptz,
  external_id   text,     -- IG media id
  permalink     text,
  status        text not null default 'scheduled' check (status in (
                  'scheduled', 'publishing', 'published', 'failed', 'skipped_shadow'
                )),
  error         text,
  created_at    timestamptz not null default now()
);
create index publications_due_idx on publications (status, scheduled_for);

-- ---------------------------------------------------------------------------
-- publication_metrics: performance of OUR posts -> feeds back into scoring
-- ---------------------------------------------------------------------------
create table publication_metrics (
  id             bigserial primary key,
  publication_id uuid not null references publications (id) on delete cascade,
  captured_at    timestamptz not null default now(),
  views          bigint,
  likes          bigint,
  comments       bigint,
  shares         bigint,
  saves          bigint,
  follows        bigint
);
create index publication_metrics_pub_idx on publication_metrics (publication_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- jobs: durable queue driving the worker
-- ---------------------------------------------------------------------------
create table jobs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in (
               'ingest', 'score', 'render', 'publish',
               'collect_own_metrics', 'recompute_baselines', 'cleanup'
             )),
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'queued' check (status in (
               'queued', 'running', 'done', 'failed'
             )),
  attempts   int not null default 0,
  max_attempts int not null default 3,
  run_after  timestamptz not null default now(),
  locked_at  timestamptz,
  locked_by  text,
  error      text,
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index jobs_claim_idx on jobs (status, run_after) where status = 'queued';

-- ---------------------------------------------------------------------------
-- claim_jobs: atomic multi-row claim, safe across concurrent workers
-- ---------------------------------------------------------------------------
create or replace function claim_jobs(p_worker text, p_limit int default 1)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'running',
         locked_at = now(),
         locked_by = p_worker,
         attempts = attempts + 1
   where id in (
     select id from jobs
      where status = 'queued'
        and run_after <= now()
      order by run_after
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- Requeue jobs whose worker died mid-flight.
create or replace function reap_stale_jobs(p_timeout_minutes int default 30)
returns int
language sql
as $$
  with reaped as (
    update jobs
       set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
           locked_at = null,
           locked_by = null,
           error = coalesce(error, 'reaped: worker timeout')
     where status = 'running'
       and locked_at < now() - make_interval(mins => p_timeout_minutes)
    returning 1
  )
  select count(*)::int from reaped;
$$;

-- ---------------------------------------------------------------------------
-- RLS: everything is worker/service-role territory. Dashboard reads go through
-- the server-side client, so no anon policies are granted here.
-- ---------------------------------------------------------------------------
alter table config              enable row level security;
alter table accounts            enable row level security;
alter table sources             enable row level security;
alter table posts               enable row level security;
alter table metric_snapshots    enable row level security;
alter table niche_baselines     enable row level security;
alter table renditions          enable row level security;
alter table publications        enable row level security;
alter table publication_metrics enable row level security;
alter table jobs                enable row level security;
