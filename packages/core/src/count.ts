import { type Fixed, SCALE, ZERO, format } from './fixed.js'
import { droopQuota } from './quota.js'
import { countback, deriveSeed, seededDraw, type History } from './tiebreak.js'
import type {
  CandidateStatus,
  CountInput,
  CountResult,
  Round,
  TieBreakKind,
  TieBreakRecord,
} from './types.js'

type Paper = { id: string; preferences: string[]; weight: Fixed }

export async function count(input: CountInput): Promise<CountResult> {
  const { candidates, seats, electionId, ballotsSha256 } = input
  const overrides = input.overrides ?? {}
  const nameOf = new Map(candidates.map((c) => [c.id, c.name]))

  const status = new Map<string, CandidateStatus>(candidates.map((c) => [c.id, 'continuing']))
  const piles = new Map<string, Paper[]>(candidates.map((c) => [c.id, []]))
  let nonTransferable: Fixed = ZERO

  const quota = droopQuota(input.ballots.length, seats)
  const initialTotal = BigInt(input.ballots.length) * SCALE

  // No ballots means no election. Without this guard the exclusion path in
  // Task 8 whittles the field down to one candidate and "elects" them on
  // zero votes.
  if (input.ballots.length === 0) {
    return { quota: format(quota), rounds: [], winners: [], tieBreaks: [] }
  }

  const rounds: Round[] = []
  const tieBreaks: TieBreakRecord[] = []
  const history: History = []
  const winners: string[] = []
  let tieCounter = 0

  const continuing = () => candidates.filter((c) => status.get(c.id) === 'continuing')
  const totalOf = (id: string) =>
    (piles.get(id) ?? []).reduce<Fixed>((s, p) => s + p.weight, ZERO)

  /** Move a paper to its next continuing preference, or to non-transferable. */
  const place = (paper: Paper) => {
    for (const pref of paper.preferences) {
      if (status.get(pref) === 'continuing') {
        piles.get(pref)!.push(paper)
        return
      }
    }
    nonTransferable += paper.weight
  }

  // round 1: every ballot at full value to its highest continuing preference
  for (const b of input.ballots) {
    place({ id: b.id, preferences: b.preferences, weight: SCALE })
  }

  const resolveTie = async (
    tied: string[],
    kind: TieBreakKind,
    roundNo: number,
  ): Promise<string> => {
    const id = `tb-${++tieCounter}`
    const override = overrides[id]
    if (override && tied.includes(override)) {
      tieBreaks.push({
        id, kind, round: roundNo, candidates: tied, resolved: override,
        method: 'officer_override', resolvedAtRound: null, seed: null,
        reason: 'Officer override',
      })
      return override
    }
    const back = countback(tied, history, kind)
    if (back) {
      tieBreaks.push({
        id, kind, round: roundNo, candidates: tied, resolved: back.winner,
        method: 'countback', resolvedAtRound: back.atRound, seed: null, reason: null,
      })
      return back.winner
    }
    const seed = await deriveSeed(electionId, ballotsSha256, id)
    const drawn = await seededDraw(tied, seed, id)
    tieBreaks.push({
      id, kind, round: roundNo, candidates: tied, resolved: drawn,
      method: 'seeded_draw', resolvedAtRound: null, seed, reason: null,
    })
    return drawn
  }

  const recordRound = (
    n: number,
    elected: Round['elected'],
    excluded: Round['excluded'],
  ) => {
    const snapshot = new Map<string, Fixed>()
    const counts = candidates.map((c) => {
      const votes = totalOf(c.id)
      snapshot.set(c.id, votes)
      return {
        candidateId: c.id,
        name: c.name,
        votes: format(votes),
        status: status.get(c.id)!,
      }
    })
    history.push(snapshot)

    const sum = counts.reduce<Fixed>((s, c) => s + snapshot.get(c.candidateId)!, ZERO)
    if (sum + nonTransferable !== initialTotal) {
      throw new Error(
        `count: votes not conserved at round ${n}: ` +
          `${format(sum)} + ${format(nonTransferable)} != ${format(initialTotal)}`,
      )
    }

    rounds.push({ n, counts, elected, excluded, nonTransferable: format(nonTransferable) })
  }

  let n = 0
  while (winners.length < seats) {
    n++
    const cont = continuing()
    if (cont.length === 0) { recordRound(n, [], []); break }

    // elect everyone at or above quota, highest first
    const atQuota = cont
      .map((c) => ({ c, votes: totalOf(c.id) }))
      .filter((x) => x.votes >= quota)

    if (atQuota.length > 0) {
      const top = atQuota.reduce((a, b) => (b.votes > a.votes ? b : a))
      const peers = atQuota.filter((x) => x.votes === top.votes)
      const chosenId =
        peers.length > 1
          ? await resolveTie(peers.map((p) => p.c.id), 'election_order', n)
          : top.c.id

      status.set(chosenId, 'elected')
      winners.push(chosenId)
      const surplus = totalOf(chosenId) - quota
      // surplus transfer arrives in Task 7; for now the pile is retained
      recordRound(n, [{
        candidateId: chosenId,
        name: nameOf.get(chosenId)!,
        surplus: format(surplus),
        transferValue: '0.00000',
      }], [])
      continue
    }

    // nobody at quota: if the continuing candidates exactly fill the
    // remaining seats, elect them all and stop
    if (cont.length <= seats - winners.length) {
      for (const c of cont) { status.set(c.id, 'elected'); winners.push(c.id) }
      recordRound(n, cont.map((c) => ({
        candidateId: c.id, name: c.name, surplus: '0.00000', transferValue: '0.00000',
      })), [])
      break
    }

    // exclusion arrives in Task 8
    recordRound(n, [], [])
    break
  }

  return {
    quota: format(quota),
    rounds,
    winners: winners.map((id) => ({ id, name: nameOf.get(id)! })),
    tieBreaks,
  }
}
