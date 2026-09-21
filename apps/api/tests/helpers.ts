/**
 * Shared setup for the result-path tests.
 *
 * Plan 2b's test files each grew their own copy of this: provision a batch,
 * sign in, import the roll, create an election, check voters in, vote. By
 * Plan 2c that is six routes deep and four files would repeat it, so it lives
 * here once — after the third copy, not before the first.
 */
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import csv from './fixtures/usu-sample.csv?raw'

export const SUPER_KEY = 'super-secret-test-key'
export const JSON_HEADERS = { 'content-type': 'application/json' }

/** Grace Hopper carries "Left Group" = 1 in the fixture. */
export const INELIGIBLE_USU_ID = '2400003'

/** usu_id -> surname, for the four eligible members of the fixture. */
export const MEMBERS = {
  '2400001': 'Lovelace',
  '2400002': 'Turing',
  '2400004': 'Dijkstra',
  '2400006': 'Hoare',
} as const

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

export const ALL_TABLES = [
  'ballot', 'vote_receipt', 'election_result', 'election_seal',
  'candidate', 'election', 'check_in', 'guest', 'voter_roll', 'audit_log', 'batch',
] as const

export async function resetDatabase(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const table of ALL_TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run()
  for (const key of (await env.RATE_LIMIT.list()).keys) await env.RATE_LIMIT.delete(key.name)
}

export type Fixture = {
  batchId: string
  officerCookie: string
  doorCookie: string
  /** An open election, seats = 1, candidates Alex and Bo. */
  electionId: string
  candidateIds: { a: string; b: string }
  /** usu_id -> voter cookie, for every member checked in by `setUp`. */
  voterCookies: Record<string, string>
}

export async function createBatch(slug = 's'): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-super-admin-key': SUPER_KEY },
    body: JSON.stringify({
      name: 'Test Society', slug,
      officer_password: 'officer-password-1', door_password: 'door-password-1',
      branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
    }),
  })
  return (await res.json() as { id: string }).id
}

export async function signIn(batchId: string, role: 'officer' | 'door', password: string): Promise<string> {
  return cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/${role}/session`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password }),
  }))
}

export async function importRoll(batchId: string, officerCookie: string): Promise<void> {
  const body = new FormData()
  body.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  await SELF.fetch(`https://example.com/api/batches/${batchId}/roll`, {
    method: 'POST', headers: { cookie: officerCookie }, body,
  })
}

export async function createElection(
  batchId: string, officerCookie: string, name: string, seats: number,
): Promise<string> {
  const res = await SELF.fetch(`https://example.com/api/batches/${batchId}/elections`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie: officerCookie },
    body: JSON.stringify({ name, seats }),
  })
  return (await res.json() as { id: string }).id
}

export async function addCandidate(
  batchId: string, officerCookie: string, electionId: string, name: string,
): Promise<string> {
  const res = await SELF.fetch(
    `https://example.com/api/batches/${batchId}/elections/${electionId}/candidates`,
    { method: 'POST', headers: { ...JSON_HEADERS, cookie: officerCookie }, body: JSON.stringify({ name }) },
  )
  return (await res.json() as { id: string }).id
}

export const openElection = (batchId: string, officerCookie: string, electionId: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/open`, {
    method: 'POST', headers: { cookie: officerCookie },
  })

export const checkIn = (batchId: string, doorCookie: string, usuId: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/check-in`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie: doorCookie },
    body: JSON.stringify({ usu_id: usuId }),
  })

export async function voterSignIn(batchId: string, usuId: string, surname: string): Promise<string> {
  return cookieOf(await SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ usu_id: usuId, surname }),
  }))
}

export const submitBallot = (
  batchId: string, electionId: string, cookie: string, preferences: string[],
) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/ballots`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ preferences }),
  })

/**
 * A batch with an imported roll and one open single-seat election, plus the
 * given members checked in and signed in as voters. No ballots are cast —
 * each test decides what the box contains.
 */
export async function setUp(usuIds: readonly string[] = ['2400001', '2400002', '2400004']): Promise<Fixture> {
  await resetDatabase()
  const batchId = await createBatch()
  const officerCookie = await signIn(batchId, 'officer', 'officer-password-1')
  const doorCookie = await signIn(batchId, 'door', 'door-password-1')
  await importRoll(batchId, officerCookie)

  const electionId = await createElection(batchId, officerCookie, 'President', 1)
  const candidateIds = {
    a: await addCandidate(batchId, officerCookie, electionId, 'Alex'),
    b: await addCandidate(batchId, officerCookie, electionId, 'Bo'),
  }
  await openElection(batchId, officerCookie, electionId)

  const voterCookies: Record<string, string> = {}
  for (const usuId of usuIds) {
    await checkIn(batchId, doorCookie, usuId)
    voterCookies[usuId] = await voterSignIn(batchId, usuId, MEMBERS[usuId as keyof typeof MEMBERS])
  }

  return { batchId, officerCookie, doorCookie, electionId, candidateIds, voterCookies }
}

/** sha256 hex, the same digest the seal and the receipt hash use. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
