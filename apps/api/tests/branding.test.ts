import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { setUp, JSON_HEADERS, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => { f = await setUp([]) })

const validBranding = {
  title: 'AGM 2026', org_name: 'Dalyell Society', accent_color: '#2563eb', logo_url: '',
}

const patch = (body: unknown, cookie = f.officerCookie) =>
  SELF.fetch(`https://example.com/api/batches/${f.batchId}/branding`, {
    method: 'PATCH', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify(body),
  })

const publicBranding = async () => {
  const res = await SELF.fetch('https://example.com/api/batches/by-slug/s')
  return (await res.json() as { branding: Record<string, unknown> }).branding
}

describe('branding', () => {
  it('requires an officer session', async () => {
    expect((await patch(validBranding, '')).status).toBe(401)
  })

  it('refuses a door session', async () => {
    expect((await patch(validBranding, f.doorCookie)).status).toBe(403)
  })

  it('updates the branding', async () => {
    const res = await patch(validBranding)
    expect(res.status).toBe(200)
    expect(await publicBranding()).toEqual(validBranding)
  })

  it('rejects a malformed accent colour', async () => {
    expect((await patch({ ...validBranding, accent_color: 'blue' })).status).toBe(400)
  })

  it('rejects a javascript: logo URL', async () => {
    // the same allow-list as sign-up, not a second copy
    expect((await patch({ ...validBranding, logo_url: 'javascript:alert(1)' })).status).toBe(400)
  })

  it('rejects a protocol-relative logo URL', async () => {
    expect((await patch({ ...validBranding, logo_url: '//evil.example/logo.png' })).status).toBe(400)
  })

  it('accepts the root-relative URL the logo upload returns', async () => {
    const res = await patch({ ...validBranding, logo_url: '/api/logos/batches/x/abc.png' })
    expect(res.status).toBe(200)
  })

  it('rejects a partial body rather than merging it', async () => {
    // PATCH replaces the whole object, so a partial body is refused.
    expect((await patch({ title: 'Only a title' })).status).toBe(400)
  })

  it('leaves the branding untouched when the body is rejected', async () => {
    await patch({ ...validBranding, accent_color: 'nope' })
    expect(await publicBranding()).toMatchObject({ title: 't' })
  })

  it('does not change another batch\'s branding', async () => {
    const other = await (await SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-super-admin-key': 'super-secret-test-key' },
      body: JSON.stringify({
        name: 'Other', slug: 'other', officer_password: 'officer-password-2', door_password: 'door-password-2',
        branding: { title: 'other-title', org_name: 'o', accent_color: '#111111', logo_url: '' },
      }),
    })).json() as { id: string }
    await patch(validBranding)
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/other')
    const body = await res.json() as { id: string; branding: { title: string } }
    expect(body.id).toBe(other.id)
    expect(body.branding.title).toBe('other-title')
  })
})
