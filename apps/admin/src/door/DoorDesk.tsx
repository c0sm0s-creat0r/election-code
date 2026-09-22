/**
 * The door desk: a search box and a list, on a volunteer's phone, in a queue.
 *
 * **The roll is fetched once and filtered in memory.** ~1,300 rows is about
 * 50 KB, so search is instant on every keystroke and keeps working if venue wifi
 * drops mid-queue (spec §4). A server round-trip per keystroke is the wrong shape
 * for a queue of people.
 *
 * **It is never written to storage.** No `localStorage`, no `sessionStorage`, no
 * IndexedDB. Persisting 1,300 members' names and USU ids onto a personal device
 * would put them outside the reach of the post-AGM purge, which is the one thing
 * that makes the retention claim true. The cost is that a reload needs the
 * network — accepted, and recorded in `LIMITATIONS.md` §10.
 *
 * **Search matches the USU id as well as either name**, because a member handing
 * over a card is showing the number, not spelling their surname.
 *
 * **Two separate additions, deliberately.** "Add guest" records someone who
 * attends and cannot vote; "Add member" records someone the export missed, who
 * can. One catch-all button would mean a volunteer's finger decides whether a
 * stranger gets a ballot.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addDoorVoter, addGuest, checkIn, getQuorum, getRoll, listGuests, removeGuest, undoCheckIn,
  type Guest, type Quorum, type RollEntry,
} from '../api.js'
import { ApiError } from '../api.js'
import { staffMessage } from '../errorMessage.js'

/** 401: no session. 403: a valid session of the wrong role. Both need the form. */
const isSessionFailure = (caught: unknown): boolean =>
  caught instanceof ApiError && (caught.status === 401 || caught.status === 403)

export type DoorDeskProps = {
  batchId: string
  /**
   * Called when the API says this session is no longer a door session — a lapsed
   * cookie, or an officer cookie on a door route, which `requireRole` answers 403.
   * Without this the desk showed a permission error and offered nothing to click.
   */
  onSessionLost: () => void
}

/** A roll row with its search text precomputed, so a keystroke allocates nothing. */
type Searchable = RollEntry & { haystack: string }

const searchable = (entry: RollEntry): Searchable => ({
  ...entry,
  // Matching the full name covers both parts, so there is nothing to check
  // separately. The id is here because a member hands over a card, not a spelling.
  haystack: `${entry.first_name} ${entry.last_name} ${entry.usu_id}`.toLowerCase(),
})

