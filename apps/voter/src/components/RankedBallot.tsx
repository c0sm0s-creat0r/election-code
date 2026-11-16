/**
 * The ranked ballot. The rank number is always visible. Removing a preference
 * renumbers the rest and discards none.
 *
 * Reordering is by arrows, never drag. Boundary arrows are disabled, not
 * hidden, so rows do not reflow. Every control's accessible name includes
 * the candidate.
 */
import { useState } from 'preact/hooks'
import { minimumPreferences } from '@election/core'

export type BallotCandidate = { id: string; name: string }

export type RankedBallotProps = {
  candidates: BallotCandidate[]
  seats: number
  onSubmit: (preferences: string[]) => void
  submitting: boolean
  /** A draft restored after the session expired mid-ballot. */
  initialRanking?: string[]
}

export function RankedBallot({
  candidates, seats, onSubmit, submitting, initialRanking,
}: RankedBallotProps) {
  const [ranking, setRanking] = useState<string[]>(initialRanking ?? [])

  // The same function the API calls, so the two agree.
  const minimum = minimumPreferences(seats, candidates.length)
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]))
  const unranked = candidates.filter((c) => !ranking.includes(c.id))
  const complete = ranking.length >= minimum

  const addPreference = (id: string) => setRanking((current) => [...current, id])

  /** Removing renumbers the rest and discards none. */
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
    // The rule. The disabled attribute only presents it.
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

      {/* role="status", so a screen reader announces why the button is disabled */}
      <p class="progress muted" role="status">
        {ranking.length} of {minimum} required preference{minimum === 1 ? '' : 's'} ranked
        {complete ? 'Ready to submit' : ''}
      </p>

      <div class="submit-bar sticky-bar">
        <button type="button" class="primary submit" disabled={!complete || submitting} onClick={submit}>
          {submitting ? 'Submitting…' : 'Submit ballot'}
        </button>
      </div>
    </div>
  )
}
