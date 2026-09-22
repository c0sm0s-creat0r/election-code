/**
 * The sealed result: winners, the round-by-round table, every tie-break, and the
 * digest that ties it to the exported ballots.
 *
 * There is no "compute" button. The count runs when the result is first
 * requested and is then stored, so this screen renders a record rather than an
 * opinion — which is also what makes an override a *new* versioned row instead
 * of a silent change to an old answer.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, getResult, overrideTieBreak, type OverrideRequest, type ResultDocument } from '../api.js'
import { staffMessage } from '../errorMessage.js'
import { Link } from 'react-router'
import { RoundsTable } from '../components/RoundsTable.js'
import { Exports } from './Exports.js'
import { TieBreaks } from '../components/TieBreaks.js'

export type ResultProps = { batchId: string; electionId: string; slug: string }

export function Result({ batchId, electionId, slug }: ResultProps) {
  const [result, setResult] = useState<ResultDocument | undefined>(undefined)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    getResult(batchId, electionId)
      .then(setResult)
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError && caught.status === 409
            ? 'There is no result until voting is closed and the ballots are sealed.'
            : staffMessage(caught),
        )
      })
  }, [batchId, electionId])

  useEffect(load, [load])

  const applyOverride = async (request: OverrideRequest) => {
    setError('')
    try {
      setResult(await overrideTieBreak(batchId, electionId, request))
    } catch (caught) {
      setError(staffMessage(caught))
    }
  }

  // The only screen deep enough to need one; everywhere else the nav is enough.
  const back = <p><Link to={`/b/${slug}/elections`}>← All elections</Link></p>

  if (error !== '') {
    return (
      <section className="stack">
        {back}
        <h2>Result</h2>
        <p className="error" role="alert">{error}</p>
      </section>
    )
  }

  if (!result) return <p className="muted">Loading the result…</p>

  // Candidate list for the tie-break labels, taken from the count's own first
  // round so it matches exactly what was counted.
  const candidates = (result.rounds[0]?.counts ?? []).map((count) => ({
    id: count.candidateId,
    name: count.name,
  }))

  return (
    <section className="stack">
      {back}
      <h2>{result.election.name}</h2>

      {result.overridden && (
        <p className="rule-note">
          This result supersedes an earlier one after a tie-break override. Both are kept.
        </p>
      )}

      <h3>Elected</h3>
      <ol className="winners">
        {result.winners.map((winner) => (
          <li key={winner.id}>{winner.name}</li>
        ))}
      </ol>

      <RoundsTable rounds={result.rounds} quota={result.quota} />

      <TieBreaks tieBreaks={result.tie_breaks} candidates={candidates} onOverride={applyOverride} />

      <Exports batchId={batchId} electionId={electionId} />

      <h3>The seal</h3>
      <p className="muted">
        {result.ballot_count} ballots were in the box when voting closed, including any that were
        cancelled. Anyone can recompute this digest from the exported ballot CSV and confirm they
        hold the sealed ballots.
      </p>
      <p className="figures seed">{result.ballots_sha256}</p>
    </section>
  )
}
