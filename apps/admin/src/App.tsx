/**
 * Routing.
 *
 * **The split that matters: the door and the officer screens are both lazy, and
 * neither is in the entry chunk.** A door volunteer works from their own phone in
 * a queue. Making only the door lazy is not enough — that puts the door in its own
 * chunk but leaves the officer screens in the entry bundle, which every route
 * loads, so the phone parses the rounds table and the exports anyway. A test
 * asserts it against the built output.
 *
 * **Officer routes are nested under one layout** so the session gate and the nav
 * bar exist once. Screens read the society from the router's outlet context
 * instead of a prop threaded through a render callback.
 *
 * The batch comes from the path (`/b/:slug/...`) because this is operator tooling:
 * one deployment serves every society.
 */
import { Suspense, lazy, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import { OfficerLayout, type OfficerContext } from './OfficerLayout.js'
import { getBatchBySlug, type Batch } from './api.js'
import { useEffect } from 'react'

// Keep every one of these a dynamic import. A static import anywhere in this file
// pulls that screen back into the entry chunk and silently undoes the split.
const DoorRoute = lazy(() => import('./door/index.js').then((m) => ({ default: m.DoorRoute })))
const RollImport = lazy(() => import('./screens/RollImport.js').then((m) => ({ default: m.RollImport })))
const Exports = lazy(() => import('./screens/Exports.js').then((m) => ({ default: m.Exports })))
const Settings = lazy(() => import('./screens/Settings.js').then((m) => ({ default: m.Settings })))
const Result = lazy(() => import('./screens/Result.js').then((m) => ({ default: m.Result })))
const Elections = lazy(() => import('./screens/Elections.js').then((m) => ({ default: m.Elections })))
const SignUp = lazy(() => import('./screens/SignUp.js').then((m) => ({ default: m.SignUp })))
const Landing = lazy(() => import('./screens/Landing.js').then((m) => ({ default: m.Landing })))

const useBatch = () => useOutletContext<OfficerContext>().batch

export function App() {
  return (
    <BrowserRouter>
      <main className="page">
        <Routes>
          <Route path="/" element={<Lazily><Landing /></Lazily>} />
          <Route path="/new" element={<Lazily><SignUp /></Lazily>} />

          {/*
            Outside the officer layout on purpose: a different password, a
            different chunk, and a volunteer who should never be offered the
            officer nav.
          */}
          <Route path="/b/:slug/door" element={<Lazily><DoorScreen /></Lazily>} />

          <Route path="/b/:slug" element={<OfficerLayout />}>
            <Route index element={<Elections />} />
            <Route path="elections" element={<Elections />} />
            <Route path="elections/:electionId/result" element={<ResultScreen />} />
            <Route path="roll" element={<RollScreen />} />
            <Route path="exports" element={<ExportsScreen />} />
            <Route path="settings" element={<SettingsScreen />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}

const Lazily = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<p className="muted">Loading…</p>}>{children}</Suspense>
)

function RollScreen() {
  return <RollImport batchId={useBatch().id} />
}

function ExportsScreen() {
  return <Exports batchId={useBatch().id} electionId={undefined} />
}

function ResultScreen() {
  const batch = useBatch()
  const { electionId } = useParams()
  if (electionId === undefined) return <p className="error">No election in the link.</p>
  return <Result batchId={batch.id} electionId={electionId} slug={batch.slug} />
}

function SettingsScreen() {
  const batch = useBatch()
  const [branding, setBranding] = useState(batch.branding)
  return <Settings batchId={batch.id} branding={branding} onSaved={setBranding} />
}

/**
 * The door desk loads its own society: it is outside the officer layout, so it
 * cannot read the outlet context, and it must not trigger an officer session
 * probe on a volunteer's phone.
 */
function DoorScreen() {
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
  return <DoorRoute batch={batch} />
}
