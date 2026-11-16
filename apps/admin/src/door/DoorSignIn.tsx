/**
 * Door sign-in. The door password grants check-in and the quorum count only:
 * no elections, candidates or tally.
 */
import { useState, type FormEvent } from 'react'
import { doorSignIn } from '../api.js'
import { signInMessage } from '../errorMessage.js'

export function DoorSignIn({ batchId, onSignedIn }: { batchId: string; onSignedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await doorSignIn(batchId, password)
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
      <h2>Check-in desk</h2>
      <div className="field">
        <label htmlFor="door-password">Check-in desk password</label>
        <input
          id="door-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error !== '' && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={password === '' || busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}
