/**
 * The door route's entry point: what a volunteer's phone needs and nothing
 * the officer needs. App.tsx imports it dynamically, so it is its own chunk.
 *
 * The door asks for its password every time. The device is passed around a
 * desk, and probing for a session stalls when the holder has an officer
 * cookie (403, not 401). An expired session returns here with a reason.
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
