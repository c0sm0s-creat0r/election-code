/**
 * The voter app's shell: which society, which screen, which election.
 *
 * No router. The slug is the first path segment, and screen state is a
 * discriminated union.
 *
 * The open-election list is polled. An AGM opens its elections one at a time
 * and only `open` ones are visible, so one read at page load would show one
 * agenda item. No screen may say voting is finished (LIMITATIONS.md §16).
 *
 * Each screen holds its election, not an index into the list, so a list
 * change cannot switch the ballot a voter is filling in.
 */
import { useEffect, useState } from 'preact/hooks'
import {
  ApiError, getBatchBySlug, getElections, listSocieties, logoSrc,
  type Batch, type Branding, type PublicElection,
} from './api.js'
import { forgetReceipt, readReceipts, rememberReceipt, type HeldReceipts } from './receipts.js'
import { SignIn } from './screens/SignIn.js'
import { Agenda } from './screens/Agenda.js'
import { Ballot } from './screens/Ballot.js'
import { Receipt } from './screens/Receipt.js'

/** The society's logo, or nothing. `alt=""`: the name is always beside it. */
function Logo({ branding }: { branding: Branding | undefined }) {
  const src = branding === undefined ? '' : logoSrc(branding.logo_url)
  if (src === '') return null
  return <img class="society-logo" src={src} alt="" />
}

function Masthead({ title, branding }: { title: string; branding: Branding | undefined }) {
  return (
    <div class="masthead">
      <Logo branding={branding} />
      <h1>{title}</h1>
    </div>
  )
}

/** The first path segment: `vote.dalyell.com.au/<slug>`. */
const slugFromPath = (): string => (window.location.pathname.split('/')[1] ?? '').trim()

/**
 * Only while the page is visible. 300 phones is ~108,000 requests an hour,
 * more than the Workers free plan allows in a day.
 */
const POLL_MS = 10_000

type Screen =
  // `resume` is a ballot in progress when the session expired. Restored after
  // sign-in.
  | { kind: 'signIn'; resume?: { election: PublicElection; draft: string[] } }
  | { kind: 'agenda' }
  | { kind: 'ballot'; election: PublicElection; draft?: string[] }
  | { kind: 'receipt'; token: string; election: PublicElection }

export function App() {
  const [batch, setBatch] = useState<Batch | undefined>(undefined)
  const [elections, setElections] = useState<PublicElection[] | undefined>(undefined)
  const [stale, setStale] = useState(false)
  const [receipts, setReceipts] = useState<HeldReceipts>({})
  const [firstName, setFirstName] = useState('')
  const [screen, setScreen] = useState<Screen>({ kind: 'signIn' })
  const [loadError, setLoadError] = useState('')
  const [societies, setSocieties] = useState<Omit<Batch, 'id'>[]>([])

  useEffect(() => {
    const slug = slugFromPath()
    if (slug === '') {
      // No slug: list the societies.
      let listing = true
      listSocieties()
        .then((list) => { if (listing) setSocieties(list) })
        .catch(() => { if (listing) setLoadError('We could not load the list of societies.') })
      return () => { listing = false }
    }
    let live = true
    getBatchBySlug(slug)
      .then((loaded) => {
        if (!live) return
        setBatch(loaded)
        setReceipts(readReceipts(loaded.id))
        // Per-society colour as a token. No per-society build.
        document.documentElement.style.setProperty('--accent', loaded.branding.accent_color)
        document.title = loaded.branding.title
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

  useEffect(() => {
    if (batch === undefined) return
    let live = true
    const poll = async () => {
      try {
        const listed = await getElections(batch.id)
        if (!live) return
        setElections(listed.filter((e) => e.status === 'open'))
        setStale(false)
      } catch {
        // A failed poll keeps the last good list. Showing "nothing is open" after
        // one timeout would send voters home.
        if (live) setStale(true)
      }
    }
    // Poll only while the page is visible, and once on return.
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer !== undefined) return
      void poll()
      timer = setInterval(() => void poll(), POLL_MS)
    }
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)
    if (!document.hidden) start()
    return () => {
      live = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [batch])

  const heading = batch?.branding.title ?? 'Vote'
  const masthead = <Masthead title={heading} branding={batch?.branding} />

  if (loadError !== '') {
    return (
      <main class="page">
        {masthead}
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
                // The whole card is the link: a larger tap target.
                <li key={society.slug}>
                  <a class="society-card" href={`/${society.slug}`}>
                    <Logo branding={society.branding} />
                    <span class="society-text">
                      <span class="society-title">{society.name}</span>
                      {/* only when it differs from the name, or it would be shown twice */}
                      {society.branding.org_name !== society.name && (
                        <span class="muted society-slug">{society.branding.org_name}</span>
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    )
  }

  const signedIn = screen.kind !== 'signIn'

  return (
    <main class="page">
      {masthead}
      {firstName !== '' && <p class="muted">Signed in as {firstName}</p>}

      {batch === undefined && <p class="muted">Loading…</p>}

      {/* Before sign-in, wait here until an election opens. The poll swaps in the form. */}
      {batch !== undefined && !signedIn && (
        elections === undefined ? (
          <p class="muted">Checking for open elections…</p>
        ) : elections.length === 0 ? (
          <p aria-live="polite">
            Nothing is open for voting yet. This page will auto refresh when exec elections open.
          </p>
        ) : (
          <SignIn
            batchId={batch.id}
            onSignedIn={(name) => {
              setFirstName(name)
              // Back to their ballot, with their ranking.
              setScreen(
                screen.kind === 'signIn' && screen.resume
                  ? { kind: 'ballot', ...screen.resume }
                  : { kind: 'agenda' },
              )
            }}
          />
        )
      )}

      {batch !== undefined && screen.kind === 'agenda' && (
        <Agenda
          elections={elections}
          receipts={receipts}
          stale={stale}
          onVote={(election) => setScreen({ kind: 'ballot', election })}
          onReceipt={(election, token) => setScreen({ kind: 'receipt', token, election })}
        />
      )}

      {batch !== undefined && screen.kind === 'ballot' && (
        <Ballot
          batchId={batch.id}
          election={screen.election}
          onBack={() => setScreen({ kind: 'agenda' })}
          onCast={(token) => {
            setReceipts(rememberReceipt(batch.id, screen.election.id, token))
            setScreen({ kind: 'receipt', token, election: screen.election })
          }}
          // the draft is kept through sign-in
          onSessionLost={(draft) => {
            setFirstName('')
            setScreen({ kind: 'signIn', resume: { election: screen.election, draft } })
          }}
          {...(screen.draft ? { initialRanking: screen.draft } : {})}
        />
      )}

      {batch !== undefined && screen.kind === 'receipt' && (
        <>
          <Receipt
            token={screen.token}
            onVoided={() => {
              // No longer recorded, so the agenda offers this election again.
              setReceipts(forgetReceipt(batch.id, screen.election.id))
              setScreen({ kind: 'ballot', election: screen.election })
            }}
          />
          <div class="submit-bar sticky-bar">
            <button
              type="button"
              class="primary submit"
              onClick={() => setScreen({ kind: 'agenda' })}
            >
              Back to elections
            </button>
          </div>
        </>
      )}
    </main>
  )
}
