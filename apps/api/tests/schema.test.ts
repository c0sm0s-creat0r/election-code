import { describe, it, expect, beforeAll } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'

beforeAll(async () => {
  // Migrations come from the TEST_MIGRATIONS binding in vitest.config.ts.
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
    // The secret ballot depends on this: row order follows the random id, not
    // insertion order.
    expect(await sqlFor('ballot')).toMatch(/WITHOUT\s+ROWID/i)
  })

  it('gives ballot no timestamp column', async () => {
    const cols = await env.DB.prepare(`PRAGMA table_info(ballot)`).all<{ name: string }>()
    const names = cols.results.map((r) => r.name)
    expect(names).not.toContain('cast_at')
    expect(names).not.toContain('created_at')
    expect(names.sort()).toEqual(['election_id', 'id', 'preferences', 'receipt_hash', 'voided'])
  })

  it('gives voter_roll exactly the spec columns, nothing else', async () => {
    // The roll's columns are a data-minimisation control. A new column (email,
    // say) must fail here.
    const cols = await env.DB.prepare(`PRAGMA table_info(voter_roll)`).all<{ name: string }>()
    const names = cols.results.map((r) => r.name)
    // added_at_door (0004) is provenance, not personal data.
    expect(names.sort()).toEqual(
      ['batch_id', 'usu_id', 'first_name', 'last_name', 'eligible', 'added_at_door'].sort(),
    )
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

describe('0004: guests and door additions', () => {
  it('creates a guest table with no usu_id — a guest cannot be joined to the roll', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(guest)').all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(['batch_id', 'checked_in_at', 'id', 'name', 'note'])
  })

  it('adds added_at_door to voter_roll, defaulting to 0', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(voter_roll)').all<{ name: string; dflt_value: string | null }>()
    const col = cols.results.find((c) => c.name === 'added_at_door')
    expect(col).toBeTruthy()
    expect(col!.dflt_value).toBe('0')
  })

  it('leaves a row the import wrote flagged as not door-added', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO batch (id, slug, name, officer_hash, door_hash, branding, created_at)
                          VALUES ('b-0004','s-0004','n','h','h','{}',1)`).run()
    await env.DB.prepare(`INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible)
                          VALUES ('b-0004','2400001','Ada','Lovelace',1)`).run()
    const row = await env.DB.prepare(`SELECT added_at_door FROM voter_roll WHERE batch_id = 'b-0004'`)
      .first<{ added_at_door: number }>()
    expect(row!.added_at_door).toBe(0)
  })
})
