import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { stub } from './helpers.js'
import { Landing } from '../src/screens/Landing.js'

afterEach(() => vi.unstubAllGlobals())

const society = {
  slug: 'scisoc', name: 'Science Society',
  branding: { title: 't', org_name: 'o', accent_color: '#000', logo_url: '' },
}

const show = (status: number, body: unknown) => {
  stub(status, body)
  renderRouted(<Landing />)
}

const logo = () => document.querySelector('img.society-logo')

describe('Landing', () => {
  it('offers registration, the only way a slug comes into existence, and no heading for an empty list', async () => {
    show(200, [])
    const register = await screen.findByRole('link', { name: /register a society/i })
    expect(register.getAttribute('href')).toBe('/new')
    expect(screen.queryByText(/societies using this system/i)).toBeNull()
  })

  it('lists societies, so nobody has to know a slug by heart, with no image for one without a logo', async () => {
    show(200, [society])
    // the whole card is the link, so its name carries the slug too
    const card = await screen.findByRole('link', { name: /Science Society/ })
    expect(card.getAttribute('href')).toBe('/b/scisoc')
    expect(logo()).toBeNull()
  })

  it('SHOWS A LOGO POINTED AT THE API, not at this app\'s own origin', async () => {
    // A stored logo_url is root-relative to the API, a different origin.
    show(200, [{ ...society, branding: { ...society.branding, logo_url: '/api/logos/batches/b1/abc.png' } }])
    await screen.findByRole('link', { name: /Science Society/ })
    expect(logo()?.getAttribute('src')).toBe('http://localhost:8787/api/logos/batches/b1/abc.png')
    // Decorative: the name is beside it, so a screen reader must not read it twice.
    expect(logo()?.getAttribute('alt')).toBe('')
  })

  it('reports a failure to load the list', async () => {
    show(500, { error: 'internal' })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
