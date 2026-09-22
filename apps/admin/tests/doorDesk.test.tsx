import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { DoorDesk } from '../src/door/DoorDesk.js'
import { renderRouted } from './renderOfficer.js'

const roll = [
  { usu_id: '2400001', first_name: 'Ada', last_name: 'Lovelace', eligible: 1, checked_in_at: null },
  { usu_id: '2400003', first_name: 'Grace', last_name: 'Hopper', eligible: 0, checked_in_at: null },
  { usu_id: '2400002', first_name: 'Alan', last_name: 'Turing', eligible: 1, checked_in_at: 123 },
]

const quorum = { checked_in: 1, eligible: 2, guests: 3, added_at_door: 1 }

let fetchSpy: ReturnType<typeof vi.fn>

/** Routes by URL, the way the component actually calls the API. */
const stubApi = (over: (url: string) => unknown = () => undefined) => {
  fetchSpy = vi.fn(async (url: string) => {
    const custom = over(url)
    if (custom !== undefined) {
      const { status, body } = custom as { status: number; body: unknown }
      return new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
      })
    }
    const body = url.includes('/guests') ? [] : url.includes('/quorum') ? quorum : roll
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
}

/**
 * Spies rather than inspection. This environment's `localStorage` is a bare stub
 * with no methods, so reading `.length` would assert nothing — and a spy is the
 * stronger test regardless: it catches a write whatever backs the store.
 */
let writes: ReturnType<typeof vi.fn>

beforeEach(() => {
  writes = vi.fn()
  // stubGlobal replaces the binding. Assigning onto the environment's own
  // storage object fails: it is a locked proxy whose set trap refuses writes.
  const fake = () => ({
    setItem: writes, getItem: () => null, removeItem: () => {}, clear: () => {},
    key: () => null, length: 0,
  })
  vi.stubGlobal('localStorage', fake())
  vi.stubGlobal('sessionStorage', fake())
})

afterEach(() => vi.unstubAllGlobals())

const search = (value: string) =>
  fireEvent.change(screen.getByLabelText(/search/i), { target: { value } })

let onSessionLost: ReturnType<typeof vi.fn>

const show = async () => {
  onSessionLost = vi.fn()
  renderRouted(<DoorDesk batchId="b1" slug="soc" onSessionLost={onSessionLost} />)
  await waitFor(() => expect(screen.getByText(/Lovelace/)).toBeTruthy())
}

