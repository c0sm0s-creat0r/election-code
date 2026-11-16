/**
 * The operator screen. The key is never written anywhere, the slug must be
 * typed back, and the request carries both.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { Operator } from '../src/screens/Operator.js'
import { renderRouted } from './renderOfficer.js'
import { json, spyOnStorage, stubFetch } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const branding = { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' }
const societies = [
  { slug: 'scisoc', name: 'Science Society', branding },
  { slug: 'artsoc', name: 'Arts Society', branding },
]

/** Routes the screen's three calls (the list, the by-slug lookup, the delete) and renders. */
const show = (deleteStatus = 204) => {
  const spy = stubFetch((url, init) => {
    if (url.includes('by-slug')) return json(200, { id: 'b-sci', ...societies[0] })
    if (init?.method === 'DELETE') {
      return json(deleteStatus, deleteStatus === 204 ? null : { error: 'unauthorized' })
    }
    return json(200, societies)
  })
  renderRouted(<Operator />)
  return () => spy.mock.calls.find(([, init]) => init?.method === 'DELETE')
}

const beginDeleting = async () => {
  const row = (await screen.findByText('Science Society')).closest('li')!
  fireEvent.click(row.querySelector('button')!)
}

const keyField = () => screen.getByLabelText(/operator key/i)
const typeKey = (key: string) => fireEvent.change(keyField(), { target: { value: key } })
const typeSlug = (slug: string) =>
  fireEvent.change(screen.getByLabelText(/^slug$/i), { target: { value: slug } })
const deleteButton = () => screen.getByRole('button', { name: /delete permanently/i })

/** The whole path to a delete request, with a good slug. */
const deleteScisoc = async (key: string) => {
  typeKey(key)
  await beginDeleting()
  typeSlug('scisoc')
  fireEvent.click(deleteButton())
}

describe('Operator', () => {
  it('says what deleting destroys before anything is clicked, and takes the key in a password field', () => {
    show()
    expect(screen.getByText(/destroys its roll/i)).toBeTruthy()
    expect(screen.getByText(/sealed results/i)).toBeTruthy()
    expect(keyField().getAttribute('type')).toBe('password')
  })

  it('WILL NOT DELETE without a key, or UNTIL THE SLUG IS TYPED BACK', async () => {
    show()
    await beginDeleting()
    typeSlug('scisoc')
    expect(deleteButton()).toHaveProperty('disabled', true)

    typeKey('operator-key')
    expect(deleteButton()).toHaveProperty('disabled', false)

    typeSlug('artsoc')
    expect(deleteButton()).toHaveProperty('disabled', true)
  })

  it('sends the key as a header and the slug in the body, then takes the society off the list', async () => {
    const deleteCall = show()
    await deleteScisoc('operator-key')

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/is gone/i))
    const [url, init] = deleteCall()!
    expect(url).toContain('/api/batches/b-sci')
    expect((init!.headers as Record<string, string>)['x-super-admin-key']).toBe('operator-key')
    expect(init!.body).toBe(JSON.stringify({ confirm_slug: 'scisoc' }))
    expect(screen.queryByText('Science Society')).toBeNull()
    expect(screen.getByText('Arts Society')).toBeTruthy()
  })

  it('NEVER PUTS THE KEY IN BROWSER STORAGE, or in the URL', async () => {
    // the key is typed when used and gone when the tab closes
    const writes = spyOnStorage()
    const deleteCall = show()
    await deleteScisoc('operator-key')
    await waitFor(() => expect(deleteCall()).toBeTruthy())

    expect(writes).not.toHaveBeenCalled()
    expect(window.location.search).not.toContain('operator-key')
  })

  it('says plainly when the key is refused, and keeps the society listed', async () => {
    show(401)
    await deleteScisoc('wrong-key')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not accepted/i))
    expect(screen.getByText('Science Society')).toBeTruthy()
  })

  it('cancels back out without deleting anything', async () => {
    const deleteCall = show()
    typeKey('operator-key')
    await beginDeleting()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(screen.queryByLabelText(/^slug$/i)).toBeNull()
    expect(deleteCall()).toBeUndefined()
  })
})
