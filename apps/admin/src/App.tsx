/**
 * Routing, and the split that matters: **the door and the officer screens are
 * both lazy, and neither is in the entry chunk.**
 *
 * A door volunteer works from their own phone in a queue. Making only the door
 * lazy is not enough — that puts the door in its own chunk but leaves the officer
 * screens in the entry bundle, which every route loads, so the phone parses the
 * rounds table and the exports anyway. Both sides are therefore dynamic imports,
 * and the entry chunk is React, the router and this shell.
 *
 * A test asserts the built chunks: the door chunk must not contain the officer's
 * round-table strings, and the entry chunk must contain neither side's.
 *
 * The batch comes from the path (`/b/:slug/...`) because this is operator tooling:
 * one deployment serves every society.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { getBatchBySlug, type Batch } from './api.js'

// Keep every one of these a dynamic import. A static import anywhere in this file
// pulls that screen back into the entry chunk and silently undoes the split.
const DoorRoute = lazy(() => import('./door/index.js').then((m) => ({ default: m.DoorRoute })))
const OfficerSignIn = lazy(() => import('./screens/OfficerSignIn.js').then((m) => ({ default: m.OfficerSignIn })))
const RollImport = lazy(() => import('./screens/RollImport.js').then((m) => ({ default: m.RollImport })))
const Exports = lazy(() => import('./screens/Exports.js').then((m) => ({ default: m.Exports })))
const Settings = lazy(() => import('./screens/Settings.js').then((m) => ({ default: m.Settings })))
const Result = lazy(() => import('./screens/Result.js').then((m) => ({ default: m.Result })))
const Elections = lazy(() => import('./screens/Elections.js').then((m) => ({ default: m.Elections })))
const SignUp = lazy(() => import('./screens/SignUp.js').then((m) => ({ default: m.SignUp })))
const Landing = lazy(() => import('./screens/Landing.js').then((m) => ({ default: m.Landing })))

function BatchShell({ children }: { children: (batch: Batch) => React.ReactNode }) {
  const { slug } = useParams()
  const [batch, setBatch] = useState<Batch | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    if (slug === undefined) return
    let live = true
    getBatchBySlug(slug)
      .then((loaded) => {
        if (!live) return
        setBatch(loaded)
        document.documentElement.style.setProperty('--accent', loaded.branding.accent_color)
      })
      .catch(() => { if (live) setError('We could not find that society. Check the link.') })
    return () => { live = false }
  }, [slug])

  if (error !== '') return <p className="error" role="alert">{error}</p>
  if (!batch) return <p className="muted">Loading…</p>
  return <>{children(batch)}</>
}

export function App() {
  return (
    <BrowserRouter>
      <main className="page">
        <Routes>
          <Route
            path="/"
            element={
              <Suspense fallback={<p className="muted">Loading…</p>}>
                <Landing />
              </Suspense>
            }
          />
          <Route
            path="/new"
            element={
              <Suspense fallback={<p className="muted">Loading…</p>}>
                <SignUp />
              </Suspense>
            }
          />

          <Route
            path="/b/:slug/door"
            element={
              <Suspense fallback={<p className="muted">Loading the door desk…</p>}>
                <BatchShell>{(batch) => <DoorRoute batch={batch} />}</BatchShell>
              </Suspense>
            }
          />

          <Route path="/b/:slug" element={<Officer>{(batch) => <OfficerHome batch={batch} />}</Officer>} />
          <Route path="/b/:slug/roll" element={<Officer>{(batch) => <RollImport batchId={batch.id} />}</Officer>} />
          <Route
            path="/b/:slug/elections"
            element={<Officer>{(batch) => <Elections batchId={batch.id} slug={batch.slug} />}</Officer>}
          />
          <Route
            path="/b/:slug/elections/:electionId/result"
            element={<Officer>{(batch) => <ResultRoute batchId={batch.id} />}</Officer>}
          />
          <Route path="/b/:slug/exports" element={<Officer>{(batch) => <Exports batchId={batch.id} electionId={undefined} />}</Officer>} />
          <Route path="/b/:slug/settings" element={<Officer>{(batch) => <SettingsRoute batch={batch} />}</Officer>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}

/** The officer side's Suspense boundary and batch load, in one place. */
function Officer({ children }: { children: (batch: Batch) => React.ReactNode }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <BatchShell>{children}</BatchShell>
    </Suspense>
  )
}

function ResultRoute({ batchId }: { batchId: string }) {
  const { electionId } = useParams()
  if (electionId === undefined) return <p className="error">No election in the link.</p>
  return <Result batchId={batchId} electionId={electionId} />
}

function SettingsRoute({ batch }: { batch: Batch }) {
  const [branding, setBranding] = useState(batch.branding)
  return <Settings batchId={batch.id} branding={branding} onSaved={setBranding} />
}

function OfficerHome({ batch }: { batch: Batch }) {
  const [signedIn, setSignedIn] = useState(false)
  if (!signedIn) return <OfficerSignIn batchId={batch.id} onSignedIn={() => setSignedIn(true)} />
  return (
    <nav className="stack">
      <h2>{batch.branding.title}</h2>
      <ul className="counts">
        <li><a href={`/b/${batch.slug}/roll`}>Member roll</a></li>
        <li><a href={`/b/${batch.slug}/elections`}>Elections</a></li>
        <li><a href={`/b/${batch.slug}/exports`}>Exports</a></li>
        <li><a href={`/b/${batch.slug}/settings`}>Appearance</a></li>
        <li><a href={`/b/${batch.slug}/door`}>Door desk</a></li>
      </ul>
    </nav>
  )
}