describe('DoorDesk', () => {
  it('finds a member by surname', async () => {
    stubApi(); await show()
    search('lovel')
    expect(screen.getByText(/Lovelace/)).toBeTruthy()
    expect(screen.queryByText(/Turing/)).toBeNull()
  })

  it('finds a member by first name', async () => {
    stubApi(); await show()
    search('alan')
    expect(screen.getByText(/Turing/)).toBeTruthy()
    expect(screen.queryByText(/Lovelace/)).toBeNull()
  })

  it('FINDS A MEMBER BY USU ID — a card shows the number, not the spelling', async () => {
    stubApi(); await show()
    search('2400002')
    expect(screen.getByText(/Turing/)).toBeTruthy()
    expect(screen.queryByText(/Lovelace/)).toBeNull()
  })

  it('is case-insensitive', async () => {
    stubApi(); await show()
    search('LOVELACE')
    expect(screen.getByText(/Lovelace/)).toBeTruthy()
  })

  it('filters WITHOUT a network request', async () => {
    stubApi(); await show()
    const before = fetchSpy.mock.calls.length
    search('lov'); search('love'); search('lovel')
    expect(fetchSpy.mock.calls.length).toBe(before)
  })

  it('NEVER writes the roll to browser storage', async () => {
    // 1,300 members' names and USU ids on a volunteer's personal device would sit
    // outside the post-AGM purge, which is the thing that makes the retention
    // claim true. LIMITATIONS.md §10 accepts losing the roll on reload instead.
    stubApi(); await show()
    search('lovel')
    expect(writes).not.toHaveBeenCalled()
  })

  it('does NOT refetch the whole roll to check someone in', async () => {
    // ~50 KB per tap over venue wifi, 1,300 times, is the cost this avoids.
    stubApi(); await show()
    const rollFetches = () =>
      fetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/roll')).length
    const before = rollFetches()
    fireEvent.click(screen.getByRole('button', { name: /check in Ada Lovelace/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check out Ada Lovelace/i })).toBeTruthy())
    expect(rollFetches()).toBe(before)
  })

  it('updates the row locally so the check-in is visible immediately', async () => {
    stubApi(); await show()
    fireEvent.click(screen.getByRole('button', { name: /check in Ada Lovelace/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check out Ada Lovelace/i })).toBeTruthy())
  })

  it('HANDS BACK to the sign-in form on a 403, instead of stranding the volunteer', async () => {
    // requireRole answers 403 for a valid session of the wrong role — an officer
    // opening the door desk. The desk used to render and then fail every request
    // with "that session does not have permission to do this", with nothing to
    // click. Now it returns to the password form.
    stubApi((url) => (url.endsWith('/roll') ? { status: 403, body: { error: 'forbidden' } } : undefined))
    renderRouted(<DoorDesk batchId="b1" slug="soc" onSessionLost={(onSessionLost = vi.fn())} />)
    await waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })

  it('hands back on a 401 too, so a lapsed shift is recoverable', async () => {
    stubApi((url) => (url.endsWith('/roll') ? { status: 401, body: { error: 'unauthenticated' } } : undefined))
    renderRouted(<DoorDesk batchId="b1" slug="soc" onSessionLost={(onSessionLost = vi.fn())} />)
    await waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })

  it('does NOT hand back on an ordinary failure, which is not a session problem', async () => {
    stubApi((url) => (url.endsWith('/roll') ? { status: 500, body: { error: 'internal' } } : undefined))
    renderRouted(<DoorDesk batchId="b1" slug="soc" onSessionLost={(onSessionLost = vi.fn())} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('offers CHECK OUT for someone already checked in', async () => {
    stubApi(); await show()
    expect(screen.getByRole('button', { name: /check out Alan Turing/i })).toBeTruthy()
  })

  it('offers a way back to the officer area', async () => {
    stubApi(); await show()
    expect(screen.getByRole('link', { name: /back to admin/i }).getAttribute('href')).toBe('/b/soc')
  })

  it('CANNOT check in an ineligible member, and says why', async () => {
    stubApi(); await show()
    expect(screen.queryByRole('button', { name: /check in Grace Hopper/i })).toBeNull()
    expect(screen.getByText(/not an eligible member/i)).toBeTruthy()
  })

  it('shows quorum with guests and door additions as separate figures', async () => {
    stubApi(); await show()
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/1 \/ 2 members/)
    expect(status.textContent).toMatch(/3 guests/)
    expect(status.textContent).toMatch(/1 added at the door/)
  })

  it('keeps the two additions as separate actions', async () => {
    stubApi(); await show()
    expect(screen.getByRole('button', { name: /^add guest$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^add member$/i })).toBeTruthy()
  })

  it('SAYS A GUEST CANNOT VOTE on the guest form', async () => {
    stubApi(); await show()
    fireEvent.click(screen.getByRole('button', { name: /^add guest$/i }))
    expect(screen.getByText(/cannot vote/i)).toBeTruthy()
  })

  it('SAYS A DOOR-ADDED MEMBER CAN VOTE on the member form', async () => {
    stubApi(); await show()
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }))
    expect(screen.getByText(/will be able to vote/i)).toBeTruthy()
  })

  it('requires a well-formed usu_id and both names to add a member', async () => {
    stubApi(); await show()
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }))
    const save = () => screen.getByRole('button', { name: /add this member/i })
    // /^usu id$/ so it does not also match "Search by name or USU ID".
    fireEvent.change(screen.getByLabelText(/^usu id$/i), { target: { value: '123' } })
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Nina' } })
    fireEvent.change(screen.getByLabelText(/surname/i), { target: { value: 'Newjoiner' } })
    expect(save()).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(/^usu id$/i), { target: { value: '2400777' } })
    expect(save()).toHaveProperty('disabled', false)
  })

  it('tells the volunteer to search when a usu_id is already on the roll', async () => {
    stubApi(); await show()
    fireEvent.click(screen.getByRole('button', { name: /^add member$/i }))
    fireEvent.change(screen.getByLabelText(/^usu id$/i), { target: { value: '2400001' } })
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
    stubApi((url) =>
      url.endsWith('/voters')
        ? { status: 409, body: { error: 'that USU id is already on the roll — search for them and check them in instead', code: 'already_on_roll' } }
        : undefined)
    fireEvent.click(screen.getByRole('button', { name: /add this member/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already on the roll/i))
  })
})
