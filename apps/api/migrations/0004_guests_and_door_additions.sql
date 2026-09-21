-- Two kinds of person the USU membership export does not contain.
--
-- A GUEST attends and cannot vote: an observer, a partner organisation, staff,
-- a member's guest. They get their own table rather than a row in voter_roll,
-- because they are not members -- putting them on the roll would change what
-- the roll means, what the import's upsert does on the next re-import, and what
-- "1,298 eligible" counts.
--
-- There is deliberately NO usu_id column here, and that absence is the control.
-- Ballot submission's eligibility clause joins voter_roll to check_in by
-- (batch_id, usu_id); a guest has nothing for it to match. A guest cannot vote
-- because the query finds nothing, not because a check says no. Do not add a
-- usu_id to this table, and do not "fix" a guest into voter_roll.
CREATE TABLE guest (
  id            TEXT PRIMARY KEY,     -- crypto.randomUUID()
  batch_id      TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,        -- as the volunteer typed it
  note          TEXT,                 -- optional: "observer, USU exec"
  checked_in_at INTEGER NOT NULL
);

CREATE INDEX guest_batch ON guest(batch_id);

-- A MEMBER the export missed is the opposite case: they genuinely belong on the
-- roll, so they are a roll row carrying a flag.
--
-- This flag is the reason that feature is defensible rather than merely
-- convenient. A door password can now enrol a voter, so "eligibility derives
-- from the membership export" becomes "derives from the export, plus N people
-- the door staff added" -- and N must never be hidden. It is reported by
-- GET /quorum beside the totals and carried as a column in both attendance
-- exports, so a committee reading the file sees which voters came from the
-- export and which did not.
--
-- NEVER CLEARED. If a corrected export later contains that member, the roll
-- import's upsert refreshes their name and eligibility and leaves this alone: a
-- human created the row at a desk, and a later file cannot un-happen it. The
-- upsert's SET list must not mention this column.
ALTER TABLE voter_roll ADD COLUMN added_at_door INTEGER NOT NULL DEFAULT 0;
