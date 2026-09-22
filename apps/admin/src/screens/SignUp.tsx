/**
 * A society registering itself.
 *
 * **Nothing here verifies anyone.** The system sends no email, so it cannot, and
 * the screen says as much rather than implying the registration was approved.
 * What protects an election is not this form — it is that a new society starts
 * with an empty roll and can only enfranchise the members it imports.
 *
 * The two passwords are shown back once, because PBKDF2 makes them
 * unrecoverable and losing the officer one means losing the society.
 */
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { signUpSociety, type Batch } from '../api.js'
import { staffMessage } from '../errorMessage.js'

/** Matches the API's floor in routes/batches.ts. */
const PASSWORD_MIN = 6

/** A usable slug from a society's name, so nobody has to guess the rules. */
const toSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

export function SignUp() {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [officerPassword, setOfficerPassword] = useState('')
  const [doorPassword, setDoorPassword] = useState('')
  const [accent, setAccent] = useState('#2563eb')
  const [created, setCreated] = useState<Batch | undefined>(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const effectiveSlug = slugEdited ? slug : toSlug(name)
  const ready =
    name.trim() !== '' &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(effectiveSlug) &&
    officerPassword.length >= PASSWORD_MIN &&
    doorPassword.length >= PASSWORD_MIN &&
    officerPassword !== doorPassword

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      setCreated(await signUpSociety({
        name: name.trim(),
        slug: effectiveSlug,
        officer_password: officerPassword,
        door_password: doorPassword,
        branding: {
          title: `${name.trim()} election`,
          org_name: name.trim(),
          accent_color: accent,
          logo_url: '',
        },
      }))
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <section className="stack">
        <h2>{created.name} is registered</h2>

        <p className="rule-note">
          <strong>Write both passwords down now.</strong> They are hashed and cannot be recovered or
          reset. Losing the officer password means losing control of this society.
        </p>

        <h3>Where to go</h3>
        <ul className="counts plain-list">
          <li>
            Officers: <code>/b/{created.slug}</code>
          </li>
          <li>
            Check-in volunteers: <code>/b/{created.slug}/door</code>
          </li>
          <li>
            Voters: the voter site, at <code>/{created.slug}</code>
          </li>
        </ul>

        <p>
          <Link to={`/b/${created.slug}`}>Sign in as an officer</Link>
        </p>
      </section>
    )
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>Register a society</h2>

      <p className="rule-note">
        Registering is open to anyone and <strong>nothing here checks who you are</strong>. A new
        society starts with no members: only the people you import from your membership export can
        vote.
      </p>

      {error !== '' && <p className="error" role="alert">{error}</p>}

      <div className="field">
        <label htmlFor="society-name">Society name</label>
        <input id="society-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="society-slug">Web address</label>
        <input
          id="society-slug"
          value={effectiveSlug}
          onChange={(e) => { setSlugEdited(true); setSlug(e.target.value) }}
        />
        <p className="muted">
          Voters will go to <code>/{effectiveSlug || 'your-society'}</code>. Lowercase letters,
          numbers and hyphens.
        </p>
      </div>

      <div className="field">
        <label htmlFor="officer-pw">Officer password</label>
        <input
          id="officer-pw"
          type="password"
          autoComplete="new-password"
          value={officerPassword}
          onChange={(e) => setOfficerPassword(e.target.value)}
        />
        <p className="muted">
          At least {PASSWORD_MIN} characters. Full control of every election.
        </p>
      </div>

      <div className="field">
        <label htmlFor="door-pw">Check-in desk password</label>
        <input
          id="door-pw"
          type="password"
          autoComplete="new-password"
          value={doorPassword}
          onChange={(e) => setDoorPassword(e.target.value)}
        />
        <p className="muted">
          At least {PASSWORD_MIN} characters, and different from the officer password — it is typed on
          volunteers' phones and grants check-in only.
        </p>
      </div>

      <div className="field">
        <label htmlFor="accent">Accent colour</label>
        <input id="accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
      </div>

      <button type="submit" className="primary" disabled={!ready || busy}>
        {busy ? 'Registering…' : 'Register society'}
      </button>
    </form>
  )
}
