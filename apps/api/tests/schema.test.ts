import { describe, it, expect, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { ALL_TABLES, resetDatabase } from './helpers.js'

beforeAll(async () => {
  await resetDatabase()
  await env.DB.prepare(
    `INSERT INTO batch (id,slug,name,officer_hash,door_hash,branding,created_at)
     VALUES ('b1','s','n','x','y','{}',1)`).run()
})

const sqlFor = async (table: string): Promise<string> =>
  (await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .bind(table).first<{ sql: string }>())?.sql ?? ''

const insertElection = (id: string, seats: number, status: string) =>
  env.DB.prepare(`INSERT INTO election (id,batch_id,name,seats,status) VALUES (?,'b1','E',?,?)`)
    .bind(id, seats, status).run()

describe('schema', () => {
  it('creates every table the spec defines', async () => {
    for (const t of ALL_TABLES) expect(await sqlFor(t), `missing table: ${t}`).not.toBe('')
  })

  it('creates ballot WITHOUT ROWID', async () => {
    // The secret ballot depends on this: row order follows the random id, not
    // insertion order.
    expect(await sqlFor('ballot')).toMatch(/WITHOUT\s+ROWID/i)
  })

  // Exact column lists are the data-minimisation control: a new column (an
  // email, a cast_at) must fail here.
  it.each([
    // no voter reference and no timestamp
    ['ballot', ['election_id', 'id', 'preferences', 'receipt_hash', 'voided']],
    // added_at_door (0004) is provenance, not personal data
    ['voter_roll', ['added_at_door', 'batch_id', 'eligible', 'first_name', 'last_name', 'usu_id']],
    // no usu_id: a guest cannot be joined to the roll
    ['guest', ['batch_id', 'checked_in_at', 'id', 'name', 'note']],
  ])('gives %s exactly its spec columns', async (table, columns) => {
    const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    expect(cols.results.map((r) => r.name).sort()).toEqual(columns)
  })

  it('makes (election_id, usu_id) the double-vote guard on vote_receipt', async () => {
    await insertElection('e1', 1, 'open')
    const markOff = (at: number) => env.DB.prepare(
      `INSERT INTO vote_receipt (election_id,usu_id,voted_at) VALUES ('e1','2400001',?)`).bind(at).run()
    await markOff(1)
    await expect(markOff(2)).rejects.toThrow(/UNIQUE/i)
  })

  it.each([
    ['seats below 1', 0, 'draft'],
    ['an unknown status', 1, 'counting'],
  ])('rejects an election with %s', async (_label, seats, status) => {
    await expect(insertElection('e2', seats, status)).rejects.toThrow(/CHECK/i)
  })

  it('flags a roll row as not door-added unless told otherwise', async () => {
    await env.DB.prepare(`INSERT INTO voter_roll (batch_id, usu_id, first_name, last_name, eligible)
                          VALUES ('b1','2400001','Ada','Lovelace',1)`).run()
    const row = await env.DB.prepare('SELECT added_at_door FROM voter_roll').first<{ added_at_door: number }>()
    expect(row!.added_at_door).toBe(0)
  })
})
