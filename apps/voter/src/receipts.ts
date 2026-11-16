/**
 * The receipt tokens this device holds, per society, in `localStorage`.
 *
 * The token is shown once and not stored server-side, so this is the only
 * copy. It is also how the app knows which elections this voter has voted in:
 * there is no "have I voted?" endpoint.
 *
 * Every access is wrapped: storage throws in Safari's private mode and when
 * full. Losing a token must not cost a ballot.
 *
 * The token can void its ballot while the election is open
 * (docs/superpowers/LIMITATIONS.md §15).
 */

/** Election id → receipt token. */
export type HeldReceipts = Record<string, string>

const keyFor = (batchId: string) => `election:receipts:${batchId}`

export function readReceipts(batchId: string): HeldReceipts {
  try {
    const raw = window.localStorage.getItem(keyFor(batchId))
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    // Filter out non-strings: the value may have been hand-edited.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

/** Returns the new map for the caller's state. */
export function rememberReceipt(batchId: string, electionId: string, token: string): HeldReceipts {
  const held = { ...readReceipts(batchId), [electionId]: token }
  try {
    window.localStorage.setItem(keyFor(batchId), JSON.stringify(held))
  } catch {
    // Unwritable storage loses the token on reload, not the vote.
  }
  return held
}

/** A voided ballot is not recorded, so the voter may vote again. */
export function forgetReceipt(batchId: string, electionId: string): HeldReceipts {
  const held = readReceipts(batchId)
  delete held[electionId]
  try {
    window.localStorage.setItem(keyFor(batchId), JSON.stringify(held))
  } catch {
    // Nothing to do: the UI renders from the map in memory.
  }
  return held
}
