import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { OfficerSignIn } from '../src/screens/OfficerSignIn.js'

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

afterEach(() => vi.unstubAllGlobals())

const signIn = (password: string) => {
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('OfficerSignIn', () => {
  it('uses a password field, so it is not shoulder-read in a hall', () => {
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    expect(screen.getByLabelText(/password/i).getAttribute('type')).toBe('password')
  })

  it('signs in', async () => {
    stub(200, { ok: true, role: 'officer' })
    const onSignedIn = vi.fn()
    render(<OfficerSignIn batchId="b1" onSignedIn={onSignedIn} />)
    signIn('officer-password-1')
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
  })

  it('reports a wrong password', async () => {
    stub(401, { error: 'unauthorized' })
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    signIn('wrong-password-here')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/password/i))
  })

  it('reports a rate limit as something to wait out', async () => {
    stub(429, { error: 'rate_limited' })
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    signIn('officer-password-1')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too many/i))
  })

  it('never puts the password into the error message', async () => {
    // The value stays in the masked field after a failure, so a typo does not
    // mean retyping it. It must never appear in unmasked text.
    stub(401, { error: 'unauthorized' })
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    signIn('hunter2-very-distinctive')
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).not.toContain('hunter2-very-distinctive')
  })

  it('clears the password once it has been accepted', async () => {
    // after sign-in the cookie is the credential; the password must not stay in state
    stub(200, { ok: true, role: 'officer' })
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    signIn('officer-password-1')
    await waitFor(() =>
      expect((screen.getByLabelText(/password/i) as HTMLInputElement).value).toBe(''))
  })

  it('does not submit an empty password', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    render(<OfficerSignIn batchId="b1" onSignedIn={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(spy).not.toHaveBeenCalled()
  })
})
