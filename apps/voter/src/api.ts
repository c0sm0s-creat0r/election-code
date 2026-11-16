/**
 * The endpoints this app calls, over `fetch`. Not shared with the admin app
 * (see apps/admin/src/api.ts).
 *
 * Every failure is an `ApiError` with the API's `code` when there is one, so
 * screens map a code to a remedy.
 */

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'

/**
 * `status` 0 means the request never completed. The ballot screen handles
 * that separately: the vote may have been recorded.
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
    // Without `credentials: 'include'` the session cookie is not sent.
    res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init })
  } catch {
    throw new ApiError(0, 'network', 'We could not reach the server.')
  }

  // The API always answers JSON. A proxy in front of it may not.
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

/** Slug, name and branding only. For the society picker. */
export const listSocieties = () => request<Omit<Batch, 'id'>[]>('/api/batches')

export const getBatchBySlug = (slug: string) =>
  request<Batch>(`/api/batches/by-slug/${encodeURIComponent(slug)}`)

export const getElections = (batchId: string) =>
  request<PublicElection[]>(`/api/batches/${batchId}/elections`)

/**
 * The `src` for a society's logo. A stored `logo_url` is root-relative, so it
 * needs the API base: this app is on another origin. `https://` values pass
 * through. Empty means no logo.
 */
export const logoSrc = (logoUrl: string): string =>
  logoUrl === '' || /^https:\/\//i.test(logoUrl) ? logoUrl : `${BASE}${logoUrl}`

export const voterSignIn = (batchId: string, usuId: string, surname: string) =>
  request<{ first_name: string }>(
    `/api/batches/${batchId}/voter/session`,
    postJson({ usu_id: usuId, surname }),
  )

/** The usu_id comes from the session cookie, never the body. */
export const submitBallot = (batchId: string, electionId: string, preferences: string[]) =>
  request<{ receipt_token: string }>(
    `/api/batches/${batchId}/elections/${electionId}/ballots`,
    postJson({ preferences }),
  )

/** Inclusion only. The API does not return preferences. */
export const getReceipt = (token: string) =>
  request<{ status: 'recorded' | 'voided'; election_name: string }>(
    `/api/receipts/${encodeURIComponent(token)}`,
  )

export const voidReceipt = (token: string) =>
  request<{ status: string }>(`/api/receipts/${encodeURIComponent(token)}/void`, { method: 'POST' })
