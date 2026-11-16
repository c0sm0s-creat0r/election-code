/**
 * Every role-gated route, in one table. No session is a 401 (sign in); a
 * valid session for another role is a 403 (never a way in); the right role
 * gets past the gate. Add a row when adding a gated route.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { setUp, api, type Fixture } from './helpers.js'

type Role = 'officer' | 'door' | 'voter'

/** Paths are below `/api/batches/:id`. */
const GATES: [method: string, path: string, role: Role][] = [
  ['GET', '/officer/ping', 'officer'],
  ['PATCH', '/branding', 'officer'],
  ['POST', '/logo', 'officer'],
  ['POST', '/roll/preview', 'officer'],
  ['POST', '/roll', 'officer'],
  ['DELETE', '/roll', 'officer'],
  ['GET', '/officer/roll/summary', 'officer'],
  ['GET', '/officer/elections', 'officer'],
  ['POST', '/elections', 'officer'],
  ['DELETE', '/elections/:eid', 'officer'],
  ['POST', '/elections/:eid/candidates', 'officer'],
  ['PATCH', '/elections/:eid/candidates/:cid', 'officer'],
  ['DELETE', '/elections/:eid/candidates/:cid', 'officer'],
  ['POST', '/elections/:eid/open', 'officer'],
  ['POST', '/elections/:eid/close', 'officer'],
  ['GET', '/elections/:eid/result', 'officer'],
  ['POST', '/elections/:eid/result/override', 'officer'],
  ['GET', '/elections/:eid/turnout', 'officer'],
  ['GET', '/elections/:eid/attendance.csv', 'officer'],
  ['GET', '/elections/:eid/ballots.csv', 'officer'],
  ['GET', '/elections/:eid/candidates.csv', 'officer'],
  ['GET', '/elections/:eid/result.json', 'officer'],
  ['GET', '/attendance.csv', 'officer'],
  ['GET', '/guests.csv', 'officer'],
  ['GET', '/check-ins.csv', 'officer'],
  ['GET', '/roll', 'door'],
  ['POST', '/check-in', 'door'],
  ['DELETE', '/check-in/2400001', 'door'],
  ['GET', '/quorum', 'door'],
  ['POST', '/voters', 'door'],
  ['DELETE', '/voters/2400777', 'door'],
  ['POST', '/guests', 'door'],
  ['GET', '/guests', 'door'],
  ['DELETE', '/guests/none', 'door'],
  ['POST', '/elections/:eid/ballots', 'voter'],
]

let f: Fixture
let cookies: Record<Role, string>

// Once: the pool rolls each test's writes back to this state.
beforeAll(async () => {
  f = await setUp(['2400001'])
  cookies = { officer: f.officerCookie, door: f.doorCookie, voter: f.voterCookies['2400001']! }
})

describe('role gates', () => {
  it.each(GATES)('%s %s is for the %s role only', async (method, path, role) => {
    const url = `/batches/${f.batchId}${path.replace(':eid', f.electionId).replace(':cid', f.candidateIds.a)}`
    const send = async (cookie: string) => {
      const res = await api(method, url, cookie)
      return { status: res.status, body: await res.text() }
    }

    expect(await send('')).toEqual({ status: 401, body: JSON.stringify({ error: 'unauthenticated' }) })
    for (const other of (['officer', 'door', 'voter'] as const).filter((r) => r !== role)) {
      expect(await send(cookies[other]), other).toEqual({ status: 403, body: JSON.stringify({ error: 'forbidden' }) })
    }
    expect([401, 403]).not.toContain((await send(cookies[role])).status)
  })
})
