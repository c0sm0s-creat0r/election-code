import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { stub } from './helpers.js'
import { ElectionDetail } from '../src/screens/ElectionDetail.js'
import type { AdminElection } from '../src/api.js'

afterEach(() => vi.unstubAllGlobals())

const turnout = { ballots_cast: 12, voters_checked_in: 40, eligible: 100, added_at_door: 2 }

const show = (status: AdminElection['status']) => {
  const onChanged = vi.fn()
  const election: AdminElection = {
    id: 'e1', name: 'President', seats: 1, status,
    candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
  }
  const view = renderRouted(
    <ElectionDetail batchId="b1" slug="soc" election={election} onChanged={onChanged} />,
  )
  return { onChanged, ...view }
}

const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const button = (name: RegExp) => screen.queryByRole('button', { name })

describe('deleting an election', () => {
  it('asks first, states the rule, and cancels without sending anything', () => {
    const spy = stub(200, {})
    show('draft')
    click(/^delete this election$/i)
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy()
    // The officer learns the limit here, not from a 409 after clicking.
    expect(screen.getByText(/anyone has voted in cannot be deleted/i)).toBeTruthy()
    click(/^cancel$/i)
    expect(button(/yes, delete/i)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('sends a DELETE for the election and reports the change', async () => {
    const spy = stub(204, null)
    const { onChanged } = show('draft')
    click(/^delete this election$/i)
    click(/yes, delete this election/i)

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    const [url, init] = spy.mock.calls[0]!
    expect(url).toMatch(/\/api\/batches\/b1\/elections\/e1$/)
    expect(init?.method).toBe('DELETE')
  })

  it('SHOWS THE API\'S REFUSAL when ballots exist, with the count in it', async () => {
    // the API enforces it: an officer can remove a mistake, never a vote
    stub(409, {
      error: 'this election has 12 ballot(s) in it and cannot be deleted.',
      code: 'has_ballots',
    })
    const { onChanged } = show('draft')
    click(/^delete this election$/i)
    click(/yes, delete this election/i)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/12 ballot/))
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe('ElectionDetail', () => {
  it('in draft: offers the candidate controls, states the freeze rule BEFORE opening, and no close', () => {
    show('draft')
    expect(button(/add candidate/i)).toBeTruthy()
    expect(button(/remove Alex/i)).toBeTruthy()
    expect(screen.getByText(/cannot be added, renamed or removed/i)).toBeTruthy()
    expect(button(/close voting/i)).toBeNull()
  })

  it('reports why an election could not be opened', async () => {
    stub(409, { error: 'an election needs at least as many candidates as seats (1 candidate(s), 3 seat(s))', code: 'not_enough_candidates' })
    show('draft')
    click(/open voting/i)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/candidate/i))
  })

  it('REMOVES the candidate controls once open, rather than disabling them, and says why', () => {
    stub(200, turnout)
    show('open')
    expect(button(/add candidate/i)).toBeNull()
    expect(button(/remove Alex/i)).toBeNull()
    expect(screen.getByText(/can no longer be edited because voting has opened/i)).toBeTruthy()
  })

  it('SHOWS TURNOUT BUT NO TALLY while an election is open', async () => {
    stub(200, turnout)
    const { container } = show('open')
    await screen.findByText(/12/)
    expect(screen.getByText(/40/)).toBeTruthy()
    // door-added voters sit beside the totals, never alone
    expect(screen.getByText(/added at the door/i)).toBeTruthy()
    // a candidate name followed by a number would be a tally
    expect(container.textContent).not.toMatch(/Alex\s*[:\-–]?\s*\d/)
    expect(container.textContent).not.toMatch(/Bo\s*[:\-–]?\s*\d/)
    expect(container.textContent).not.toMatch(/quota|winner|round|elected/i)
    expect(screen.queryByRole('link', { name: /result/i })).toBeNull()
  })

  it('WARNS that closing is irreversible, and closes only after the confirmation', async () => {
    const spy = stub(200, turnout)
    const { onChanged } = show('open')
    click(/close voting/i)
    expect(screen.getByText(/cannot be reopened/i)).toBeTruthy()
    expect(spy.mock.calls.some(([url]) => url.includes('/close'))).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()

    stub(200, { closed_at: 1, ballot_count: 12, ballots_sha256: 'ab' })
    click(/yes, close/i)
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('once closed: links to the result by slug, and can still be deleted', () => {
    show('closed')
    // The routes are /b/:slug. No route matches the batch id.
    expect(screen.getByRole('link', { name: /view the result/i }).getAttribute('href'))
      .toBe('/b/soc/elections/e1/result')
    // an empty closed election is still junk
    expect(button(/^delete this election$/i)).toBeTruthy()
  })
})

/** jsdom's page is always visible. This simulates a background tab. */
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Each turnout poll costs D1 row reads, so the poll stops when nobody is looking. */
describe('turnout polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  const start = () => {
    vi.useFakeTimers()
    const spy = stub(200, turnout)
    show('open')
    return () => spy.mock.calls.length
  }

  const paused = () => screen.queryByText(/turnout updates paused/i)

  it('PAUSES after ten minutes with no activity, says so, and RESUMES from the button at once', async () => {
    const polls = start()
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 5000)
    const atPause = polls()
    expect(paused()).toBeTruthy()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(polls()).toBe(atPause)

    click(/resume/i)
    await vi.advanceTimersByTimeAsync(0)
    expect(polls()).toBe(atPause + 1)
    expect(paused()).toBeNull()
  })

  it('keeps updating while the officer is using the page', async () => {
    const polls = start()
    for (let minute = 0; minute < 15; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      fireEvent.pointerDown(document.body)
    }
    const before = polls()
    await vi.advanceTimersByTimeAsync(5000)
    expect(polls()).toBe(before + 1)
    expect(paused()).toBeNull()
  })

  it('STOPS while the tab is in the background, and catches up on return', async () => {
    const polls = start()
    await vi.advanceTimersByTimeAsync(0)
    setVisibility('hidden')
    const hiddenAt = polls()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(polls()).toBe(hiddenAt)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(polls()).toBe(hiddenAt + 1)
  })
})
