/**
 * Everything every officer screen shares: the society, the session gate, and a
 * nav bar that is always on screen.
 *
 * The nav is the answer to "there are no back arrows". With every destination one
 * tap away and always visible, browser back stops being the way to get around —
 * and because these are router `Link`s rather than `<a href>`, navigating does not
 * reload the app, so nothing is thrown away and nothing is re-fetched.
 *
 * The gate lives here rather than on the home screen, so a direct link or an
 * expired session shows a password form on any officer route instead of a 401
 * that reads as "wrong password".
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useParams } from 'react-router'
import { getBatchBySlug, officerSignOut, probeOfficer, type Batch } from './api.js'
import { useStaffSession } from './useStaffSession.js'

const OfficerSignIn = lazy(() => import('./screens/OfficerSignIn.js').then((m) => ({ default: m.OfficerSignIn })))

/** Available to every officer screen through the router's outlet context. */
export type OfficerContext = { batch: Batch }

const NAV = [
  { to: 'elections', label: 'Elections' },
  { to: 'roll', label: 'Member roll' },
  { to: 'exports', label: 'Exports' },
  { to: 'settings', label: 'Appearance' },
] as const

export function OfficerLayout() {
  const { slug } = useParams()
  const location = useLocation()
  const [batch, setBatch] = useState<Batch | undefined>(undefined)
  const [error, setError] = useState('')
  const { state, confirm, forget } = useStaffSession(batch?.id, probeOfficer)

  useEffect(() => {
    if (slug === undefined) return
    let live = true
    getBatchBySlug(slug)
      .then((loaded) => {
        if (!live) return
        setBatch(loaded)
        document.documentElement.style.setProperty('--accent', loaded.branding.accent_color)
        document.title = loaded.branding.title
      })
      .catch(() => { if (live) setError('We could not find that society. Check the link.') })
    return () => { live = false }
  }, [slug])

  if (error !== '') return <p className="error" role="alert">{error}</p>
  if (!batch || state === 'checking') return <p className="muted">Loading…</p>

  if (state === 'signed-out') {
    return (
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <h2>{batch.branding.title}</h2>
        <OfficerSignIn batchId={batch.id} onSignedIn={confirm} />
      </Suspense>
    )
  }

  const base = `/b/${batch.slug}`

  return (
    <>
      <header className="officer-header">
        {/*
          Sign out sits with the society's name rather than in the nav. It is not a
          destination, and a row of places to go with one way out on the end of it
          invites the tap that ends the session by accident — on a phone the nav
          wraps, so which row it lands on is not predictable.
        */}
        <div className="officer-title">
          <h1>
            <Link to={base}>{batch.branding.title}</Link>
          </h1>
          <button
            type="button"
            className="sign-out"
            onClick={() => { void officerSignOut(batch.id).finally(forget) }}
          >
            Sign out
          </button>
        </div>
        <nav aria-label="Officer">
          <ul className="officer-nav plain-list">
            {NAV.map((item) => {
              const to = `${base}/${item.to}`
              return (
                <li key={item.to}>
                  <Link to={to} aria-current={location.pathname.startsWith(to) ? 'page' : undefined}>
                    {item.label}
                  </Link>
                </li>
              )
            })}
            <li>
              {/* A full navigation on purpose: the check-in desk is a separate chunk
                  and a separate password, so it is a departure rather than a tab. */}
              <a href={`${base}/door`}>Check-in desk</a>
            </li>
          </ul>
        </nav>
      </header>

      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Outlet context={{ batch } satisfies OfficerContext} />
      </Suspense>
    </>
  )
}
