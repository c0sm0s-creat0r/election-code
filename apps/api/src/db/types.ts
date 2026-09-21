// Hand-written row types matching apps/api/migrations/0001_initial.sql exactly.
// No ORM: these describe the shape of rows returned by D1's prepared-statement
// API. Booleans and timestamps are SQLite integers (0/1, unix ms).

export type BatchRow = {
  id: string
  slug: string
  name: string
  officer_hash: string
  door_hash: string
  branding: string // JSON, Zod-validated on write
  created_at: number
}

export type VoterRollRow = {
  batch_id: string
  // usu_id is the "Net Id" column in the USU member export (7 digits).
  // It is the only identifier a voter ever sees or types. The export's
  // "User Identifier" (6) and "Member Identifier" (8) are not imported.
  usu_id: string
  first_name: string
  last_name: string
  eligible: number // 0 | 1; computed at import: "Left Group" = 0
  /**
   * 1 when a door volunteer created this row because the export missed the
   * member. Added in 0004, and never cleared -- see that migration. This is
   * what keeps a door-added voter visible in `GET /quorum` and in both
   * attendance exports.
   */
  added_at_door: number // 0 | 1
}

/**
 * Someone in the room who is not on the roll and cannot vote. Migration 0004.
 * Deliberately has no `usu_id`: nothing joins a guest to the roll, so the
 * ballot insert's eligibility clause has nothing to match.
 */
export type GuestRow = {
  id: string
  batch_id: string
  name: string
  note: string | null
  checked_in_at: number
}

export type CheckInRow = {
  batch_id: string
  usu_id: string
  checked_in_at: number
}

export type ElectionStatus = 'draft' | 'open' | 'closed'

export type ElectionRow = {
  id: string
  batch_id: string
  name: string
  seats: number
  status: ElectionStatus
  opened_at: number | null
  closed_at: number | null
}

export type CandidateRow = {
  id: string
  election_id: string
  name: string
  ordinal: number
}

// the secret part — no timestamp column. See migration comment.
export type BallotRow = {
  id: string // random UUIDv4, never sequential
  election_id: string
  preferences: string // JSON: candidate ids in rank order
  receipt_hash: string // sha256(token); voter holds the token
  voided: number // 0 | 1
}

/** The two columns the count needs from a ballot. */
export type CountBallotRow = Pick<BallotRow, 'id' | 'preferences'>

// who voted, never what. This is the mark-off on the roll.
export type VoteReceiptRow = {
  election_id: string
  usu_id: string // = "Net Id" in the USU export
  voted_at: number
  recast_count: number
  /**
   * The receipt hash of this voter's CURRENT live ballot, or null if they hold
   * none (they have voided, or the election has closed). Added in 0002; see
   * that migration for why it exists and why it must not outlive the count.
   *
   * Non-null, this is a join from a usu_id to a ballot's preferences. Do not
   * select it into anything, do not export it, and do not leave it set once
   * ballots can no longer be voided.
   */
  live_receipt_hash: string | null
}

// written once at close, never updated
export type ElectionSealRow = {
  election_id: string
  closed_at: number
  ballot_count: number
  ballots_sha256: string
}

// one row per count run
export type ElectionResultRow = {
  id: number
  election_id: string
  computed_at: number
  /** Fixed-point, formatted, e.g. "2.00000". Added in 0003; see that migration. */
  quota: string
  rounds: string // full round-by-round JSON
  winners: string
  tie_breaks: string // every tie, method, seed or reason
  overridden: number // 0 | 1
  supersedes: number | null
}

export type AuditLogRole = 'super' | 'public' | 'officer' | 'door' | 'voter'

export type AuditLogRow = {
  id: number
  // null for a privileged action that has no batch to attribute -- a
  // denied super-admin-key attempt. See migrations/0001_initial.sql.
  batch_id: string | null
  role: AuditLogRole
  action: string
  detail: string | null
  at: number
}
