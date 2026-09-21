/**
 * Provisions the one election the smoke test needs, through the real API.
 *
 * **Deliberately not a seeding endpoint.** A route in `apps/api` that provisions
 * voters would be the single worst thing that could exist in this codebase, and
 * "it's only enabled in dev" is exactly how such a thing reaches production. This
 * uses only the documented endpoints, with the super-admin key the local dev
 * server is configured with — the same path an operator takes.
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

/** Just enough of a USU export to import one eligible member. */
const rollCsv = [
  '"User Identifier","Net Id","Member Identifier","First Name","Last Name","Email","Year Of Graduation","Member Type","Officer","Source Type","Membership End Date","Signup Date","Membership Payments","Events Payments","Member Tags","Sub-Groups Tags","User Tags","Officer  Notes","Last Online iOS","Last Online Android","Unsubscribed from all emails","Left Group","Left Group Reason","Dalyell Status","First Aid Expiry","Online Module Expiry","RSA Expiry","Working with Children Expiry"',
  `"600001","${USU_ID}","11000001","Ada","${SURNAME}","ada@example.com","-","","Member","0","Web","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""`,
].join('\n')

async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`seed: ${what} failed with ${res.status}: ${await res.text()}`)
  return res
}

export default async function seed(): Promise<void> {
  const created = await expectOk(
    await fetch(`${API}/api/batches`, {
      method: 'POST',
      headers: { ...json, 'x-super-admin-key': SUPER_KEY },
      body: JSON.stringify({
        name: 'E2E Society',
        slug: SLUG,
        officer_password: OFFICER_PASSWORD,
        door_password: DOOR_PASSWORD,
        branding: { title: 'E2E AGM', org_name: 'E2E Society', accent_color: '#2563eb', logo_url: '' },
      }),
    }),
    'create batch',
  )
  const { id: batchId } = (await created.json()) as { id: string }

  const officerCookie = cookieOf(await expectOk(
    await fetch(`${API}/api/batches/${batchId}/officer/session`, {
      method: 'POST', headers: json, body: JSON.stringify({ password: OFFICER_PASSWORD }),
    }),
    'officer sign-in',
  ))
  const doorCookie = cookieOf(await expectOk(
    await fetch(`${API}/api/batches/${batchId}/door/session`, {
      method: 'POST', headers: json, body: JSON.stringify({ password: DOOR_PASSWORD }),
    }),
    'door sign-in',
  ))

  const upload = new FormData()
  upload.append('file', new File([rollCsv], 'members.csv', { type: 'text/csv' }))
  await expectOk(
    await fetch(`${API}/api/batches/${batchId}/roll`, {
      method: 'POST', headers: { cookie: officerCookie }, body: upload,
    }),
    'roll import',
  )

  const election = await expectOk(
    await fetch(`${API}/api/batches/${batchId}/elections`, {
      method: 'POST', headers: { ...json, cookie: officerCookie },
      body: JSON.stringify({ name: 'President', seats: 1 }),
    }),
    'create election',
  )
  const { id: electionId } = (await election.json()) as { id: string }

  for (const name of [CANDIDATE, 'Bo']) {
    await expectOk(
      await fetch(`${API}/api/batches/${batchId}/elections/${electionId}/candidates`, {
        method: 'POST', headers: { ...json, cookie: officerCookie }, body: JSON.stringify({ name }),
      }),
      `add candidate ${name}`,
    )
  }

  await expectOk(
    await fetch(`${API}/api/batches/${batchId}/elections/${electionId}/open`, {
      method: 'POST', headers: { cookie: officerCookie },
    }),
    'open election',
  )

  await expectOk(
    await fetch(`${API}/api/batches/${batchId}/check-in`, {
      method: 'POST', headers: { ...json, cookie: doorCookie },
      body: JSON.stringify({ usu_id: USU_ID }),
    }),
    'check in',
  )
}
