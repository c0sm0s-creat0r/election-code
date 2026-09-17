import { describe, it, expect, beforeAll } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'

beforeAll(async () => {
  // `applyD1Migrations` validates its second argument at runtime as
  // `D1Migration[]` ({ name, queries }[]) — a raw imported SQL string fails
  // that check. `vitest.config.ts` reads migrations/0001_initial.sql on the
  // Node side with `readD1Migrations` and injects the parsed result as the
  // `TEST_MIGRATIONS` binding (see tests/env.d.ts for its type).
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

const sqlFor = async (table: string): Promise<string> => {
  const row = await env.DB
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(table)
    .first<{ sql: string }>()
  return row?.sql ?? ''
}

describe('schema', () => {
  it('resolves the DB binding at runtime', async () => {
    // Task 1 only asserted the D1 binding via wrangler.jsonc config; this
    // proves env.DB actually resolves to a working database at test time.
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
    expect(row?.one).toBe(1)
  })

  it('creates every table the spec defines', async () => {
    for (const t of [
      'batch', 'voter_roll', 'check_in', 'election', 'candidate',
      'ballot', 'vote_receipt', 'election_seal', 'election_result', 'audit_log',
    ]) {
      expect(await sqlFor(t), `missing table: ${t}`).not.toBe('')
    }
  })

  it('creates ballot WITHOUT ROWID', async () => {
    // This clause is the entire basis of the secret-ballot guarantee: it makes
    // physical row order follow the random UUID key rather than insertion order.
    // Losing it silently reintroduces the ballot/roll correlation leak.
    expect(await sqlFor('ballot')).toMatch(/WITHOUT\s+ROWID/i)
  })

  it('gives ballot no timestamp column', async () => {
    const cols = await env.DB.prepare(`PRAGMA table_info(ballot)`).all<{ name: string }>()
    const names = cols.results.map((r) => r.name)
    expect(names).not.toContain('cast_at')
    expect(names).not.toContain('created_at')
    expect(names.sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('makes (election_id, usu_id) the double-vote guard on vote_receipt', async () => {
    await env.DB.prepare(
      `INSERT INTO batch (id,slug,name,officer_hash,door_hash,branding,created_at)
       VALUES ('b1','s','n','x','y','{}',1)`).run()
    await env.DB.prepare(
      `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e1','b1','E',1,'open')`).run()
    await env.DB.prepare(
      `INSERT INTO vote_receipt (election_id,usu_id,voted_at) VALUES ('e1','2400001',1)`).run()

    await expect(
      env.DB.prepare(`INSERT INTO vote_receipt (election_id,usu_id,voted_at) VALUES ('e1','2400001',2)`).run(),
    ).rejects.toThrow(/UNIQUE|constraint/i)
  })

  it('rejects an election with seats below 1', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e2','b1','E',0,'draft')`).run(),
    ).rejects.toThrow(/CHECK|constraint/i)
  })

  it('rejects an unknown election status', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO election (id,batch_id,name,seats,status) VALUES ('e3','b1','E',1,'counting')`).run(),
    ).rejects.toThrow(/CHECK|constraint/i)
  })
})
