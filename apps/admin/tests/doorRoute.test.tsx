import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { DoorRoute } from '../src/door/index.js'
import { renderRouted, testBatch } from './renderOfficer.js'
import { json, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const stubDoor = (over: (url: string) => Response | undefined = () => undefined) =>
  stubFetch((url) => over(url) ?? json(200,
    url.includes('/quorum')
      ? { checked_in: 0, eligible: 2, guests: 0, added_at_door: 0 }
      : url.includes('/door/session') ? { ok: true } : []))

const password = () => screen.getByLabelText(/check-in desk password/i)

const signIn = (value = 'door-password-1') => {
  fireEvent.change(password(), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('DoorRoute', () => {
  it('ASKS FOR THE PASSWORD EVERY TIME, without probing for a session first', () => {
    const spy = stubDoor()
    renderRouted(<DoorRoute batch={testBatch} />)
    expect(password()).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })

  it('opens the desk once the password is accepted', async () => {
    stubDoor()
    renderRouted(<DoorRoute batch={testBatch} />)
    signIn()
    expect(await screen.findByLabelText(/search/i)).toBeTruthy()
  })

  // 401: the shift's session lapsed. 403: a valid session of the wrong role,
  // e.g. an officer opening the desk. Without the hand-back the desk shows a
  // permission error with nothing to click.
  it.each([401, 403])('RETURNS TO THE FORM WITH A REASON when the desk gets a %i', async (status) => {
    stubDoor((url) => (url.endsWith('/roll') ? json(status, { error: 'refused' }) : undefined))
    renderRouted(<DoorRoute batch={testBatch} />)
    signIn()
    expect(await screen.findByText(/door session ended/i)).toBeTruthy()
    expect(password()).toBeTruthy()
  })

  it('a 401 at sign-in reads as a wrong password, not as an ended session', async () => {
    stubDoor((url) => (url.includes('/door/session') ? json(401, { error: 'unauthorized' }) : undefined))
    renderRouted(<DoorRoute batch={testBatch} />)
    signIn('wrong')
    expect((await screen.findByRole('alert')).textContent).toMatch(/not recognised/i)
    expect(screen.queryByText(/door session ended/i)).toBeNull()
  })
})
