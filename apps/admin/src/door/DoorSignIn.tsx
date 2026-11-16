/**
 * Door sign-in. The door password grants check-in and the quorum count only:
 * no elections, candidates or tally.
 */
import { doorSignIn } from '../api.js'
import { PasswordForm } from '../components/PasswordForm.js'

export function DoorSignIn({ batchId, onSignedIn }: { batchId: string; onSignedIn: () => void }) {
  return (
    <PasswordForm
      id="door-password"
      heading="Check-in desk"
      label="Check-in desk password"
      signIn={(password) => doorSignIn(batchId, password)}
      onSignedIn={onSignedIn}
    />
  )
}
