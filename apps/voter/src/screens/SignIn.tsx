/**
 * Voter sign-in: USU id and surname, both matching the roll. A lookup by id
 * alone would map ids to names, so a failed attempt renders no name.
 */
import { useState } from 'preact/hooks'
import { voterSignIn } from '../api.js'
import { signInMessage } from '../errorMessage.js'

export type SignInProps = {
  batchId: string
  onSignedIn: (firstName: string) => void
}

export function SignIn({ batchId, onSignedIn }: SignInProps) {
  const [usuId, setUsuId] = useState('')
  const [surname, setSurname] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const ready = usuId.trim() !== '' && surname.trim() !== ''

  const submit = async (event: Event) => {
    event.preventDefault()
    // The keyboard's Go key submits even when the button is disabled.
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      const { first_name } = await voterSignIn(batchId, usuId.trim(), surname.trim())
      onSignedIn(first_name)
    } catch (caught) {
      setError(signInMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="stack" onSubmit={submit}>
      <h2>Sign in to vote</h2>

      <div class="field">
        <label for="usu-id">USU ID</label>
        {/* numeric keypad; the value stays a string, so leading zeros survive */}
        <input
          id="usu-id"
          name="usu-id"
          inputMode="numeric"
          autocomplete="off"
          value={usuId}
          onInput={(e) => setUsuId((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <label for="surname">Surname</label>
        <input
          id="surname"
          name="surname"
          autocomplete="family-name"
          value={surname}
          onInput={(e) => setSurname((e.target as HTMLInputElement).value)}
        />
      </div>

      {error !== '' && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <div class="submit-bar sticky-bar">
        <button type="submit" class="primary submit" disabled={!ready || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  )
}
