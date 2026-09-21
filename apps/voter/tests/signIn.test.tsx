import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { SignIn } from '../src/screens/SignIn.js'

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

afterEach(() => vi.unstubAllGlobals())

const fill = (usuId: string, surname: string) => {
  fireEvent.input(screen.getByLabelText(/usu id/i), { target: { value: usuId } })
  fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: surname } })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
}

describe('SignIn', () => {
  it('opens a number pad for the USU id', () => {
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    expect(screen.getByLabelText(/usu id/i).getAttribute('inputmode')).toBe('numeric')
  })

  it('reports the signed-in name to its parent', async () => {
    stub(200, { first_name: 'Ada' })
    const onSignedIn = vi.fn()
    render(<SignIn batchId="b1" onSignedIn={onSignedIn} />)
    fill('2400001', 'Lovelace')
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('Ada'))
  })

  it('gives a wrong surname a vague message', async () => {
    stub(401, { error: 'unauthorized' })
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Wrong')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/check your usu id and surname/i))
  })

  it('tells a not-checked-in voter to see the door desk', async () => {
    stub(403, { error: 'not checked in', code: 'not_checked_in' })
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Lovelace')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/door desk/i))
  })

  it('tells an ineligible member what the problem is', async () => {
    stub(403, { error: 'ineligible', code: 'ineligible' })
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Lovelace')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/membership/i))
  })

  it('reports a rate limit as something to wait out', async () => {
    stub(429, { error: 'rate_limited' })
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Lovelace')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/too many/i))
  })

  it('reports a network failure as a connection problem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Lovelace')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/connection/i))
  })

  it('does not submit an empty form', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('never reveals another member\'s name on a failure', async () => {
    stub(401, { error: 'unauthorized' })
    const { container } = render(<SignIn batchId="b1" onSignedIn={vi.fn()} />)
    fill('2400001', 'Wrong')
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(container.textContent).not.toMatch(/Ada|Lovelace/)
  })
})
