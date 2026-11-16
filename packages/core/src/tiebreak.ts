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
    const votes = (id: string) => history[i]!.get(id) ?? 0n
    const extreme = tied
      .map(votes)
      .reduce((a, b) => ((kind === 'exclusion' ? b < a : b > a) ? b : a))
    // The extreme must be unique, or this round does not settle it.
    const atExtreme = tied.filter((id) => votes(id) === extreme)
    if (atExtreme.length === 1) return { winner: atExtreme[0]!, atRound: i + 1 }
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
