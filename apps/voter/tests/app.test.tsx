import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { App } from '../src/App.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.documentElement.style.removeProperty('--accent')
})

const BATCH = {
  id: 'b1', slug: 's', name: 'Soc',
  branding: { title: 'AGM 2026', org_name: 'Soc', accent_color: '#ff0000', logo_url: '' },
}

const election = (id: string, name: string) => ({
  id, name, seats: 1, status: 'open' as const,
  candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
})

/** Routes stubbed responses by URL, the way the app actually calls them. */
const stubRoutes = (elections: unknown[], extra: (url: string) => Response | undefined = () => undefined) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const custom = extra(url)
    if (custom) return custom
    const body = url.includes('by-slug') ? BATCH : elections
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))

const atSlug = (slug: string) => window.history.pushState({}, '', `/${slug}`)

const json = { status: 200, headers: { 'content-type': 'application/json' } }

/** An `extra` route handler that accepts any voter sign-in. */
const signedInAs = (firstName: string) => (url: string) =>
  url.includes('voter/session') ? new Response(JSON.stringify({ first_name: firstName }), json) : undefined

/**
 * The test environment's `localStorage` is a stub with no methods, so a test that
 * needs storage brings its own. That every other test here passes without one is
 * the point: `readReceipts`/`rememberReceipt` guard every access, because Safari
 * private mode and an exhausted quota throw, and a voter must never lose a ballot
 * to browser storage.
 */
const stubStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  })
  return store
}

/**
 * Preact flushes effects on an animation frame, which the fake clock also fakes,
 * so advancing by 0 never runs them. Three frames, because the load is a chain:
 * fetch the society, which starts the election poll, which renders the list.
 * Well under POLL_MS, so this never stands in for a poll tick.
 */
const settle = async () => {
  for (let frame = 0; frame < 3; frame++) await vi.advanceTimersByTimeAsync(20)
}

const signIn = async () => {
  await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
  fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: '2400001' } })
  fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
}

