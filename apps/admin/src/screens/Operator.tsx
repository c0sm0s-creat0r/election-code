/**
 * The operator's own screen: delete a society, and everything in it.
 *
 * **Nothing links here.** It is mounted at `/operator` and reachable only by
 * typing that path, which is not a security control on its own — the control is
 * `SUPER_ADMIN_KEY`, checked by the API on every request — but it keeps the most
 * destructive capability in the system off every officer's screen. A test asserts
 * that no link to it exists, because a well-meaning "add it to the nav" would
 * otherwise pass review.
 *
 * **The key is held in component state for the length of one visit and written
 * nowhere else.** Not `localStorage`, not `sessionStorage`, not a cookie, not a
 * URL. This is the credential that can mint an officer session for every society
 * in the system, so it is typed when it is used and gone when the tab closes. The
 * field is a password input so it does not sit on screen in a projector-lit room.
 *
 * The slug has to be typed back before the button does anything, and the API
 * requires it again in the body — a UUID is not something anyone proofreads, and
 * the difference between deleting the right society and the wrong one should not
 * be one click.
 */
import { useEffect, useState } from 'react'
import { ApiError, deleteSociety, getBatchBySlug, listSocieties, type Batch } from '../api.js'
import { staffMessage } from '../errorMessage.js'
import { SocietyLogo } from '../components/SocietyLogo.js'

type Society = Omit<Batch, 'id'>

export function Operator() {
  const [key, setKey] = useState('')
  const [societies, setSocieties] = useState<Society[]>([])
  const [selected, setSelected] = useState<Society | undefined>(undefined)
  const [typedSlug, setTypedSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    let live = true
    listSocieties()
      .then((list) => { if (live) setSocieties(list) })
      .catch((caught: unknown) => { if (live) setError(staffMessage(caught)) })
    return () => { live = false }
  }, [])

  const choose = (society: Society | undefined) => {
    setSelected(society)
    setTypedSlug('')
    setError('')
    setDone('')
  }

  const remove = async () => {
    if (selected === undefined || busy) return
    setBusy(true)
    setError('')
    try {
      // `GET /api/batches` returns no ids — spec §6 narrowed it to slug, name and
      // branding — so the id comes from the public by-slug lookup. Resolving it
      // here also means the slug shown is the slug deleted.
      const { id } = await getBatchBySlug(selected.slug)
      await deleteSociety(id, selected.slug, key)
      setSocieties((list) => list.filter((s) => s.slug !== selected.slug))
      // `choose` clears the notices, so the outcome is set after it, not before.
      choose(undefined)
      setDone(`${selected.name} and everything in it is gone.`)
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That operator key was not accepted.'
          : staffMessage(caught),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stack">
      <h2>Operator</h2>

      <p className="rule-note">
        Deleting a society destroys its roll, its check-ins, its elections, its ballots and its sealed
        results. It cannot be undone, and there is no backup inside this system. The audit log is the
        only thing that survives.
      </p>

      <div className="field">
        <label htmlFor="operator-key">Operator key</label>
        <input
          id="operator-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <p className="muted">Used for this one action and stored nowhere.</p>
      </div>

      {error !== '' && <p className="error" role="alert">{error}</p>}
      {done !== '' && <p className="ok-note" role="status">{done}</p>}

      <h3>Societies</h3>

      {societies.length === 0 ? (
        <p className="muted">No societies are registered.</p>
      ) : (
        <ul className="society-list plain-list">
          {societies.map((society) => (
            <li key={society.slug} className="row-card spread">
              <span className="society-name">
                <SocietyLogo branding={society.branding} />
                <span className="society-text">
                  <span className="society-title">{society.name}</span>
                  <span className="muted society-slug">/{society.slug}</span>
                </span>
              </span>
              <button type="button" onClick={() => choose(society)}>Delete…</button>
            </li>
          ))}
        </ul>
      )}

      {selected !== undefined && (
        <div className="confirm stack">
          <p>
            Type <strong>{selected.slug}</strong> to delete {selected.name} permanently.
          </p>
          <div className="field">
            <label htmlFor="confirm-slug">Slug</label>
            <input
              id="confirm-slug"
              autoComplete="off"
              value={typedSlug}
              onChange={(event) => setTypedSlug(event.target.value)}
            />
          </div>
          <div className="add-actions">
            <button
              type="button"
              className="danger"
              disabled={busy || key === '' || typedSlug !== selected.slug}
              onClick={remove}
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
            <button type="button" onClick={() => choose(undefined)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}
