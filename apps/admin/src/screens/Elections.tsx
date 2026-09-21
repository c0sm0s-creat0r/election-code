/**
 * The officer's election list: create one, pick one, or see its result.
 *
 * Drafts come from the officer-only listing. The public route hides them, so
 * without that endpoint an officer who reloaded could not find the election they
 * had just created.
 */
import { useCallback, useEffect, useState } from 'react'
import { createElection, listElections, type AdminElection } from '../api.js'
import { staffMessage } from '../errorMessage.js'
import { ElectionDetail } from './ElectionDetail.js'

export type ElectionsProps = { batchId: string; slug: string }

export function Elections({ batchId, slug }: ElectionsProps) {
  const [elections, setElections] = useState<AdminElection[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  const [seats, setSeats] = useState('1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setElections(await listElections(batchId))
    } catch (caught) {
      setError(staffMessage(caught))
    }
  }, [batchId])

  useEffect(() => { void reload() }, [reload])

  const create = async () => {
    const parsedSeats = Number(seats)
    if (name.trim() === '' || !Number.isInteger(parsedSeats) || parsedSeats < 1 || busy) return
    setBusy(true)
    setError('')
    try {
      const made = await createElection(batchId, name.trim(), parsedSeats)
      setName('')
      setSeats('1')
      await reload()
      setSelected(made.id)
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const current = elections.find((e) => e.id === selected)

  return (
    <section className="stack">
      <h2>Elections</h2>

      {error !== '' && <p className="error" role="alert">{error}</p>}

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

      <h3>New election</h3>
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
      <button type="button" className="primary" disabled={name.trim() === '' || busy} onClick={() => void create()}>
        Create election
      </button>

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
