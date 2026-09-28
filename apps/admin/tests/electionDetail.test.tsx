import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { ElectionDetail } from '../src/screens/ElectionDetail.js'
import type { AdminElection } from '../src/api.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

const turnout = { ballots_cast: 12, voters_checked_in: 40, eligible: 100, added_at_door: 2 }

const election = (status: AdminElection['status']): AdminElection => ({
  id: 'e1', name: 'President', seats: 1, status,
  candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
})

const show = (status: AdminElection['status']) => {
  const onChanged = vi.fn()
  const view = renderRouted(
    <ElectionDetail batchId="b1" slug="soc" election={election(status)} onChanged={onChanged} />,
  )
  return { onChanged, ...view }
}

describe('deleting an election', () => {
  it('asks for confirmation first, and states the rule', () => {
    show('draft')
    fireEvent.click(screen.getByRole('button', { name: /^delete this election$/i }))
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy()
    // The officer learns the limit here, not from a 409 after clicking.
    expect(screen.getByText(/anyone has voted in cannot be deleted/i)).toBeTruthy()
  })

  it('sends a DELETE for the election and reports the change', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', spy)
    const { onChanged } = show('draft')
    fireEvent.click(screen.getByRole('button', { name: /^delete this election$/i }))
    fireEvent.click(screen.getByRole('button', { name: /yes, delete this election/i }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/batches/b1/elections/e1')
    expect(url).not.toContain('/candidates')
    expect(init.method).toBe('DELETE')
  })

  it('SHOWS THE API\'S REFUSAL when ballots exist, with the count in it', async () => {
    // The guarantee is the API's, not this screen's: an officer password removes
    // a mistake and never a vote.
    stub(409, {
      error: 'this election has 12 ballot(s) in it and cannot be deleted.',
      code: 'has_ballots',
    })
    const { onChanged } = show('draft')
    fireEvent.click(screen.getByRole('button', { name: /^delete this election$/i }))
    fireEvent.click(screen.getByRole('button', { name: /yes, delete this election/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/12 ballot/))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('cancels without sending anything', () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    show('draft')
    fireEvent.click(screen.getByRole('button', { name: /^delete this election$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('button', { name: /yes, delete/i })).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('is offered for a closed election too, because an empty one is still junk', () => {
    show('closed')
    expect(screen.getByRole('button', { name: /^delete this election$/i })).toBeTruthy()
  })
})

describe('ElectionDetail', () => {
  it('states the freeze rule BEFORE opening, not after', () => {
    show('draft')
    expect(screen.getByText(/cannot be added, renamed or removed/i)).toBeTruthy()
  })

  it('offers the candidate controls while in draft', () => {
    show('draft')
    expect(screen.getByRole('button', { name: /add candidate/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /remove Alex/i })).toBeTruthy()
  })

  it('REMOVES the candidate controls once open, rather than disabling them', () => {
    stub(200, turnout)
    show('open')
    expect(screen.queryByRole('button', { name: /add candidate/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /remove Alex/i })).toBeNull()
  })

  it('explains why the controls are gone', () => {
    stub(200, turnout)
    show('open')
    expect(screen.getByText(/can no longer be edited because voting has opened/i)).toBeTruthy()
  })

  it('reports why an election could not be opened', async () => {
    stub(409, { error: 'an election needs at least as many candidates as seats (1 candidate(s), 3 seat(s))', code: 'not_enough_candidates' })
    show('draft')
    fireEvent.click(screen.getByRole('button', { name: /open voting/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/candidate/i))
  })

  it('shows turnout while open', async () => {
    stub(200, turnout)
    show('open')
    await waitFor(() => expect(screen.getByText(/12/)).toBeTruthy())
    expect(screen.getByText(/40/)).toBeTruthy()
  })

  it('shows door-added voters beside the totals, never alone', async () => {
    stub(200, turnout)
    show('open')
    await waitFor(() => expect(screen.getByText(/added at the door/i)).toBeTruthy())
  })

  it('SHOWS NO TALLY while an election is open', async () => {
    stub(200, turnout)
    const { container } = show('open')
    await waitFor(() => expect(screen.getByText(/12/)).toBeTruthy())
    // A candidate name followed by a number is exactly the thing that must not
    // exist on this screen: that is a tally, and closing is what releases it.
    expect(container.textContent).not.toMatch(/Alex\s*[:\-–]?\s*\d/)
    expect(container.textContent).not.toMatch(/Bo\s*[:\-–]?\s*\d/)
    expect(container.textContent).not.toMatch(/quota|winner|round|elected/i)
  })

  it('does not offer to close a draft election', () => {
    show('draft')
    expect(screen.queryByRole('button', { name: /close voting/i })).toBeNull()
  })

  it('WARNS that closing is irreversible before doing it', async () => {
    stub(200, turnout)
    show('open')
    fireEvent.click(screen.getByRole('button', { name: /close voting/i }))
    await waitFor(() => expect(screen.getByText(/cannot be reopened/i)).toBeTruthy())
  })

  it('closes only after the confirmation', async () => {
    stub(200, turnout)
    const { onChanged } = show('open')
    fireEvent.click(screen.getByRole('button', { name: /close voting/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /yes, close/i })).toBeTruthy())
    stub(200, { closed_at: 1, ballot_count: 12, ballots_sha256: 'ab' })
    fireEvent.click(screen.getByRole('button', { name: /yes, close/i }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('offers the result only once closed', () => {
    show('closed')
    expect(screen.getByRole('link', { name: /view the result/i })).toBeTruthy()
  })


  it('offers no result link while open', async () => {
    stub(200, turnout)
    show('open')
    await waitFor(() => expect(screen.getByText(/12/)).toBeTruthy())
    expect(screen.queryByRole('link', { name: /result/i })).toBeNull()
  })
})
