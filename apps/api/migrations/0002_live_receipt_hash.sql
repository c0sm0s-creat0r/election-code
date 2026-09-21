-- Lets a void find the mark-off row it has to clear.
--
-- `ballot` carries no voter reference -- that absence IS the secret ballot --
-- so a void keyed on `receipt_hash` alone has no way to find the
-- `vote_receipt` row for the voter whose ballot it just voided. Without that,
-- either the void cannot clear the mark-off (and spec section 4's "voiding ...
-- lets the voter cast again" is impossible) or re-submission has no guard and
-- a voter can hold two live ballots.
--
-- THE COST, accepted deliberately and with the tradeoff stated before the
-- decision: while a ballot is live, this column is a join from `usu_id` to
-- that ballot's preferences. It is the correlation spec section 2 drops
-- `cast_at` and ROWID to prevent, and anyone with database access can follow
-- it. It is therefore bounded, and must STAY bounded:
--
--   * the void sets it to NULL, so it exists only while a ballot is live;
--   * closing an election MUST NULL it for every row of that election, in the
--     same transaction that writes `election_seal` (Plan 2c);
--   * the post-AGM purge must cover `vote_receipt`, whose `usu_id` spec
--     section 2's retention paragraph does not currently name at all.
--
-- What it buys, beyond simplicity: because the receipt row is found THROUGH
-- the hash, a void always clears the true owner's mark-off. Someone holding a
-- stolen token can destroy that voter's ballot -- which spec section 5's
-- public void endpoint already accepts -- but cannot mint a second live
-- ballot for themselves.
ALTER TABLE vote_receipt ADD COLUMN live_receipt_hash TEXT;

-- Two receipt rows must never claim one ballot. Partial, so the many NULLs
-- (every voter who has voided, and after close, every voter) do not collide.
CREATE UNIQUE INDEX vote_receipt_live ON vote_receipt(live_receipt_hash)
  WHERE live_receipt_hash IS NOT NULL;
