/**
 * The door route's entry point, and the reason this directory exists separately:
 * everything a volunteer's phone needs, and nothing the officer needs.
 *
 * Imported dynamically by `App.tsx`, so Vite emits it as its own chunk.
 *
 * **The door asks for its password every time, deliberately.** It is the one
 * screen on a device that gets handed round a desk, and it briefly probed for an
 * existing session instead — which stalled: an officer opening the door desk holds
 * an officer cookie, `requireRole` answers 403 rather than 401 for a valid session
 * of the wrong role, and the desk rendered anyway and then failed every request
 * with "that session does not have permission to do this", with nothing to click.
 *
 * Signing in each time removes that state entirely. It also means a lapsed session
 * mid-shift returns here rather than leaving the volunteer stuck: `DoorDesk`
 * reports a 401 or 403 upward and the form comes back with a reason.
 */
import { useState } from 'react'
import type { Batch } from '../api.js'
import { DoorSignIn } from './DoorSignIn.js'
import { DoorDesk } from './DoorDesk.js'

export function DoorRoute({ batch }: { batch: Batch }) {
  const [signedIn, setSignedIn] = useState(false)
  const [note, setNote] = useState('')

  if (!signedIn) {
    return (
      <>
        {note !== '' && <p className="rule-note">{note}</p>}
        <DoorSignIn batchId={batch.id} onSignedIn={() => { setNote(''); setSignedIn(true) }} />
      </>
    )
  }

  return (
    <DoorDesk
      batchId={batch.id}
      slug={batch.slug}
      onSessionLost={() => {
        setSignedIn(false)
        setNote('Your door session ended. Please enter the door password again to carry on.')
      }}
    />
  )
}
