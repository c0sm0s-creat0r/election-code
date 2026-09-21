/**
 * Every tie the count had to resolve, and the officer's power to overrule one.
 *
 * **The control is labelled from the tie's `kind`, and this is the whole reason
 * the API field was renamed from `winner_id` to `resolved_id`.** For
 * `kind: 'exclusion'` the id in `TieBreakRecord.resolved` is the candidate
 * **excluded** — the one who loses. A control saying "pick the winner" would
 * collect the exact opposite of the officer's intent, and the resulting sealed
 * document would look perfectly correct.
 *
 * The seed is shown because spec §3 makes the draw verifiable: anyone holding the
 * sealed ballots can re-derive it and check it was not steered.
 */
import { useState } from 'react'
import type { TieBreakKind, TieBreakRecord } from '@election/core'
import type { Candidate, OverrideRequest } from '../api.js'

export type TieBreaksProps = {
  tieBreaks: TieBreakRecord[]
  candidates: Candidate[]
  onOverride: (request: OverrideRequest) => void
}

/** The one place the asymmetry is written down for the UI. */
const promptFor = (kind: TieBreakKind): string =>
  kind === 'exclusion' ? 'Choose who is excluded' : 'Choose who is elected first'

const outcomeFor = (kind: TieBreakKind, name: string): string =>
  kind === 'exclusion' ? `${name} was excluded` : `${name} was elected first`

export function TieBreaks({ tieBreaks, candidates, onOverride }: TieBreaksProps) {
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [resolvedId, setResolvedId] = useState('')
  const [reason, setReason] = useState('')

  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? id

  if (tieBreaks.length === 0) {
    return (
      <section className="stack">
        <h3>Tie-breaks</h3>
        <p className="muted">This count had no ties to resolve.</p>
      </section>
    )
  }

  return (
    <section className="stack">
      <h3>Tie-breaks</h3>

      {tieBreaks.map((tie) => (
        <div className="tie-break stack" key={tie.id}>
          <p>
            <strong>Round {tie.round}</strong> · {tie.candidates.map(nameOf).join(' and ')} were level.{' '}
            {outcomeFor(tie.kind, nameOf(tie.resolved))} by{' '}
            {tie.method === 'countback'
              ? 'countback'
              : tie.method === 'seeded_draw'
                ? 'a seeded draw'
                : 'the returning officer'}
            .
          </p>

          {tie.method === 'seeded_draw' && tie.seed !== null && (
            <p className="muted figures seed">
              Seed: {tie.seed}
            </p>
          )}

          {tie.method === 'officer_override' && tie.reason !== null && (
            <p className="muted">Reason given: {tie.reason}</p>
          )}

          {editing === tie.id ? (
            <div className="override stack">
              <p>
                An override does not change this result. It writes a{' '}
                <strong>new</strong> one that supersedes it, and <strong>both are kept</strong>, so
                the change stays visible with both counts attached.
              </p>

              <div className="field">
                <label htmlFor={`resolved-${tie.id}`}>{promptFor(tie.kind)}</label>
                <select
                  id={`resolved-${tie.id}`}
                  value={resolvedId}
                  onChange={(e) => setResolvedId(e.target.value)}
                >
                  <option value="">—</option>
                  {tie.candidates.map((id) => (
                    <option value={id} key={id}>
                      {nameOf(id)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor={`reason-${tie.id}`}>Reason (recorded in the result)</label>
                <input
                  id={`reason-${tie.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              <button
                type="button"
                className="primary"
                disabled={resolvedId === '' || reason.trim() === ''}
                onClick={() =>
                  onOverride({ tie_break_id: tie.id, resolved_id: resolvedId, reason: reason.trim() })
                }
              >
                Save override
              </button>
              <button type="button" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditing(tie.id)
                setResolvedId('')
                setReason('')
              }}
            >
              Override this tie-break
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
