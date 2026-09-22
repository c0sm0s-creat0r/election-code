import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { DoorRoute } from '../src/door/index.js'
import { renderRouted, testBatch } from './renderOfficer.js'

afterEach(() => vi.unstubAllGlobals())

const json = { 'content-type': 'application/json' }

const stub = (over: (url: string, init?: RequestInit) => unknown = () => undefined) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const custom = over(url, init)
    if (custom !== undefined) {
      const { status, body } = custom as { status: number; body: unknown }
      return new Response(JSON.stringify(body), { status, headers: json })
    }
    const body = url.includes('/guests')
      ? []
      : url.includes('/quorum')
        ? { checked_in: 0, eligible: 2, guests: 0, added_at_door: 0 }
        : url.includes('/door/session')
          ? { ok: true }
          : []
    return new Response(JSON.stringify(body), { status: 200, headers: json })
  }))

describe('DoorRoute', () => {
  it('ASKS FOR THE PASSWORD EVERY TIME, without probing for a session first', async () => {
    const spy = vi.fn(async () => new Response('[]', { status: 200, headers: json }))
    vi.stubGlobal('fetch', spy)
    renderRouted(<DoorRoute batch={testBatch} />)
    expect(screen.getByLabelText(/check-in desk password/i)).toBeTruthy()
    // No probe: the door does not ask the server whether it is already signed in.
    expect(spy).not.toHaveBeenCalled()
  })

  it('opens the desk once the password is accepted', async () => {
    stub()
    renderRouted(<DoorRoute batch={testBatch} />)
    fireEvent.change(screen.getByLabelText(/check-in desk password/i), { target: { value: 'door-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByLabelText(/search/i)).toBeTruthy())
  })

  it('RETURNS TO THE FORM WITH A REASON when the session ends mid-shift', async () => {
    // The stall that prompted this: the desk used to sit on a permission error
    // with nothing to click.
    let signedIn = false
    stub((url) => {
      if (url.includes('/door/session')) { signedIn = true; return undefined }
      if (!signedIn) return undefined
      return url.endsWith('/roll') ? { status: 403, body: { error: 'forbidden' } } : undefined
    })
    renderRouted(<DoorRoute batch={testBatch} />)
    fireEvent.change(screen.getByLabelText(/check-in desk password/i), { target: { value: 'door-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByText(/door session ended/i)).toBeTruthy())
    expect(screen.getByLabelText(/check-in desk password/i)).toBeTruthy()
  })

  it('a wrong password reads as a wrong password, not as an ended session', async () => {
    stub((url) => (url.includes('/door/session') ? { status: 401, body: { error: 'unauthorized' } } : undefined))
    renderRouted(<DoorRoute batch={testBatch} />)
    fireEvent.change(screen.getByLabelText(/check-in desk password/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not recognised/i))
  })
})
