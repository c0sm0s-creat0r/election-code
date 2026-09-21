/**
 * The voter app's shell: which society, which screen, which election.
 *
 * No router. There are three screens and the slug comes from the path
 * (`vote.dalyell.com.au/<slug>`), so a router would be a dependency earning
 * nothing (spec §1.2). Screen state is a discriminated union, which is what makes
 * "show sign-in again but keep the draft" expressible rather than a pile of
 * booleans.
 */
import { useEffect, useState } from 'preact/hooks'
import {
  ApiError, getBatchBySlug, getElections, listSocieties,
  type Batch, type PublicElection,
} from './api.js'
import { SignIn } from './screens/SignIn.js'
import { Ballot } from './screens/Ballot.js'
import { Receipt } from './screens/Receipt.js'

/** The first path segment: `vote.dalyell.com.au/<slug>`. */
const slugFromPath = (): string => (window.location.pathname.split('/')[1] ?? '').trim()

type Screen =
  // `resume` carries a ballot that was in progress when the session lapsed, so
  // signing in again returns to it with the ranking intact.
  | { kind: 'signIn'; resume?: { index: number; draft: string[] } }
  | { kind: 'ballot'; index: number; draft?: string[] }
  | { kind: 'receipt'; token: string; index: number }
  | { kind: 'done' }

export function App() {
  const [batch, setBatch] = useState<Batch | undefined>(undefined)
  const [elections, setElections] = useState<PublicElection[]>([])
  const [firstName, setFirstName] = useState('')
  const [screen, setScreen] = useState<Screen>({ kind: 'signIn' })
  const [loadError, setLoadError] = useState('')
  const [societies, setSocieties] = useState<Omit<Batch, 'id'>[]>([])

  useEffect(() => {
    const slug = slugFromPath()
    if (slug === '') {
      // No slug: offer the list rather than dead-ending on an error. A voter
      // handed a bare domain has no other way through.
      let listing = true
      listSocieties()
        .then((list) => { if (listing) setSocieties(list) })
        .catch(() => { if (listing) setLoadError('We could not load the list of societies.') })
      return () => { listing = false }
    }
    let live = true
    getBatchBySlug(slug)
      .then(async (loaded) => {
        if (!live) return
        setBatch(loaded)
        // The one runtime style mutation in the app, and it is a token rather than
        // a style attribute: per-society colour with no per-society build.
        document.documentElement.style.setProperty('--accent', loaded.branding.accent_color)
        document.title = loaded.branding.title
        const open = await getElections(loaded.id)
        if (live) setElections(open.filter((e) => e.status === 'open'))
      })
      .catch((caught: unknown) => {
        if (!live) return
        setLoadError(
          caught instanceof ApiError && caught.status === 404
            ? 'We could not find that society. Check the link and try again.'
            : 'We could not load this election. Check your connection and try again.',
        )
      })
    return () => { live = false }
  }, [])

  const heading = batch?.branding.title ?? 'Vote'

  if (loadError !== '') {
    return (
      <main class="page">
        <h1>{heading}</h1>
        <p class="error" role="alert">{loadError}</p>
      </main>
    )
  }

  // Reached only with no slug in the path.
  if (slugFromPath() === '') {
    return (
      <main class="page">
        <h1>Vote</h1>
        {societies.length === 0 ? (
          <p class="muted">Loading…</p>
        ) : (
          <>
            <p>Choose your society.</p>
            <ul class="society-list plain-list">
              {societies.map((society) => (
                <li key={society.slug}>
                  <a href={`/${society.slug}`}>{society.name}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    )
  }

  const current = screen.kind === 'ballot' || screen.kind === 'receipt'
    ? elections[screen.index]
    : undefined

  return (
    <main class="page">
      <h1>{heading}</h1>
      {firstName !== '' && <p class="muted">Signed in as {firstName}</p>}

      {batch === undefined && <p class="muted">Loading…</p>}

      {batch !== undefined && elections.length === 0 && (
        <p>No voting open just yet. Your society will let you know when it starts.</p>
      )}

      {batch !== undefined && elections.length > 0 && screen.kind === 'signIn' && (
        <SignIn
          batchId={batch.id}
          onSignedIn={(name) => {
            setFirstName(name)
            // Back to the ballot they were on, with the ranking they had.
            setScreen(
              screen.resume ? { kind: 'ballot', ...screen.resume } : { kind: 'ballot', index: 0 },
            )
          }}
        />
      )}

      {batch !== undefined && screen.kind === 'ballot' && current !== undefined && (
        <Ballot
          batchId={batch.id}
          election={current}
          index={screen.index}
          total={elections.length}
          onCast={(token) => setScreen({ kind: 'receipt', token, index: screen.index })}
          // The draft travels with the lapsed session, so signing in again costs
          // the voter nothing.
          onSessionLost={(draft) => {
            setFirstName('')
            setScreen({ kind: 'signIn', resume: { index: screen.index, draft } })
          }}
          {...(screen.draft ? { initialRanking: screen.draft } : {})}
        />
      )}

      {batch !== undefined && screen.kind === 'receipt' && current !== undefined && (
        <>
          <Receipt
            token={screen.token}
            onVoided={() => setScreen({ kind: 'ballot', index: screen.index })}
          />
          <div class="submit-bar sticky-bar">
            <button
              type="button"
              class="primary submit"
              onClick={() =>
                setScreen(
                  screen.index + 1 < elections.length
                    ? { kind: 'ballot', index: screen.index + 1 }
                    : { kind: 'done' },
                )
              }
            >
              {screen.index + 1 < elections.length ? 'Next election' : 'Finish'}
            </button>
          </div>
        </>
      )}

      {screen.kind === 'done' && (
        <p>That is every election. Thank you for voting.</p>
      )}
    </main>
  )
}
