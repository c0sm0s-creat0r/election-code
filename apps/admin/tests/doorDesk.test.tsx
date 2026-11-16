import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { DoorDesk } from '../src/door/DoorDesk.js'
import { renderRouted } from './renderOfficer.js'
import { json, spyOnStorage, stubFetch } from './helpers.js'

const roll = [
  { usu_id: '2400001', first_name: 'Ada', last_name: 'Lovelace', eligible: 1, checked_in_at: null },
  { usu_id: '2400003', first_name: 'Grace', last_name: 'Hopper', eligible: 0, checked_in_at: null },
  { usu_id: '2400002', first_name: 'Alan', last_name: 'Turing', eligible: 1, checked_in_at: 123 },
]

const quorum = { checked_in: 1, eligible: 2, guests: 3, added_at_door: 1 }

type Override = (url: string) => Response | undefined

/** Routes stubbed responses by URL. */
const stubApi = (over: Override = () => undefined) =>
  stubFetch((url) =>
    over(url) ?? json(200, url.includes('/guests') ? [] : url.includes('/quorum') ? quorum : roll))

afterEach(() => vi.unstubAllGlobals())

const search = (value: string) =>
  fireEvent.change(screen.getByLabelText(/search/i), { target: { value } })

const mount = (over?: Override) => {
  const fetchSpy = stubApi(over)
  const onSessionLost = vi.fn()
  renderRouted(<DoorDesk batchId="b1" slug="soc" onSessionLost={onSessionLost} />)
  return { fetchSpy, onSessionLost }
}

const show = async () => {
  const mounted = mount()
  await screen.findByText(/Lovelace/)
  return mounted
}

const openForm = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))

const fillMember = (usuId: string, first: string, last: string) => {
  // /^usu id$/ so it does not also match "Search by name or USU ID".
  fireEvent.change(screen.getByLabelText(/^usu id$/i), { target: { value: usuId } })
  fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: first } })
  fireEvent.change(screen.getByLabelText(/surname/i), { target: { value: last } })
}

describe('DoorDesk', () => {
  it.each([
    ['surname, in any case', 'LOVEL', /Lovelace/, /Turing/],
    ['first name', 'alan', /Turing/, /Lovelace/],
    // a card shows the number, not the spelling
    ['USU id', '2400002', /Turing/, /Lovelace/],
  ])('finds a member by %s', async (_by, term, found, hidden) => {
    await show()
    search(term)
    expect(screen.getByText(found)).toBeTruthy()
    expect(screen.queryByText(hidden)).toBeNull()
  })

  it('NEVER writes the roll to browser storage, and filters without a request', async () => {
    // Names on a volunteer's device would survive the purge (LIMITATIONS.md §10).
    const writes = spyOnStorage()
    const { fetchSpy } = await show()
    const before = fetchSpy.mock.calls.length
    search('lov'); search('lovel')
    expect(fetchSpy.mock.calls.length).toBe(before)
    expect(writes).not.toHaveBeenCalled()
  })

  it('checks someone in on the row itself, WITHOUT refetching the whole roll', async () => {
    // Reloading would cost ~50 KB per tap over venue wifi, 1,300 times.
    const { fetchSpy } = await show()
    const rollFetches = () =>
      fetchSpy.mock.calls.filter((call) => String(call[0]).endsWith('/roll')).length
    const before = rollFetches()
    fireEvent.click(screen.getByRole('button', { name: /check in Ada Lovelace/i }))
    await screen.findByRole('button', { name: /check out Ada Lovelace/i })
    expect(rollFetches()).toBe(before)
  })

  it('does NOT hand back on an ordinary failure, which is not a session problem', async () => {
    // The 401 and 403 hand-backs are in doorRoute.test.tsx.
    const { onSessionLost } = mount((url) =>
      url.endsWith('/roll') ? json(500, { error: 'internal' }) : undefined)
    await screen.findByRole('alert')
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('offers check out, refuses the ineligible and says why, and links back to admin', async () => {
    await show()
    expect(screen.getByRole('button', { name: /check out Alan Turing/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /check in Grace Hopper/i })).toBeNull()
    expect(screen.getByText(/not an eligible member/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /back to admin/i }).getAttribute('href')).toBe('/b/soc')
  })

  it('shows quorum with guests and door additions as separate figures', async () => {
    await show()
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/1 \/ 2 members/)
    expect(status.textContent).toMatch(/3 guests/)
    expect(status.textContent).toMatch(/1 added at the door/)
  })

  it.each([
    ['A GUEST CANNOT VOTE', /^add guest$/i, /cannot vote/i],
    ['A DOOR-ADDED MEMBER CAN VOTE', /^add member$/i, /will be able to vote/i],
  ])('SAYS %s on its own form', async (_rule, button, wording) => {
    await show()
    openForm(button)
    expect(screen.getByText(wording)).toBeTruthy()
  })

  it('requires a well-formed usu_id and both names to add a member', async () => {
    await show()
    openForm(/^add member$/i)
    const save = () => screen.getByRole('button', { name: /add this member/i })
    fillMember('123', 'Nina', 'Newjoiner')
    expect(save()).toHaveProperty('disabled', true)
    fillMember('2400777', 'Nina', 'Newjoiner')
    expect(save()).toHaveProperty('disabled', false)
  })

  it('tells the volunteer to search when a usu_id is already on the roll', async () => {
    await show()
    openForm(/^add member$/i)
    fillMember('2400001', 'Ada', 'Lovelace')
    stubApi((url) => (url.endsWith('/voters')
      ? json(409, { error: 'that USU id is already on the roll — search for them and check them in instead', code: 'already_on_roll' })
      : undefined))
    fireEvent.click(screen.getByRole('button', { name: /add this member/i }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already on the roll/i))
  })
})
