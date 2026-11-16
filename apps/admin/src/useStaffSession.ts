import { useEffect, useState } from 'react'
import { ApiError, probeOfficer } from './api.js'

/**
 * Whether the officer session is live, according to the server. Component
 * state is lost on reload, back navigation and new tabs while the cookie is
 * still valid.
 *
 * `checking` stops the sign-in form flashing at someone already signed in.
 */
type SessionState = 'checking' | 'signed-in' | 'signed-out'

export function useStaffSession(batchId: string | undefined) {
  const [state, setState] = useState<SessionState>('checking')

  useEffect(() => {
    if (batchId === undefined) return
    let live = true
    probeOfficer(batchId)
      .then(() => { if (live) setState('signed-in') })
      .catch((caught: unknown) => {
        if (!live) return
        // 401 and 403 both mean "not signed in as this role" (403 is a valid session
        // for another role). A network failure or a 503 does not call for a
        // password.
        const status = caught instanceof ApiError ? caught.status : 0
        setState(status === 401 || status === 403 ? 'signed-out' : 'signed-in')
      })
    return () => { live = false }
  }, [batchId])

  return { state, confirm: () => setState('signed-in'), forget: () => setState('signed-out') }
}
