/** Register a society, or pick one you run. */
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { listSocieties, type Batch } from '../api.js'
import { staffMessage } from '../errorMessage.js'
import { SocietyLogo } from '../components/SocietyLogo.js'

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
        <Link className="primary-link" to="/new">Register a society</Link>
      </p>

      {societies.length > 0 && (
        <>
          <h3>Societies using this system</h3>
          <ul className="society-list plain-list">
            {societies.map((society) => (
              <li key={society.slug}>
                <Link className="society-card" to={`/b/${society.slug}`}>
                  <SocietyLogo branding={society.branding} />
                  <span className="society-text">
                    <span className="society-title">{society.name}</span>
                    <span className="muted society-slug">/{society.slug}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

