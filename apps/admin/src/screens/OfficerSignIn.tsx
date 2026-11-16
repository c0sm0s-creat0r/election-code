import { officerSignIn } from '../api.js'
import { PasswordForm } from '../components/PasswordForm.js'

export function OfficerSignIn({ batchId, onSignedIn }: { batchId: string; onSignedIn: () => void }) {
  return (
    <PasswordForm
      id="officer-password"
      heading="Officer sign in"
      label="Password"
      signIn={(password) => officerSignIn(batchId, password)}
      onSignedIn={onSignedIn}
    />
  )
}
