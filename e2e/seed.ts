/**
 * Creates the one election the smoke test needs, through the real API.
 * `apps/api` has no seeding endpoint and must never get one.
 *
 * Idempotent: the run's database (`.wrangler-e2e`) persists. It tolerates an
 * existing society, closes any open election, and opens a new one.
 */
const API = 'http://localhost:8787'

export const SLUG = 'e2e'
export const USU_ID = '2400001'
export const SURNAME = 'Lovelace'
export const CANDIDATE = 'Alex'

const OFFICER_PASSWORD = 'officer-password-e2e'
const DOOR_PASSWORD = 'door-password-e2e'
const SUPER_KEY = 'e2e-super-admin-key'

const json = { 'content-type': 'application/json' }
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

/** The minimum USU export that imports one eligible member. */
const rollCsv = [
  '"User Identifier","Net Id","Member Identifier","First Name","Last Name","Email","Year Of Graduation","Member Type","Officer","Source Type","Membership End Date","Signup Date","Membership Payments","Events Payments","Member Tags","Sub-Groups Tags","User Tags","Officer  Notes","Last Online iOS","Last Online Android","Unsubscribed from all emails","Left Group","Left Group Reason","Dalyell Status","First Aid Expiry","Online Module Expiry","RSA Expiry","Working with Children Expiry"',
  `"600001","${USU_ID}","11000001","Ada","${SURNAME}","ada@example.com","-","","Member","0","Web","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""`,
].join('\n')

async function post(path: string, what: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, { method: 'POST', ...init })
  if (!res.ok) throw new Error(`seed: ${what} failed with ${res.status}: ${await res.text()}`)
  return res
}

export default async function seed(): Promise<void> {
  const batchId = await findOrCreateSociety()
  const officer = { cookie: await signIn(batchId, 'officer', OFFICER_PASSWORD) }
  const door = { cookie: await signIn(batchId, 'door', DOOR_PASSWORD) }

  const upload = new FormData()
  upload.append('file', new File([rollCsv], 'members.csv', { type: 'text/csv' }))
  await post(`/api/batches/${batchId}/roll`, 'roll import', { headers: officer, body: upload })

  await closeAnyOpenElections(batchId, officer.cookie)
  await openFreshElection(batchId, officer.cookie)

  // A repeat check-in returns 200 with `already: true`.
  await post(`/api/batches/${batchId}/check-in`, 'check in',
    { headers: { ...json, ...door }, body: JSON.stringify({ usu_id: USU_ID }) })
}

/** A 409 means a previous run created it. */
async function findOrCreateSociety(): Promise<string> {
  const res = await fetch(`${API}/api/batches`, {
    method: 'POST',
    headers: { ...json, 'x-super-admin-key': SUPER_KEY },
    body: JSON.stringify({
      name: 'E2E Society',
      slug: SLUG,
      officer_password: OFFICER_PASSWORD,
      door_password: DOOR_PASSWORD,
      branding: { title: 'E2E AGM', org_name: 'E2E Society', accent_color: '#2563eb', logo_url: '' },
    }),
  })
  if (res.ok) return ((await res.json()) as { id: string }).id
  if (res.status !== 409) {
    throw new Error(`seed: create batch failed with ${res.status}: ${await res.text()}`)
  }

  const existing = await fetch(`${API}/api/batches/by-slug/${SLUG}`)
  if (!existing.ok) throw new Error(`seed: ${SLUG} exists but could not be loaded`)
  return ((await existing.json()) as { id: string }).id
}

async function signIn(batchId: string, role: 'officer' | 'door', password: string): Promise<string> {
  return cookieOf(await post(`/api/batches/${batchId}/${role}/session`, `${role} sign-in`,
    { headers: json, body: JSON.stringify({ password }) }))
}

/**
 * Close the previous run's election. Its voter has voted, so leaving it open
 * gives the test two `Vote` buttons, one of which returns 409.
 */
async function closeAnyOpenElections(batchId: string, officerCookie: string): Promise<void> {
  const res = await fetch(`${API}/api/batches/${batchId}/officer/elections`, {
    headers: { cookie: officerCookie },
  })
  if (!res.ok) return
  const elections = (await res.json()) as { id: string; status: string }[]
  for (const election of elections.filter((e) => e.status === 'open')) {
    await post(`/api/batches/${batchId}/elections/${election.id}/close`, 'close stale election',
      { headers: { cookie: officerCookie } })
  }
}

async function openFreshElection(batchId: string, officerCookie: string): Promise<void> {
  const created = await post(`/api/batches/${batchId}/elections`, 'create election',
    { headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name: 'President', seats: 1 }) })
  const { id: electionId } = (await created.json()) as { id: string }

  for (const name of [CANDIDATE, 'Bo']) {
    await post(`/api/batches/${batchId}/elections/${electionId}/candidates`, `add candidate ${name}`,
      { headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name }) })
  }

  await post(`/api/batches/${batchId}/elections/${electionId}/open`, 'open election',
    { headers: { cookie: officerCookie } })
}
