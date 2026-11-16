/**
 * Officer sign-in. The password is typed with people standing behind the
 * laptop, so it never appears in an error message or stays in state.
 */
import { useState, type FormEvent } from 'react'
import { officerSignIn } from '../api.js'
import { signInMessage } from '../errorMessage.js'

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
      // Cleared before moving on. Nothing downstream needs it.
      setPassword('')
      onSignedIn()
    } catch (caught) {
      setError(signInMessage(caught))
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
