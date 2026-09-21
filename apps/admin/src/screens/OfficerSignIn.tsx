/**
 * Officer sign-in.
 *
 * The password grants full control of an election, and it is typed on a laptop in
 * a hall with people standing behind it — so the field is `type="password"` and
 * its value never reaches an error message or the DOM after a failure.
 */
import { useState, type FormEvent } from 'react'
import { officerSignIn } from '../api.js'
import { staffMessage } from '../errorMessage.js'

export type OfficerSignInProps = {
  batchId: string
  onSignedIn: () => void
}

export function OfficerSignIn({ batchId, onSignedIn }: OfficerSignInProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await officerSignIn(batchId, password)
      // Cleared before handing control on: nothing downstream needs it, and it
      // should not sit in state for the rest of the session.
      setPassword('')
      onSignedIn()
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>Officer sign in</h2>
      <div className="field">
        <label htmlFor="officer-password">Password</label>
        <input
          id="officer-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error !== '' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={password === '' || busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
