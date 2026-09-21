import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { Receipt } from '../src/screens/Receipt.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

describe('Receipt', () => {
  it('shows a recorded ballot', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    render(<Receipt token="t-1" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/recorded/i)).toBeTruthy())
    expect(screen.getByText(/President/)).toBeTruthy()
  })

  it('NEVER shows preferences, because a receipt that proves how you voted enables coercion', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    const { container } = render(<Receipt token="t-1" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/recorded/i)).toBeTruthy())
    expect(container.textContent).not.toMatch(/preference/i)
  })

  it('shows the token so it can be kept', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    render(<Receipt token="t-1" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('t-1')).toBeTruthy())
  })

  it('reports an unknown token', async () => {
    stub({ error: 'not found' }, 404)
    render(<Receipt token="nope" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('offers to void a recorded ballot', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    render(<Receipt token="t-1" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /vote again/i })).toBeTruthy())
  })

  it('does not offer to void an already-voided ballot', async () => {
    stub({ status: 'voided', election_name: 'President' })
    render(<Receipt token="t-1" onVoided={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/voided/i)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /vote again/i })).toBeNull()
  })

  it('tells the parent once the ballot is voided, so it can offer a new ballot', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    const onVoided = vi.fn()
    render(<Receipt token="t-1" onVoided={onVoided} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /vote again/i })).toBeTruthy())
    stub({ status: 'voided' })
    fireEvent.click(screen.getByRole('button', { name: /vote again/i }))
    await waitFor(() => expect(onVoided).toHaveBeenCalled())
  })

  it('reports a refused void without pretending it worked', async () => {
    stub({ status: 'recorded', election_name: 'President' })
    const onVoided = vi.fn()
    render(<Receipt token="t-1" onVoided={onVoided} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /vote again/i })).toBeTruthy())
    stub({ error: 'voting has closed', code: 'not_open' }, 409)
    fireEvent.click(screen.getByRole('button', { name: /vote again/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/closed/i))
    expect(onVoided).not.toHaveBeenCalled()
  })
})
