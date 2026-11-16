/**
 * The round-by-round count, as a table a scrutineer can check on paper: one
 * column per round, one row per candidate, figures tabular and right-aligned,
 * with the non-transferable total. Typed from `@election/core`'s `Round`.
 */
import type { Round } from '@election/core'

export type RoundsTableProps = { rounds: Round[]; quota: string }

export function RoundsTable({ rounds, quota }: RoundsTableProps) {
  const first = rounds[0]
  if (!first) return <p className="muted">This count produced no rounds.</p>

  // The first round fixes the order, so each candidate keeps one row.
  const order = first.counts.map((count) => ({ id: count.candidateId, name: count.name }))
  const valueIn = (round: Round, candidateId: string) =>
    round.counts.find((count) => count.candidateId === candidateId)

  return (
    <div className="rounds-scroll">
      <table className="rounds">
        <caption>
          Quota <span className="figures">{quota}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">Candidate</th>
            {rounds.map((round) => (
              <th scope="col" key={round.n}>
                Round {round.n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((candidate) => (
            <tr key={candidate.id}>
              <th scope="row">{candidate.name}</th>
              {rounds.map((round) => {
                const cell = valueIn(round, candidate.id)
                return (
                  <td className="figures" key={round.n} data-status={cell?.status}>
                    {cell ? cell.votes : '—'}
                    {cell?.status === 'elected' && <span aria-label="elected"> ✓</span>}
                    {cell?.status === 'excluded' && <span aria-label="excluded"> ✕</span>}
                  </td>
                )
              })}
            </tr>
          ))}
          <tr className="non-transferable">
            <th scope="row">Non-transferable</th>
            {rounds.map((round) => (
              <td className="figures" key={round.n}>
                {round.nonTransferable}
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {rounds.some((round) => round.elected.length > 0) && (
        <>
          <h4>Surpluses distributed</h4>
          <ul className="counts plain-list">
            {rounds.flatMap((round) =>
              round.elected.map((elected) => (
                <li key={`${round.n}-${elected.candidateId}`}>
                  Round {round.n}: {elected.name} elected with a surplus of{' '}
                  <span className="figures">{elected.surplus}</span>, transferred at{' '}
                  <span className="figures">{elected.transferValue}</span>
                </li>
              )),
            )}
          </ul>
        </>
      )}
    </div>
  )
}
