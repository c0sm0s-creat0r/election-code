/**
 * The exports, each labelled with what it proves.
 *
 * **Plain download links, not fetches.** A navigation carries the session cookie
 * and lets the browser stream the file to disk, so a multi-megabyte ballot CSV
 * never sits in a laptop's memory mid-AGM. (`Content-Disposition` is exposed by
 * the API's CORS config if a fetch is ever genuinely needed.)
 *
 * The labels matter as much as the links. These files are the answer to "prove
 * it", and an officer handing one over should know which question it answers.
 */
import { API_BASE } from '../api.js'

export type ExportsProps = { batchId: string; electionId: string | undefined }

export function Exports({ batchId, electionId }: ExportsProps) {
  const base = `${API_BASE}/api/batches/${batchId}`
  return (
    <section className="stack">
      <h2>Exports</h2>

      {electionId !== undefined && (
        <ul className="export-list">
          <li>
            <a href={`${base}/elections/${electionId}/ballots.csv`}>Ballots (CSV)</a>
            <span className="muted">
              The anonymous ballot box. Carries the <code>voided</code> column, so anyone can
              recompute the seal digest from this file alone and confirm these are the sealed ballots.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/candidates.csv`}>Candidates (CSV)</a>
            <span className="muted">
              Needed alongside the ballots: a recount refuses a preference naming a candidate it has
              not been given, so the ballots alone cannot be replayed.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/result.json`}>Sealed result (JSON)</a>
            <span className="muted">
              The count as stored, with every round, every tie-break and its reasoning.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/attendance.csv`}>Attendance for this election (CSV)</a>
            <span className="muted">
              Who voted — never how. Includes <code>added_at_door</code>, so the total carries its
              provenance.
            </span>
          </li>
        </ul>
      )}

      <ul className="export-list">
        <li>
          <a href={`${base}/attendance.csv`}>Attendance across the AGM (CSV)</a>
          <span className="muted">Every election's mark-off in one file, for the minutes.</span>
        </li>
        <li>
          <a href={`${base}/guests.csv`}>Guests (CSV)</a>
          <span className="muted">
            People who attended and could not vote. Separate from attendance on purpose — attendance
            is about voting.
          </span>
        </li>
      </ul>
    </section>
  )
}
