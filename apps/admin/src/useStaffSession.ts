import { useCallback, useEffect, useState } from 'react'
import { ApiError } from './api.js'

/**
 * Whether a staff session is live, according to the server.
 *
 * The problem this replaces: `signedIn` used to be `useState(false)`, so every
 * full page load — and the menu was plain `<a href>` links, so *every*
 * navigation was one — reset it and demanded the password again, while the cookie
 * sat there valid the whole time. Browser back was the worst case: it re-mounted
 * the app and asked again.
 *
 * Deriving it from a probe fixes all of those at once, including a reload, a new
 * tab, and the session genuinely lapsing at its TTL.
 *
 * `checking` matters: rendering the sign-in form while the probe is in flight
 * would flash a password prompt at somebody who is already signed in.
 */
export type SessionState = 'checking' | 'signed-in' | 'signed-out'

export function useStaffSession(batchId: string | undefined, probe: (batchId: string) => Promise<unknown>) {
  const [state, setState] = useState<SessionState>('checking')

  useEffect(() => {
    if (batchId === undefined) return
    let live = true
    probe(batchId)
      .then(() => { if (live) setState('signed-in') })
      .catch((caught: unknown) => {
        if (!live) return
        // Only a 401 means "not signed in". A network failure or a 503 is not a
        // reason to ask for a password — that would train someone to retype it
        // at a broken server.
        setState(caught instanceof ApiError && caught.status === 401 ? 'signed-out' : 'signed-in')
      })
    return () => { live = false }
  }, [batchId, probe])

  const confirm = useCallback(() => setState('signed-in'), [])
  const forget = useCallback(() => setState('signed-out'), [])

  return { state, confirm, forget }
}
