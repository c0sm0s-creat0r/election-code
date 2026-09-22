import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { render } from '@testing-library/react'
import { OfficerLayout } from '../src/OfficerLayout.js'

afterEach(() => vi.unstubAllGlobals())

const BATCH = {
  id: 'b1', slug: 'soc', name: 'Test Society',
  branding: { title: 'AGM 2026', org_name: 'Test Society', accent_color: '#123456', logo_url: '' },
}

const json = { 'content-type': 'application/json' }

/** `ping` decides whether the password form appears; everything else is the batch. */
const stub = (pingStatus: number) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/officer/ping')) {
      return pingStatus === 200
        ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: json })
        : new Response(JSON.stringify({ error: 'unauthenticated' }), { status: pingStatus, headers: json })
    }
    if (url.includes('/officer/session') && init?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    if (url.includes('/officer/session')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: json })
    }
    return new Response(JSON.stringify(BATCH), { status: 200, headers: json })
  }))

const show = () =>
  render(
    <MemoryRouter initialEntries={['/b/soc/elections']}>
      <Routes>
        <Route path="/b/:slug" element={<OfficerLayout />}>
          <Route path="elections" element={<p>the elections screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

describe('OfficerLayout', () => {
  it('DOES NOT ASK FOR A PASSWORD when the session cookie is still valid', async () => {
    // The whole point. Previously `signedIn` was useState(false), so every full
    // page load — and every menu link was one — demanded the password again while
    // the cookie sat there valid.
    stub(200)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
    expect(screen.queryByLabelText(/password/i)).toBeNull()
  })

  it('asks for a password when the session has lapsed', async () => {
    stub(401)
    show()
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeTruthy())
    expect(screen.queryByText('the elections screen')).toBeNull()
  })

  it('shows the screen without a reload once the password is accepted', async () => {
    stub(401)
    show()
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'officer-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
  })

  it('never flashes the password form while the probe is in flight', async () => {
    stub(200)
    show()
    // Before the probe resolves there is a loading state, not a prompt.
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
  })

  it('does NOT ask for a password when the probe fails for a non-auth reason', async () => {
    // A network failure or a 503 is not a reason to demand a password; that would
    // train an officer to retype it at a broken server.
    stub(503)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
  })

  it('offers every destination in an always-visible nav', async () => {
    stub(200)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
    for (const label of [/elections/i, /member roll/i, /exports/i, /appearance/i, /check-in desk/i]) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy()
    }
  })

  it('KEEPS SIGN OUT OUT OF THE NAV, beside the society name instead', async () => {
    // It is not a destination, and a row of places to go with one way out on the
    // end invites the tap that ends the session by accident — the nav wraps on a
    // phone, so which row it lands on is not predictable.
    stub(200)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
    const signOut = screen.getByRole('button', { name: /sign out/i })
    expect(signOut.closest('nav')).toBeNull()
    expect(signOut.closest('.officer-title')).not.toBeNull()
  })

  it('marks the current section, so the nav says where you are', async () => {
    stub(200)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
    expect(screen.getByRole('link', { name: /elections/i }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /member roll/i }).getAttribute('aria-current')).toBeNull()
  })

  it('titles the page from the society, and applies its accent', async () => {
    stub(200)
    show()
    await waitFor(() => expect(document.title).toBe('AGM 2026'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456')
  })

  it('signs out, and then asks for the password again', async () => {
    stub(200)
    show()
    await waitFor(() => expect(screen.getByText('the elections screen')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeTruthy())
  })

  it('reports a society that does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), {
      status: 404, headers: json,
    })))
    show()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not find/i))
  })
})
