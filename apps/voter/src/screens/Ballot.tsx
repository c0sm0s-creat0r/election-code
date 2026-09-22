/**
 * One election's ballot, and what happens when submitting it goes wrong.
 *
 * The ranking itself lives in `RankedBallot`; this screen owns the submission and
 * its outcomes. The interesting one is the network failure: a request that never
 * completes may still have committed, and the wording has to say that (spec §4.4,
 * `docs/superpowers/LIMITATIONS.md` §1).
 */
import { useState } from 'preact/hooks'
import { ApiError, submitBallot, type PublicElection } from '../api.js'
import { RankedBallot } from '../components/RankedBallot.js'

export type BallotProps = {
  batchId: string
  election: PublicElection
  /** Leaving without voting. Without it, tapping into a ballot is a trap. */
  onBack: () => void
  onCast: (receiptToken: string) => void
  /** Handed the draft ranking, so a lapsed session costs nobody their work. */
  onSessionLost: (draft: string[]) => void
  initialRanking?: string[]
}

export function Ballot({
  batchId, election, onBack, onCast, onSessionLost, initialRanking,
}: BallotProps) {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (preferences: string[]) => {
    // Single-flight. A double tap on a laggy connection would otherwise send two
    // requests; the API refuses the second with 409, but "already voted" is a bad
    // answer to a question the voter did not ask.
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
        // The dangerous case. The insert may have committed while the response was
        // lost, and the receipt token is never stored server-side, so it is gone.
        // Say so: do not imply failure, and do not offer a retry that would read
        // as a second chance at the receipt.
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
        setError('You are no longer checked in. Please see the door desk.')
        return
      }
      if (caught.status === 409) {
        setError(`Your ballot for ${election.name} is already recorded.`)
        return
      }
      if (caught.status === 400) {
        // validateBallot's reasons are written to be read by a voter mid-ballot,
        // so they are shown verbatim rather than translated.
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
      {/*
        No "election 2 of 3": the count is only of what is open right now, and
        stating it as a total told voters the meeting was nearly over when it was
        not. The agenda lists what is open; this says which one you are in.
      */}
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
