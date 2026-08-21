-- ig-automatic :: clip a channel's back catalogue, not just its new uploads
--
-- A tracked channel yields a few videos a week, which is thin once an account
-- posts several times a day. The archive is the deeper seam: years of uploads,
-- already ranked by the audience. Sorting a channel by view count and working
-- down it turns a back catalogue into months of material.
--
-- Same pipeline either way — only the listing URL differs, so this is a source
-- kind rather than a new code path.

alter table public.sources drop constraint sources_kind_check;
alter table public.sources add constraint sources_kind_check check (kind in (
  'ig_hashtag_graph',
  'ig_account_graph',
  'ig_hashtag_apify',
  'ig_account_apify',
  'tt_hashtag_apify',
  'yt_channel',
  'yt_channel_top'
));

comment on column public.sources.kind is
  'yt_channel follows new uploads; yt_channel_top works down the most-viewed archive.';

-- A channel that publishes several times a day is mostly noise: the same feed
-- carries both the piece everyone is talking about and four that nobody
-- watched. View count is the audience's own verdict on which is which, so a
-- source can require one before a video is worth clipping.
--
-- Null means take everything, which is right for a channel that publishes
-- rarely and lands every time.
alter table public.sources add column if not exists min_view_count integer;

comment on column public.sources.min_view_count is
  'Skip videos below this view count; null takes everything.';

-- A playlist is somebody else's edit of a channel — a best-of, a themed run —
-- and is often the only place that material exists as a set. Same pipeline as a
-- channel; only the listing URL differs.
alter table public.sources drop constraint sources_kind_check;
alter table public.sources add constraint sources_kind_check check (kind in (
  'ig_hashtag_graph',
  'ig_account_graph',
  'ig_hashtag_apify',
  'ig_account_apify',
  'tt_hashtag_apify',
  'yt_channel',
  'yt_channel_top',
  'yt_playlist'
));

-- One source can feed several accounts. Spreading a back catalogue between
-- them keeps any one account from reading as a single channel's rip, and makes
-- a finite pile of material last proportionally longer on each.
alter table public.sources add column if not exists niche_pool text[];

comment on column public.sources.niche_pool is
  'Spread this source''s videos across these niches; null publishes to niche.';
