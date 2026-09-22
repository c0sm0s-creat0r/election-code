/**
 * The receipt tokens this device is holding, per society.
 *
 * Two jobs, and the second is the reason this file exists at all:
 *
 * 1. Spec §4 requires the token be written to `localStorage`. It is shown once
 *    and is never stored server-side, so a voter who reloads the page without it
 *    has permanently lost the ability to verify their own ballot.
 * 2. It is how the app knows which elections this voter has already voted in.
 *    There is deliberately no "have I voted?" endpoint — answering that for
 *    anyone but the asker would leak who voted — so the knowledge has to live
 *    here, on the voter's own device.
 *
 * Every access is wrapped. `localStorage` throws rather than returning null in
 * Safari's private mode and when a quota is exhausted, and a voter must never
 * lose a ballot to browser storage. Losing the token is bad; a blank screen is
 * worse.
 *
 * The token is a bearer capability over one ballot: anyone holding it can void
 * that ballot while the election is open (see `apps/api/src/routes/receipts.ts`).
 * Keeping it on the device is spec §5's accepted trade — see
 * `docs/superpowers/LIMITATIONS.md` §15.
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
    // Filter rather than trust: a hand-edited or half-written value must not
    // put a non-string where a token is expected.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

/** Returns the new map, so the caller can hold it in state without re-reading. */
export function rememberReceipt(batchId: string, electionId: string, token: string): HeldReceipts {
  const held = { ...readReceipts(batchId), [electionId]: token }
  try {
    window.localStorage.setItem(keyFor(batchId), JSON.stringify(held))
  } catch {
    // Unwritable storage costs the voter the token on reload, not the vote.
  }
  return held
}

/** A voided ballot is no longer recorded, so the voter may vote in it again. */
export function forgetReceipt(batchId: string, electionId: string): HeldReceipts {
  const held = readReceipts(batchId)
  delete held[electionId]
  try {
    window.localStorage.setItem(keyFor(batchId), JSON.stringify(held))
  } catch {
    // Nothing to do: the map in memory is what the UI renders from.
  }
  return held
}
