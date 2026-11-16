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
  /** Hex digest from election_seal. Fixes the tie-break draw. */
  ballotsSha256: string
  /**
   * Officer overrides, keyed by `TieBreakRecord.id`. `candidateId` is the
   * candidate to exclude (`exclusion`) or to elect first (`election_order`).
   * `count` throws on an override that matches no tie-break or names someone
   * outside the tie.
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
