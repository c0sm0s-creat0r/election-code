/**
 * The exports, each labelled with what it proves.
 *
 * Plain download links, not fetches: a navigation sends the session cookie
 * and streams the file to disk.
 */
import { API_BASE } from '../api.js'

export type ExportsProps = { batchId: string; electionId: string | undefined }

export function Exports({ batchId, electionId }: ExportsProps) {
  const base = `${API_BASE}/api/batches/${batchId}`
  return (
    <section className="stack">
      <h3>{electionId === undefined ? 'Exports' : 'Download this election'}</h3>

      {electionId !== undefined && (
        <ul className="export-list plain-list">
          <li>
            <a href={`${base}/elections/${electionId}/ballots.csv`}>Ballots (CSV)</a>
            <span className="muted">
              The ballots. Also allows for the seal digest to be recomputed.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/candidates.csv`}>Candidates (CSV)</a>
            <span className="muted">
              The candidates in the election.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/result.json`}>Sealed result (JSON)</a>
            <span className="muted">
              The count result every round. Includies tie-breaks and reasoning.
            </span>
          </li>
          <li>
            <a href={`${base}/elections/${electionId}/attendance.csv`}>Attendance for this election (CSV)</a>
            <span className="muted">
              Who voted. Doesn't include how they voted.
            </span>
          </li>
        </ul>
      )}

      {/* Only when no election is named: these files cover the whole AGM. */}
      {electionId === undefined && (
        <ul className="export-list plain-list">
          <li>
            <a href={`${base}/attendance.csv`}>Voters in every election (CSV)</a>
            <span className="muted">
              Who voted in each election, one row per vote. Doesn't include how they voted.
            </span>
          </li>
          <li>
            <a href={`${base}/check-ins.csv`}>Checked-in members (CSV)</a>
            <span className="muted">
              Everyone checked in at the desk, whether or not they voted. Download for the minutes.
            </span>
          </li>
          <li>
            <a href={`${base}/guests.csv`}>Guests (CSV)</a>
            <span className="muted">
              People who attended and could not vote. Download as needed.
            </span>
          </li>
        </ul>
      )}
    </section>
  )
}
