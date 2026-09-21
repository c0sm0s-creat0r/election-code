/**
 * Voter sign-in: USU id and surname, both matching the roll.
 *
 * Both are required because looking a voter up by a seven-digit id alone and
 * echoing their name back would be an enumeration oracle over the whole roll
 * (spec §4). Nothing on this screen ever renders a name that came from a failed
 * attempt — a test asserts it.
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
    // Guarded as well as disabled: the form can also be submitted by the phone
    // keyboard's Go key, which does not consult a button's disabled attribute.
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
        {/* inputMode numeric opens the number pad; the value stays a string,
            because the API takes a string and leading zeros must survive. */}
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

      <div class="submit-bar">
        <button type="submit" class="primary submit" disabled={!ready || busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  )
}
