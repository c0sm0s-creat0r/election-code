import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { setUp, type Fixture } from './helpers.js'

let f: Fixture

beforeEach(async () => {
  f = await setUp([])
  for (const obj of (await env.LOGOS.list()).objects) await env.LOGOS.delete(obj.key)
})

/** A minimal but genuine PNG: signature + IHDR. */
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

const upload = (bytes: Uint8Array, filename: string, cookie = f.officerCookie) => {
  const body = new FormData()
  // .slice() hands File a view whose buffer is a plain ArrayBuffer, which is
  // what BlobPart requires under @cloudflare/workers-types.
  body.append('file', new File([bytes.slice()], filename))
  return SELF.fetch(`https://example.com/api/batches/${f.batchId}/logo`, {
    method: 'POST', headers: { cookie }, body,
  })
}

const urlOf = async (res: Response) => (await res.json() as { logo_url: string }).logo_url

describe('logo upload', () => {
  it('REQUIRES AN OFFICER SESSION — the legacy route had none', async () => {
    expect((await upload(PNG, 'logo.png', '')).status).toBe(401)
    expect((await upload(PNG, 'logo.png', f.doorCookie)).status).toBe(403)
  })

  it('accepts a real PNG', async () => {
    const res = await upload(PNG, 'logo.png')
    expect(res.status).toBe(201)
    expect(await urlOf(res)).toMatch(/^\/api\/logos\/batches\//)
  })

  it('accepts JPEG, GIF and WebP', async () => {
    for (const bytes of [JPEG, GIF, WEBP]) {
      expect((await upload(bytes, 'logo.bin')).status).toBe(201)
    }
  })

  it('REJECTS A FILE WHOSE BYTES ARE NOT AN IMAGE, whatever it is named', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>')
    expect((await upload(html, 'logo.png')).status).toBe(400)
  })

  it('rejects an SVG, which is a script container, however it is named', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await upload(svg, 'logo.svg')).status).toBe(400)
  })

  it('rejects a file too short to identify', async () => {
    expect((await upload(new Uint8Array([0x89, 0x50]), 'tiny.png')).status).toBe(400)
  })

  it('rejects a file that is too large', async () => {
    expect((await upload(new Uint8Array(3 * 1024 * 1024), 'big.png')).status).toBe(413)
  })

  it('keys by content hash, so two societies do not collide', async () => {
    const a = await urlOf(await upload(PNG, 'logo.png'))
    const b = await urlOf(await upload(JPEG, 'logo.png'))
    expect(a).not.toBe(b)
  })

  it('is idempotent for the same bytes', async () => {
    const a = await urlOf(await upload(PNG, 'logo.png'))
    const b = await urlOf(await upload(PNG, 'renamed.png'))
    expect(a).toBe(b)
    expect((await env.LOGOS.list()).objects).toHaveLength(1)
  })

  it('scopes the key to the batch, so one society cannot overwrite another', async () => {
    const url = await urlOf(await upload(PNG, 'logo.png'))
    expect(url).toContain(f.batchId)
  })

  it('serves the object back with its real content type', async () => {
    const url = await urlOf(await upload(PNG, 'logo.png'))
    const res = await SELF.fetch(`https://example.com${url}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toMatch(/max-age=/)
    // The route streams R2's body rather than buffering it, so the body has to
    // be consumed here: an open stream outlives the test and trips the pool's
    // isolated-storage stack.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('serves the stored type, never one the request asks for', async () => {
    const url = await urlOf(await upload(JPEG, 'logo.png'))
    const res = await SELF.fetch(`https://example.com${url}`, { headers: { accept: 'text/html' } })
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    await res.arrayBuffer()
  })

  it('updates the batch branding to point at it', async () => {
    const url = await urlOf(await upload(PNG, 'logo.png'))
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/s')
    const body = await res.json() as { branding: { logo_url: string } }
    expect(body.branding.logo_url).toBe(url)
  })

  it('keeps the rest of the branding intact', async () => {
    await upload(PNG, 'logo.png')
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/s')
    const body = await res.json() as { branding: { accent_color: string; title: string } }
    expect(body.branding.accent_color).toBe('#000000')
    expect(body.branding.title).toBe('t')
  })

  it('404s an unknown key', async () => {
    const res = await SELF.fetch('https://example.com/api/logos/batches/x/nope.png')
    expect(res.status).toBe(404)
    await res.arrayBuffer()
  })

  it('rejects a request with no file', async () => {
    const res = await SELF.fetch(`https://example.com/api/batches/${f.batchId}/logo`, {
      method: 'POST', headers: { cookie: f.officerCookie }, body: new FormData(),
    })
    expect(res.status).toBe(400)
  })

  it('records the upload in the audit log with no filename', async () => {
    await upload(PNG, 'my-society-logo.png')
    const row = await env.DB.prepare(`SELECT detail FROM audit_log WHERE action = 'logo.upload'`)
      .first<{ detail: string | null }>()
    expect(row).toBeTruthy()
    expect(row!.detail).toBeNull()
  })
})
