import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env, applyD1Migrations } from 'cloudflare:test'

const KEY = 'super-secret-test-key'

beforeEach(async () => {
  // The brief's literal snippet imports the migration as a raw SQL string via
  // `?raw` and passes it to applyD1Migrations; that fails at runtime with
  // "parameter 2 is not of type 'D1Migration[]'" (confirmed when this test was
  // first run). Per the task context notes and tests/schema.test.ts, migrations
  // must go through the TEST_MIGRATIONS binding that vitest.config.ts builds
  // with readD1Migrations() on the Node side.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('DELETE FROM audit_log').run()
  await env.DB.prepare('DELETE FROM batch').run()
})

const create = (body: unknown, key?: string) =>
  SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-super-admin-key': key } : {}) },
    body: JSON.stringify(body),
  })

const valid = {
  name: 'SciSoc AGM 2026', slug: 'scisoc-2026',
  officer_password: 'officer-password-1', door_password: 'door-password-1',
  branding: { title: 'Executive Elections', org_name: 'SciSoc', accent_color: '#2563eb', logo_url: '' },
}

describe('POST /api/batches', () => {
  it('ALLOWS creation with no key — societies sign themselves up', async () => {
    // Reversed deliberately on 2026-09-22. This endpoint required the
    // super-admin key until then, and spec §1 listed self-serve signup as a
    // non-goal; both were overridden. The key is still honoured when offered
    // (see the next test), so a wrong one is still an operator attempt.
    expect((await create(valid)).status).toBe(201)
  })

  it('refuses a wrong super admin key', async () => {
    expect((await create(valid, 'wrong')).status).toBe(401)
  })

  it('creates a batch with the key', async () => {
    const res = await create(valid, KEY)
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; slug: string }
    expect(body.slug).toBe('scisoc-2026')
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('never returns a password or a hash', async () => {
    const text = await (await create(valid, KEY)).text()
    expect(text).not.toContain('officer-password-1')
    expect(text).not.toContain('door-password-1')
    expect(text).not.toContain('pbkdf2')
  })

  it('stores hashes, not plaintext', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare('SELECT officer_hash, door_hash FROM batch').first<{ officer_hash: string; door_hash: string }>()
    expect(row!.officer_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.door_hash).toMatch(/^pbkdf2-sha256\$/)
    expect(row!.officer_hash).not.toBe(row!.door_hash)
  })

  it('rejects a duplicate slug', async () => {
    await create(valid, KEY)
    expect((await create(valid, KEY)).status).toBe(409)
  })

  it('rejects a missing field with 400', async () => {
    expect((await create({ name: 'x' }, KEY)).status).toBe(400)
  })

  it('audits a DENIED super-admin-key attempt, with a null batch_id', async () => {
    // The highest-privileged action in the system, and the direct descendant
    // of the legacy unauthenticated tenant-creation endpoint. batch_id is
    // NULL because no batch exists to attribute the attempt to.
    expect((await create(valid, 'wrong')).status).toBe(401)
    const row = await env.DB.prepare(`SELECT batch_id, role, action, detail FROM audit_log`)
      .first<{ batch_id: string | null; role: string; action: string; detail: string | null }>()
    expect(row).toEqual({ batch_id: null, role: 'super', action: 'batch.create.denied', detail: null })
  })

  it('does NOT record a denial when no key was offered, because none is needed', async () => {
    expect((await create(valid)).status).toBe(201)
    const { results } = await env.DB.prepare(`SELECT id FROM audit_log WHERE action = 'batch.create.denied'`).all()
    expect(results).toHaveLength(0)
  })

  it('never records the supplied key, or any prefix of it, in the audit row', async () => {
    // A near-miss guess written into `detail` is a credential sitting in a
    // table officers and exports can read.
    const guess = 'super-secret-test-kex'
    await create(valid, guess)
    const row = await env.DB.prepare(`SELECT detail FROM audit_log`).first<{ detail: string | null }>()
    expect(row?.detail).toBeNull()
    const all = JSON.stringify(
      (await env.DB.prepare(`SELECT * FROM audit_log`).all()).results,
    )
    expect(all).not.toContain(guess)
    expect(all).not.toContain(guess.slice(0, 6))
  })

  it('writes an audit_log row', async () => {
    await create(valid, KEY)
    const row = await env.DB.prepare(`SELECT role, action FROM audit_log`).first<{ role: string; action: string }>()
    expect(row).toEqual({ role: 'super', action: 'batch.create' })
  })

  it('writes exactly one audit row per successful create — never zero, never more than one', async () => {
    await create(valid, KEY)
    const { results } = await env.DB.prepare(`SELECT id FROM audit_log`).all()
    expect(results).toHaveLength(1)
  })

  it('leaves no audit_log row behind when the batch insert fails (duplicate slug)', async () => {
    // Regression check on the insert-fails path: a duplicate slug throws
    // before either statement in db.batch([insert, audit]) commits, so no
    // audit row should appear. Note this does not by itself discriminate
    // the atomicity fix from the pre-fix code, since the old code also
    // returned 409 before ever calling recordAudit on this path — see the
    // task report for the failure mode this doesn't cover (the audit write
    // failing *after* a successful insert), which was not cleanly
    // inducible from the HTTP boundary.
    await create(valid, KEY)
    const dup = await create(valid, KEY)
    expect(dup.status).toBe(409)
    const { results } = await env.DB.prepare(`SELECT id FROM audit_log`).all()
    expect(results).toHaveLength(1)
  })
})

