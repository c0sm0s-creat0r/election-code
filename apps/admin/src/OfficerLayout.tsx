/**
 * Shared by every officer screen: the society, the session gate, and a nav
 * of router `Link`s, so navigation does not reload the app.
 *
 * The gate is here so a direct link or an expired session shows the password
 * form on any officer route.
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useParams } from 'react-router'
import { getBatchBySlug, officerSignOut, type Batch } from './api.js'
import { useStaffSession } from './useStaffSession.js'
import { ElectionHelp } from './components/ElectionHelp.js'

const OfficerSignIn = lazy(() => import('./screens/OfficerSignIn.js').then((m) => ({ default: m.OfficerSignIn })))

/** Passed to every officer screen through the outlet context. */
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
  const { state, confirm, forget } = useStaffSession(batch?.id)

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
        {/* Sign out sits with the society's name, not in the nav: it is not a destination. */}
        <div className="officer-title">
          <h1>
            <Link to={base}>{batch.branding.title}</Link>
          </h1>
          <div className="officer-actions">
            <ElectionHelp base={base} />
            <button
              type="button"
              className="sign-out"
              onClick={() => { void officerSignOut(batch.id).finally(forget) }}
            >
              Sign out
            </button>
          </div>
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
              {/* a full navigation: the check-in desk is a separate chunk and password */}
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
