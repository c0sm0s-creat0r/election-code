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
    // The whole card is the link — a bare name is a small target inside a much
    // larger row that does nothing — so its name carries the slug too.
    await waitFor(() => expect(screen.getByRole('link', { name: /Science Society/ })).toBeTruthy())
    expect(screen.getByRole('link', { name: /Science Society/ }).getAttribute('href')).toBe('/b/scisoc')
  })

  it('SHOWS A LOGO POINTED AT THE API, not at this app\'s own origin', async () => {
    // A stored logo_url is root-relative to the API, which in production is a
    // different host. Rendering it as-is 404s silently.
    stub(200, [{
      ...societies[0]!,
      branding: { ...societies[0]!.branding, logo_url: '/api/logos/batches/b1/abc.png' },
    }])
    renderRouted(<Landing />)
    await waitFor(() => expect(document.querySelector('img.society-logo')).toBeTruthy())
    expect(document.querySelector('img.society-logo')!.getAttribute('src'))
      .toBe('http://localhost:8787/api/logos/batches/b1/abc.png')
    // Decorative: the name is right beside it, so a reader must not hear it twice.
    expect(document.querySelector('img.society-logo')!.getAttribute('alt')).toBe('')
  })

  it('renders no image for a society without a logo', async () => {
    stub(200, societies)
    renderRouted(<Landing />)
    await waitFor(() => expect(screen.getByRole('link', { name: /Science Society/ })).toBeTruthy())
    expect(document.querySelector('img.society-logo')).toBeNull()
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
