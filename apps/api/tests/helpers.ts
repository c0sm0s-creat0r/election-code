/**
 * Shared setup for the API tests: provision a batch, sign in, import the
 * roll, create and open an election, check voters in, cast, close.
 */
import { SELF, env, applyD1Migrations } from 'cloudflare:test'
import csv from './fixtures/usu-sample.csv?raw'

export const SUPER_KEY = 'super-secret-test-key'
/** Must match the SESSION_SECRET binding in the vitest config. */
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef'
export const JSON_HEADERS = { 'content-type': 'application/json' }
export const ROLL_CSV = csv

/** Grace Hopper carries "Left Group" = 1 in the fixture. */
export const INELIGIBLE_USU_ID = '2400003'

/** usu_id -> surname, for the four eligible members of the fixture. */
export const MEMBERS = {
  '2400001': 'Lovelace',
  '2400002': 'Turing',
  '2400004': 'Dijkstra',
  '2400006': 'Hoare',
} as const

/** A request to the worker. `path` is below `/api`; a body is sent as JSON. */
export const api = (
  method: string, path: string, cookie = '', body?: unknown, headers: Record<string, string> = {},
) =>
  SELF.fetch(`https://example.com/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

export const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

const idOf = async (res: Response) => (await res.json() as { id: string }).id

export const ALL_TABLES = [
  'ballot', 'vote_receipt', 'election_result', 'election_seal',
  'candidate', 'election', 'check_in', 'guest', 'voter_roll', 'audit_log', 'batch',
] as const

export async function resetDatabase(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const table of ALL_TABLES) await env.DB.prepare(`DELETE FROM ${table}`).run()
}

/** `SELECT count(*)`, optionally filtered. */
export async function countOf(table: string, where = '1 = 1', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds).first<{ n: number }>()
  return row?.n ?? 0
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
export const batchBody = (slug = 's', n = 1) => ({
  name: 'Test Society', slug,
  officer_password: `officer-password-${n}`, door_password: `door-password-${n}`,
  branding: { title: 't', org_name: 'o', accent_color: '#000000', logo_url: '' },
})

export const postBatch = (body: unknown, key?: string) =>
  api('POST', '/batches', '', body, key === undefined ? {} : { 'x-super-admin-key': key })

export const createBatch = async (slug = 's', n = 1): Promise<string> =>
  idOf(await postBatch(batchBody(slug, n), SUPER_KEY))

export const staffSession = (batchId: string, role: 'officer' | 'door', password: string) =>
  api('POST', `/batches/${batchId}/${role}/session`, '', { password })

export const signIn = async (batchId: string, role: 'officer' | 'door', password: string): Promise<string> =>
  cookieOf(await staffSession(batchId, role, password))

/** Posts a CSV (the fixture by default) to `/roll` or `/roll/preview`. */
export function uploadRoll(batchId: string, cookie: string, path = '/roll', content: string = csv): Promise<Response> {
  const body = new FormData()
  body.append('file', new File([content], 'members.csv', { type: 'text/csv' }))
  return SELF.fetch(`https://example.com/api/batches/${batchId}${path}`, {
    method: 'POST', headers: { cookie }, body,
  })
}

export async function importRoll(batchId: string, officerCookie: string): Promise<void> {
  await uploadRoll(batchId, officerCookie)
}

export const createElection = async (
  batchId: string, officerCookie: string, name: string, seats: number,
): Promise<string> => idOf(await api('POST', `/batches/${batchId}/elections`, officerCookie, { name, seats }))

export const addCandidate = async (
  batchId: string, officerCookie: string, electionId: string, name: string,
): Promise<string> =>
  idOf(await api('POST', `/batches/${batchId}/elections/${electionId}/candidates`, officerCookie, { name }))

export const openElection = (batchId: string, officerCookie: string, electionId: string) =>
  api('POST', `/batches/${batchId}/elections/${electionId}/open`, officerCookie)

export const checkIn = (batchId: string, doorCookie: string, usuId: string) =>
  api('POST', `/batches/${batchId}/check-in`, doorCookie, { usu_id: usuId })

export const voterSession = (batchId: string, usuId: string, surname: string) =>
  api('POST', `/batches/${batchId}/voter/session`, '', { usu_id: usuId, surname })

export const voterSignIn = async (batchId: string, usuId: string, surname: string): Promise<string> =>
  cookieOf(await voterSession(batchId, usuId, surname))

export const submitBallot = (batchId: string, electionId: string, cookie: string, preferences: unknown) =>
  api('POST', `/batches/${batchId}/elections/${electionId}/ballots`, cookie, { preferences })

export const tokenOf = async (res: Response) => (await res.json() as { receipt_token: string }).receipt_token

type Staffed = Pick<Fixture, 'batchId' | 'officerCookie' | 'doorCookie'>

/** A clean database and one batch, with both staff roles signed in. No roll. */
export async function setUpBatch(): Promise<Staffed> {
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

/** Casts one ballot in the fixture's election, preferences by candidate key. */
export const cast = (f: Fixture, usuId: string, ...keys: string[]) =>
  submitBallot(f.batchId, f.electionId, f.voterCookies[usuId]!, keys.map((k) => f.candidateIds[k] ?? k))

/** The usual box: Alex 2, Bo 1. Needs the default three voters. */
export async function castThree(f: Fixture): Promise<void> {
  await cast(f, '2400001', 'a', 'b')
  await cast(f, '2400002', 'a', 'b')
  await cast(f, '2400004', 'b', 'a')
}

type Officer = Pick<Fixture, 'batchId' | 'officerCookie' | 'electionId'>

export const closeElection = (f: Officer, electionId = f.electionId) =>
  api('POST', `/batches/${f.batchId}/elections/${electionId}/close`, f.officerCookie)

/** The first GET after close runs the count and stores it. */
export const getResult = (f: Officer, electionId = f.electionId) =>
  api('GET', `/batches/${f.batchId}/elections/${electionId}/result`, f.officerCookie)

export const addGuest = (f: Staffed, body: unknown = { name: 'Jo Visitor', note: 'observer' }) =>
  api('POST', `/batches/${f.batchId}/guests`, f.doorCookie, body)

export const NEW_MEMBER = { usu_id: '2400777', first_name: 'Nina', last_name: 'Newjoiner' }

export const addDoorVoter = (f: Staffed, body: unknown = NEW_MEMBER) =>
  api('POST', `/batches/${f.batchId}/voters`, f.doorCookie, body)

/**
 * Voids a member's live ballot in the database. For tests that hold no
 * receipt token; receipts.test.ts covers the route.
 */
export async function voidLiveBallot(usuId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT live_receipt_hash FROM vote_receipt WHERE usu_id = ?')
    .bind(usuId).first<{ live_receipt_hash: string }>()
  await env.DB.batch([
    env.DB.prepare('UPDATE ballot SET voided = 1 WHERE receipt_hash = ?').bind(row!.live_receipt_hash),
    env.DB.prepare('UPDATE vote_receipt SET live_receipt_hash = NULL WHERE usu_id = ?').bind(usuId),
  ])
}

/** sha256 hex, as the seal and the receipt hash use. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
