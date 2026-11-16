import { vi } from 'vitest'

/** A JSON response. A null body sends none, as a 204 does. */
export const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })

/** Stubs fetch with a handler and returns the spy. */
export const stubFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  const spy = vi.fn(async (url: string, init?: RequestInit) => respond(url, init))
  vi.stubGlobal('fetch', spy)
  return spy
}

/** Every request gets the same answer. */
export const stub = (status: number, body: unknown) => stubFetch(() => json(status, body))

/**
 * Replaces both browser stores and returns a spy on every write. A spy, not
 * inspection: it catches a write whatever backs the store.
 */
export const spyOnStorage = () => {
  const setItem = vi.fn()
  const fake = {
    setItem, getItem: () => null, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
  }
  vi.stubGlobal('localStorage', fake)
  vi.stubGlobal('sessionStorage', fake)
  return setItem
}
