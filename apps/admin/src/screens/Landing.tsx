/**
 * The way in: register a society, or pick one you already run.
 *
 * `GET /api/batches` returns slug, name and branding for every society and
 * nothing else — spec §6 narrowed it to exactly that, because the legacy version
 * listed every tenant with far more. Listing them here is what removes the need
 * to know a slug by heart.
 */
import { useEffect, useState } from 'react'
import { listSocieties, type Batch } from '../api.js'
import { staffMessage } from '../errorMessage.js'

export function Landing() {
  const [societies, setSocieties] = useState<Omit<Batch, 'id'>[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    listSocieties()
      .then((list) => { if (live) setSocieties(list) })
      .catch((caught: unknown) => { if (live) setError(staffMessage(caught)) })
    return () => { live = false }
  }, [])

  return (
    <section className="stack">
      <h2>Society elections</h2>

      {error !== '' && <p className="error" role="alert">{error}</p>}

      <p>
        <a className="primary-link" href="/new">Register a society</a>
      </p>

      {societies.length > 0 && (
        <>
          <h3>Societies using this system</h3>
          <ul className="election-list plain-list">
            {societies.map((society) => (
              <li key={society.slug}>
                <a href={`/b/${society.slug}`}>{society.name}</a>{' '}
                <span className="muted">/{society.slug}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Anyone can register, and registering is not an endorsement — this list says only that a
            society signed itself up.
          </p>
        </>
      )}
    </section>
  )
}
