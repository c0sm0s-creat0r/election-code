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
        /**
         * 401 *and* 403 both mean "not signed in as this role".
         *
         * `requireRole` answers 403 when you hold a valid session for a different
         * role on the same batch — an officer opening the door desk, say. Treating
         * that as signed-in was a real defect: the desk rendered, every request it
         * made came back 403, and the screen showed "that session does not have
         * permission to do this" with no way to sign in.
         *
         * A network failure or a 503 still is not a reason to ask for a password;
         * that would train someone to retype it at a broken server.
         */
        const status = caught instanceof ApiError ? caught.status : 0
        setState(status === 401 || status === 403 ? 'signed-out' : 'signed-in')
      })
    return () => { live = false }
  }, [batchId, probe])

  const confirm = useCallback(() => setState('signed-in'), [])
  const forget = useCallback(() => setState('signed-out'), [])

  return { state, confirm, forget }
}
