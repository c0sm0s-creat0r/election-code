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

  /**
   * An override that matched nothing is not a harmless no-op. The realistic
   * path is that an officer overrides `tb-2`, the count is then re-run after a
   * ballot is voided or re-exported, and `tb-2` is now a different tie among
   * different candidates. Falling through to the countback would tell the
   * officer their decision stands while the result document records
   * `method: "seeded_draw"` - the audit log and the sealed result would
   * disagree about whether a human touched the count. Refuse instead.
   */
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

  // No live ballot means no election. Guarding only on `ballots.length === 0`
  // misses the case this comment describes: three papers that rank nobody (or
  // rank only people who are not candidates) are three ballots, but they put
  // no vote on any candidate, so the exclusion path whittles the field down to
  // one and "elects" them on 0.00000 votes. The quota is still reported,
  // because it is computed from the ballot count and is a fact about the
  // election either way.
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
    if (override) {
      // An override naming somebody who is not in this tie is the same
      // failure as an override naming a tie that no longer exists: the
      // officer decided something about a different count. Refuse loudly
      // rather than quietly falling through to the countback.
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

  /**
   * The C1 invariant, enforced rather than remembered: once a round's
   * elections have been declared, no CONTINUING candidate may still be sitting
   * at or above the quota.
   *
   * Commonwealth Electoral Act s273(8) elects a candidate who equals or
   * exceeds the quota AT THAT COUNT, and s273(1) then stops them being a
   * "continuing candidate". So a surplus distributed afterwards must skip
   * them. Electing only the leader and leaving a second quota-holder
   * continuing pours the leader's surplus onto someone who has already been
   * paid their quota, who re-transfers it by THEIR preferences - and that
   * moves a seat.
   *
   * This is checked here, immediately after the elect step and before a single
   * paper moves, rather than at the end of `recordRound`. End-of-round is not a
   * sound place for it: a transfer made DURING a round - an exclusion's papers
   * or an elected candidate's surplus - can legitimately lift a continuing
   * candidate to quota, and that candidate is elected at the next count. The
   * existing exclusion test is exactly that shape (a reaches 6.00000 = quota on
   * c's exclusion in round 1 and is elected in round 2). Asserting at the end of
   * the round would throw on a correct count; asserting here catches precisely
   * the bug, and nothing else.
   */
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

    // Elect EVERY candidate at or above quota this round, highest first, and
    // do it before a single paper moves. See assertNoContinuingAtQuota above
    // for why electing only the leader changes who wins.
    const atQuota = cont
      .map((c) => ({ id: c.id, votes: totalOf(c.id) }))
      .filter((x) => x.votes >= quota)

    if (atQuota.length > 0) {
      const remainingSeats = seats - winners.length

      /*
       * Descending by total. Where totals are EQUAL the order is settled by an
       * `election_order` tie-break, because that order is not cosmetic: it is
       * the order the surpluses are distributed in, and distributing A's
       * surplus before B's can change which papers B's own transfer value is
       * computed over. The tie-break is recorded like any other, so the result
       * document explains the ordering it used.
       *
       * The cap at `remainingSeats` cannot bite in a conserved count - (k+m)
       * candidates at quota implies (k+m) * quota <= total < (seats+1) * quota
       * - but it is kept so that a corrupted state fails closed rather than
       * over-filling the chamber.
       */
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
      }
      assertNoContinuingAtQuota(n)

      /**
       * Inclusive Gregory Method, as the Australian Senate uses:
       * transfer value = surplus / NUMBER of papers, and every paper moves
       * at that value regardless of the value it arrived with.
       *
       * One transfer value per distribution is what keeps a printed round
       * table checkable by hand. The known cost is that a paper which
       * arrived at a low value can transfer onward at a higher one.
       *
       * Each elected candidate's surplus is read after all of them are marked
       * elected, so an earlier surplus cannot inflate a later one: `place()`
       * skips anyone who is no longer continuing.
       */
      const electedRecords: Round['elected'] = []
      for (const chosenId of electionOrder) {
        const surplus = totalOf(chosenId) - quota
        const pile = piles.get(chosenId) ?? []

        let transferValue: Fixed = ZERO
        if (surplus > ZERO && pile.length > 0) {
          transferValue = surplus / BigInt(pile.length)

          // The elected candidate retains exactly the quota. Without this the
          // conservation check fails, because totalOf() reads the pile.
          piles.set(chosenId, [{ id: `${chosenId}-quota`, preferences: [], weight: quota }])
          for (const paper of pile) place({ ...paper, weight: transferValue })

          // Truncating the transfer value loses a fraction of a vote per paper.
          // Real counts call this loss by fraction; it is booked as
          // non-transferable so the conservation invariant stays exact.
          nonTransferable += surplus - transferValue * BigInt(pile.length)
        }
        // surplus of zero: the papers stay put, and the total is already quota

        electedRecords.push({
          candidateId: chosenId,
          name: nameOf.get(chosenId)!,
          surplus: format(surplus),
          transferValue: format(transferValue),
        })
      }

      recordRound(n, electedRecords, [])
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

    // nobody at quota: exclude the lowest, in bulk where provably safe
    const remainingSeats = seats - winners.length
    const maxExcludable = Math.max(1, cont.length - remainingSeats)
    const totals = cont.map((c) => ({ id: c.id, votes: totalOf(c.id) }))

    let toExclude = bulkExclusionSet(totals, maxExcludable)

    // a single exclusion among tied-lowest candidates needs a tie-break
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