describe('App', () => {
  it('LISTS SOCIETIES when the path has no slug, rather than dead-ending', async () => {
    // A voter handed a bare domain has no other way through: the slug is the only
    // route into an election.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify([{ slug: 's', name: 'Soc', branding: BATCH.branding }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    atSlug('')
    render(<App />)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Soc' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Soc' }).getAttribute('href')).toBe('/s')
  })

  it('applies the society accent colour from the API to the token', async () => {
    stubRoutes([])
    atSlug('s')
    render(<App />)
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000'))
  })

  it('uses the society title as the page title', async () => {
    stubRoutes([])
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(document.title).toBe('AGM 2026'))
  })

  it('says nothing is open yet, and does not ask the voter to reload', async () => {
    stubRoutes([])
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(screen.getByText(/nothing is open for voting yet/i)).toBeTruthy())
    expect(screen.getByText(/leave this page open/i)).toBeTruthy()
  })

  it('shows sign-in once an election is open', async () => {
    stubRoutes([election('e1', 'President')])
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
  })

  it('lands on the agenda after sign-in, listing every open election', async () => {
    stubRoutes([election('e1', 'President'), election('e2', 'Secretary')], signedInAs('Ada'))
    atSlug('s')
    render(<App />)
    await signIn()
    await waitFor(() => expect(screen.getByText('President')).toBeTruthy())
    expect(screen.getByText('Secretary')).toBeTruthy()
    expect(screen.getByText(/Ada/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Vote' })).toHaveLength(2)
  })

  it('opens the ballot for the election the voter picks', async () => {
    stubRoutes([election('e1', 'President'), election('e2', 'Secretary')], signedInAs('Ada'))
    atSlug('s')
    render(<App />)
    await signIn()
    await waitFor(() => expect(screen.getByText('Secretary')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Vote' })[1]!)
    expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy()
  })

  it('goes back to the agenda from a ballot without voting', async () => {
    stubRoutes([election('e1', 'President')], signedInAs('Ada'))
    atSlug('s')
    render(<App />)
    await signIn()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vote' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Vote' }))
    fireEvent.click(screen.getByRole('button', { name: /all elections/i }))
    expect(screen.getByRole('button', { name: 'Vote' })).toBeTruthy()
  })

  it('KEEPS THE DRAFT when a session lapses mid-ballot, and returns to it', async () => {
    // The path that matters: a voter mid-ballot must not lose their ranking
    // because a cookie expired. Sign in, rank, get a 401 on submit, sign in
    // again, and the ranking is still there.
    let sessionCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('by-slug')) {
        return new Response(JSON.stringify(BATCH), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('voter/session')) {
        sessionCalls++
        return new Response(JSON.stringify({ first_name: 'Ada' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/ballots')) {
        return new Response(JSON.stringify({ error: 'unauthenticated', code: 'no_session' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify([election('e1', 'President'), election('e2', 'Secretary')]), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    atSlug('s')
    render(<App />)

    await signIn()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Vote' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Vote' })[0]!)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Bo' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add Bo' }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    // thrown back to sign-in by the 401
    await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
    await signIn()
    // ...straight back into the ballot, not via the agenda

    // ...and the ranking survived
    await waitFor(() => expect(screen.getByTestId('ranked-0').textContent).toContain('Bo'))
    expect(sessionCalls).toBe(2)
  })

  it('NEVER TELLS A VOTER THE MEETING IS OVER, only that nothing is open now', async () => {
    // The defect this screen exists to prevent: elections open one at a time, so
    // running out of open ones is not the end of the AGM. The app said "that is
    // every election. Thank you for voting." after item 4 of 8, and voters left.
    stubRoutes([election('e1', 'President')], (url) => {
      if (url.includes('voter/session')) return new Response(JSON.stringify({ first_name: 'Ada' }), json)
      if (url.includes('/ballots')) return new Response(JSON.stringify({ receipt_token: 'tok-1' }), json)
      if (url.includes('/receipts/')) {
        return new Response(JSON.stringify({ status: 'recorded', election_name: 'President' }), json)
      }
      return undefined
    })
    atSlug('s')
    render(<App />)
    await signIn()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vote' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Vote' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Bo' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add Bo' }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    await waitFor(() => expect(screen.getByText('tok-1')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /back to elections/i }))

    expect(screen.getByText(/keep this page open/i)).toBeTruthy()
    expect(screen.queryByText(/that is every election/i)).toBeNull()
    expect(screen.queryByText(/thank you for voting/i)).toBeNull()
  })

  it('SHOWS AN ELECTION OPENED AFTER LOAD, without a reload', async () => {
    // The other half: the voter keeps the page open and the next agenda item
    // appears on its own. A `draft` election is invisible to a voter by design
    // (spec §6), so polling is the only way it can ever arrive.
    vi.useFakeTimers()
    let open = [election('e1', 'President')]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('by-slug')) return new Response(JSON.stringify(BATCH), json)
      if (url.includes('voter/session')) return new Response(JSON.stringify({ first_name: 'Ada' }), json)
      return new Response(JSON.stringify(open), json)
    }))
    atSlug('s')
    render(<App />)

    await settle()
    fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: '2400001' } })
    fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await settle()
    expect(screen.queryByText('Secretary')).toBeNull()

    // The chair opens the next item.
    open = [election('e1', 'President'), election('e2', 'Secretary')]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByText('Secretary')).toBeTruthy()
  })

  it('turns the waiting notice into sign-in when the first election opens', async () => {
    vi.useFakeTimers()
    let open: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('by-slug')) return new Response(JSON.stringify(BATCH), json)
      return new Response(JSON.stringify(open), json)
    }))
    atSlug('s')
    render(<App />)
    await settle()
    expect(screen.getByText(/nothing is open for voting yet/i)).toBeTruthy()

    open = [election('e1', 'President')]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByLabelText(/usu id/i)).toBeTruthy()
  })

  it('KEEPS THE LAST LIST when a poll fails, rather than emptying the agenda', async () => {
    // Dropping to "nothing is open" because one request timed out is a lie a
    // voter acts on by leaving.
    vi.useFakeTimers()
    let failing = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('by-slug')) return new Response(JSON.stringify(BATCH), json)
      if (url.includes('voter/session')) return new Response(JSON.stringify({ first_name: 'Ada' }), json)
      if (failing) throw new TypeError('network down')
      return new Response(JSON.stringify([election('e1', 'President')]), json)
    }))
    atSlug('s')
    render(<App />)
    await settle()
    fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: '2400001' } })
    fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await settle()
    expect(screen.getByText('President')).toBeTruthy()

    failing = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByText('President')).toBeTruthy()
    expect(screen.getByText(/could not check for new elections/i)).toBeTruthy()
  })

  it('MARKS AN ELECTION VOTED ACROSS A RELOAD, and still offers the receipt', async () => {
    // The receipt token is shown once and never stored server-side (spec §4), so
    // the device is the only place it can live. It is also the only way the app
    // can know this voter has already voted — there is deliberately no
    // "have I voted?" endpoint.
    stubStorage({ 'election:receipts:b1': JSON.stringify({ e1: 'tok-1' }) })
    stubRoutes([election('e1', 'President')], (url) => {
      if (url.includes('voter/session')) return new Response(JSON.stringify({ first_name: 'Ada' }), json)
      if (url.includes('/receipts/')) {
        return new Response(JSON.stringify({ status: 'recorded', election_name: 'President' }), json)
      }
      return undefined
    })
    atSlug('s')
    render(<App />)
    await signIn()
    await waitFor(() => expect(screen.getByRole('button', { name: /voted/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Vote' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /voted/i }))
    await waitFor(() => expect(screen.getByText('tok-1')).toBeTruthy())
  })

  it('reports a society that does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })))
    atSlug('nope')
    render(<App />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not find/i))
  })
})
