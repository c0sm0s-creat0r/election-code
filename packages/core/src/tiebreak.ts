import type { Fixed } from './fixed.js'
import type { TieBreakKind } from './types.js'

/** Candidate totals per round. Index 0 is round 1. */
export type History = Map<string, Fixed>[]

/**
 * Australian tie rule, step 1: compare totals at the most recent earlier
 * round where they differed. For an exclusion the lower candidate loses;
 * for election order the higher goes first.
 *
 * Returns null when the candidates were level at every round, which is when
 * the seeded draw takes over.
 */
export function countback(
  tied: string[],
  history: History,
  kind: TieBreakKind,
): { winner: string; atRound: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const round = history[i]!
    const totals = tied.map((id) => ({ id, votes: round.get(id) ?? 0n }))
    const distinct = new Set(totals.map((t) => t.votes.toString()))
    if (distinct.size === 1) continue

    const sorted = [...totals].sort((a, b) =>
      a.votes === b.votes ? a.id.localeCompare(b.id) : a.votes < b.votes ? -1 : 1,
    )
    const winner = kind === 'exclusion' ? sorted[0]!.id : sorted[sorted.length - 1]!.id
    return { winner, atRound: i + 1 }
  }
  return null
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * seed = sha256(electionId || ballotsSha256 || tieBreakId)
 *
 * Derived from the SEALED ballots, so anyone can re-derive it and verify the
 * draw, and it cannot be steered without changing the ballots and breaking
 * the seal. The tie-break id is included so two ties within one count do not
 * resolve to the same index.
 */
export function deriveSeed(
  electionId: string,
  ballotsSha256: string,
  tieBreakId: string,
): Promise<string> {
  return sha256Hex(`${electionId}|${ballotsSha256}|${tieBreakId}`)
}

/**
 * Australian tie rule, step 2: a draw. Candidate ids are sorted
 * lexicographically first so the caller's ordering cannot influence the
 * outcome. index = first 8 bytes of the seed, big-endian, mod n.
 */
export async function seededDraw(
  tied: string[],
  seedHex: string,
  _tieBreakId: string,
): Promise<string> {
  const sorted = [...tied].sort((a, b) => a.localeCompare(b))
  const seedInt = BigInt(`0x${seedHex.slice(0, 16)}`)
  const index = Number(seedInt % BigInt(sorted.length))
  return sorted[index]!
}
