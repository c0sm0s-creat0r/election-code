import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  fireEvent.change(screen.getByLabelText(/door password/i), { target: { value: over.door ?? 'door-password-1' } })
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /register society/i }))

describe('SignUp', () => {
  it('SAYS PLAINLY that nothing verifies who you are', () => {
    render(<SignUp />)
    expect(screen.getByText(/nothing here checks who you are/i)).toBeTruthy()
  })

  it('suggests a slug from the name, so nobody has to guess the rules', () => {
    render(<SignUp />)
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Science Society!' } })
    expect((screen.getByLabelText(/web address/i) as HTMLInputElement).value).toBe('science-society')
  })

  it('lets the slug be overridden and then stops tracking the name', () => {
    render(<SignUp />)
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
    render(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText(/is registered/i)).toBeTruthy())
    const headers = (spy.mock.calls[0]![1]!.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-super-admin-key')
  })

  it('TELLS THEM THE PASSWORDS CANNOT BE RECOVERED', async () => {
    stub(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: {} })
    render(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText(/cannot be recovered/i)).toBeTruthy())
  })

  it('shows all three URLs afterwards', async () => {
    stub(201, { id: 'b1', slug: 'science-society', name: 'Science Society', branding: {} })
    render(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByText('/b/science-society')).toBeTruthy())
    expect(screen.getByText('/b/science-society/door')).toBeTruthy()
    expect(screen.getByText('/science-society')).toBeTruthy()
  })

  it('will not submit a password under the floor', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    render(<SignUp />)
    fill({ officer: 'short' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('REFUSES the same password for both roles', () => {
    // The door password is typed on volunteers' phones. Reusing the officer
    // password there hands full control to anyone at the desk.
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    render(<SignUp />)
    fill({ officer: 'same-password-1', door: 'same-password-1' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('will not submit a malformed slug', () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    render(<SignUp />)
    fill({ slug: 'Not A Slug' })
    submit()
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports a taken slug from the server', async () => {
    stub(409, { error: 'slug already exists' })
    render(<SignUp />)
    fill()
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/i))
  })

  it('reports a reserved slug from the server', async () => {
    stub(400, { error: 'that name is reserved — please choose another' })
    render(<SignUp />)
    fill({ slug: 'admin' })
    submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/reserved/i))
  })
})
