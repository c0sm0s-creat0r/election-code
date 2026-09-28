/**
 * The voter app's shell: which society, which screen, which election.
 *
 * No router. The slug comes from the path (`vote.dalyell.com.au/<slug>`), so a
 * router would be a dependency earning nothing (spec §1.2). Screen state is a
 * discriminated union, which is what makes "show sign-in again but keep the
 * draft" expressible rather than a pile of booleans.
 *
 * **The open-election list is polled, not snapshotted.** An AGM opens its
 * elections one at a time, as the agenda reaches them, and only an `open`
 * election is visible to a voter — a `draft` one must stay hidden (spec §6). So a
 * list read once at page load is the list for one agenda item, and treating the
 * end of it as the end of the meeting told voters they were finished while four
 * elections were still to come. Polling is also what spec §1 chose for live
 * counts: a room of a few hundred phones asking a cached D1 read every ten
 * seconds is negligible next to getting this wrong.
 *
 * Each screen carries the election it is about, rather than an index into that
 * list. A list that changes underneath a voter must not change which ballot they
 * are filling in.
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

/**
 * A society's own logo, or nothing at all — never a placeholder. `alt=""` because
 * the name is always beside it, and a screen reader should not read it twice.
 */
function Logo({ branding }: { branding: Branding | undefined }) {
  const src = branding === undefined ? '' : logoSrc(branding.logo_url)
  if (src === '') return null
  return <img class="society-logo" src={src} alt="" />
}

/** The society's logo and the title it chose, on every screen of the app. */
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
 * Ten seconds, and only while the page is visible. Fast enough that a voter
 * looking at the screen when the chair opens an election sees it without being
 * told to reload. It is not free: 300 phones is ~108,000 requests an hour, more
 * than the Workers free plan allows in a day.
 */
const POLL_MS = 10_000

type Screen =
  // `resume` carries a ballot that was in progress when the session lapsed, so
  // signing in again returns to it with the ranking intact.
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
      .then((loaded) => {
        if (!live) return
        setBatch(loaded)
        setReceipts(readReceipts(loaded.id))
        // The one runtime style mutation in the app, and it is a token rather than
        // a style attribute: per-society colour with no per-society build.
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
        // A failed poll keeps the last good list. Dropping to "nothing is open"
        // because one request timed out would be a lie a voter acts on.
        if (live) setStale(true)
      }
    }
    // Only while the page is on screen. A locked phone or a background tab asks
    // nothing: a room of phones left polling on the table is what spent the
    // free plan's daily Worker requests and D1 reads. Coming back checks at
    // once, so an election opened meanwhile is there without a ten-second wait.
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
  // One masthead for every screen, so the society's own logo is on the page a
  // voter is looking at when they rank a ballot — not only on the way in.
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
                // The whole card is the link: on a phone, a bare name is a small
                // target inside a much larger row that does nothing.
                <li key={society.slug}>
                  <a class="society-card" href={`/${society.slug}`}>
                    <Logo branding={society.branding} />
                    <span class="society-text">
                      <span class="society-title">{society.name}</span>
                      {/*
                        Only when it says something the name does not. Most
                        societies set both to the same string, and rendering it
                        twice reads as a mistake — and is read out twice.
                      */}
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

      {/*
        Before sign-in there is nothing to sign in *to* until an election opens,
        so the wait is here rather than in the agenda. The poll turns this into
        the sign-in form on its own — the voter is never asked to reload.
      */}
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
              // Back to the ballot they were on, with the ranking they had.
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
          // The draft travels with the lapsed session, so signing in again costs
          // the voter nothing.
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
              // The ballot is no longer recorded, so the agenda must offer this
              // election again — and the stored token now voids nothing.
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
