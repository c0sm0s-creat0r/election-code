import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { Elections } from '../src/screens/Elections.js'
import { renderOfficerScreen } from './renderOfficer.js'

afterEach(() => vi.unstubAllGlobals())

const draft = {
  id: 'e1', name: 'President', seats: 1, status: 'draft' as const,
  candidates: [{ id: 'a', name: 'Alex' }],
}

/** The form is a disclosure now, so every creation test opens it first. */
const openTheForm = () => fireEvent.click(screen.getByRole('button', { name: /new election/i }))

const stubList = (list: unknown[], extra: (url: string) => unknown = () => undefined) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const custom = extra(url)
    const body = custom === undefined ? list : custom
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))

describe('Elections', () => {
  it('lists what the officer has, drafts included', async () => {
    stubList([draft])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    expect(screen.getByText(/draft/)).toBeTruthy()
  })

  it('reads the officer listing, not the public one', async () => {
    const spy = vi.fn(async (_url: string) => new Response('[]', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', spy)
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0]![0]).toContain('/officer/elections')
  })

  it('says so when there are none', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
  })

  it('creates an election and opens it for editing', async () => {
    // Stateful, like the server: creating adds to what the next list returns.
    // The list URL also ends in /elections, so the create URL is matched exactly.
    const made = { id: 'e9', name: 'Secretary', seats: 1, status: 'draft' as const, candidates: [] }
    let created = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.endsWith('/batches/b1/elections')
        ? ((created = true), made)
        : created ? [made] : []
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    openTheForm()
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Secretary' } })
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy())
  })

  it('keeps the form out of the way until it is asked for', async () => {
    stubList([draft])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    expect(screen.queryByLabelText(/name/i)).toBeNull()

    openTheForm()
    expect(screen.getByLabelText(/name/i)).toBeTruthy()
    expect(screen.getByLabelText(/seats/i)).toBeTruthy()
  })

  it('closes the form again, discarding what was typed', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    openTheForm()
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Secretary' } })
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByLabelText(/name/i)).toBeNull()

    openTheForm()
    expect(screen.getByLabelText(/name/i)).toHaveProperty('value', '')
  })

  it('closes the form once the election exists', async () => {
    const made = { id: 'e9', name: 'Secretary', seats: 1, status: 'draft' as const, candidates: [] }
    let created = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.endsWith('/batches/b1/elections')
        ? ((created = true), made)
        : created ? [made] : []
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }))
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    openTheForm()
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Secretary' } })
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy())
    expect(screen.queryByLabelText(/^name$/i)).toBeNull()
  })

  it('will not create an election with no name', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    openTheForm()
    expect(screen.getByRole('button', { name: /create election/i })).toHaveProperty('disabled', true)
  })

  it('will not create an election with zero seats', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    openTheForm()
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/seats/i), { target: { value: '0' } })
    const spyBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(spyBefore)
  })

  it('shows the selected election\'s detail', async () => {
    stubList([draft])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'President' }))
    expect(screen.getByRole('heading', { name: 'President' })).toBeTruthy()
    expect(screen.getByText(/cannot be added, renamed or removed/i)).toBeTruthy()
  })

  it('tells the officer to upload the roll when none has been imported', async () => {
    stubList([draft], (url) => (url.includes('/roll/summary') ? { total: 0, eligible: 0 } : undefined))
    renderOfficerScreen(<Elections />)
    const link = await screen.findByRole('link', { name: /upload the member roll/i })
    expect(link.getAttribute('href')).toBe('/b/soc/roll')
  })

  it('says nothing about the roll once members are imported', async () => {
    stubList([draft], (url) => (url.includes('/roll/summary') ? { total: 6, eligible: 4 } : undefined))
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    await waitFor(() => expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).includes('/roll/summary')),
    ).toBe(true))
    expect(screen.queryByText(/no members have been imported/i)).toBeNull()
  })
})
