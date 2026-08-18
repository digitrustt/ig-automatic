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
