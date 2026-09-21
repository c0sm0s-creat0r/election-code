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
