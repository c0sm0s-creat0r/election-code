/**
 * Every election that is open right now, and which of them this voter has done.
 *
 * **This screen exists because an AGM opens its elections one at a time.** The
 * app used to walk the list that was open when the page loaded and then say
 * "that is every election" — so a voter who voted for President during item 4
 * was told the voting was over, and left before Secretary opened. Nothing here
 * may ever claim the meeting is finished: the app cannot know that, because a
 * `draft` election is deliberately invisible to a voter (spec §6). All it can
 * honestly say is that nothing is open *yet*, and keep watching.
 */
import type { PublicElection } from '../api.js'
import type { HeldReceipts } from '../receipts.js'

export type AgendaProps = {
  /** `undefined` until the first poll answers; `[]` means nothing is open. */
  elections: PublicElection[] | undefined
  receipts: HeldReceipts
  /** True once a poll has failed and the list on screen may be stale. */
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

      {/*
        The whole point of the screen. `aria-live` because the list changes under
        a voter who is not looking at it — the next election appears here on its
        own, and a screen reader should hear that it did.
      */}
      <p class="muted" aria-live="polite">
        {elections.length > 0 && voted === elections.length
          ? 'That is everything open so far. Keep this page open — the next election appears here when it opens.'
          : 'More elections open as the meeting goes on. Keep this page open and they will appear here.'}
      </p>
    </section>
  )
}
