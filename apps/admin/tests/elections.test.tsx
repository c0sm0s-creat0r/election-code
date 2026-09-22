import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { Elections } from '../src/screens/Elections.js'
import { renderOfficerScreen } from './renderOfficer.js'

afterEach(() => vi.unstubAllGlobals())

const draft = {
  id: 'e1', name: 'President', seats: 1, status: 'draft' as const,
  candidates: [{ id: 'a', name: 'Alex' }],
}

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
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Secretary' } })
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy())
  })

  it('will not create an election with no name', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /create election/i })).toHaveProperty('disabled', true)
  })

  it('will not create an election with zero seats', async () => {
    stubList([])
    renderOfficerScreen(<Elections />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
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
})
