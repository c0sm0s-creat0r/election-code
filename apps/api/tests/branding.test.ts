import { describe, it, expect, beforeEach } from 'vitest'
import { api, batchBody, postBatch, setUpBatch } from './helpers.js'

let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie } = await setUpBatch())
})

const valid = { title: 'AGM 2026', org_name: 'Dalyell Society', accent_color: '#2563eb', logo_url: '' }

const patch = (body: unknown) => api('PATCH', `/batches/${batchId}/branding`, officerCookie, body)
const brandingOf = async (slug: string) =>
  (await (await api('GET', `/batches/by-slug/${slug}`)).json() as { branding: Record<string, unknown> }).branding

describe('branding', () => {
  it('updates the branding, accepting the root-relative URL the logo upload returns', async () => {
    const body = { ...valid, logo_url: '/api/logos/batches/x/abc.png' }
    expect((await patch(body)).status).toBe(200)
    expect(await brandingOf('s')).toEqual(body)
  })

  // the same allow-list as sign-up, not a second copy
  it.each([
    ['a malformed accent colour', { ...valid, accent_color: 'blue' }],
    ['a javascript: logo URL', { ...valid, logo_url: 'javascript:alert(1)' }],
    ['a protocol-relative logo URL', { ...valid, logo_url: '//evil.example/logo.png' }],
    // PATCH replaces the whole object, so a partial body is refused, not merged
    ['a partial body', { title: 'Only a title' }],
  ])('rejects %s and leaves the branding untouched', async (_label, body) => {
    expect((await patch(body)).status).toBe(400)
    expect(await brandingOf('s')).toEqual(batchBody().branding)
  })

  it('does not change another batch\'s branding', async () => {
    await postBatch(batchBody('other', 2))
    await patch(valid)
    expect(await brandingOf('other')).toEqual(batchBody().branding)
  })
})
