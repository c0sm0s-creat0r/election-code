import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { Elections } from '../src/screens/Elections.js'
import { renderOfficerScreen } from './renderOfficer.js'
import { json, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const draft = {
  id: 'e1', name: 'President', seats: 1, status: 'draft' as const,
  candidates: [{ id: 'a', name: 'Alex' }],
}

/** Answers every request with the list, unless `extra` has something for the URL. */
const show = (list: unknown[], extra: (url: string) => unknown = () => undefined) => {
  const spy = stubFetch((url) => json(200, extra(url) ?? list))
  renderOfficerScreen(<Elections />)
  return spy
}

const president = () => screen.findByRole('button', { name: 'President' })
const nothingYet = () => screen.findByText(/no elections yet/i)

/** The form is a disclosure, so every creation test opens it first. */
const openTheForm = () => fireEvent.click(screen.getByRole('button', { name: /new election/i }))
const nameField = () => screen.queryByLabelText(/name/i)
const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const createButton = () => screen.getByRole('button', { name: /create election/i })

describe('Elections', () => {
  it('lists what the officer has, drafts included, from the officer listing and not the public one', async () => {
    const spy = show([draft])
    await president()
    expect(screen.getByText(/draft/)).toBeTruthy()
    expect(spy.mock.calls.some(([url]) => url.includes('/officer/elections'))).toBe(true)
  })

  it('keeps the form out of the way until asked, and discards what was typed on cancel', async () => {
    show([])
    await nothingYet()
    expect(nameField()).toBeNull()

    openTheForm()
    expect(screen.getByLabelText(/seats/i)).toBeTruthy()
    // no name, no election
    expect(createButton()).toHaveProperty('disabled', true)
    type(/name/i, 'Secretary')
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(nameField()).toBeNull()

    openTheForm()
    expect(nameField()).toHaveProperty('value', '')
  })

  it('creates an election, opens it for editing, and closes the form', async () => {
    // Stateful, like the server: creating adds to the next list. The list URL
    // also ends in /elections, so the create URL is matched exactly.
    const made = { id: 'e9', name: 'Secretary', seats: 1, status: 'draft' as const, candidates: [] }
    let created = false
    show([], (url) => (url.endsWith('/batches/b1/elections')
      ? ((created = true), made)
      : created ? [made] : []))
    await nothingYet()
    openTheForm()
    type(/name/i, 'Secretary')
    fireEvent.click(createButton())
    expect(await screen.findByRole('heading', { name: 'Secretary' })).toBeTruthy()
    expect(nameField()).toBeNull()
  })

  it('will not create an election with zero seats', async () => {
    const spy = show([])
    await nothingYet()
    openTheForm()
    type(/name/i, 'x')
    type(/seats/i, '0')
    const before = spy.mock.calls.length
    fireEvent.click(createButton())
    expect(spy.mock.calls.length).toBe(before)
  })

  it('shows the selected election\'s detail', async () => {
    show([draft])
    fireEvent.click(await president())
    expect(screen.getByRole('heading', { name: 'President' })).toBeTruthy()
    expect(screen.getByText(/cannot be added, renamed or removed/i)).toBeTruthy()
  })

  it('tells the officer to upload the roll when none has been imported', async () => {
    show([draft], (url) => (url.includes('/roll/summary') ? { total: 0, eligible: 0 } : undefined))
    const link = await screen.findByRole('link', { name: /upload the member roll/i })
    expect(link.getAttribute('href')).toBe('/b/soc/roll')
  })

  it('says nothing about the roll once members are imported', async () => {
    const spy = show([draft], (url) => (url.includes('/roll/summary') ? { total: 6, eligible: 4 } : undefined))
    await president()
    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => url.includes('/roll/summary'))).toBe(true))
    expect(screen.queryByText(/no members have been imported/i)).toBeNull()
  })
})
