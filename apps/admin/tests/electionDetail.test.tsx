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
    expect(screen.getByText(/frozen/i)).toBeTruthy()
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

  it('offers the per-election exports once closed, which nothing else could reach', () => {
    // Exports was only ever rendered with electionId undefined, so the ballot,
    // candidate and result files -- the whole offline-recount story -- were
    // unreachable UI.
    show('closed')
    expect(screen.getByRole('link', { name: /ballots \(csv\)/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /candidates \(csv\)/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /sealed result \(json\)/i })).toBeTruthy()
  })

  it('offers no result link while open', async () => {
    stub(200, turnout)
    show('open')
    await waitFor(() => expect(screen.getByText(/12/)).toBeTruthy())
    expect(screen.queryByRole('link', { name: /result/i })).toBeNull()
  })
})
