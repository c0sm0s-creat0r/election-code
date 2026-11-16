/**
 * Shared setup for the API tests: provision a batch, sign in, import the
 * roll, create and open an election, check voters in.
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
}

export type Fixture = {
  batchId: string
  officerCookie: string
  doorCookie: string
  /** An open election; by default seats = 1, candidates Alex and Bo. */
  electionId: string
  /** Keyed a, b, c... in ballot order. */
  candidateIds: { a: string; b: string; [key: string]: string }
  /** usu_id -> voter cookie, for every member checked in by `setUp`. */
  voterCookies: Record<string, string>
}

/** Passwords are `officer-password-<n>` and `door-password-<n>`. */
export async function createBatch(slug = 's', n = 1): Promise<string> {
  const res = await SELF.fetch('https://example.com/api/batches', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-super-admin-key': SUPER_KEY },
    body: JSON.stringify({
      name: 'Test Society', slug,
      officer_password: `officer-password-${n}`, door_password: `door-password-${n}`,
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

/** Posts the fixture CSV to `/roll` or `/roll/preview`. */
export function uploadRoll(batchId: string, cookie: string, path = '/roll'): Promise<Response> {
  const body = new FormData()
  body.append('file', new File([csv], 'members.csv', { type: 'text/csv' }))
  return SELF.fetch(`https://example.com/api/batches/${batchId}${path}`, {
    method: 'POST', headers: { cookie }, body,
  })
}

export async function importRoll(batchId: string, officerCookie: string): Promise<void> {
  await uploadRoll(batchId, officerCookie)
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

export const voterSession = (batchId: string, usuId: string, surname: string) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/voter/session`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ usu_id: usuId, surname }),
  })

export async function voterSignIn(batchId: string, usuId: string, surname: string): Promise<string> {
  return cookieOf(await voterSession(batchId, usuId, surname))
}

export const submitBallot = (
  batchId: string, electionId: string, cookie: string, preferences: string[],
) =>
  SELF.fetch(`https://example.com/api/batches/${batchId}/elections/${electionId}/ballots`, {
    method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ preferences }),
  })

/** A clean database and one batch, with both staff roles signed in. No roll. */
export async function setUpBatch(): Promise<Pick<Fixture, 'batchId' | 'officerCookie' | 'doorCookie'>> {
  await resetDatabase()
  const batchId = await createBatch()
  const officerCookie = await signIn(batchId, 'officer', 'officer-password-1')
  const doorCookie = await signIn(batchId, 'door', 'door-password-1')
  return { batchId, officerCookie, doorCookie }
}

/**
 * A batch with an imported roll and one open election (single-seat unless
 * `seats` says otherwise), with the given members checked in and signed in as
 * voters. No ballots are cast.
 */
export async function setUp(
  usuIds: readonly string[] = ['2400001', '2400002', '2400004'],
  { seats = 1, candidates = ['Alex', 'Bo'] }: { seats?: number; candidates?: readonly string[] } = {},
): Promise<Fixture> {
  const { batchId, officerCookie, doorCookie } = await setUpBatch()
  await importRoll(batchId, officerCookie)

  const electionId = await createElection(batchId, officerCookie, 'President', seats)
  const candidateIds: Fixture['candidateIds'] = { a: '', b: '' }
  for (const [i, name] of candidates.entries()) {
    candidateIds[String.fromCharCode(97 + i)] = await addCandidate(batchId, officerCookie, electionId, name)
  }
  await openElection(batchId, officerCookie, electionId)

  const voterCookies: Record<string, string> = {}
  for (const usuId of usuIds) {
    await checkIn(batchId, doorCookie, usuId)
    voterCookies[usuId] = await voterSignIn(batchId, usuId, MEMBERS[usuId as keyof typeof MEMBERS])
  }

  return { batchId, officerCookie, doorCookie, electionId, candidateIds, voterCookies }
}

/** sha256 hex, as the seal and the receipt hash use. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
