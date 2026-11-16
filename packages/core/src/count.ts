import { type Fixed, SCALE, ZERO, format } from './fixed.js'
import { bulkExclusionSet } from './exclusion.js'
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

  const rounds: Round[] = []
  const tieBreaks: TieBreakRecord[] = []
  const history: History = []
  const winners: string[] = []
  let tieCounter = 0
  const appliedOverrides = new Set<string>()

  // The override matches no tie-break, so the count changed after the officer
  // decided. Throw.
  const assertOverridesConsumed = () => {
    for (const key of Object.keys(overrides)) {
      if (!appliedOverrides.has(key)) {
        throw new Error(
          `count: override for tie-break ${key} was not applied - this count ` +
            `has no tie-break with that id. The count may have changed since ` +
            `the override was recorded; no result was produced.`,
        )
      }
    }
  }

  const candidateIds = new Set(candidates.map((c) => c.id))

  // A ballot ranking no real candidate could elect the last one standing on
  // zero votes.
  const anyLivePreference = input.ballots.some((b) =>
    b.preferences.some((p) => candidateIds.has(p)),
  )
  if (!anyLivePreference) {
    assertOverridesConsumed()
    return { quota: format(quota), rounds: [], winners: [], tieBreaks: [] }
  }

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

  // Round 1: each ballot at full value to its first continuing preference.
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
    if (override) {
      // As with an unmatched override: the decision was for a different count.
      if (!tied.includes(override.candidateId)) {
        throw new Error(
          `count: override for tie-break ${id} names ${override.candidateId}, ` +
            `who is not among that tie-break's candidates ` +
            `(${tied.join(', ')}). No result was produced.`,
        )
      }
      appliedOverrides.add(id)
      tieBreaks.push({
        id, kind, round: roundNo, candidates: tied, resolved: override.candidateId,
        method: 'officer_override', resolvedAtRound: null, seed: null,
        reason: override.reason,
      })
      return override.candidateId
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
    const drawn = await seededDraw(tied, seed)
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

  // Run before each surplus distribution: no continuing candidate may be at or
  // above quota (CEA s273(8)). Not run at round end, where an exclusion
  // transfer can lift someone to quota for the next round.
  const assertNoContinuingAtQuota = (n: number) => {
    for (const c of continuing()) {
      const votes = totalOf(c.id)
      if (votes >= quota) {
        throw new Error(
          `count: round ${n}: ${c.id} is still continuing while holding ` +
            `${format(votes)} >= quota ${format(quota)}`,
        )
      }
    }
  }

  let n = 0
  while (winners.length < seats) {
    n++
    const cont = continuing()
    if (cont.length === 0) { recordRound(n, [], []); break }

    // A round is a cascade: elect everyone at quota, distribute the largest
    // pending surplus, elect anyone it lifted to quota, repeat. Distributing all
    // surpluses against frozen statuses would move a seat.
    const electedRecords: Round['elected'] = []
    const pending: { id: string; record: Round['elected'][number] }[] = []

    const electAtQuota = async (): Promise<void> => {
      const remainingSeats = seats - winners.length
      if (remainingSeats <= 0) return

      const atQuota = continuing()
        .map((c) => ({ id: c.id, votes: totalOf(c.id) }))
        .filter((x) => x.votes >= quota)
      if (atQuota.length === 0) return

      // Highest total first. Equal totals take an `election_order` tie-break,
      // since this is also the surplus distribution order. The `remainingSeats`
      // cap cannot bite in a conserved count.
      const pool = [...atQuota]
      const electionOrder: string[] = []
      while (pool.length > 0 && electionOrder.length < remainingSeats) {
        const top = pool.reduce((a, b) => (b.votes > a.votes ? b : a))
        const peers = pool.filter((x) => x.votes === top.votes)
        const chosenId =
          peers.length > 1
            ? await resolveTie(peers.map((p) => p.id), 'election_order', n)
            : top.id
        electionOrder.push(chosenId)
        pool.splice(pool.findIndex((x) => x.id === chosenId), 1)
      }

      for (const id of electionOrder) {
        status.set(id, 'elected')
        winners.push(id)
        // Surplus and transfer value are set at distribution. Push now to keep
        // `elected` in election order.
        const record = {
          candidateId: id,
          name: nameOf.get(id)!,
          surplus: format(ZERO),
          transferValue: format(ZERO),
        }
        electedRecords.push(record)
        pending.push({ id, record })
      }
    }

    await electAtQuota()

    if (electedRecords.length > 0) {
      while (pending.length > 0) {
        assertNoContinuingAtQuota(n)

        // Largest pending surplus first. Ties go to the earlier entry (election order).
        let bestIndex = 0
        let bestTotal = totalOf(pending[0]!.id)
        for (let i = 1; i < pending.length; i++) {
          const votes = totalOf(pending[i]!.id)
          if (votes > bestTotal) {
            bestTotal = votes
            bestIndex = i
          }
        }
        const next = pending.splice(bestIndex, 1)[0]!
        const surplus = bestTotal - quota
        const pile = piles.get(next.id) ?? []

        // Inclusive Gregory: transfer value = surplus / papers, applied to every
        // paper. One value per distribution, checkable by hand.
        let transferValue: Fixed = ZERO
        if (surplus > ZERO && pile.length > 0) {
          transferValue = surplus / BigInt(pile.length)

          // The elected candidate keeps exactly the quota, as one placeholder paper.
          piles.set(next.id, [{ id: `${next.id}-quota`, preferences: [], weight: quota }])
          for (const paper of pile) place({ ...paper, weight: transferValue })

          // Truncation loses a fraction per paper. Book it as non-transferable so the
          // count conserves.
          nonTransferable += surplus - transferValue * BigInt(pile.length)
        }
        // Zero surplus: the papers stay, and the total is already quota.

        next.record.surplus = format(surplus)
        next.record.transferValue = format(transferValue)

        // s273(8): anyone that transfer lifted to quota is elected at this count.
        await electAtQuota()
      }

      recordRound(n, electedRecords, [])
      continue
    }

    // Nobody at quota. If the continuing candidates exactly fill the remaining
    // seats, elect them all and stop.
    if (cont.length <= seats - winners.length) {
      for (const c of cont) { status.set(c.id, 'elected'); winners.push(c.id) }
      recordRound(n, cont.map((c) => ({
        candidateId: c.id, name: c.name, surplus: '0.00000', transferValue: '0.00000',
      })), [])
      break
    }

    // Nobody at quota: exclude the lowest, in bulk where safe.
    const remainingSeats = seats - winners.length
    const maxExcludable = Math.max(1, cont.length - remainingSeats)
    const totals = cont.map((c) => ({ id: c.id, votes: totalOf(c.id) }))

    let toExclude = bulkExclusionSet(totals, maxExcludable)

    // A single exclusion among tied-lowest candidates needs a tie-break.
    if (toExclude.length === 1) {
      const lowest = totals.reduce((a, b) => (b.votes < a.votes ? b : a)).votes
      const tiedLowest = totals.filter((t) => t.votes === lowest).map((t) => t.id)
      if (tiedLowest.length > 1) {
        toExclude = [await resolveTie(tiedLowest, 'exclusion', n)]
      }
    }

    const excludedRecord = toExclude.map((id) => ({ candidateId: id, name: nameOf.get(id)! }))
    for (const id of toExclude) status.set(id, 'excluded')
    for (const id of toExclude) {
      const pile = piles.get(id) ?? []
      piles.set(id, [])
      for (const paper of pile) place(paper) // at current weight
    }

    recordRound(n, [], excludedRecord)
  }

  assertOverridesConsumed()

  return {
    quota: format(quota),
    rounds,
    winners: winners.map((id) => ({ id, name: nameOf.get(id)! })),
    tieBreaks,
  }
}
