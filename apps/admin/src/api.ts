/**
 * The admin app's API client. Not shared with the voter app: a common
 * package would couple two release cycles.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

/** `status` 0 means the request never completed. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    // Without `credentials: 'include'` the session cookie is not sent.
    res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init })
  } catch {
    throw new ApiError(0, 'network', 'We could not reach the server.')
  }
  const body = (await res.json().catch(() => undefined)) as
    | { error?: string; code?: string }
    | undefined
  if (!res.ok) throw new ApiError(res.status, body?.code, body?.error ?? 'Something went wrong.')
  return body as T
}

const postJson = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

const patchJson = (payload: unknown): RequestInit => ({ ...postJson(payload), method: 'PATCH' })

export type Branding = { title: string; org_name: string; accent_color: string; logo_url: string }
export type Batch = { id: string; slug: string; name: string; branding: Branding }

/** Slug, name and branding only. Nothing about members. */
export const listSocieties = () => request<Omit<Batch, 'id'>[]>('/api/batches')

export type SignUp = {
  name: string
  slug: string
  officer_password: string
  door_password: string
  branding: Branding
}

/**
 * A society signing itself up, with no key. Nothing verifies who it is, so
 * the sign-up screen must not imply approval.
 */
export const signUpSociety = (body: SignUp) => request<Batch>('/api/batches', postJson(body))

export const getBatchBySlug = (slug: string) =>
  request<Batch>(`/api/batches/by-slug/${encodeURIComponent(slug)}`)

/**
 * Is this officer session still live? Asks the server: a reload or new tab
 * loses component state while the cookie is still valid. The door does not
 * probe. It asks for its password every time.
 */
export const probeOfficer = (batchId: string) =>
  request<{ ok: true }>(`/api/batches/${batchId}/officer/ping`)

export const officerSignOut = (batchId: string) =>
  request<void>(`/api/batches/${batchId}/officer/session`, { method: 'DELETE' })

export const officerSignIn = (batchId: string, password: string) =>
  request<{ ok: true; role: string }>(`/api/batches/${batchId}/officer/session`, postJson({ password }))

export const doorSignIn = (batchId: string, password: string) =>
  request<{ ok: true; role: string }>(`/api/batches/${batchId}/door/session`, postJson({ password }))

export { BASE as API_BASE }

// Roll

export type RollPreview = {
  total: number
  eligible: number
  excluded: number
  skipped: number
  shifted: boolean
}

const uploadRoll = (batchId: string, path: string, file: File) => {
  const body = new FormData()
  // The part must be named `file`: that is what routes/roll.ts reads.
  body.append('file', file)
  return request<RollPreview>(`/api/batches/${batchId}${path}`, { method: 'POST', body })
}

export const previewRoll = (batchId: string, file: File) => uploadRoll(batchId, '/roll/preview', file)
export const commitRoll = (batchId: string, file: File) => uploadRoll(batchId, '/roll', file)

/** Counts only: whether a roll exists, never who is on it. */
export type RollSummary = { total: number; eligible: number }
export const getRollSummary = (batchId: string) =>
  request<RollSummary>(`/api/batches/${batchId}/officer/roll/summary`)

// Elections

export type ElectionStatus = 'draft' | 'open' | 'closed'
export type { Candidate } from '@election/core'

export type AdminElection = {
  id: string
  name: string
  seats: number
  status: ElectionStatus
  candidates: import('@election/core').Candidate[]
}

/** Drafts included. The public listing hides them. */
export const listElections = (batchId: string) =>
  request<AdminElection[]>(`/api/batches/${batchId}/officer/elections`)

export const createElection = (batchId: string, name: string, seats: number) =>
  request<{ id: string; name: string; seats: number; status: ElectionStatus }>(
    `/api/batches/${batchId}/elections`,
    postJson({ name, seats }),
  )

export const addCandidate = (batchId: string, electionId: string, name: string) =>
  request<import('@election/core').Candidate>(
    `/api/batches/${batchId}/elections/${electionId}/candidates`,
    postJson({ name }),
  )

export const removeCandidate = (batchId: string, electionId: string, candidateId: string) =>
  request<void>(`/api/batches/${batchId}/elections/${electionId}/candidates/${candidateId}`, {
    method: 'DELETE',
  })

/**
 * Delete an election. The API refuses once a ballot exists
 * (`409 has_ballots`): this removes a mistake, never a vote.
 */
export const deleteElection = (batchId: string, electionId: string) =>
  request<void>(`/api/batches/${batchId}/elections/${electionId}`, { method: 'DELETE' })

