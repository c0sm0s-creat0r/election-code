import { vi } from 'vitest'

/** A JSON response. */
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Stubs fetch with a handler and returns the spy. */
export const stubFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const spy = vi.fn(async (url: string, init?: RequestInit) => respond(url, init))
  vi.stubGlobal('fetch', spy)
  return spy
}

/** Every request gets the same answer. */
export const stub = (status: number, body: unknown) => stubFetch(() => json(status, body))

/** No request completes. */
export const stubOffline = () => stubFetch(() => { throw new TypeError('Failed to fetch') })

/**
 * The test environment's `localStorage` is a stub with no methods, so a test
 * that needs storage supplies its own. The rest pass without one because
 * every storage access is guarded.
 */
export const stubStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  })
}
