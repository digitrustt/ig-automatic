-- ig-automatic :: publish the same clip to a Facebook Page
--
-- A Page is just another account to publish to, so it becomes a row in
-- `accounts` and reuses the whole scheduling, slot and retry machinery. What
-- differs is only the call at the very end, which branches on platform.
--
-- Instagram fetches the file from a URL we sign; Facebook wants the bytes
-- pushed to it. Both start from the same rendition.

alter table accounts drop constraint accounts_platform_check;
alter table accounts add constraint accounts_platform_check
  check (platform in ('instagram', 'tiktok', 'facebook'));

comment on column accounts.platform_user_id is
  'IG: ig_user_id. Facebook: the Page id. TikTok: open_id.';
