import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { json, stub, stubFetch } from './helpers.js'
import { SignUp } from '../src/screens/SignUp.js'

afterEach(() => vi.unstubAllGlobals())

const made = {
  id: 'b1', slug: 'science-society', name: 'Science Society',
  branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
}

type Fields = Partial<Record<'name' | 'officer' | 'door' | 'slug', string>>

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const slugField = () => screen.getByLabelText(/web address/i) as HTMLInputElement

/** Renders, fills the form and submits it. */
const register = (over: Fields = {}, logo?: File) => {
  renderRouted(<SignUp />)
  type(/society name/i, over.name ?? 'Science Society')
  if (over.slug !== undefined) type(/web address/i, over.slug)
  type(/officer password/i, over.officer ?? 'officer-password-1')
  type(/check-in desk password/i, over.door ?? 'door-password-1')
  if (logo) fireEvent.change(screen.getByLabelText(/logo/i), { target: { files: [logo] } })
  fireEvent.click(screen.getByRole('button', { name: /register society/i }))
}

/** Registration and the officer sign-in succeed. `logo` answers the upload. */
const stubWithLogo = (logo: Response) =>
  stubFetch((url) => {
    if (url.endsWith('/api/batches')) return json(201, made)
    if (url.endsWith('/officer/session')) return json(200, { ok: true, role: 'officer' })
    return logo
  })

describe('SignUp', () => {
  it('suggests a slug from the name, and stops tracking the name once the slug is overridden', () => {
    renderRouted(<SignUp />)
    type(/society name/i, 'Science Society!')
    expect(slugField().value).toBe('science-society')
    type(/web address/i, 'scisoc')
    type(/society name/i, 'Science Society 2026')
    expect(slugField().value).toBe('scisoc')
  })

  it('registers without asking for a key, shows all three URLs, and SAYS TO WRITE THE PASSWORDS DOWN', async () => {
    const spy = stub(201, made)
    register()
    await screen.findByText(/is registered/i)
    const headers = (spy.mock.calls[0]![1]!.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-super-admin-key')
    expect(screen.getByText(/written down your passwords/i)).toBeTruthy()
    for (const url of ['/b/science-society', '/b/science-society/door', '/science-society']) {
      expect(screen.getByText(url)).toBeTruthy()
    }
  })

  it.each<[string, Fields]>([
    ['a password under the floor', { officer: 'short' }],
    ['the same password for both roles', { officer: 'same-password-1', door: 'same-password-1' }],
    ['a malformed slug', { slug: 'Not A Slug' }],
  ])('REFUSES %s without a request', (_what, over) => {
    const spy = stub(201, made)
    register(over)
    expect(spy).not.toHaveBeenCalled()
  })

  it.each([
    [409, 'slug already exists'],
    [400, 'that name is reserved — please choose another'],
  ])('shows the server\'s reason for a %i', async (status, error) => {
    stub(status, { error })
    register()
    expect((await screen.findByRole('alert')).textContent).toContain(error)
  })

  it('UPLOADS THE LOGO after registering, signed in as the new officer', async () => {
    const spy = stubWithLogo(json(201, { logo_url: '/api/logos/batches/b1/abc.png' }))
    register({}, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }))
    await screen.findByText(/is registered/i)
    expect(spy.mock.calls.map(([url]) => url.replace(/^.*\/api/, '/api'))).toEqual([
      '/api/batches', '/api/batches/b1/officer/session', '/api/batches/b1/logo',
    ])
    expect(document.querySelector('img.society-logo')!.getAttribute('src'))
      .toMatch(/\/api\/logos\/batches\/b1\/abc\.png$/)
  })

  it('STILL SHOWS THE PASSWORDS when the logo is refused, because the society exists', async () => {
    stubWithLogo(json(400, { error: 'that file is not a PNG, JPEG, GIF or WebP image', code: 'not_an_image' }))
    register({}, new File(['nope'], 'x.png'))
    await waitFor(() => expect(screen.getByText(/written down your passwords/i)).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/logo was not/i)
    expect(document.querySelector('img.society-logo')).toBeNull()
  })
})
