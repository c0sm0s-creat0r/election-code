/**
 * The operator's screen: delete a society and everything in it.
 *
 * Nothing links here, and a test checks that. The control is
 * `SUPER_ADMIN_KEY`, which the API checks on every request. The missing link
 * only keeps this off officers' screens.
 *
 * The key is held in component state for one visit: no storage, no cookie,
 * no URL.
 *
 * The slug must be typed back, and the API requires it again in the body.
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
      // `GET /api/batches` returns no ids, so resolve the id from the slug. The
      // slug shown is then the slug deleted.
      const { id } = await getBatchBySlug(selected.slug)
      await deleteSociety(id, selected.slug, key)
      setSocieties((list) => list.filter((s) => s.slug !== selected.slug))
      // `choose` clears the notices, so set the outcome after it.
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
        results.
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
