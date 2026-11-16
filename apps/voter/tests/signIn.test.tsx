import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { SignIn } from '../src/screens/SignIn.js'
import { json, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

/** Renders the form against one API answer. */
const show = (respond: () => Response) => {
  const spy = stubFetch(respond)
  const onSignedIn = vi.fn()
  const { container } = render(<SignIn batchId="b1" onSignedIn={onSignedIn} />)
  return { spy, onSignedIn, container }
}

const usuId = () => screen.getByLabelText(/usu id/i)
const submit = () => fireEvent.click(screen.getByRole('button', { name: /continue/i }))

const fill = (surname = 'Lovelace') => {
  fireEvent.input(usuId(), { target: { value: '2400001' } })
  fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: surname } })
  submit()
}

describe('SignIn', () => {
  it('opens a number pad for the USU id, and reports the signed-in name to its parent', async () => {
    const { onSignedIn } = show(() => json(200, { first_name: 'Ada' }))
    expect(usuId().getAttribute('inputmode')).toBe('numeric')
    fill()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('Ada'))
  })

  it('gives a wrong surname a vague message, and never reveals a member\'s name', async () => {
    const { container } = show(() => json(401, { error: 'unauthorized' }))
    fill('Wrong')
    expect((await screen.findByRole('alert')).textContent).toMatch(/check your usu id and surname/i)
    expect(container.textContent).not.toMatch(/Ada|Lovelace/)
  })

  it.each([
    ['a not-checked-in voter to see the check-in desk',
      () => json(403, { error: 'not checked in', code: 'not_checked_in' }), /check-in desk/i],
    ['an ineligible member what the problem is',
      () => json(403, { error: 'ineligible', code: 'ineligible' }), /membership/i],
    ['a rate-limited voter to wait it out', () => json(429, { error: 'rate_limited' }), /too many/i],
    ['a voter with no network that it is the connection',
      () => { throw new TypeError('Failed to fetch') }, /connection/i],
  ])('tells %s', async (_whom, respond, message) => {
    show(respond)
    fill()
    expect((await screen.findByRole('alert')).textContent).toMatch(message)
  })

  it('does not submit an empty form', () => {
    const { spy } = show(() => json(200, { first_name: 'Ada' }))
    submit()
    expect(spy).not.toHaveBeenCalled()
  })
})