export const openElection = (batchId: string, electionId: string) =>
  request<{ id: string; status: ElectionStatus }>(
    `/api/batches/${batchId}/elections/${electionId}/open`,
    { method: 'POST' },
  )

export const closeElection = (batchId: string, electionId: string) =>
  request<{ closed_at: number; ballot_count: number; ballots_sha256: string }>(
    `/api/batches/${batchId}/elections/${electionId}/close`,
    { method: 'POST' },
  )

/** Turnout only. Never a per-candidate figure (spec §4). */
export type Turnout = {
  ballots_cast: number
  voters_checked_in: number
  eligible: number
  added_at_door: number
}

export const getTurnout = (batchId: string, electionId: string) =>
  request<Turnout>(`/api/batches/${batchId}/elections/${electionId}/turnout`)

// Result

/**
 * The stored result document, typed from `@election/core`, so a change to
 * the count's output is a compile error here.
 */
export type ResultDocument = {
  election: { id: string; name: string; seats: number }
  closed_at: number
  ballot_count: number
  ballots_sha256: string
  computed_at: number
  overridden: boolean
  quota: string
  rounds: import('@election/core').Round[]
  winners: import('@election/core').Candidate[]
  tie_breaks: import('@election/core').TieBreakRecord[]
}

export const getResult = (batchId: string, electionId: string) =>
  request<ResultDocument>(`/api/batches/${batchId}/elections/${electionId}/result`)

export type OverrideRequest = { tie_break_id: string; resolved_id: string; reason: string }

export const overrideTieBreak = (batchId: string, electionId: string, body: OverrideRequest) =>
  request<ResultDocument>(
    `/api/batches/${batchId}/elections/${electionId}/result/override`,
    postJson(body),
  )

// Branding and logo

export const updateBranding = (batchId: string, branding: Branding) =>
  request<Branding>(`/api/batches/${batchId}/branding`, patchJson(branding))

export const uploadLogo = (batchId: string, file: File) => {
  const body = new FormData()
  body.append('file', file)
  return request<{ logo_url: string }>(`/api/batches/${batchId}/logo`, { method: 'POST', body })
}

/**
 * The `src` for a society's logo. A stored `logo_url` is root-relative, so it
 * needs the API base: this app is on another origin. `https://` values pass
 * through. Empty means no logo.
 */
export const logoSrc = (logoUrl: string): string =>
  logoUrl === '' || /^https:\/\//i.test(logoUrl) ? logoUrl : `${BASE}${logoUrl}`

// Operator

/**
 * Delete a society and everything in it. Irreversible. Operator key only
 * (see apps/api/src/routes/batches.ts). The key is passed per call and never
 * stored.
 */
export const deleteSociety = (batchId: string, slug: string, superAdminKey: string) =>
  request<void>(`/api/batches/${batchId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-super-admin-key': superAdminKey },
    body: JSON.stringify({ confirm_slug: slug }),
  })

// Door

export type RollEntry = {
  usu_id: string
  first_name: string
  last_name: string
  eligible: number
  checked_in_at: number | null
}

export type Quorum = {
  checked_in: number
  eligible: number
  guests: number
  added_at_door: number
}

export type Guest = { id: string; name: string; note: string | null; checked_in_at: number }

export const getRoll = (batchId: string) => request<RollEntry[]>(`/api/batches/${batchId}/roll`)
export const getQuorum = (batchId: string) => request<Quorum>(`/api/batches/${batchId}/quorum`)

export const checkIn = (batchId: string, usuId: string) =>
  request<{ checked_in: boolean; already: boolean }>(
    `/api/batches/${batchId}/check-in`,
    postJson({ usu_id: usuId }),
  )

export const undoCheckIn = (batchId: string, usuId: string) =>
  request<void>(`/api/batches/${batchId}/check-in/${encodeURIComponent(usuId)}`, { method: 'DELETE' })

export const listGuests = (batchId: string) => request<Guest[]>(`/api/batches/${batchId}/guests`)

export const addGuest = (batchId: string, name: string, note?: string) =>
  request<{ id: string; name: string }>(
    `/api/batches/${batchId}/guests`,
    postJson(note === undefined || note === '' ? { name } : { name, note }),
  )

export const removeGuest = (batchId: string, guestId: string) =>
  request<void>(`/api/batches/${batchId}/guests/${guestId}`, { method: 'DELETE' })

/** A member the export missed, who can vote. A guest (`addGuest`) cannot. */
export const addDoorVoter = (batchId: string, usuId: string, firstName: string, lastName: string) =>
  request<{ usu_id: string; first_name: string; last_name: string }>(
    `/api/batches/${batchId}/voters`,
    postJson({ usu_id: usuId, first_name: firstName, last_name: lastName }),
  )
