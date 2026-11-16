import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { OfficerLayout } from '../src/OfficerLayout.js'
import { json, stub, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const BATCH = {
  id: 'b1', slug: 'soc', name: 'Test Society',
  branding: { title: 'AGM 2026', org_name: 'Test Society', accent_color: '#123456', logo_url: '' },
}

const render_ = () =>
  render(
    <MemoryRouter initialEntries={['/b/soc/elections']}>
      <Routes>
        <Route path="/b/:slug" element={<OfficerLayout />}>
          <Route path="elections" element={<p>the elections screen</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

/** `pingStatus` decides whether the password form appears. Everything else is the batch. */
const show = (pingStatus: number) => {
  stubFetch((url, init) => {
    if (url.includes('/officer/ping')) {
      return json(pingStatus, pingStatus === 200 ? { ok: true } : { error: 'unauthenticated' })
    }
    if (url.includes('/officer/session')) {
      return init?.method === 'DELETE' ? json(204, null) : json(200, { ok: true })
    }
    return json(200, BATCH)
  })
  render_()
}

const theScreen = () => screen.findByText('the elections screen')
const password = () => screen.queryByLabelText(/password/i)

describe('OfficerLayout', () => {
  it.each([
    // a reload with a valid cookie must not ask for the password again
    [200, 'the session cookie is still valid'],
    // a network failure or a 503 is not a reason to ask for a password
    [503, 'the probe fails for a non-auth reason'],
  ])('DOES NOT ASK FOR A PASSWORD on a %i: %s', async (pingStatus) => {
    show(pingStatus)
    // Nor while the probe is in flight: a loading state, not a prompt.
    expect(password()).toBeNull()
    await theScreen()
    expect(password()).toBeNull()
  })

  it('asks for a password when the session has lapsed, then shows the screen without a reload', async () => {
    show(401)
    await waitFor(() => expect(password()).toBeTruthy())
    expect(screen.queryByText('the elections screen')).toBeNull()
    fireEvent.change(password()!, { target: { value: 'officer-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await theScreen()
  })

  it('offers every destination in an always-visible nav, and marks the current one', async () => {
    show(200)
    await theScreen()
    for (const name of [/elections/i, /member roll/i, /exports/i, /appearance/i, /check-in desk/i]) {
      expect(screen.getByRole('link', { name })).toBeTruthy()
    }
    expect(screen.getByRole('link', { name: /elections/i }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /member roll/i }).getAttribute('aria-current')).toBeNull()
  })

  it('titles the page from the society, and applies its accent', async () => {
    show(200)
    await waitFor(() => expect(document.title).toBe('AGM 2026'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456')
  })

  it('signs out from beside the society name, NOT THE NAV, and then asks for the password again', async () => {
    show(200)
    await theScreen()
    // sign out is not a destination
    const signOut = screen.getByRole('button', { name: /sign out/i })
    expect(signOut.closest('nav')).toBeNull()
    expect(signOut.closest('.officer-title')).not.toBeNull()
    fireEvent.click(signOut)
    await waitFor(() => expect(password()).toBeTruthy())
  })

  it('reports a society that does not exist', async () => {
    stub(404, { error: 'not found' })
    render_()
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not find/i)
  })

  it('has a help button beside sign out that walks through an election', async () => {
    show(200)
    const help = await screen.findByRole('button', { name: 'Help' })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(help)
    const steps = screen.getByRole('region', { name: /how to run an election/i })
    expect(steps.textContent).toMatch(/upload the member roll/i)
    expect(steps.textContent).toMatch(/only checked-in members can vote/i)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /how to run an election/i })).toBeNull()
  })
})
