import type { Fixed } from './fixed.js'

export type Candidate = { id: string; name: string }

/** A ballot as the count sees it: preferences already validated. */
export type CountBallot = { id: string; preferences: string[] }

export type CandidateStatus = 'continuing' | 'elected' | 'excluded'

export type RoundCount = {
  candidateId: string
  name: string
  votes: string // Fixed, formatted
  status: CandidateStatus
}

export type Round = {
  n: number
  counts: RoundCount[]
  elected: {
    candidateId: string
    name: string
    surplus: string
    transferValue: string
  }[]
  excluded: { candidateId: string; name: string }[]
  nonTransferable: string // cumulative
}

export type TieBreakKind = 'exclusion' | 'election_order'
export type TieBreakMethod = 'countback' | 'seeded_draw' | 'officer_override'

export type TieBreakRecord = {
  id: string // "tb-1", "tb-2", ... - what the override endpoint references
  kind: TieBreakKind
  round: number
  candidates: string[]
  resolved: string
  method: TieBreakMethod
  resolvedAtRound: number | null
  seed: string | null
  reason: string | null
}

export type CountInput = {
  candidates: Candidate[]
  ballots: CountBallot[]
  seats: number
  electionId: string
  /** hex digest from election_seal; fixes the tie-break draw */
  ballotsSha256: string
  /**
   * Officer overrides, keyed by `TieBreakRecord.id` ("tb-1", "tb-2", ...).
   *
   * `candidateId` is the candidate the tie-break RESOLVES TO, which is not
   * always the candidate who benefits - read this carefully before wiring a
   * UI to it:
   *
   * - `kind: 'exclusion'` - `candidateId` is the candidate to EXCLUDE. The
   *   tie is over who goes out, so the resolved id is the one who loses.
   * - `kind: 'election_order'` - `candidateId` is the candidate to elect
   *   FIRST, i.e. whose surplus is distributed first. The resolved id is the
   *   one who goes ahead.
   *
   * Both write straight into `TieBreakRecord.resolved` with the same meaning,
   * so a result document and an override speak the same language. A UI that
   * labels this field "winner" for an exclusion tie would collect the exact
   * opposite of the officer's intent.
   *
   * `reason` is required - spec section 3 says an override "requires a reason,
   * is written to audit_log, and appears in the result document" - and is
   * copied verbatim into `TieBreakRecord.reason`.
   *
   * An override whose key matches no tie-break in this count, or whose
   * `candidateId` is not among that tie-break's candidates, makes `count`
   * throw. A stale override must not be silently discarded: the officer would
   * be told their decision stands while the result says it was never applied.
   */
  overrides?: Record<string, { candidateId: string; reason: string }>
}

export type CountResult = {
  quota: string
  rounds: Round[]
  winners: Candidate[]
  tieBreaks: TieBreakRecord[]
}

export type { Fixed }
