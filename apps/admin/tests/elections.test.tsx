import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Elections } from '../src/screens/Elections.js'

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
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    expect(screen.getByText(/draft/)).toBeTruthy()
  })

  it('reads the officer listing, not the public one', async () => {
    const spy = vi.fn(async (_url: string) => new Response('[]', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', spy)
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0]![0]).toContain('/officer/elections')
  })

  it('says so when there are none', async () => {
    stubList([])
    render(<Elections batchId="b1" slug="soc" />)
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
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Secretary' } })
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy())
  })

  it('will not create an election with no name', async () => {
    stubList([])
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    expect(screen.getByRole('button', { name: /create election/i })).toHaveProperty('disabled', true)
  })

  it('will not create an election with zero seats', async () => {
    stubList([])
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(/no elections yet/i)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/seats/i), { target: { value: '0' } })
    const spyBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /create election/i }))
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(spyBefore)
  })

  it('shows the selected election\'s detail', async () => {
    stubList([draft])
    render(<Elections batchId="b1" slug="soc" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'President' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'President' }))
    expect(screen.getByRole('heading', { name: 'President' })).toBeTruthy()
    expect(screen.getByText(/cannot be added, renamed or removed/i)).toBeTruthy()
  })
})

/**
 * Reachability, as a test.
 *
 * Elections management was written, fully tested, and wired to nothing: no route
 * mounted `ElectionDetail` and the officer's menu never linked to it, so an
 * officer could not create an election at all. Every unit test passed, because
 * each rendered its screen directly. These assertions are the cheapest thing that
 * would have caught it.
 */
describe('officer screens are reachable', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')

  it('mounts every officer screen on a route', () => {
    for (const screenName of ['Elections', 'RollImport', 'Exports', 'Settings', 'Result']) {
      expect(appSource, `${screenName} is never rendered`).toMatch(new RegExp(`<${screenName}\\b`))
    }
  })

  it('links the officer menu to each of them', () => {
    for (const path of ['/roll', '/elections', '/exports', '/settings', '/door']) {
      expect(appSource, `no link to ${path}`).toContain(`${path}\``)
    }
  })

  it('builds officer links from the slug, because the routes are /b/:slug', () => {
    // An earlier version built the result link from the batch id, which no route
    // matches — the sort of thing only an integration test or a human notices.
    const links = [...appSource.matchAll(/href=\{`([^`]+)`\}/g)].map((m) => m[1]!)
    for (const link of links.filter((l) => l.startsWith('/b/'))) {
      expect(link, `${link} should interpolate a slug`).toMatch(/^\/b\/\$\{[^}]*slug[^}]*\}/)
    }
  })
})