describe('POST /api/batches validation', () => {
  const withSlug = (slug: string) => create({ ...valid, slug }, KEY)
  const withBranding = (branding: Partial<typeof valid.branding>) =>
    create({ ...valid, branding: { ...valid.branding, ...branding } }, KEY)

  it('rejects a slug containing a path separator', async () => {
    expect((await withSlug('scisoc/2026')).status).toBe(400)
  })

  it('rejects a slug containing ..', async () => {
    expect((await withSlug('../etc')).status).toBe(400)
  })

  it('rejects an uppercase or spaced slug rather than normalising it', async () => {
    expect((await withSlug('SciSoc 2026')).status).toBe(400)
  })

  it('accepts a lowercase hyphenated slug', async () => {
    expect((await withSlug('scisoc-agm-2026')).status).toBe(201)
  })

  it('rejects a non-hex accent_color', async () => {
    expect((await withBranding({ accent_color: 'blue' })).status).toBe(400)
  })

  it('accepts the fixture hex accent_color', async () => {
    expect((await withBranding({ accent_color: '#2563eb' })).status).toBe(201)
  })

  it('rejects a javascript: logo_url', async () => {
    expect((await withBranding({ logo_url: 'javascript:alert(1)' })).status).toBe(400)
  })

  it('rejects a data: logo_url', async () => {
    expect((await withBranding({ logo_url: 'data:image/png;base64,AAAA' })).status).toBe(400)
  })

  it('rejects a non-https logo_url', async () => {
    expect((await withBranding({ logo_url: 'http://insecure.example/logo.png' })).status).toBe(400)
  })

  it('accepts an https logo_url', async () => {
    expect((await withBranding({ logo_url: 'https://example.com/logo.png' })).status).toBe(201)
  })

  it('accepts a root-relative logo_url', async () => {
    expect((await withBranding({ logo_url: '/logo.png' })).status).toBe(201)
  })

  it('rejects a protocol-relative logo_url (//evil.com)', async () => {
    // The root-relative branch must not admit a scheme-relative URL that
    // browsers resolve off-origin.
    expect((await withBranding({ logo_url: '//evil.com/logo.png' })).status).toBe(400)
  })

  it('rejects a backslash-prefixed logo_url (/\\evil.com)', async () => {
    // Some browsers treat a leading backslash as a path separator too,
    // making "/\\evil.com" behave like "//evil.com".
    expect((await withBranding({ logo_url: '/\\evil.com' })).status).toBe(400)
  })

  it('accepts the empty-string logo_url used by the fixture ("no logo")', async () => {
    expect((await withBranding({ logo_url: '' })).status).toBe(201)
  })

  // PBKDF2 at 210k iterations buys a constant factor; it does not rescue a
  // one-character door password, which is typed on a volunteer's phone in a
  // public room and chosen in a hurry.
  const withPasswords = (officer: string, door: string) =>
    create({ ...valid, officer_password: officer, door_password: door }, KEY)

  it('rejects a one-character door password', async () => {
    expect((await withPasswords('officer-password-1', 'x')).status).toBe(400)
  })

  it('rejects a one-character officer password', async () => {
    expect((await withPasswords('x', 'door-password-1')).status).toBe(400)
  })

  it('rejects an 11-character password but accepts 12', async () => {
    expect((await withPasswords('a'.repeat(11), 'door-password-1')).status).toBe(400)
    expect((await withPasswords('a'.repeat(12), 'b'.repeat(12))).status).toBe(201)
  })

  it('refuses a short password without echoing it back', async () => {
    // The 400 body is a fixed literal; the Zod message stays server-side so
    // nothing the caller typed is reflected.
    const res = await withPasswords('short', 'door-password-1')
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('short')
  })
})

