/**
 * Importing the USU member export: preview, then commit.
 *
 * The preview exists so a human sees the counts *before* anything is written. A
 * third-party export that silently drops members is the failure it catches —
 * which is why `skipped` is shown even when it is zero, and raised as a warning
 * when it is not. A number that only appears when it is bad is a number nobody
 * learns to look for.
 */
import { useState } from 'react'
import { previewRoll, commitRoll, type RollPreview } from '../api.js'
import { staffMessage } from '../errorMessage.js'

export type RollImportProps = { batchId: string }

export function RollImport({ batchId }: RollImportProps) {
  const [file, setFile] = useState<File | undefined>(undefined)
  const [preview, setPreview] = useState<RollPreview | undefined>(undefined)
  const [imported, setImported] = useState<RollPreview | undefined>(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const choose = async (chosen: File | undefined) => {
    setFile(chosen)
    setPreview(undefined)
    setImported(undefined)
    setError('')
    if (!chosen) return
    setBusy(true)
    try {
      setPreview(await previewRoll(batchId, chosen))
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await commitRoll(batchId, file)
      setImported(result)
      setPreview(undefined)
    } catch (caught) {
      setError(staffMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const counts = preview ?? imported

  return (
    <section className="stack">
      <h2>Member roll</h2>

      <div className="field">
        <label htmlFor="roll-file">USU member export (CSV)</label>
        <input
          id="roll-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </div>

      {error !== '' && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {counts && (
        <>
          <ul className="counts">
            <li>{counts.total} members in the file</li>
            <li>{counts.eligible} eligible</li>
            <li>{counts.excluded} excluded (left the group)</li>
            <li>{counts.skipped} skipped</li>
          </ul>

          {counts.skipped > 0 && (
            <p className="error" role="alert">
              {counts.skipped} row(s) were skipped because their columns did not line up. Those
              members will <strong>not</strong> be able to vote. Check the export before importing.
            </p>
          )}

          {counts.shifted && (
            <p className="muted">
              This export had the known column-shift defect and was realigned automatically.
            </p>
          )}
        </>
      )}

      {preview && (
        <button type="button" className="primary" disabled={busy} onClick={commit}>
          {busy ? 'Importing…' : 'Import this roll'}
        </button>
      )}

      {imported && <p className="ok-note">Roll imported. {imported.eligible} members can vote.</p>}
    </section>
  )
}
