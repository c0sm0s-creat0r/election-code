/**
 * One election's ballot and its submission errors. `RankedBallot` owns the
 * ranking; this screen owns the submission. A request that never completes
 * may still have committed, and the wording must say so
 * (docs/superpowers/LIMITATIONS.md §1).
 */
import { useState } from 'preact/hooks'
import { ApiError, submitBallot, type PublicElection } from '../api.js'
import { RankedBallot } from '../components/RankedBallot.js'

export type BallotProps = {
  batchId: string
  election: PublicElection
  /** Leaving without voting. */
  onBack: () => void
  onCast: (receiptToken: string) => void
  /** Receives the draft ranking, so an expired session loses no work. */
  onSessionLost: (draft: string[]) => void
  initialRanking?: string[]
}

export function Ballot({
  batchId, election, onBack, onCast, onSessionLost, initialRanking,
}: BallotProps) {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (preferences: string[]) => {
    // Single-flight: a double tap would get a 409 "already voted".
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      const { receipt_token } = await submitBallot(batchId, election.id, preferences)
      onCast(receipt_token)
    } catch (caught) {
      if (!(caught instanceof ApiError)) {
        setError('Something went wrong. Please try again.')
        return
      }
      if (caught.status === 0) {
        // The ballot may have committed while the response, with the receipt token,
        // was lost. Do not imply failure or offer a retry.
        setError(
          'Your vote may have been recorded, but we could not show you a receipt — '
          + 'so you will not be able to verify it later. Do not submit again; '
          + 'ask an officer to check for you.',
        )
        return
      }
      if (caught.status === 401) {
        onSessionLost(preferences)
        return
      }
      if (caught.status === 403) {
        setError('You are no longer checked in. Please see the check-in desk.')
        return
      }
      if (caught.status === 409) {
        setError(`Your ballot for ${election.name} is already recorded.`)
        return
      }
      if (caught.status === 400) {
        // validateBallot's reasons are written for a voter. Show them as-is.
        setError(caught.message)
        return
      }
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section class="stack">
      {/* No "election 2 of 3": only the open ones are known. */}
      <p>
        <button type="button" class="link-button" onClick={onBack}>
          ← All elections
        </button>
      </p>
      <h2>{election.name}</h2>

      {error !== '' && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <RankedBallot
        key={election.id}
        candidates={election.candidates}
        seats={election.seats}
        onSubmit={submit}
        submitting={submitting}
        initialRanking={initialRanking}
      />
    </section>
  )
}
