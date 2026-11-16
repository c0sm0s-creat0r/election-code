import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { api, batchBody, setUpBatch } from './helpers.js'

let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie } = await setUpBatch())
  for (const obj of (await env.LOGOS.list()).objects) await env.LOGOS.delete(obj.key)
})

/** A minimal valid PNG: signature + IHDR. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00])
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
])
const text = (s: string) => new TextEncoder().encode(s)

const upload = (bytes: Uint8Array | null, filename = 'logo.png') => {
  const body = new FormData()
  // .slice() gives File a view over a plain ArrayBuffer, which BlobPart
  // requires under @cloudflare/workers-types.
  if (bytes) body.append('file', new File([bytes.slice()], filename))
  return SELF.fetch(`https://example.com/api/batches/${batchId}/logo`, {
    method: 'POST', headers: { cookie: officerCookie }, body,
  })
}

const urlOf = async (res: Response) => (await res.json() as { logo_url: string }).logo_url

describe('logo upload', () => {
  it('stores a PNG under the batch, points the branding at it, and audits no filename', async () => {
    const res = await upload(PNG, 'my-society-logo.png')
    expect(res.status).toBe(201)
    const url = await urlOf(res)
    // scoped to the batch, so one society cannot overwrite another
    expect(url).toMatch(new RegExp(`^/api/logos/batches/${batchId}/`))
    const { branding } = await (await api('GET', '/batches/by-slug/s')).json() as { branding: unknown }
    expect(branding).toEqual({ ...batchBody().branding, logo_url: url })
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'logo.upload'`)
      .first<{ detail: string | null }>()
    expect(row).toEqual({ detail: null })
  })

  it('accepts JPEG, GIF and WebP', async () => {
    for (const bytes of [JPEG, GIF, WEBP]) expect((await upload(bytes, 'logo.bin')).status).toBe(201)
  })

  it.each<[string, Uint8Array | null, string, number]>([
    ['bytes that are not an image, whatever the name', text('<script>alert(1)</script>'), 'logo.png', 400],
    ['an SVG, which is a script container', text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', 400],
    ['a file too short to identify', new Uint8Array([0x89, 0x50]), 'tiny.png', 400],
    ['a file that is too large', new Uint8Array(3 * 1024 * 1024), 'big.png', 413],
    ['a request with no file', null, '', 400],
  ])('rejects %s', async (_label, bytes, filename, status) => {
    expect((await upload(bytes, filename)).status).toBe(status)
    expect((await env.LOGOS.list()).objects).toHaveLength(0)
  })

  it('keys by content hash: the same bytes once, different bytes apart', async () => {
    const a = await urlOf(await upload(PNG, 'logo.png'))
    expect(await urlOf(await upload(PNG, 'renamed.png'))).toBe(a)
    expect((await env.LOGOS.list()).objects).toHaveLength(1)
    expect(await urlOf(await upload(JPEG, 'logo.png'))).not.toBe(a)
  })

  it('serves the object back with the stored type, never one the name or the request asks for', async () => {
    const url = await urlOf(await upload(JPEG, 'logo.png'))
    const res = await SELF.fetch(`https://example.com${url}`, { headers: { accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toMatch(/max-age=/)
    // Consume the body, or the open stream trips the pool's isolated storage.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
  })

  it('404s an unknown key', async () => {
    const res = await api('GET', '/logos/batches/x/nope.png')
    expect(res.status).toBe(404)
    await res.arrayBuffer()
  })
})