export function DoorDesk({ batchId, onSessionLost }: DoorDeskProps) {
  const [roll, setRoll] = useState<Searchable[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [quorum, setQuorum] = useState<Quorum | undefined>(undefined)
  const [term, setTerm] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<'none' | 'guest' | 'member'>('none')

  /** The full load: the roll, the guests and the counts. Once, on arrival. */
  const loadAll = useCallback(async () => {
    try {
      const [rollRows, guestRows, counts] = await Promise.all([
        getRoll(batchId), listGuests(batchId), getQuorum(batchId),
      ])
      setRoll(rollRows.map(searchable))
      setGuests(guestRows)
      setQuorum(counts)
    } catch (caught) {
      if (isSessionFailure(caught)) return onSessionLost()
      setError(staffMessage(caught))
    }
  }, [batchId, onSessionLost])

  useEffect(() => { void loadAll() }, [loadAll])

  const found = useMemo(() => {
    const needle = term.trim().toLowerCase()
    return needle === '' ? roll : roll.filter((entry) => entry.haystack.includes(needle))
  }, [roll, term])

  /**
   * A check-in patches the one row it changed and refetches four integers.
   *
   * Reloading the whole roll instead would be ~50 KB per tap, so a night of
   * 1,300 check-ins would pull ~65 MB over venue wifi and re-render the list
   * every time — which also defeats the point of holding it in memory.
   */
  const checkedInAt = (usuId: string, at: number | null) =>
    setRoll((rows) => rows.map((r) => (r.usu_id === usuId ? { ...r, checked_in_at: at } : r)))

  const act = async (action: () => Promise<unknown>) => {
    setError('')
    try {
      await action()
      setQuorum(await getQuorum(batchId))
    } catch (caught) {
      if (isSessionFailure(caught)) return onSessionLost()
      setError(staffMessage(caught))
    }
  }

  return (
    <section className="stack">
      <h2>Door check-in</h2>

      <div className="field">
        <label htmlFor="door-search">Search by name or USU ID</label>
        <input
          id="door-search"
          autoFocus
          autoComplete="off"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>

      {error !== '' && <p className="error" role="alert">{error}</p>}

      <ul className="roll-list plain-list">
        {found.map((entry) => (
          <li className="row-card spread" key={entry.usu_id}>
            <span className="roll-name">
              {entry.first_name} {entry.last_name}
              <span className="muted figures roll-id"> {entry.usu_id}</span>
            </span>
            {entry.eligible === 0 ? (
              <span className="muted">Not an eligible member</span>
            ) : entry.checked_in_at !== null ? (
              <button
                type="button"
                aria-label={`Undo check-in for ${entry.first_name} ${entry.last_name}`}
                onClick={() => void act(async () => {
                  await undoCheckIn(batchId, entry.usu_id)
                  checkedInAt(entry.usu_id, null)
                })}
              >
                Checked in — undo
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                aria-label={`Check in ${entry.first_name} ${entry.last_name}`}
                onClick={() => void act(async () => {
                  await checkIn(batchId, entry.usu_id)
                  checkedInAt(entry.usu_id, Date.now())
                })}
              >
                Check in
              </button>
            )}
          </li>
        ))}
      </ul>

      {guests.length > 0 && (
        <>
          <h3>Guests</h3>
          <ul className="roll-list plain-list">
            {guests.map((guest) => (
              <li className="row-card spread" key={guest.id}>
                <span className="roll-name">
                  {guest.name}
                  {guest.note !== null && <span className="muted"> · {guest.note}</span>}
                </span>
                <button
                  type="button"
                  aria-label={`Remove guest ${guest.name}`}
                  onClick={() => void act(async () => {
                    await removeGuest(batchId, guest.id)
                    setGuests((gs) => gs.filter((g) => g.id !== guest.id))
                  })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="add-actions">
        <button type="button" onClick={() => setAdding('guest')}>Add guest</button>
        <button type="button" onClick={() => setAdding('member')}>Add member</button>
      </div>

      {adding === 'guest' && (
        <AddGuest
          onCancel={() => setAdding('none')}
          onAdd={(name, note) => act(async () => {
            await addGuest(batchId, name, note)
            setAdding('none')
            await loadAll()
          })}
        />
      )}

      {adding === 'member' && (
        <AddMember
          onCancel={() => setAdding('none')}
          onAdd={(usuId, first, last) => act(async () => {
            await addDoorVoter(batchId, usuId, first, last)
            setAdding('none')
            await loadAll()
          })}
        />
      )}

      {quorum && (
        <p className="quorum sticky-bar figures" role="status">
          {quorum.checked_in} / {quorum.eligible} members · {quorum.guests} guests ·{' '}
          {quorum.added_at_door} added at the door
        </p>
      )}
    </section>
  )
}

/** Attends, cannot vote — and the form says so, because that is the distinction. */
function AddGuest({ onAdd, onCancel }: {
  onAdd: (name: string, note?: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  return (
    <div className="adder stack">
      <h3>Add a guest</h3>
      <p className="rule-note">
        A guest is recorded as attending and <strong>cannot vote</strong>. If they are a member the
        export missed, use <strong>Add member</strong> instead.
      </p>
      <div className="field">
        <label htmlFor="guest-name">Name</label>
        <input id="guest-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="guest-note">Note (optional)</label>
        <input id="guest-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="primary" disabled={name.trim() === ''}
              onClick={() => onAdd(name.trim(), note.trim())}>
        Add this guest
      </button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  )
}

/** A member the export missed. They can vote, so the wording is different. */
function AddMember({ onAdd, onCancel }: {
  onAdd: (usuId: string, firstName: string, lastName: string) => void
  onCancel: () => void
}) {
  const [usuId, setUsuId] = useState('')
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const ready = /^\d{7,8}$/.test(usuId) && first.trim() !== '' && last.trim() !== ''
  return (
    <div className="adder stack">
      <h3>Add a member the export missed</h3>
      <p className="rule-note">
        This person <strong>will be able to vote</strong>. Only add someone you have confirmed is a
        current member. They are recorded separately in the attendance export.
      </p>
      <div className="field">
        <label htmlFor="member-usu">USU ID</label>
        <input id="member-usu" inputMode="numeric" value={usuId}
               onChange={(e) => setUsuId(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="member-first">First name</label>
        <input id="member-first" value={first} onChange={(e) => setFirst(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="member-last">Surname</label>
        <input id="member-last" value={last} onChange={(e) => setLast(e.target.value)} />
      </div>
      <button type="button" className="primary" disabled={!ready}
              onClick={() => onAdd(usuId, first.trim(), last.trim())}>
        Add this member
      </button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  )
}
