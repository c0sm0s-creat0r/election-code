/**
 * Branding and the society logo. The API checks the logo's contents, not its
 * filename. Its rejection message is shown as-is.
 */
import { useState } from 'react'
import { updateBranding, uploadLogo, type Branding } from '../api.js'
import { staffMessage } from '../errorMessage.js'

export type SettingsProps = { batchId: string; branding: Branding; onSaved: (next: Branding) => void }

export function Settings({ batchId, branding, onSaved }: SettingsProps) {
  const [draft, setDraft] = useState<Branding>(branding)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const field = (key: keyof Branding, label: string, type = 'text') => (
    <div className="field">
      <label htmlFor={`branding-${key}`}>{label}</label>
      <input
        id={`branding-${key}`}
        type={type}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </div>
  )

  const save = async () => {
    setError('')
    setNote('')
    try {
      const saved = await updateBranding(batchId, draft)
      onSaved(saved)
      setNote('Branding saved.')
    } catch (caught) {
      setError(staffMessage(caught))
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError('')
    setNote('')
    try {
      const { logo_url } = await uploadLogo(batchId, file)
      const next = { ...draft, logo_url }
      setDraft(next)
      onSaved(next)
      setNote('Logo uploaded.')
    } catch (caught) {
      setError(staffMessage(caught))
    }
  }

  return (
    <section className="stack">
      <h2>Appearance</h2>

      {error !== '' && <p className="error" role="alert">{error}</p>}
      {note !== '' && <p className="ok-note">{note}</p>}

      {field('title', 'Page title')}
      {field('org_name', 'Organisation name')}
      {field('accent_color', 'Accent colour', 'color')}

      <button type="button" className="primary" onClick={() => void save()}>
        Save branding
      </button>

      <div className="field">
        <label htmlFor="logo-file">Logo (PNG, JPEG, GIF or WebP)</label>
        <input
          id="logo-file"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </div>
      <p className="muted">
        The file's contents are checked, not its name — an image renamed to
        <code>.png</code> is still refused if it is not one.
      </p>
    </section>
  )
}
