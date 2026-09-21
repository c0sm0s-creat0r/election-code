/**
 * One election: candidates while it is a draft, turnout while it is open, and a
 * link to the result once it is closed.
 *
 * **Two rules from spec §4 live here, and both are stated rather than merely
 * enforced.**
 *
 * *Candidates freeze at open.* The rule is on screen before the officer opens
 * anything, because the API's 409 afterwards arrives too late to be useful — and
 * adding a candidate after fifty ballots means those fifty voters never had the
 * chance to rank them. The controls are **removed** once open, not disabled: a
 * disabled control says "later", and there is no later.
 *
 * *No tally before closed.* While open this screen shows turnout and nothing
 * else: ballots cast, voters checked in, eligible, and how many of those were
 * added at the door. There is deliberately no per-candidate figure anywhere in
 * this app before a seal exists, because an officer who can watch the result
 * develop and choose when to stop makes every other control decorative.
 */
import { useEffect, useState } from 'react'
import {
  addCandidate, closeElection, getTurnout, openElection, removeCandidate,
  type AdminElection, type Turnout,
} from '../api.js'
import { staffMessage } from '../errorMessage.js'

export type ElectionDetailProps = {
  batchId: string
  election: AdminElection
  onChanged: () => void
}

export function ElectionDetail({ batchId, election, onChanged }: ElectionDetailProps) {
  const [turnout, setTurnout] = useState<Turnout | undefined>(undefined)
  const [candidateName, setCandidateName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)

  useEffect(() => {
    if (election.status !== 'open') return
    let live = true
    const poll = () => {
      getTurnout(batchId, election.id)
        .then((next) => { if (live) setTurnout(next) })
        .catch(() => { /* a dropped poll is not worth an error banner */ })
    }
    poll()
    // Polling, not WebSockets: the double-vote race is settled by a database
    // constraint, so a Durable Object would buy nothing here (spec §1).
    const timer = setInterval(poll, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [batchId, election.id, election.status])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      onChanged()
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const isDraft = election.status === 'draft'

  return (
    <section className="stack">
      <h2>{election.name}</h2>
      <p className="muted">
        {election.seats} seat{election.seats === 1 ? '' : 's'} · {election.status}
      </p>

      {error !== '' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h3>Candidates</h3>
      <ul className="candidate-list">
        {election.candidates.map((candidate) => (
          <li className="candidate-row" key={candidate.id}>
            <span>{candidate.name}</span>
            {isDraft && (
              <button
                type="button"
                aria-label={`Remove ${candidate.name}`}
                disabled={busy}
                onClick={() => void run(() => removeCandidate(batchId, election.id, candidate.id))}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {isDraft ? (
        <>
          <div className="field">
            <label htmlFor="candidate-name">New candidate</label>
            <input
              id="candidate-name"
              value={candidateName}
              onChange={(e) => setCandidateName(e.target.value)}
            />
          </div>
          <button
            type="button"
            disabled={candidateName.trim() === '' || busy}
            onClick={() =>
              void run(async () => {
                await addCandidate(batchId, election.id, candidateName.trim())
                setCandidateName('')
              })
            }
          >
            Add candidate
          </button>

          <p className="rule-note">
            Once voting opens, candidates <strong>cannot be added, renamed or removed</strong>.
            Anyone added afterwards could not be ranked by people who have already voted.
          </p>

          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void run(() => openElection(batchId, election.id))}
          >
            Open voting
          </button>
        </>
      ) : (
        <p className="rule-note">
          Candidates are frozen because voting has opened.
        </p>
      )}

      {election.status === 'open' && (
        <>
          <h3>Turnout</h3>
          {turnout ? (
            <ul className="counts figures">
              <li>{turnout.ballots_cast} ballots cast</li>
              <li>{turnout.voters_checked_in} voters checked in</li>
              <li>{turnout.eligible} eligible members</li>
              <li>{turnout.added_at_door} of those were added at the door</li>
            </ul>
          ) : (
            <p className="muted">Loading turnout…</p>
          )}
          <p className="muted">
            The count is not available until voting is closed. That is deliberate.
          </p>

          {confirmingClose ? (
            <div className="confirm stack">
              <p>
                Closing seals the ballots and publishes the count. It{' '}
                <strong>cannot be reopened</strong>.
              </p>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void run(() => closeElection(batchId, election.id))}
              >
                Yes, close voting
              </button>
              <button type="button" onClick={() => setConfirmingClose(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmingClose(true)}>
              Close voting
            </button>
          )}
        </>
      )}

      {election.status === 'closed' && (
        <p>
          <a href={`/b/${batchId}/elections/${election.id}/result`}>View the result</a>
        </p>
      )}
    </section>
  )
}
