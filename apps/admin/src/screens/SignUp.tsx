/**
 * A society registering itself.
 *
 * Nothing here verifies anyone, and the screen says so. A new society starts
 * with an empty roll and can enfranchise only the members it imports.
 *
 * The two passwords are shown once: they cannot be recovered.
 *
 * The logo uploads after registration. The upload needs an officer session,
 * so the screen signs in with the password just typed. A refused logo does
 * not undo the registration.
 */
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { logoSrc, officerSignIn, signUpSociety, uploadLogo, type Batch } from '../api.js'
import { staffMessage } from '../errorMessage.js'

/** Matches the API's minimum in routes/batches.ts. */
const PASSWORD_MIN = 6

/** Derives a valid slug from the society's name. */
const toSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

export function SignUp() {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [officerPassword, setOfficerPassword] = useState('')
  const [doorPassword, setDoorPassword] = useState('')
  const [accent, setAccent] = useState('#2563eb')
  const [logo, setLogo] = useState<File | undefined>(undefined)
  const [logoError, setLogoError] = useState('')
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
    setLogoError('')
    try {
      const batch = await signUpSociety({
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
      })
      if (logo) {
        try {
          await officerSignIn(batch.id, officerPassword)
          const { logo_url } = await uploadLogo(batch.id, logo)
          batch.branding = { ...batch.branding, logo_url }
        } catch (caught) {
          setLogoError(staffMessage(caught))
        }
      }
      setCreated(batch)
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <section className="stack">
        {created.branding.logo_url && (
          <img className="society-logo" src={logoSrc(created.branding.logo_url)} alt="" />
        )}
        <h2>{created.name} is registered</h2>

        {logoError !== '' && (
          <p className="error" role="alert">
            The society was registered, but the logo was not: {logoError} You can add one later from
            Appearance once signed in.
          </p>
        )}

        <p className="rule-note">
          <strong>Make sure you've written down your passwords!</strong>
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
        Fill in your society's details below. All except the passwords can be later changed if needed in <strong>appearance</strong> tab.
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
          At least {PASSWORD_MIN} characters. Main access password for the Returning Officer.
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
          At least {PASSWORD_MIN} characters, and different from the officer password. Used by an executive to check people in at the door.
        </p>
      </div>

      <div className="field">
        <label htmlFor="accent">Accent colour</label>
        <input id="accent" type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="logo-file">Logo (optional)</label>
        <input
          id="logo-file"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => setLogo(e.target.files?.[0])}
        />
        <p className="muted">
          PNG, JPEG, GIF or WebP file.
        </p>
      </div>

      <button type="submit" className="primary" disabled={!ready || busy}>
        {busy ? 'Registering…' : 'Register society'}
      </button>
    </form>
  )
}
