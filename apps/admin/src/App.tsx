/**
 * Routing.
 *
 * Every screen is lazy, so the entry chunk holds neither door nor officer
 * code. tests/codeSplit.test.ts checks this.
 *
 * Officer routes nest under one layout, which owns the session gate and the
 * nav. Screens read the society from the outlet context. The batch comes
 * from the path (`/b/:slug/...`): one deployment serves every society.
 */
import { Suspense, lazy, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useOutletContext, useParams } from 'react-router'
import { OfficerLayout, type OfficerContext } from './OfficerLayout.js'
import { getBatchBySlug, type Batch } from './api.js'
import { useEffect } from 'react'

// Keep each of these a dynamic import. A static import puts that screen in
// the entry chunk.
const DoorRoute = lazy(() => import('./door/index.js').then((m) => ({ default: m.DoorRoute })))
const RollImport = lazy(() => import('./screens/RollImport.js').then((m) => ({ default: m.RollImport })))
const Exports = lazy(() => import('./screens/Exports.js').then((m) => ({ default: m.Exports })))
const Settings = lazy(() => import('./screens/Settings.js').then((m) => ({ default: m.Settings })))
const Result = lazy(() => import('./screens/Result.js').then((m) => ({ default: m.Result })))
const Elections = lazy(() => import('./screens/Elections.js').then((m) => ({ default: m.Elections })))
const SignUp = lazy(() => import('./screens/SignUp.js').then((m) => ({ default: m.SignUp })))
const Landing = lazy(() => import('./screens/Landing.js').then((m) => ({ default: m.Landing })))
// Unlinked on purpose. See the note on the route below.
const Operator = lazy(() => import('./screens/Operator.js').then((m) => ({ default: m.Operator })))

const useBatch = () => useOutletContext<OfficerContext>().batch

export function App() {
  return (
    <BrowserRouter>
      <main className="page">
        <Routes>
          <Route path="/" element={<Lazily><Landing /></Lazily>} />
          <Route path="/new" element={<Lazily><SignUp /></Lazily>} />

          {/*
            The operator's screen: deleting a society. Nothing links to it,
            and a test checks that. The API checks SUPER_ADMIN_KEY on every
            request.
          */}
          <Route path="/operator" element={<Lazily><Operator /></Lazily>} />

          {/* Outside the officer layout: its own password and chunk, no officer nav. */}
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
 * The door desk loads its own society. It is outside the officer layout and
 * must not probe for an officer session on a volunteer's phone.
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
