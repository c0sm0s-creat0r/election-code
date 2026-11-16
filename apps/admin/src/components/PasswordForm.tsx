/**
 * A sign-in form for one password. The password is typed with people standing
 * nearby, so it never appears in an error message or stays in state.
 */
import { useState, type FormEvent } from 'react'
import { signInMessage } from '../errorMessage.js'

type PasswordFormProps = {
  id: string
  heading: string
  label: string
  signIn: (password: string) => Promise<unknown>
  onSignedIn: () => void
}

export function PasswordForm({ id, heading, label, signIn, onSignedIn }: PasswordFormProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password === '' || busy) return
    setBusy(true)
    setError('')
    try {
      await signIn(password)
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
      <h2>{heading}</h2>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
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
