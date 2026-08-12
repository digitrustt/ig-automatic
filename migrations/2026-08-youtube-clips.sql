-- ig-automatic :: YouTube clipping mode
--
-- A second way to source content, alongside reposting Instagram video. Here a
-- long video is the raw material and the product is several clips cut from it:
-- real editorial work rather than a re-upload, which is both a stronger post
-- and a materially different position under the platforms' unoriginal-content
-- rules.
--
-- The existing tables carry it: a video is a `posts` row, and each clip cut
-- from it is a `renditions` row with its own in/out points. One post to many
-- renditions already works — nothing about the queue, publishing, scheduling or
-- retention needs to change.

-- Sources can now be a YouTube channel.
alter table sources drop constraint sources_kind_check;
alter table sources add constraint sources_kind_check check (kind in (
  'ig_hashtag_graph',
  'ig_account_graph',
  'ig_hashtag_apify',
  'ig_account_apify',
  'tt_hashtag_apify',
  'yt_channel'
));

-- Posts can now originate from YouTube.
alter table posts drop constraint posts_platform_check;
alter table posts add constraint posts_platform_check
  check (platform in ('instagram', 'tiktok', 'youtube'));

-- Clipping runs as its own job kind: it is long (download, transcribe,
-- several renders) and worth retrying independently of anything else.
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check check (kind in (
  'ingest', 'score', 'render', 'publish',
  'collect_own_metrics', 'recompute_baselines', 'cleanup',
  'clip'
));

-- Where in the source video this rendition was cut from. Null for the repost
-- path, which uses the whole clip.
alter table renditions add column start_seconds numeric;
alter table renditions add column end_seconds   numeric;
-- What is said in the clip: used to burn captions and to explain a pick.
alter table renditions add column transcript text;

comment on column renditions.start_seconds is
  'In-point within the source video, for clips cut from long-form.';

-- A video is transcribed once, however many clips come out of it.
alter table posts add column transcript jsonb;
comment on column posts.transcript is
  'Whisper output with word-level timestamps, cached so re-clipping a video costs nothing.';

create index renditions_post_idx on renditions (post_id);
