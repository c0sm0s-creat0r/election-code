/**
 * Every open election, and which ones this voter has done.
 *
 * An AGM opens its elections one at a time, and a `draft` one is hidden from
 * voters. Nothing here may say the meeting is finished, only that nothing is
 * open yet.
 */
import type { PublicElection } from '../api.js'
import type { HeldReceipts } from '../receipts.js'

export type AgendaProps = {
  /** `undefined` until the first poll answers. `[]` means nothing is open. */
  elections: PublicElection[] | undefined
  receipts: HeldReceipts
  /** True after a failed poll: the list may be stale. */
  stale: boolean
  onVote: (election: PublicElection) => void
  onReceipt: (election: PublicElection, token: string) => void
}

const positions = (seats: number) => (seats === 1 ? 'One position' : `${seats} positions`)

export function Agenda({ elections, receipts, stale, onVote, onReceipt }: AgendaProps) {
  if (elections === undefined) return <p class="muted">Loading…</p>

  const voted = elections.filter((e) => receipts[e.id] !== undefined).length

  return (
    <section class="stack">
      <h2>Voting now</h2>

      {stale && (
        <p class="muted" role="status">
          We could not check for new elections just now. Still trying.
        </p>
      )}

      {elections.length === 0 ? (
        <p>Nothing is open for voting yet.</p>
      ) : (
        <ul class="plain-list agenda-list">
          {elections.map((election) => {
            const token = receipts[election.id]
            return (
              <li key={election.id} class="row-card spread">
                <span class="agenda-name">
                  {election.name}
                  <span class="muted agenda-seats">{positions(election.seats)}</span>
                </span>
                {token === undefined ? (
                  <button type="button" class="primary" onClick={() => onVote(election)}>
                    Vote
                  </button>
                ) : (
                  <button type="button" onClick={() => onReceipt(election, token)}>
                    Voted ✓
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* aria-live: the next election appears here unprompted */}
      <p class="muted" aria-live="polite">
        {elections.length > 0 && voted === elections.length
          ? 'Keep this page open for the next election.'
          : 'More elections open as the meeting goes on. Keep this page open and they will appear here.'}
      </p>
    </section>
  )
}
