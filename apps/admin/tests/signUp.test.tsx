import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { SignUp } from '../src/screens/SignUp.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

const fill = (over: Partial<Record<'name' | 'officer' | 'door' | 'slug', string>> = {}) => {
  fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: over.name ?? 'Science Society' } })
  if (over.slug !== undefined) {
    fireEvent.change(screen.getByLabelText(/web address/i), { target: { value: over.slug } })
  }
  fireEvent.change(screen.getByLabelText(/officer password/i), { target: { value: over.officer ?? 'officer-password-1' } })
  fireEvent.change(screen.getByLabelText(/check-in desk password/i), { target: { value: over.door ?? 'door-password-1' } })
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /register society/i }))

describe('SignUp', () => {
  it('suggests a slug from the name, so nobody has to guess the rules', () => {
    renderRouted(<SignUp />)
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Science Society!' } })
    expect((screen.getByLabelText(/web address/i) as HTMLInputElement).value).toBe('science-society')
  })

  it('lets the slug be overridden and then stops tracking the name', () => {
    renderRouted(<SignUp />)
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Science Society' } })
    fireEvent.change(screen.getByLabelText(/web address/i), { target: { value: 'scisoc' } })
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Science Society 2026' } })
    expect((screen.getByLabelText(/web address/i) as HTMLInputElement).value).toBe('scisoc')
  })

  it('registers a society and never asks for a key', async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'b1', slug: 'science-society', name: 'Science Society', branding: {} }), {
        status: 201, headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', spy)
    renderRouted(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText(/is registered/i)).toBeTruthy())
    const headers = (spy.mock.calls[0]![1]!.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-super-admin-key')
  })

  it('TELLS THEM TO WRITE THE PASSWORDS DOWN', async () => {
    stub(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: {} })
    renderRouted(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText(/written down your passwords/i)).toBeTruthy())
  })

  it('shows all three URLs afterwards', async () => {
    stub(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: {} })
    renderRouted(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText('/b/science-society')).toBeTruthy())
    expect(screen.getByText('/b/science-society/door')).toBeTruthy()
    expect(screen.getByText('/science-society')).toBeTruthy()
  })

  it('will not submit a password under the floor', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    renderRouted(<SignUp />)
    fill({ officer: 'short' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('REFUSES the same password for both roles', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    renderRouted(<SignUp />)
    fill({ officer: 'same-password-1', door: 'same-password-1' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('will not submit a malformed slug', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    renderRouted(<SignUp />)
    fill({ slug: 'Not A Slug' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports a taken slug from the server', async () => {
    stub(409, { error: 'slug already exists' })
    renderRouted(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/i))
  })

  it('reports a reserved slug from the server', async () => {
    stub(400, { error: 'that name is reserved — please choose another' })
    renderRouted(<SignUp />)
    fill({ slug: 'admin' })
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reserved/i))
  })

  it('UPLOADS THE LOGO after registering, signed in as the new officer', async () => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const spy = vi.fn(async (url: string) => {
      if (url.endsWith('/api/batches')) return json(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' } })
      if (url.endsWith('/officer/session')) return json(200, { ok: true, role: 'officer' })
      return json(201, { logo_url: '/api/logos/batches/b1/abc.png' })
    })
    vi.stubGlobal('fetch', spy)
    renderRouted(<SignUp />)
    fill()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(/logo/i), { target: { files: [file] } })
    submit()
    await waitFor(() => expect(screen.getByText(/is registered/i)).toBeTruthy())
    const urls = spy.mock.calls.map((call) => String(call[0]))
    expect(urls.map((u) => u.replace(/^.*\/api/, '/api'))).toEqual([
      '/api/batches', '/api/batches/b1/officer/session', '/api/batches/b1/logo',
    ])
    expect(document.querySelector('img.society-logo')!.getAttribute('src')).toMatch(/\/api\/logos\/batches\/b1\/abc\.png$/)
  })

  it('STILL SHOWS THE PASSWORDS when the logo is refused, because the society exists', async () => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/batches')) return json(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' } })
      if (url.endsWith('/officer/session')) return json(200, { ok: true, role: 'officer' })
      return json(400, { error: 'that file is not a PNG, JPEG, GIF or WebP image', code: 'not_an_image' })
    }))
    renderRouted(<SignUp />)
    fill()
    fireEvent.change(screen.getByLabelText(/logo/i), { target: { files: [new File(['nope'], 'x.png')] } })
    submit()
    await waitFor(() => expect(screen.getByText(/written down your passwords/i)).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/logo was not/i)
    expect(document.querySelector('img.society-logo')).toBeNull()
  })
})
