/**
 * The operator screen. Most of these tests are about what it refuses to do.
 *
 * The screen holds the one credential that can mint an officer session for every
 * society in the system, and drives the only route that can destroy a sealed
 * result. So the assertions worth having are: the key is never written anywhere,
 * the slug has to be typed back, and the request carries both.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { Operator } from '../src/screens/Operator.js'
import { renderRouted } from './renderOfficer.js'

afterEach(() => vi.unstubAllGlobals())

const branding = { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' }
const societies = [
  { slug: 'scisoc', name: 'Science Society', branding },
  { slug: 'artsoc', name: 'Arts Society', branding },
]

type Call = { url: string; init?: RequestInit }

/**
 * Routes the three calls the screen makes: the list, the by-slug lookup that
 * turns a slug into an id, and the delete itself.
 */
const stubApi = (deleteStatus = 204) => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('by-slug')) {
      return new Response(JSON.stringify({ id: 'b-sci', slug: 'scisoc', name: 'Science Society', branding }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (init?.method === 'DELETE') {
      return new Response(deleteStatus === 204 ? null : JSON.stringify({ error: 'unauthorized' }), {
        status: deleteStatus, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(societies), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

const beginDeleting = async (name = 'Science Society') => {
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy())
  const row = screen.getByText(name).closest('li')!
  fireEvent.click(row.querySelector('button')!)
}

const typeKey = (key: string) =>
  fireEvent.change(screen.getByLabelText(/operator key/i), { target: { value: key } })

const typeSlug = (slug: string) =>
  fireEvent.change(screen.getByLabelText(/^slug$/i), { target: { value: slug } })

const deleteButton = () => screen.getByRole('button', { name: /delete permanently/i })

describe('Operator', () => {
  it('says what deleting a society destroys, before anything is clicked', async () => {
    stubApi()
    renderRouted(<Operator />)
    expect(screen.getByText(/destroys its roll/i)).toBeTruthy()
    expect(screen.getByText(/sealed results/i)).toBeTruthy()
  })

  it('WILL NOT DELETE UNTIL THE SLUG IS TYPED BACK', async () => {
    // The id is a UUID nobody proofreads. Typing the slug is what makes deleting
    // the wrong society take more than one click.
    stubApi()
    renderRouted(<Operator />)
    typeKey('operator-key')
    await beginDeleting()
    expect(deleteButton()).toHaveProperty('disabled', true)

    typeSlug('artsoc')
    expect(deleteButton()).toHaveProperty('disabled', true)

    typeSlug('scisoc')
    expect(deleteButton()).toHaveProperty('disabled', false)
  })

  it('will not delete without a key', async () => {
    stubApi()
    renderRouted(<Operator />)
    await beginDeleting()
    typeSlug('scisoc')
    expect(deleteButton()).toHaveProperty('disabled', true)
  })

  it('sends the key as a header and the slug in the body', async () => {
    const calls = stubApi()
    renderRouted(<Operator />)
    typeKey('operator-key')
    await beginDeleting()
    typeSlug('scisoc')
    fireEvent.click(deleteButton())

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true))
    const del = calls.find((call) => call.init?.method === 'DELETE')!
    expect(del.url).toContain('/api/batches/b-sci')
    expect((del.init!.headers as Record<string, string>)['x-super-admin-key']).toBe('operator-key')
    expect(del.init!.body).toBe(JSON.stringify({ confirm_slug: 'scisoc' }))
  })

  it('NEVER PUTS THE KEY IN BROWSER STORAGE, or in the URL', async () => {
    // It is the credential that can reach every society. It is typed when used
    // and gone when the tab closes.
    const writes: string[] = []
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: (key: string) => { writes.push(key) },
      removeItem: () => {},
      clear: () => {},
    })
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: (key: string) => { writes.push(key) },
      removeItem: () => {},
      clear: () => {},
    })
    const calls = stubApi()
    renderRouted(<Operator />)
    typeKey('operator-key')
    await beginDeleting()
    typeSlug('scisoc')
    fireEvent.click(deleteButton())
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(true))

    expect(writes).toEqual([])
    expect(window.location.search).not.toContain('operator-key')
  })

  it('offers the key in a password field, not in plain sight', async () => {
    stubApi()
    renderRouted(<Operator />)
    expect(screen.getByLabelText(/operator key/i).getAttribute('type')).toBe('password')
  })

  it('takes the society off the list and says so', async () => {
    stubApi()
    renderRouted(<Operator />)
    typeKey('operator-key')
    await beginDeleting()
    typeSlug('scisoc')
    fireEvent.click(deleteButton())

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/is gone/i))
    expect(screen.queryByText('Science Society')).toBeNull()
    expect(screen.getByText('Arts Society')).toBeTruthy()
  })

  it('says plainly when the key is refused, and keeps the society listed', async () => {
    stubApi(401)
    renderRouted(<Operator />)
    typeKey('wrong-key')
    await beginDeleting()
    typeSlug('scisoc')
    fireEvent.click(deleteButton())

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not accepted/i))
    expect(screen.getByText('Science Society')).toBeTruthy()
  })

  it('cancels back out without deleting anything', async () => {
    const calls = stubApi()
    renderRouted(<Operator />)
    typeKey('operator-key')
    await beginDeleting()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(screen.queryByLabelText(/^slug$/i)).toBeNull()
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
  })
})
