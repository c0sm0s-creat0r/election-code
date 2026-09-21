import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { Ballot } from '../src/screens/Ballot.js'

const election = {
  id: 'e1',
  name: 'President',
  seats: 1,
  status: 'open' as const,
  candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
}

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

const renderBallot = (overrides: Partial<Parameters<typeof Ballot>[0]> = {}) => {
  const props = {
    batchId: 'b1', election, index: 0, total: 1,
    onCast: vi.fn(), onSessionLost: vi.fn(),
    ...overrides,
  }
  render(<Ballot {...props} />)
  return props
}

const castFor = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Add ${name}` }))
  fireEvent.click(screen.getByRole('button', { name: /submit/i }))
}

describe('Ballot', () => {
  it('shows which election this is, of how many', () => {
    renderBallot({ index: 0, total: 3 })
    expect(screen.getByText(/1 of 3/i)).toBeTruthy()
  })

  it('names the election', () => {
    renderBallot()
    expect(screen.getByText('President')).toBeTruthy()
  })

  it('hands the receipt token up on success', async () => {
    stub(201, { receipt_token: 'tok-1' })
    const { onCast } = renderBallot()
    castFor('Alex')
    await waitFor(() => expect(onCast).toHaveBeenCalledWith('tok-1'))
  })

  it('tells an un-checked-in voter to see the door desk', async () => {
    stub(403, { error: 'not eligible', code: 'not_eligible' })
    renderBallot()
    castFor('Alex')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/door desk/i))
  })

  it('reports an already-recorded ballot without implying failure', async () => {
    stub(409, { error: 'already voted', code: 'already_voted' })
    renderBallot()
    castFor('Alex')
    await waitFor(() => {
      const text = screen.getByRole('alert').textContent ?? ''
      expect(text).toMatch(/already recorded/i)
      expect(text).not.toMatch(/failed|error/i)
    })
  })

  it('SAYS PLAINLY that a lost response means no receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    renderBallot()
    castFor('Alex')
    await waitFor(() => {
      const text = screen.getByRole('alert').textContent ?? ''
      expect(text).toMatch(/may have been recorded/i)
      expect(text).toMatch(/receipt/i)
      expect(text).not.toMatch(/try again|resubmit/i)
    })
  })

  it('reports a lapsed session upward WITH the draft, so it is not lost', async () => {
    stub(401, { error: 'unauthenticated', code: 'no_session' })
    const { onSessionLost } = renderBallot()
    castFor('Alex')
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledWith(['a']))
  })

  it('surfaces a validation reason from the server verbatim', async () => {
    stub(400, { error: 'Rank at least 2 candidate(s).', code: 'invalid_ballot' })
    renderBallot()
    castFor('Alex')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least 2/))
  })

  it('restores a draft handed back after a re-sign-in', () => {
    renderBallot({ initialRanking: ['b'] })
    expect(screen.getByTestId('ordinal-0').textContent).toBe('1')
    expect(screen.getByTestId('ranked-0').textContent).toContain('Bo')
  })

  it('does not fire a second request while one is in flight', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ receipt_token: 't' }), { status: 201 }))
    vi.stubGlobal('fetch', spy)
    renderBallot()
    fireEvent.click(screen.getByRole('button', { name: 'Add Alex' }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })
})
