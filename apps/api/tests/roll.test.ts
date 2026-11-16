import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { ROLL_CSV, api, countOf, setUpBatch, uploadRoll } from './helpers.js'

let batchId = ''
let officerCookie = ''

beforeEach(async () => {
  ({ batchId, officerCookie } = await setUpBatch())
})

const upload = (path = '/roll', content?: string) => uploadRoll(batchId, officerCookie, path, content)
const summary = async () => (await api('GET', `/batches/${batchId}/officer/roll/summary`, officerCookie)).json()

describe('roll import', () => {
  it('previews counts without writing anything', async () => {
    const res = await upload('/roll/preview')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: true })
    expect(await countOf('voter_roll')).toBe(0)
  })

  it('commits the roll, marking departed members ineligible rather than dropping them', async () => {
    expect(await summary()).toEqual({ total: 0, eligible: 0 })
    expect((await upload()).status).toBe(200)
    expect(await countOf('voter_roll', 'batch_id = ?', batchId)).toBe(6)
    expect(await countOf('voter_roll', 'eligible = 0')).toBe(2)
    expect(await summary()).toEqual({ total: 6, eligible: 4 })
  })

  it('re-importing updates eligibility and duplicates nothing', async () => {
    await upload()
    await env.DB.prepare('UPDATE voter_roll SET eligible = 0').run()
    await upload()
    expect(await countOf('voter_roll')).toBe(6)
    expect(await countOf('voter_roll', 'eligible = 1')).toBe(4)
  })

  it.each([
    ['a corrupt export', new File(['"Net Id","First Name"\n"1","unterminated'], 'bad.csv', { type: 'text/csv' })],
    ['a request with no file', null],
    ['a file over the size ceiling', new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'huge.csv', { type: 'text/csv' })],
  ])('rejects %s without writing a partial roll', async (_label, file) => {
    const body = new FormData()
    if (file) body.append('file', file)
    const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body,
    })
    expect(res.status).toBe(400)
    expect(await countOf('voter_roll')).toBe(0)
  })

  it('imports a roll of 1,300 rows in one request', async () => {
    // more rows than one D1 batch() allows, to exercise chunking
    const [header, template] = ROLL_CSV.split('\n') as [string, string]
    const rows = Array.from({ length: 1300 }, (_, i) =>
      template.replace('"2400001"', `"${3000000 + i}"`).replace('"600001"', `"${700000 + i}"`),
    )
    expect((await upload('/roll', [header, ...rows].join('\n'))).status).toBe(200)
    expect(await countOf('voter_roll', 'batch_id = ?', batchId)).toBe(1300)
  })
})
