-- ig-automatic :: feed an account from back catalogues, not just new uploads
--
-- A tracked channel yields a few videos a week, which is thin once an account
-- posts eight times a day. The material that closes the gap is already
-- published: years of uploads ranked by view count, other people's best-of
-- playlists, a single video somebody pointed at. Same pipeline for all of it —
-- only the listing URL differs — so they are source kinds rather than new code
-- paths.

alter table public.sources drop constraint sources_kind_check;
alter table public.sources add constraint sources_kind_check check (kind in (
  'ig_hashtag_graph',
  'ig_account_graph',
  'ig_hashtag_apify',
  'ig_account_apify',
  'tt_hashtag_apify',
  'yt_channel',      -- new uploads
  'yt_channel_top',  -- the archive, most-viewed first
  'yt_playlist',     -- somebody else's edit of a channel
  'yt_video'         -- one video, named directly
));

comment on column public.sources.kind is
  'yt_channel follows new uploads; yt_channel_top, yt_playlist and yt_video work back catalogues.';


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


-- One source can feed several accounts. Spreading a back catalogue between
-- them keeps any one account from reading as a single channel's rip, and makes
-- a finite pile of material last proportionally longer on each.
alter table public.sources add column if not exists niche_pool text[];

comment on column public.sources.niche_pool is
  'Spread this source''s videos across these niches; null publishes to niche.';


-- How many clips to take from one video, per source. This is the pacing dial
-- for a back catalogue: a hundred-video playlist yielding two clips each lasts
-- months, and the same playlist yielding six is spent before the account has
-- found its audience.
alter table public.sources add column if not exists max_clips_per_video integer;

comment on column public.sources.max_clips_per_video is
  'Clips taken from one video; null uses MAX_CLIPS_PER_VIDEO.';
