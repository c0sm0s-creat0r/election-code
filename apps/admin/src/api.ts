/**
 * The admin app's API client.
 *
 * Deliberately not shared with the voter app. The two overlap on one endpoint out
 * of thirty-three (spec §1.1), so a common package would couple their release
 * cycles to save thirty lines. The `ApiError`/`request` pair below is duplicated
 * on purpose, and that duplication is the cheaper of the two costs.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

/** `status` 0 means the request never completed — no HTTP status ever arrived. */
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
    // Without `credentials: 'include'` the session cookie is never sent and every
    // authenticated call fails in a way that looks like a CORS problem (spec §1).
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

export type Branding = { title: string; org_name: string; accent_color: string; logo_url: string }
export type Batch = { id: string; slug: string; name: string; branding: Branding }

export const getBatchBySlug = (slug: string) =>
  request<Batch>(`/api/batches/by-slug/${encodeURIComponent(slug)}`)

export const officerSignIn = (batchId: string, password: string) =>
  request<{ ok: true; role: string }>(`/api/batches/${batchId}/officer/session`, postJson({ password }))

export const doorSignIn = (batchId: string, password: string) =>
  request<{ ok: true; role: string }>(`/api/batches/${batchId}/door/session`, postJson({ password }))

export { request as apiRequest, postJson as apiPostJson, BASE as API_BASE }

// --- roll ------------------------------------------------------------------

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

// --- elections -------------------------------------------------------------

export type ElectionStatus = 'draft' | 'open' | 'closed'
export type Candidate = { id: string; name: string }

export type AdminElection = {
  id: string
  name: string
  seats: number
  status: ElectionStatus
  candidates: Candidate[]
}

export const listPublicElections = (batchId: string) =>
  request<AdminElection[]>(`/api/batches/${batchId}/elections`)

export const createElection = (batchId: string, name: string, seats: number) =>
  request<{ id: string; name: string; seats: number; status: ElectionStatus }>(
    `/api/batches/${batchId}/elections`,
    postJson({ name, seats }),
  )

export const addCandidate = (batchId: string, electionId: string, name: string) =>
  request<Candidate>(
    `/api/batches/${batchId}/elections/${electionId}/candidates`,
    postJson({ name }),
  )

export const renameCandidate = (batchId: string, electionId: string, candidateId: string, name: string) =>
  request<Candidate>(`/api/batches/${batchId}/elections/${electionId}/candidates/${candidateId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })

export const removeCandidate = (batchId: string, electionId: string, candidateId: string) =>
  request<void>(`/api/batches/${batchId}/elections/${electionId}/candidates/${candidateId}`, {
    method: 'DELETE',
  })

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

/**
 * Turnout, and only turnout. Three counts plus the provenance of the fourth.
 * There is deliberately no per-candidate figure here and there must never be
 * one: an officer who can watch the result develop makes every other control
 * decorative (spec §4).
 */
export type Turnout = {
  ballots_cast: number
  voters_checked_in: number
  eligible: number
  added_at_door: number
}

export const getTurnout = (batchId: string, electionId: string) =>
  request<Turnout>(`/api/batches/${batchId}/elections/${electionId}/turnout`)

// --- result ----------------------------------------------------------------

/**
 * The stored result document. `rounds`, `winners` and `tie_breaks` are typed from
 * `@election/core`'s own exports, so a change to what the count produces is a
 * compile error here rather than a silently wrong table.
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
