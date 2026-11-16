/**
 * One election: candidates while draft, turnout while open, a link to the
 * result once closed.
 *
 * Candidates freeze at open. The screen states the rule before the officer
 * opens anything, and removes the controls afterwards.
 *
 * No tally before closed. While open this shows turnout only, never a
 * per-candidate figure (spec §4).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  addCandidate, closeElection, deleteElection, getTurnout, openElection, removeCandidate,
  type AdminElection, type Turnout,
} from '../api.js'
import { staffMessage } from '../errorMessage.js'

export type ElectionDetailProps = {
  batchId: string
  /** The route is `/b/:slug/...`, so the link needs the slug, not the id. */
  slug: string
  election: AdminElection
  onChanged: () => void
}

/**
 * Turnout is polled only while the tab is visible and the officer has been
 * active in the last ten minutes. Each poll costs D1 row reads, and one tab
 * left open used the free plan's daily allowance in a few hours.
 */
const POLL_MS = 5000
const IDLE_MS = 10 * 60_000

export function ElectionDetail({ batchId, slug, election, onChanged }: ElectionDetailProps) {
  const [turnout, setTurnout] = useState<Turnout | undefined>(undefined)
  const [candidateName, setCandidateName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const [paused, setPaused] = useState(false)
  // The Resume button bumps this to restart the poll effect.
  const [resumes, setResumes] = useState(0)

  useEffect(() => {
    if (election.status !== 'open') return
    let live = true
    let timer: ReturnType<typeof setInterval> | undefined
    let lastActivity = Date.now()

    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const poll = () => {
      // Checked on each tick, so there is no separate idle timer.
      if (Date.now() - lastActivity > IDLE_MS) {
        stop()
        setPaused(true)
        return
      }
      getTurnout(batchId, election.id)
        .then((next) => { if (live) setTurnout(next) })
        .catch(() => { /* ignore a dropped poll: no error banner */ })
    }
    const start = () => {
      if (timer !== undefined) return
      setPaused(false)
      poll()
      // Polling, not WebSockets: a database constraint settles the double-vote
      // race, so a live channel has nothing to coordinate (spec §1).
      timer = setInterval(poll, POLL_MS)
    }
    // Activity keeps a running poll alive. Once paused, only the button or
    // returning to the tab restarts it, not a stray mouse move.
    const onActivity = () => { lastActivity = Date.now() }
    const onVisibility = () => {
      if (document.hidden) return stop()
      lastActivity = Date.now()
      start()
    }

    window.addEventListener('pointerdown', onActivity)
    window.addEventListener('keydown', onActivity)
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()
    return () => {
      live = false
      stop()
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [batchId, election.id, election.status, resumes])

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
      <ul className="candidate-list plain-list">
        {election.candidates.map((candidate) => (
          <li className="row-card spread" key={candidate.id}>
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
          Candidates can no longer be edited because voting has opened.
        </p>
      )}

      {election.status === 'open' && (
        <>
          <h3>Turnout</h3>
          {turnout ? (
            <ul className="counts plain-list figures">
              <li>{turnout.ballots_cast} ballots cast</li>
              <li>{turnout.voters_checked_in} voters checked in</li>
              <li>{turnout.eligible} eligible members</li>
              <li>{turnout.added_at_door} of those were added at the door</li>
            </ul>
          ) : (
            <p className="muted">Loading turnout…</p>
          )}
          {paused && (
            <p className="muted">
              Turnout updates paused after 10 minutes without activity.{' '}
              <button type="button" onClick={() => setResumes((n) => n + 1)}>
                Resume
              </button>
            </p>
          )}
          <p className="muted">
            The count is not available until voting is closed.
          </p>

          {confirmingClose ? (
            <div className="confirm stack">
              <p>
                Closing seals the ballots. It{' '}
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
        <p className="centred">
          <Link className="button-link" to={`/b/${slug}/elections/${election.id}/result`}>
            View the result
          </Link>
        </p>
      )}

      {/* Offered at every status, with the rule stated. The API refuses once a ballot exists. */}
      {confirmingDelete ? (
        <div className="confirm stack">
          <p>
            Deleting removes <strong>{election.name}</strong>, its candidates and anything counted
            from it. It <strong>cannot be undone</strong>.
          </p>
          <p>
            An election that anyone has voted in cannot be deleted at all.
          </p>
          <div className="add-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run(() => deleteElection(batchId, election.id))}
            >
              Yes, delete this election
            </button>
            <button type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
          Delete this election
        </button>
      )}
    </section>
  )
}
