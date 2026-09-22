import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { Landing } from '../src/screens/Landing.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

const societies = [
  { slug: 'scisoc', name: 'Science Society', branding: { title: 't', org_name: 'o', accent_color: '#000', logo_url: '' } },
]

describe('Landing', () => {
  it('offers registration, which is the only way a slug comes into existence', async () => {
    stub(200, [])
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByRole('link', { name: /register a society/i })).toBeTruthy())
    expect(screen.getByRole('link', { name: /register a society/i }).getAttribute('href')).toBe('/new')
  })

  it('lists societies, so nobody has to know a slug by heart', async () => {
    stub(200, societies)
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Science Society' })).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Science Society' }).getAttribute('href')).toBe('/b/scisoc')
  })

  it('SAYS THE LIST IS NOT AN ENDORSEMENT', async () => {
    // Registration is open and unverified, so the list must not read as vetting.
    stub(200, societies)
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByText(/not an endorsement/i)).toBeTruthy())
  })

  it('shows no list when there are none, rather than an empty heading', async () => {
    stub(200, [])
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByRole('link', { name: /register/i })).toBeTruthy())
    expect(screen.queryByText(/societies using this system/i)).toBeNull()
  })

  it('reports a failure to load the list', async () => {
    stub(500, { error: 'internal' })
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})
