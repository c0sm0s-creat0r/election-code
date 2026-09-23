/**
 * The officer's election list: create one, pick one, or see its result.
 *
 * Drafts come from the officer-only listing. The public route hides them, so
 * without that endpoint an officer who reloaded could not find the election they
 * had just created.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import { createElection, getRollSummary, listElections, type AdminElection } from '../api.js'
import type { OfficerContext } from '../OfficerLayout.js'
import { staffMessage } from '../errorMessage.js'
import { ElectionDetail } from './ElectionDetail.js'

export function Elections() {
  const { batch } = useOutletContext<OfficerContext>()
  const batchId = batch.id
  const slug = batch.slug

  const [elections, setElections] = useState<AdminElection[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  const [seats, setSeats] = useState('1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // The form is a disclosure, not a permanent fixture. Creating an election is a
  // once-per-office act; the list is what an officer comes back to.
  const [creating, setCreating] = useState(false)
  // Only ever `true` once the server has said the roll is empty. Unknown — still
  // loading, or the request failed — shows nothing: a warning that flashes up and
  // disappears on every visit is one officers learn to ignore.
  const [rollMissing, setRollMissing] = useState(false)

  const reload = useCallback(async () => {
    try {
      setElections(await listElections(batchId))
    } catch (caught) {
      setError(staffMessage(caught))
    }
  }, [batchId])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    let live = true
    getRollSummary(batchId)
      .then((summary) => { if (live) setRollMissing(summary.total === 0) })
      .catch(() => { /* advisory only; see rollMissing */ })
    return () => { live = false }
  }, [batchId])

  const create = async () => {
    const parsedSeats = Number(seats)
    if (name.trim() === '' || !Number.isInteger(parsedSeats) || parsedSeats < 1 || busy) return
    setBusy(true)
    setError('')
    try {
      const made = await createElection(batchId, name.trim(), parsedSeats)
      setName('')
      setSeats('1')
      setCreating(false)
      await reload()
      setSelected(made.id)
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const current = elections.find((e) => e.id === selected)

  const closeForm = () => {
    setCreating(false)
    setName('')
    setSeats('1')
  }

  return (
    <section className="stack">
      <div className="screen-head">
        <h2>Elections</h2>
        <button type="button" aria-expanded={creating} onClick={() => (creating ? closeForm() : setCreating(true))}>
          New election
        </button>
      </div>

      {error !== '' && <p className="error" role="alert">{error}</p>}

      {/* Without a roll nobody can be checked in, and without a check-in nobody
          can vote — so this is worth saying before the day, not at the door. */}
      {rollMissing && (
        <p className="roll-missing" role="status">
          !!! No members have been imported yet. <Link to={`/b/${slug}/roll`}>Upload the member roll</Link>{' '}!!!.
        </p>
      )}

      {creating && (
        <div className="adder stack">
          <div className="field">
            <label htmlFor="election-name">Name</label>
            <input id="election-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="election-seats">Seats</label>
            <input
              id="election-seats"
              inputMode="numeric"
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
            />
          </div>
          <div className="add-actions">
            <button
              type="button"
              className="primary"
              disabled={name.trim() === '' || busy}
              onClick={() => void create()}
            >
              Create election
            </button>
            <button type="button" onClick={closeForm}>Cancel</button>
          </div>
        </div>
      )}

      {elections.length === 0 ? (
        <p className="muted">No elections yet.</p>
      ) : (
        <ul className="election-list plain-list">
          {elections.map((election) => (
            <li className="election-row" key={election.id}>
              <button type="button" onClick={() => setSelected(election.id)}>
                {election.name}
              </button>
              <span className="muted">
                {election.seats} seat{election.seats === 1 ? '' : 's'} · {election.status} ·{' '}
                {election.candidates.length} candidate{election.candidates.length === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {current && (
        <ElectionDetail
          key={current.id}
          batchId={batchId}
          slug={slug}
          election={current}
          onChanged={() => void reload()}
        />
      )}
    </section>
  )
}
