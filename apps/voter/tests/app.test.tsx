import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { App } from '../src/App.js'

afterEach(() => {
  vi.unstubAllGlobals()
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

  it('says so when no election is open yet', async () => {
    stubRoutes([])
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(screen.getByText(/no voting open/i)).toBeTruthy())
  })

  it('shows sign-in once an election is open', async () => {
    stubRoutes([election('e1', 'President')])
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
  })

  it('walks from sign-in to the first ballot, counting the elections', async () => {
    stubRoutes([election('e1', 'President'), election('e2', 'Secretary')], (url) =>
      url.includes('voter/session')
        ? new Response(JSON.stringify({ first_name: 'Ada' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        : undefined)
    atSlug('s')
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
    fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: '2400001' } })
    fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(screen.getByText(/1 of 2/i)).toBeTruthy())
    expect(screen.getByText(/Ada/)).toBeTruthy()
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

    const signIn = async () => {
      await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
      fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: '2400001' } })
      fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    }

    await signIn()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Bo' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add Bo' }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    // thrown back to sign-in by the 401
    await waitFor(() => expect(screen.getByLabelText(/usu id/i)).toBeTruthy())
    await signIn()

    // ...and the ranking survived
    await waitFor(() => expect(screen.getByTestId('ranked-0').textContent).toContain('Bo'))
    expect(sessionCalls).toBe(2)
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
