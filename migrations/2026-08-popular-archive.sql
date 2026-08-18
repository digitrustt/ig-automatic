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
