/**
 * The door route's entry point, and the reason this directory exists separately:
 * everything a volunteer's phone needs, and nothing the officer needs.
 *
 * Imported dynamically by `App.tsx`, so Vite emits it as its own chunk.
 *
 * Whether the volunteer is signed in comes from the server, not from component
 * state. A door shift outlasts a page reload, and asking the phone to re-enter the
 * password every time one happens is the difference between a usable queue and a
 * stalled one. `/quorum` doubles as the probe: it is door-gated and four integers.
 */
import type { Batch } from '../api.js'
import { probeDoor } from '../api.js'
import { useStaffSession } from '../useStaffSession.js'
import { DoorSignIn } from './DoorSignIn.js'
import { DoorDesk } from './DoorDesk.js'

export function DoorRoute({ batch }: { batch: Batch }) {
  const { state, confirm } = useStaffSession(batch.id, probeDoor)

  if (state === 'checking') return <p className="muted">Loading…</p>
  if (state === 'signed-out') return <DoorSignIn batchId={batch.id} onSignedIn={confirm} />
  return <DoorDesk batchId={batch.id} />
}
