/**
 * The door route's entry point, and the reason this directory exists separately:
 * everything a volunteer's phone needs, and nothing the officer needs.
 *
 * Imported dynamically by `App.tsx`, so Vite emits it as its own chunk.
 */
import { useState } from 'react'
import type { Batch } from '../api.js'
import { DoorSignIn } from './DoorSignIn.js'
import { DoorDesk } from './DoorDesk.js'

export function DoorRoute({ batch }: { batch: Batch }) {
  const [signedIn, setSignedIn] = useState(false)
  return signedIn
    ? <DoorDesk batchId={batch.id} />
    : <DoorSignIn batchId={batch.id} onSignedIn={() => setSignedIn(true)} />
}
