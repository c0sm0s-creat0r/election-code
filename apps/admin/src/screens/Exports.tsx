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

      {/* Only when no election was named. The whole-AGM files have their own
          screen; repeating them under every election's result would suggest they
          were about that election. */}
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
