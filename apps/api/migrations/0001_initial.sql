CREATE TABLE batch (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  officer_hash TEXT NOT NULL,        -- pbkdf2$iters$salt$hash
  door_hash    TEXT NOT NULL,
  branding     TEXT NOT NULL,        -- JSON, Zod-validated on write
  created_at   INTEGER NOT NULL
);

CREATE TABLE voter_roll (
  batch_id   TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  -- usu_id is the "Net Id" column in the USU member export (7 digits).
  -- It is the only identifier a voter ever sees or types. The export's
  -- "User Identifier" (6) and "Member Identifier" (8) are not imported.
  usu_id     TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  eligible   INTEGER NOT NULL DEFAULT 1,   -- computed at import: "Left Group" = 0
  PRIMARY KEY (batch_id, usu_id)
);

CREATE TABLE check_in (
  batch_id      TEXT NOT NULL,
  usu_id        TEXT NOT NULL,
  checked_in_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, usu_id),
  FOREIGN KEY (batch_id, usu_id)
    REFERENCES voter_roll(batch_id, usu_id) ON DELETE CASCADE
);

CREATE TABLE election (
  id        TEXT PRIMARY KEY,
  batch_id  TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  seats     INTEGER NOT NULL DEFAULT 1 CHECK (seats >= 1),
  status    TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','open','closed')),
  opened_at INTEGER,
  closed_at INTEGER
);

CREATE TABLE candidate (
  id          TEXT PRIMARY KEY,
  election_id TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL
);

-- the secret part
CREATE TABLE ballot (
  id           TEXT PRIMARY KEY,     -- random UUIDv4, never sequential
  election_id  TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  preferences  TEXT NOT NULL,        -- JSON: candidate ids in rank order
  receipt_hash TEXT NOT NULL,        -- sha256(token); voter holds the token
  voided       INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;                     -- deliberately no cast_at

CREATE INDEX ballot_receipt ON ballot(receipt_hash);

-- who voted, never what. This is the mark-off on the roll.
CREATE TABLE vote_receipt (
  election_id  TEXT NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  usu_id       TEXT NOT NULL,        -- = "Net Id" in the USU export
  voted_at     INTEGER NOT NULL,
  recast_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (election_id, usu_id)  -- the double-vote guard
);

CREATE TABLE election_seal (         -- written once at close, never updated
  election_id    TEXT PRIMARY KEY REFERENCES election(id),
  closed_at      INTEGER NOT NULL,
  ballot_count   INTEGER NOT NULL,
  ballots_sha256 TEXT NOT NULL
);

CREATE TABLE election_result (       -- one row per count run
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  election_id TEXT NOT NULL REFERENCES election(id),
  computed_at INTEGER NOT NULL,
  rounds      TEXT NOT NULL,         -- full round-by-round JSON
  winners     TEXT NOT NULL,
  tie_breaks  TEXT NOT NULL,         -- every tie, method, seed or reason
  overridden  INTEGER NOT NULL DEFAULT 0,
  supersedes  INTEGER REFERENCES election_result(id)
);

CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  role     TEXT NOT NULL,            -- super | officer | door
  action   TEXT NOT NULL,
  detail   TEXT,
  at       INTEGER NOT NULL
);