describe('DB.batch() atomicity (carried from Task 5 review)', () => {
  // Task 5 made the batch insert and its audit write atomic via db.batch(),
  // but no test exercised the real failure direction: a second statement in
  // the same batch failing *after* a first statement that would otherwise
  // have succeeded. This is the primitive spec §2 also relies on for the
  // ballot/receipt pair, so it is worth pinning directly rather than only
  // through the HTTP-level duplicate-slug case (which fails *before* either
  // statement runs).
  it('rolls back a successful batch insert when a later statement in the same db.batch() fails', async () => {
    await expect(
      env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO batch (id,slug,name,officer_hash,door_hash,branding,created_at)
             VALUES ('atomicity-1','atomicity-1','n','x','y','{}',1)`,
          ),
        env.DB.prepare(`INSERT INTO nonexistent_table (x) VALUES (1)`),
      ]),
    ).rejects.toThrow()

    const row = await env.DB.prepare(`SELECT count(*) AS n FROM batch`).first<{ n: number }>()
    expect(row!.n).toBe(0)
  })
})

describe('public batch listing', () => {
  it('returns slug and branding only — never a hash', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches')
    expect(res.status).toBe(200)
    const list = await res.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['branding', 'name', 'slug'])
  })

  it('looks a batch up by slug', async () => {
    await create(valid, KEY)
    const res = await SELF.fetch('https://example.com/api/batches/by-slug/scisoc-2026')
    expect(res.status).toBe(200)
    const b = await res.json() as Record<string, unknown>
    expect(Object.keys(b).sort()).toEqual(['branding', 'id', 'name', 'slug'])
  })

  it('404s an unknown slug', async () => {
    expect((await SELF.fetch('https://example.com/api/batches/by-slug/nope')).status).toBe(404)
  })
})

describe('self-serve signup', () => {
  const signUp = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    SELF.fetch('https://example.com/api/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        name: 'New Society', slug: 'new-society',
        officer_password: 'officer-password-1', door_password: 'door-password-1',
        branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
        ...body,
      }),
    })

  it('CREATES A SOCIETY WITH NO KEY AT ALL', async () => {
    const res = await signUp({})
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ slug: 'new-society' })
  })

  it('records it as self-registered, not as an operator action', async () => {
    await signUp({})
    const row = await env.DB.prepare(`SELECT role FROM audit_log WHERE action = 'batch.create'`)
      .first<{ role: string }>()
    expect(row!.role).toBe('public')
  })

  it('still refuses a WRONG key, because presenting one is an operator attempt', async () => {
    // Omitting the key is a signup; getting it wrong is someone probing the
    // operator path, which is worth refusing and recording.
    const res = await signUp({}, { 'x-super-admin-key': 'not-the-key' })
    expect(res.status).toBe(401)
    const row = await env.DB.prepare(`SELECT count(*) c FROM audit_log WHERE action = 'batch.create.denied'`)
      .first<{ c: number }>()
    expect(row!.c).toBe(1)
  })

  it('accepts the operator key and records it as an operator action', async () => {
    const res = await signUp({}, { 'x-super-admin-key': 'super-secret-test-key' })
    expect(res.status).toBe(201)
    const row = await env.DB.prepare(`SELECT role FROM audit_log WHERE action = 'batch.create'`)
      .first<{ role: string }>()
    expect(row!.role).toBe('super')
  })

  it('refuses a slug already taken, so one society cannot shadow another', async () => {
    await signUp({})
    expect((await signUp({})).status).toBe(409)
  })

  it('REFUSES RESERVED SLUGS, so no society can call itself admin or official', async () => {
    for (const slug of ['new', 'api', 'admin', 'official', 'receipt', 'door']) {
      const res = await signUp({ slug })
      expect(res.status, slug).toBe(400)
    }
  })

  it('still enforces the password floor on a self-serve signup', async () => {
    expect((await signUp({ officer_password: 'short' })).status).toBe(400)
  })

  it('still enforces the slug format', async () => {
    expect((await signUp({ slug: 'Not A Slug' })).status).toBe(400)
  })

  it('REFUSES the same password for both roles', async () => {
    // The door password is typed on volunteers' phones and grants check-in only.
    // Reusing the officer password there hands full control of the election to
    // anyone standing at the desk, which is the one boundary this system has.
    const res = await signUp({ officer_password: 'same-password-1', door_password: 'same-password-1' })
    expect(res.status).toBe(400)
    const row = await env.DB.prepare('SELECT count(*) c FROM batch').first<{ c: number }>()
    expect(row!.c).toBe(0)
  })

  it('never returns either password', async () => {
    const text = await (await signUp({})).text()
    expect(text).not.toContain('officer-password-1')
    expect(text).not.toContain('door-password-1')
  })
})
