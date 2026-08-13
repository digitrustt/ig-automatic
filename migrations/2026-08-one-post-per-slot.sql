-- ig-automatic :: one post per slot
--
-- Scheduling read the day's booked hours and picked the first free one. With
-- two publish jobs running concurrently both read before either wrote, both
-- saw the same hour free, and both took it — so two Reels would have gone out
-- in the same minute, which is the burst pattern the slot spacing exists to
-- prevent.
--
-- Checking harder in application code cannot fix a read-then-write race. The
-- database can: a unique index makes the second insert fail, and the caller
-- retries against the next slot.
--
-- Failed publications are excluded so a slot frees up when a post never made
-- it out.

create unique index publications_one_per_slot
  on publications (account_id, scheduled_for)
  where status <> 'failed';
