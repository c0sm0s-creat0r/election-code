/**
 * The ranked ballot.
 *
 * **What the legacy app got wrong.** `toggleRank` appended clicks to an array, so
 * rank came from the order you happened to tap, no ordinal was ever shown, and
 * changing preference 2 meant unticking everything after it. Spec §4 requires
 * this rebuilt rather than ported. So: the ordinal is always visible, removing a
 * preference renumbers the rest and discards nothing, and order is explicit.
 *
 * **Reordering is arrows, and there is no drag.** Spec §4 says "arrows or drag".
 * Drag is fiddly with a thumb, and it needs a keyboard-accessible equivalent
 * built anyway — which is arrows. Building both doubles the work on the harder
 * interaction. The boundary arrows are **disabled, not hidden**, so a row never
 * reflows under a thumb already moving toward it.
 *
 * **Every control's accessible name includes the candidate.** A button labelled
 * only "▲" is unusable with a screen reader, and it forces tests to find rows by
 * index rather than by what they are.
 */
import { useState } from 'preact/hooks'
import { minimumPreferences } from '@election/core'

export type BallotCandidate = { id: string; name: string }

export type RankedBallotProps = {
  candidates: BallotCandidate[]
  seats: number
  onSubmit: (preferences: string[]) => void
  submitting: boolean
  /**
   * A draft handed back after a session lapsed mid-ballot. A voter who has to
   * sign in again must not lose their ranking (spec §4.4).
   */
  initialRanking?: string[]
}

export function RankedBallot({
  candidates, seats, onSubmit, submitting, initialRanking,
}: RankedBallotProps) {
  // One array of candidate ids, in rank order — exactly the shape the API wants,
  // so nothing has to be transformed on the way out.
  const [ranking, setRanking] = useState<string[]>(initialRanking ?? [])

  // The same function the API calls, so the two can never disagree about what a
  // valid ballot is. It is min(seats, candidateCount), floored at 1.
  const minimum = minimumPreferences(seats, candidates.length)
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]))
  const unranked = candidates.filter((c) => !ranking.includes(c.id))
  const complete = ranking.length >= minimum

  const addPreference = (id: string) => setRanking((current) => [...current, id])

  /** Removing renumbers the rest, and discards nothing. */
  const removePreference = (id: string) =>
    setRanking((current) => current.filter((existing) => existing !== id))

  const movePreference = (index: number, delta: -1 | 1) =>
    setRanking((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const moved = next[index]!
      next[index] = next[target]!
      next[target] = moved
      return next
    })

  const submit = () => {
    // Guarded here as well as by the disabled attribute: a disabled button is a
    // presentation detail, and this is the rule.
    if (!complete || submitting) return
    onSubmit(ranking)
  }

  return (
    <div class="stack">
      <p class="muted">
        Rank at least {minimum} candidate{minimum === 1 ? '' : 's'}, starting with your favourite.
        You may rank more if you wish.
      </p>

      <section aria-labelledby="your-ranking">
        <h2 id="your-ranking">Your ranking</h2>
        {ranking.length === 0 ? (
          <p class="muted">Nothing ranked yet. Choose a candidate below.</p>
        ) : (
          <ol class="ranked-list plain-list">
            {ranking.map((id, index) => (
              <li class="ranked-item row-card" key={id} data-testid={`ranked-${index}`}>
                <span class="ordinal figures" data-testid={`ordinal-${index}`} aria-hidden="true">
                  {index + 1}
                </span>
                <span class="candidate-name">
                  <span class="sr-only">Preference {index + 1}: </span>
                  {nameOf.get(id)}
                </span>
                <span class="row-controls">
                  <button
                    type="button"
                    aria-label={`Move ${nameOf.get(id)} up`}
                    disabled={index === 0}
                    onClick={() => movePreference(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${nameOf.get(id)} down`}
                    disabled={index === ranking.length - 1}
                    onClick={() => movePreference(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${nameOf.get(id)}`}
                    onClick={() => removePreference(id)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {unranked.length > 0 && (
        <section aria-labelledby="to-rank">
          <h2 id="to-rank">Tap to add</h2>
          <ul class="add-list plain-list">
            {unranked.map((candidate) => (
              <li class="add-row" key={candidate.id}>
                <button
                  type="button"
                  aria-label={`Add ${candidate.name}`}
                  onClick={() => addPreference(candidate.id)}
                >
                  <span class="candidate-name">{candidate.name}</span>
                  <span class="add-mark" aria-hidden="true">+</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        A live region, so a screen reader hears the gate rather than discovering a
        dead button. role="status" is polite: it does not interrupt.
      */}
      <p class="progress muted" role="status">
        {ranking.length} of {minimum} required preference{minimum === 1 ? '' : 's'} ranked
        {complete ? ' — ready to submit' : ''}
      </p>

      <div class="submit-bar sticky-bar">
        <button type="button" class="primary submit" disabled={!complete || submitting} onClick={submit}>
          {submitting ? 'Submitting…' : 'Submit ballot'}
        </button>
      </div>
    </div>
  )
}
