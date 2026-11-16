import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ApiError } from '../src/api.js'
import { PasswordForm } from '../src/components/PasswordForm.js'

/** The officer and door sign-ins are this form with a different `signIn`. */
const show = (signIn: (password: string) => Promise<unknown>) => {
  const onSignedIn = vi.fn()
  render(<PasswordForm id="pw" heading="Sign in" label="Password" signIn={signIn} onSignedIn={onSignedIn} />)
  return onSignedIn
}

const field = () => screen.getByLabelText('Password')

const submit = (password: string) => {
  fireEvent.change(field(), { target: { value: password } })
  fireEvent.submit(field().closest('form')!)
}

describe('PasswordForm', () => {
  it('signs in from a masked field, so the password is not shoulder-read in a hall', async () => {
    const signIn = vi.fn(async (_password: string) => ({ ok: true }))
    const onSignedIn = show(signIn)
    expect(field().getAttribute('type')).toBe('password')
    submit('officer-password-1')
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(signIn).toHaveBeenCalledWith('officer-password-1')
  })

  it.each([
    [401, /not recognised/i],
    [429, /too many/i],
  ])('explains a %i without repeating the password', async (status, message) => {
    // The value stays in the masked field. It must never appear in unmasked text.
    show(async () => { throw new ApiError(status, undefined, 'refused') })
    submit('hunter2-very-distinctive')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(message)
    expect(alert.textContent).not.toContain('hunter2')
  })

  it('does not submit an empty password', () => {
    const signIn = vi.fn(async (_password: string) => ({ ok: true }))
    show(signIn)
    submit('')
    expect(signIn).not.toHaveBeenCalled()
  })
})
