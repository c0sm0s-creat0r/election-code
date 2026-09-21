/**
 * The five endpoints this app touches, over `fetch`.
 *
 * Deliberately not shared with the admin app — see the note in
 * `apps/admin/src/api.ts` for the reasoning.
 *
 * Every failure reaches a screen as an `ApiError` carrying the API's own `code`
 * when there is one, so screens map a code to a remedy rather than printing a
 * message they did not write (spec §3).
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

/**
 * `status` 0 means the request never completed — a phone losing wifi — which the
 * ballot screen must treat differently from every HTTP status, because the vote
 * may have been recorded anyway (spec §4.4).
 */
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
    // `credentials: 'include'` is not optional. Without it the browser never
    // sends the session cookie, and every authenticated call fails in a way
    // indistinguishable from a CORS misconfiguration (spec §1).
    res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init })
  } catch {
    throw new ApiError(0, 'network', 'We could not reach the server.')
  }

  // Every API failure is JSON — the API's app.onError guarantees it — but a
  // proxy or gateway in front of it may not be, so a parse failure must not
  // become a different error than the status it arrived with.
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

export type Branding = {
  title: string
  org_name: string
  accent_color: string
  logo_url: string
}

export type Batch = { id: string; slug: string; name: string; branding: Branding }

export type PublicElection = {
  id: string
  name: string
  seats: number
  status: 'open' | 'closed'
  candidates: { id: string; name: string }[]
}

export const getBatchBySlug = (slug: string) =>
  request<Batch>(`/api/batches/by-slug/${encodeURIComponent(slug)}`)

export const getElections = (batchId: string) =>
  request<PublicElection[]>(`/api/batches/${batchId}/elections`)

export const voterSignIn = (batchId: string, usuId: string, surname: string) =>
  request<{ first_name: string }>(
    `/api/batches/${batchId}/voter/session`,
    postJson({ usu_id: usuId, surname }),
  )

/**
 * The voter's `usu_id` is carried by the session cookie and never appears in the
 * body (spec §5), so a caller cannot nominate whose ballot this is.
 */
export const submitBallot = (batchId: string, electionId: string, preferences: string[]) =>
  request<{ receipt_token: string }>(
    `/api/batches/${batchId}/elections/${electionId}/ballots`,
    postJson({ preferences }),
  )

/** Inclusion only. The API does not return preferences, so there are none to render. */
export const getReceipt = (token: string) =>
  request<{ status: 'recorded' | 'voided'; election_name: string }>(
    `/api/receipts/${encodeURIComponent(token)}`,
  )

export const voidReceipt = (token: string) =>
  request<{ status: string }>(`/api/receipts/${encodeURIComponent(token)}/void`, { method: 'POST' })
