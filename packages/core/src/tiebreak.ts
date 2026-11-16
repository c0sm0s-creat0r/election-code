import type { Fixed } from './fixed.js'
import type { TieBreakKind } from './types.js'

/** Candidate totals per round. Index 0 is round 1. */
export type History = Map<string, Fixed>[]

/**
 * Tie rule, step 1: compare totals at the latest earlier round where they
 * differed. Exclusion: the lowest loses. Election order: the highest goes
 * first. Null when level at every round.
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

    // The extreme must be unique, or this round does not settle it.
    if (kind === 'exclusion') {
      const minVotes = sorted[0]!.votes
      const countAtMin = sorted.filter((t) => t.votes === minVotes).length
      if (countAtMin > 1) continue
      return { winner: sorted[0]!.id, atRound: i + 1 }
    } else {
      const maxVotes = sorted[sorted.length - 1]!.votes
      const countAtMax = sorted.filter((t) => t.votes === maxVotes).length
      if (countAtMax > 1) continue
      return { winner: sorted[sorted.length - 1]!.id, atRound: i + 1 }
    }
  }
  return null
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * seed = sha256(electionId | ballotsSha256 | tieBreakId)
 *
 * Derived from the sealed ballots: anyone can re-derive it, and nobody can
 * steer it without breaking the seal. The tie-break id gives each tie in a
 * count its own draw.
 */
export function deriveSeed(
  electionId: string,
  ballotsSha256: string,
  tieBreakId: string,
): Promise<string> {
  return sha256Hex(`${electionId}|${ballotsSha256}|${tieBreakId}`)
}

/**
 * Tie rule, step 2: a draw. Ids are sorted first, so caller order has no
 * effect. index = first 8 bytes of the seed, big-endian, mod n.
 */
export async function seededDraw(tied: string[], seedHex: string): Promise<string> {
  const sorted = [...tied].sort((a, b) => a.localeCompare(b))
  const seedInt = BigInt(`0x${seedHex.slice(0, 16)}`)
  const index = Number(seedInt % BigInt(sorted.length))
  return sorted[index]!
}
