# packages/core — Counting Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dependency-free TypeScript library that counts Australian STV elections, validates ballots, and imports the USU member export — so a disputed count can be re-run offline on a laptop.

**Architecture:** An npm workspace package with no runtime dependencies. Fixed-point integer arithmetic underpins everything; the count is a pure function from candidates plus ballots to a round-by-round result. Single-winner IRV is `seats = 1`, not a separate path.

**Tech Stack:** npm workspaces, TypeScript 5.x (strict), Vitest, `globalThis.crypto.subtle` for SHA-256. No other runtime dependencies.

**Toolchain ruling (2026-09-16):** the plan originally specified pnpm. pnpm is not installed on this machine and Node 25 no longer bundles corepack, so using it would require a global install outside the repo. npm 11.6.2 is present, npm workspaces cover everything this plan needs, and npm matches the house style in the sibling notforsale.sydney project. Cost if wrong: pnpm's stricter dependency isolation is lost, and commands read `npm run -w @election/core test` rather than `pnpm -F`.

**Spec:** `docs/superpowers/specs/2026-09-16-election-code-rewrite-design.md`

**Plan 1 of 3.** Plan 2 is `apps/api`; Plan 3 is the two frontends. Both depend on this package and neither is started until this one's tests pass.

## Global Constraints

- **Zero runtime dependencies in `packages/core`.** Devtime only: `typescript`, `vitest`. Adding anything else requires justification in the commit message.
- **Node 20+.** `globalThis.crypto.subtle` must exist without an import.
- TypeScript `strict: true`. No `any` in exported signatures.
- **Fixed-point: 5 decimal places, truncated toward zero.** Never floating point for vote values. `number` appears only in display helpers.
- **Surplus transfers use the Inclusive Gregory Method** — transfer value is surplus divided by the *number* of papers, and every paper transfers at that value, replacing its previous weight.
- **Quota is Droop:** `floor(valid_ballots / (seats + 1)) + 1`, computed once from the initial valid total and never recomputed.
- **Minimum preferences = `min(seats, candidateCount)`.** Shorter ballots are invalid.
- Invariant asserted at every round: `sum(candidate totals) + nonTransferable === initial valid total`.
- TDD throughout: write the failing test, watch it fail, then implement. Commit after every task.

---

### Task 1: Workspace and package scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm run -w @election/core test` command that later tasks rely on

- [ ] **Step 1: Write the failing test**

`packages/core/tests/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('package scaffold', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('1.0.0')
  })

  it('has crypto.subtle available without an import', () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test`
Expected: FAIL — cannot resolve `../src/index.js`

- [ ] **Step 3: Write minimal implementation**

Root `package.json` (npm workspaces — no separate workspace file):

```json
{
  "name": "election-code",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

`packages/core/package.json`:

```json
{
  "name": "@election/core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
})
```

`packages/core/src/index.ts`:

```ts
export const VERSION = '1.0.0'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npm run -w @election/core test`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json packages/core package-lock.json
git commit -m "chore: scaffold npm workspace and packages/core"
```

---

### Task 2: Fixed-point arithmetic

Vote values are fractional once surpluses transfer, and floating point drift can flip a seat. This module is the foundation for every later task.

**Files:**
- Create: `packages/core/src/fixed.ts`
- Test: `packages/core/tests/fixed.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type Fixed = bigint`, `SCALE`, `fromInt(n: number): Fixed`, `mul(a: Fixed, b: Fixed): Fixed`, `div(a: Fixed, b: Fixed): Fixed`, `format(f: Fixed): string`, `ZERO: Fixed`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/fixed.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SCALE, ZERO, fromInt, mul, div, format } from '../src/fixed.js'

describe('fixed-point', () => {
  it('scales integers by 100000', () => {
    expect(fromInt(1)).toBe(100_000n)
    expect(fromInt(0)).toBe(ZERO)
    expect(SCALE).toBe(100_000n)
  })

  it('formats to exactly five decimal places', () => {
    expect(format(fromInt(1))).toBe('1.00000')
    expect(format(0n)).toBe('0.00000')
    expect(format(133_333n)).toBe('1.33333')
    expect(format(50n)).toBe('0.00050')
  })

  it('divides with truncation, never rounding', () => {
    // 1 / 3 = 0.333333... truncates to 0.33333, NOT 0.33334
    expect(div(fromInt(1), fromInt(3))).toBe(33_333n)
    // 2 / 3 = 0.666666... truncates to 0.66666, NOT 0.66667
    expect(div(fromInt(2), fromInt(3))).toBe(66_666n)
  })

  it('multiplies with truncation', () => {
    expect(mul(fromInt(2), fromInt(3))).toBe(fromInt(6))
    // 0.33333 * 0.33333 = 0.1111088889 -> truncates to 0.11110
    expect(mul(33_333n, 33_333n)).toBe(11_110n)
  })

  it('never accumulates drift across repeated division', () => {
    // the whole reason this module exists
    let acc = ZERO
    const third = div(fromInt(1), fromInt(3))
    for (let i = 0; i < 3; i++) acc += third
    expect(acc).toBe(99_999n) // exactly, forever - not 0.9999999998
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- fixed`
Expected: FAIL — cannot resolve `../src/fixed.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/fixed.ts`:

```ts
/**
 * Vote values in fixed point: 5 decimal places, truncated toward zero.
 *
 * Matches the Scottish STV rules. Chosen over arbitrary-precision rationals
 * deliberately: a published, fixed rule can be checked by hand on paper,
 * which is the point of the whole audit story. BigInt division truncates
 * toward zero natively, and every value here is non-negative.
 */
export type Fixed = bigint

export const SCALE = 100_000n
export const ZERO: Fixed = 0n

export function fromInt(n: number): Fixed {
  return BigInt(n) * SCALE
}

export function mul(a: Fixed, b: Fixed): Fixed {
  return (a * b) / SCALE
}

export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0n) throw new Error('fixed: division by zero')
  return (a * SCALE) / b
}

export function format(f: Fixed): string {
  const whole = f / SCALE
  const frac = (f % SCALE).toString().padStart(5, '0')
  return `${whole}.${frac}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- fixed`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fixed.ts packages/core/tests/fixed.test.ts
git commit -m "feat(core): fixed-point arithmetic, 5dp truncated"
```

---

### Task 3: Domain types and Droop quota

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/quota.ts`
- Test: `packages/core/tests/quota.test.ts`

**Interfaces:**
- Consumes: `Fixed`, `fromInt` from `fixed.ts`
- Produces: `Candidate`, `CountBallot`, `CandidateStatus`, `RoundCount`, `Round`, `TieBreakRecord`, `CountInput`, `CountResult` from `types.ts`; `droopQuota(validBallots: number, seats: number): Fixed` from `quota.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/quota.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { droopQuota } from '../src/quota.js'
import { format } from '../src/fixed.js'

describe('droop quota', () => {
  it('is floor(valid / (seats + 1)) + 1', () => {
    expect(format(droopQuota(100, 3))).toBe('26.00000') // floor(100/4)+1
    expect(format(droopQuota(101, 3))).toBe('26.00000') // floor(101/4)=25, +1
    expect(format(droopQuota(103, 3))).toBe('26.00000') // floor(103/4)=25, +1
    expect(format(droopQuota(104, 3))).toBe('27.00000') // floor(104/4)=26, +1
  })

  it('collapses to a simple majority at seats = 1', () => {
    // this is why IRV is not a separate code path
    expect(format(droopQuota(100, 1))).toBe('51.00000')
    expect(format(droopQuota(101, 1))).toBe('51.00000')
    expect(format(droopQuota(10, 1))).toBe('6.00000')
  })

  it('is always an exact integer', () => {
    for (const v of [7, 13, 99, 1302]) {
      for (const s of [1, 2, 3, 5]) {
        expect(droopQuota(v, s) % 100_000n).toBe(0n)
      }
    }
  })

  it('rejects nonsense input', () => {
    expect(() => droopQuota(10, 0)).toThrow(/seats/)
    expect(() => droopQuota(-1, 1)).toThrow(/ballots/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- quota`
Expected: FAIL — cannot resolve `../src/quota.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/types.ts`:

```ts
import type { Fixed } from './fixed.js'

export type Candidate = { id: string; name: string }

/** A ballot as the count sees it: preferences already validated. */
export type CountBallot = { id: string; preferences: string[] }

export type CandidateStatus = 'continuing' | 'elected' | 'excluded'

export type RoundCount = {
  candidateId: string
  name: string
  votes: string // Fixed, formatted
  status: CandidateStatus
}

export type Round = {
  n: number
  counts: RoundCount[]
  elected: {
    candidateId: string
    name: string
    surplus: string
    transferValue: string
  }[]
  excluded: { candidateId: string; name: string }[]
  nonTransferable: string // cumulative
}

export type TieBreakKind = 'exclusion' | 'election_order'
export type TieBreakMethod = 'countback' | 'seeded_draw' | 'officer_override'

export type TieBreakRecord = {
  id: string // "tb-1", "tb-2", ... - what the override endpoint references
  kind: TieBreakKind
  round: number
  candidates: string[]
  resolved: string
  method: TieBreakMethod
  resolvedAtRound: number | null
  seed: string | null
  reason: string | null
}

export type CountInput = {
  candidates: Candidate[]
  ballots: CountBallot[]
  seats: number
  electionId: string
  /** hex digest from election_seal; fixes the tie-break draw */
  ballotsSha256: string
  /** tieBreakId -> chosen candidate id, from an officer override */
  overrides?: Record<string, string>
}

export type CountResult = {
  quota: string
  rounds: Round[]
  winners: Candidate[]
  tieBreaks: TieBreakRecord[]
}

export type { Fixed }
```

`packages/core/src/quota.ts`:

```ts
import { type Fixed, fromInt } from './fixed.js'

/**
 * Droop quota, as the Australian Senate uses:
 *   floor(valid ballots / (seats + 1)) + 1
 *
 * Computed once from the initial valid total and never recomputed, so
 * exhausted ballots can leave the final seat filled below quota. That is
 * standard, and handled by the "continuing == remaining seats" rule.
 *
 * At seats = 1 this is floor(n/2) + 1, i.e. an absolute majority - which is
 * why instant-runoff needs no separate implementation.
 */
export function droopQuota(validBallots: number, seats: number): Fixed {
  if (!Number.isInteger(seats) || seats < 1) {
    throw new Error(`droopQuota: seats must be a positive integer, got ${seats}`)
  }
  if (!Number.isInteger(validBallots) || validBallots < 0) {
    throw new Error(`droopQuota: ballots must be a non-negative integer, got ${validBallots}`)
  }
  return fromInt(Math.floor(validBallots / (seats + 1)) + 1)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- quota`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/quota.ts packages/core/tests/quota.test.ts
git commit -m "feat(core): domain types and Droop quota"
```

---

### Task 4: Ballot validation

Enforces the Senate-style minimum decided in the spec: a ballot must rank at least `seats` candidates.

**Files:**
- Create: `packages/core/src/ballot.ts`
- Test: `packages/core/tests/ballot.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type BallotCheck = { ok: true } | { ok: false; reason: string }`, `validateBallot(preferences: string[], candidateIds: readonly string[], seats: number): BallotCheck`, `minimumPreferences(seats: number, candidateCount: number): number`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/ballot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateBallot, minimumPreferences } from '../src/ballot.js'

const CANDIDATES = ['a', 'b', 'c', 'd']

describe('minimumPreferences', () => {
  it('is the seat count', () => {
    expect(minimumPreferences(3, 5)).toBe(3)
  })

  it('never exceeds the number of candidates', () => {
    // 5 seats but only 4 candidates: demanding 5 preferences is unsatisfiable
    expect(minimumPreferences(5, 4)).toBe(4)
  })
})

describe('validateBallot', () => {
  it('accepts a full ranking', () => {
    expect(validateBallot(['a', 'b', 'c', 'd'], CANDIDATES, 2)).toEqual({ ok: true })
  })

  it('accepts a partial ranking at or above the minimum', () => {
    expect(validateBallot(['a', 'b'], CANDIDATES, 2)).toEqual({ ok: true })
    expect(validateBallot(['a', 'b', 'c'], CANDIDATES, 2)).toEqual({ ok: true })
  })

  it('rejects fewer preferences than seats', () => {
    const r = validateBallot(['a'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/at least 2/)
  })

  it('rejects an empty ballot', () => {
    expect(validateBallot([], CANDIDATES, 1).ok).toBe(false)
  })

  it('rejects an unknown candidate', () => {
    const r = validateBallot(['a', 'zzz'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown/i)
  })

  it('rejects a duplicated preference', () => {
    const r = validateBallot(['a', 'a'], CANDIDATES, 2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/duplicate/i)
  })

  it('rejects more preferences than candidates', () => {
    expect(validateBallot(['a', 'b', 'c', 'd', 'a'], CANDIDATES, 2).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- ballot`
Expected: FAIL — cannot resolve `../src/ballot.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/ballot.ts`:

```ts
export type BallotCheck = { ok: true } | { ok: false; reason: string }

/**
 * Senate-style minimum: rank at least as many candidates as there are seats.
 * Capped at the candidate count, because demanding 5 preferences in a
 * 4-candidate field is unsatisfiable.
 */
export function minimumPreferences(seats: number, candidateCount: number): number {
  return Math.min(seats, candidateCount)
}

export function validateBallot(
  preferences: string[],
  candidateIds: readonly string[],
  seats: number,
): BallotCheck {
  const min = minimumPreferences(seats, candidateIds.length)

  if (preferences.length < min) {
    return { ok: false, reason: `Rank at least ${min} candidate(s).` }
  }
  if (preferences.length > candidateIds.length) {
    return { ok: false, reason: 'More preferences than candidates.' }
  }

  const known = new Set(candidateIds)
  const seen = new Set<string>()
  for (const id of preferences) {
    if (!known.has(id)) return { ok: false, reason: `Unknown candidate: ${id}` }
    if (seen.has(id)) return { ok: false, reason: `Duplicate preference: ${id}` }
    seen.add(id)
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- ballot`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ballot.ts packages/core/tests/ballot.test.ts
git commit -m "feat(core): ballot validation with Senate-style minimum"
```

---

### Task 5: Tie-breaking — countback then seeded draw

**Files:**
- Create: `packages/core/src/tiebreak.ts`
- Test: `packages/core/tests/tiebreak.test.ts`

**Interfaces:**
- Consumes: `Fixed` from `fixed.ts`; `TieBreakRecord`, `TieBreakKind` from `types.ts`
- Produces:
  - `type History = Map<string, Fixed>[]` — index 0 is round 1
  - `countback(tied: string[], history: History, kind: TieBreakKind): { winner: string; atRound: number } | null`
  - `seededDraw(tied: string[], seedHex: string, tieBreakId: string): Promise<string>`
  - `deriveSeed(electionId: string, ballotsSha256: string, tieBreakId: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/tiebreak.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { countback, seededDraw, deriveSeed } from '../src/tiebreak.js'
import { fromInt } from '../src/fixed.js'
import type { Fixed } from '../src/fixed.js'

const r = (o: Record<string, number>): Map<string, Fixed> =>
  new Map(Object.entries(o).map(([k, v]) => [k, fromInt(v)]))

describe('countback', () => {
  it('excludes whoever was lower at the last round they differed', () => {
    const history = [r({ a: 10, b: 12 }), r({ a: 15, b: 15 })]
    // for an exclusion, the LOWER candidate at the differing round loses
    expect(countback(['a', 'b'], history, 'exclusion')).toEqual({ winner: 'a', atRound: 1 })
  })

  it('elects whoever was higher at the last round they differed', () => {
    const history = [r({ a: 10, b: 12 }), r({ a: 15, b: 15 })]
    expect(countback(['a', 'b'], history, 'election_order')).toEqual({ winner: 'b', atRound: 1 })
  })

  it('walks backwards and uses the MOST RECENT differing round', () => {
    const history = [r({ a: 1, b: 9 }), r({ a: 8, b: 5 }), r({ a: 15, b: 15 })]
    // round 2 is the most recent difference: a=8 > b=5, so b is excluded
    expect(countback(['a', 'b'], history, 'exclusion')).toEqual({ winner: 'b', atRound: 2 })
  })

  it('returns null when level at every round', () => {
    const history = [r({ a: 5, b: 5 }), r({ a: 9, b: 9 })]
    expect(countback(['a', 'b'], history, 'exclusion')).toBeNull()
  })
})

describe('seededDraw', () => {
  it('is deterministic for the same seed and tie id', async () => {
    const seed = await deriveSeed('election-1', 'abc123', 'tb-1')
    const a = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    const b = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    expect(a).toBe(b)
  })

  it('is independent of the order the tied candidates are passed in', async () => {
    const seed = await deriveSeed('election-1', 'abc123', 'tb-1')
    const a = await seededDraw(['x', 'y', 'z'], seed, 'tb-1')
    const b = await seededDraw(['z', 'y', 'x'], seed, 'tb-1')
    expect(a).toBe(b) // sorted internally, so caller order cannot steer it
  })

  it('always returns one of the tied candidates', async () => {
    for (const id of ['tb-1', 'tb-2', 'tb-3', 'tb-4', 'tb-5']) {
      const seed = await deriveSeed('e', 'deadbeef', id)
      expect(['x', 'y', 'z']).toContain(await seededDraw(['x', 'y', 'z'], seed, id))
    }
  })
})

describe('deriveSeed', () => {
  it('differs per tie-break id', async () => {
    // if it did not, two ties in one count would resolve to the same index
    const s1 = await deriveSeed('e1', 'hash', 'tb-1')
    const s2 = await deriveSeed('e1', 'hash', 'tb-2')
    expect(s1).not.toBe(s2)
  })

  it('differs when the ballot hash differs', async () => {
    const s1 = await deriveSeed('e1', 'hashA', 'tb-1')
    const s2 = await deriveSeed('e1', 'hashB', 'tb-1')
    expect(s1).not.toBe(s2)
  })

  it('is reproducible, so anyone can verify a draw after the fact', async () => {
    expect(await deriveSeed('e1', 'hash', 'tb-1')).toBe(await deriveSeed('e1', 'hash', 'tb-1'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- tiebreak`
Expected: FAIL — cannot resolve `../src/tiebreak.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tiebreak.ts`:

```ts
import type { Fixed } from './fixed.js'
import type { TieBreakKind } from './types.js'

/** Candidate totals per round. Index 0 is round 1. */
export type History = Map<string, Fixed>[]

/**
 * Australian tie rule, step 1: compare totals at the most recent earlier
 * round where they differed. For an exclusion the lower candidate loses;
 * for election order the higher goes first.
 *
 * Returns null when the candidates were level at every round, which is when
 * the seeded draw takes over.
 */
export function countback(
  tied: string[],
  history: History,
  kind: TieBreakKind,
): { winner: string; atRound: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const round = history[i]!
    const totals = tied.map((id) => ({ id, votes: round.get(id) ?? 0n }))
    const distinct = new Set(totals.map((t) => t.votes.toString()))
    if (distinct.size === 1) continue

    const sorted = [...totals].sort((a, b) =>
      a.votes === b.votes ? a.id.localeCompare(b.id) : a.votes < b.votes ? -1 : 1,
    )
    const winner = kind === 'exclusion' ? sorted[0]!.id : sorted[sorted.length - 1]!.id
    return { winner, atRound: i + 1 }
  }
  return null
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * seed = sha256(electionId || ballotsSha256 || tieBreakId)
 *
 * Derived from the SEALED ballots, so anyone can re-derive it and verify the
 * draw, and it cannot be steered without changing the ballots and breaking
 * the seal. The tie-break id is included so two ties within one count do not
 * resolve to the same index.
 */
export function deriveSeed(
  electionId: string,
  ballotsSha256: string,
  tieBreakId: string,
): Promise<string> {
  return sha256Hex(`${electionId}|${ballotsSha256}|${tieBreakId}`)
}

/**
 * Australian tie rule, step 2: a draw. Candidate ids are sorted
 * lexicographically first so the caller's ordering cannot influence the
 * outcome. index = first 8 bytes of the seed, big-endian, mod n.
 */
export async function seededDraw(
  tied: string[],
  seedHex: string,
  _tieBreakId: string,
): Promise<string> {
  const sorted = [...tied].sort((a, b) => a.localeCompare(b))
  const seedInt = BigInt(`0x${seedHex.slice(0, 16)}`)
  const index = Number(seedInt % BigInt(sorted.length))
  return sorted[index]!
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- tiebreak`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tiebreak.ts packages/core/tests/tiebreak.test.ts
git commit -m "feat(core): countback and ballot-seeded tie-break draw"
```

---

### Task 6: The count — first preferences and the terminating rules

Builds the count skeleton: distribute first preferences, record a round, elect anyone at quota, and stop when seats are filled or the continuing candidates exactly fill the remaining seats. Surplus transfers and exclusions come in Tasks 7 and 8.

**Files:**
- Create: `packages/core/src/count.ts`
- Test: `packages/core/tests/count.test.ts`

**Interfaces:**
- Consumes: everything from `fixed.ts`, `quota.ts`, `types.ts`, `tiebreak.ts`
- Produces: `count(input: CountInput): Promise<CountResult>`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/count.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

const base = (over: Partial<CountInput>): CountInput => ({
  candidates: [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cass' },
  ],
  ballots: [],
  seats: 1,
  electionId: 'e1',
  ballotsSha256: 'deadbeef00000000',
  ...over,
})

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('count - first preferences', () => {
  it('elects an outright majority in round 1', async () => {
    const r = await count(
      base({ ballots: ballots([[['a', 'b'], 6], [['b', 'a'], 4]]) }),
    )
    expect(r.quota).toBe('6.00000') // floor(10/2)+1
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
    expect(r.rounds).toHaveLength(1)
    expect(r.rounds[0]!.counts.find((c) => c.candidateId === 'a')!.votes).toBe('6.00000')
  })

  it('elects the remaining candidates when continuing == remaining seats', async () => {
    // 2 seats, 2 candidates: both are elected without anyone reaching quota
    const r = await count(
      base({
        seats: 2,
        candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
        ballots: ballots([[['a', 'b'], 5], [['b', 'a'], 5]]),
      }),
    )
    expect(r.winners.map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('returns no winner and no rounds for zero ballots', async () => {
    const r = await count(base({ ballots: [] }))
    expect(r.winners).toEqual([])
  })

  it('conserves votes in every round', async () => {
    const r = await count(
      base({ ballots: ballots([[['a', 'b'], 6], [['b', 'a'], 4]]) }),
    )
    for (const round of r.rounds) {
      const total =
        round.counts.reduce((s, c) => s + Number(c.votes), 0) + Number(round.nonTransferable)
      expect(total).toBeCloseTo(10, 4)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- count`
Expected: FAIL — cannot resolve `../src/count.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/count.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- count`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/count.ts packages/core/tests/count.test.ts
git commit -m "feat(core): count skeleton - first preferences, quota, terminating rules"
```

---

### Task 7: Surplus transfers — Inclusive Gregory Method

**Files:**
- Modify: `packages/core/src/count.ts` — replace the `// surplus transfer arrives in Task 7` block
- Test: `packages/core/tests/count.surplus.test.ts`

**Interfaces:**
- Consumes: `count()` from Task 6
- Produces: no new exports; `Round.elected[].transferValue` becomes meaningful

- [ ] **Step 1: Write the failing test**

`packages/core/tests/count.surplus.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

const input = (over: Partial<CountInput>): CountInput => ({
  candidates: [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Bo' },
    { id: 'c', name: 'Cass' },
  ],
  ballots: [],
  seats: 2,
  electionId: 'e1',
  ballotsSha256: 'deadbeef00000000',
  ...over,
})

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('surplus transfers (IGM)', () => {
  it('transfer value is surplus divided by the NUMBER of papers', async () => {
    // 12 ballots, 2 seats -> quota = floor(12/3)+1 = 5
    // a gets 9 first preferences: surplus 4, over 9 papers -> TV = 0.44444
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    const elected = r.rounds.flatMap((x) => x.elected).find((e) => e.candidateId === 'a')!
    expect(elected.surplus).toBe('4.00000')
    expect(elected.transferValue).toBe('0.44444') // 4/9 truncated, NOT 0.44445
  })

  it('moves every paper at the same value, replacing its old weight', async () => {
    // this is what makes IGM hand-checkable: ONE number per distribution
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    // b receives 9 papers at 0.44444 = 3.99996
    const round2 = r.rounds[1]!
    expect(round2.counts.find((c) => c.candidateId === 'b')!.votes).toBe('3.99996')
  })

  it('sends exhausted papers to non-transferable', async () => {
    // a's surplus papers have no further preference
    const r = await count(
      input({ ballots: ballots([[['a'], 9], [['b'], 2], [['c'], 1]]) }),
    )
    const last = r.rounds[r.rounds.length - 1]!
    expect(Number(last.nonTransferable)).toBeGreaterThan(0)
  })

  it('conserves votes through a surplus transfer', async () => {
    const r = await count(
      input({ ballots: ballots([[['a', 'b'], 9], [['c', 'b'], 3]]) }),
    )
    for (const round of r.rounds) {
      const total =
        round.counts.reduce((s, c) => s + Number(c.votes), 0) + Number(round.nonTransferable)
      expect(total).toBeCloseTo(12, 3) // truncation loses <1e-4 per paper
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- count.surplus`
Expected: FAIL — `transferValue` is `'0.00000'`, expected `'0.44444'`

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/count.ts`, replace the block from `status.set(chosenId, 'elected')` down to the `continue` with:

```ts
      status.set(chosenId, 'elected')
      winners.push(chosenId)

      const surplus = totalOf(chosenId) - quota
      const pile = piles.get(chosenId) ?? []

      /**
       * Inclusive Gregory Method, as the Australian Senate uses:
       * transfer value = surplus / NUMBER of papers, and every paper moves
       * at that value regardless of the value it arrived with.
       *
       * One transfer value per distribution is what keeps a printed round
       * table checkable by hand. The known cost is that a paper which
       * arrived at a low value can transfer onward at a higher one.
       */
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

      recordRound(n, [{
        candidateId: chosenId,
        name: nameOf.get(chosenId)!,
        surplus: format(surplus),
        transferValue: format(transferValue),
      }], [])
      continue
```

Note: `totalOf` reads the pile, so an elected candidate must retain a paper worth exactly the quota — otherwise the conservation check fails. The `-quota` synthetic paper does that, and never transfers because it has no preferences and its candidate is no longer continuing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test -- count`
Expected: PASS, all count tests including the four new ones

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/count.ts packages/core/tests/count.surplus.test.ts
git commit -m "feat(core): IGM surplus transfers"
```

---

### Task 8: Bulk exclusion with the safety condition

`irv.py` excludes every tied-lowest candidate at once with no safety test, which can cut a candidate who would have overtaken. Bulk exclusion is Australian and correct — but only when provably safe.

**Files:**
- Modify: `packages/core/src/count.ts` — replace the `// exclusion arrives in Task 8` block
- Create: `packages/core/src/exclusion.ts`
- Test: `packages/core/tests/exclusion.test.ts`, `packages/core/tests/count.exclusion.test.ts`

**Interfaces:**
- Consumes: `Fixed` from `fixed.ts`
- Produces: `bulkExclusionSet(totals: { id: string; votes: Fixed }[], maxExcludable: number): string[]`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/exclusion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bulkExclusionSet } from '../src/exclusion.js'
import { fromInt } from '../src/fixed.js'

const t = (o: Record<string, number>) =>
  Object.entries(o).map(([id, v]) => ({ id, votes: fromInt(v) }))

describe('bulkExclusionSet', () => {
  it('excludes only the lowest when bulk would be unsafe', () => {
    // a=3, b=4: 3+4=7 > 8? no, 7 < 8 so both are safe... use a clearer case
    // a=5, b=6, c=7: 5+6=11 > 7, so b cannot join a
    expect(bulkExclusionSet(t({ a: 5, b: 6, c: 7 }), 2)).toEqual(['a'])
  })

  it('excludes several when their combined total is below the next candidate', () => {
    // a=1, b=2, c=10: 1+2=3 < 10, so both a and b are safe to exclude
    expect(bulkExclusionSet(t({ a: 1, b: 2, c: 10 }), 2).sort()).toEqual(['a', 'b'])
  })

  it('never excludes so many that fewer candidates remain than seats', () => {
    // maxExcludable caps it even when the arithmetic would allow more
    expect(bulkExclusionSet(t({ a: 1, b: 1, c: 1, d: 30 }), 1)).toHaveLength(1)
  })

  it('excludes all tied-lowest together when safe', () => {
    // the case irv.py gets wrong: a=5, b=5, c=30. 5+5=10 < 30, safe.
    expect(bulkExclusionSet(t({ a: 5, b: 5, c: 30 }), 2).sort()).toEqual(['a', 'b'])
  })

  it('does NOT bulk-exclude tied candidates when unsafe', () => {
    // a=5, b=5, c=8: 5+5=10 > 8. Excluding both could cut a candidate who
    // would have overtaken c. This is the irv.py bug.
    expect(bulkExclusionSet(t({ a: 5, b: 5, c: 8 }), 2)).toHaveLength(1)
  })
})
```

`packages/core/tests/count.exclusion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'

const ballots = (spec: [string[], number][]) =>
  spec.flatMap(([prefs, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefs.join('')}-${i}`, preferences: prefs })),
  )

describe('count - exclusions', () => {
  it('runs a full instant-runoff and transfers preferences', async () => {
    // a=4, b=4, c=2. Nobody has 6 (quota). c excluded, its 2 go to a -> a=6.
    const r = await count({
      candidates: [
        { id: 'a', name: 'Alex' },
        { id: 'b', name: 'Bo' },
        { id: 'c', name: 'Cass' },
      ],
      ballots: ballots([[['a'], 4], [['b'], 4], [['c', 'a'], 2]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    })
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
    expect(r.rounds.flatMap((x) => x.excluded).map((e) => e.candidateId)).toContain('c')
  })

  it('resolves a two-way tie instead of returning no winner', async () => {
    // THE irv.py BUG: 5-5 eliminated both and returned winner: null
    const r = await count({
      candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
      ballots: ballots([[['a'], 5], [['b'], 5]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    })
    expect(r.winners).toHaveLength(1)
    expect(r.tieBreaks).toHaveLength(1)
    expect(r.tieBreaks[0]!.method).toBe('seeded_draw')
  })

  it('honours an officer override of a tie-break', async () => {
    const args = {
      candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
      ballots: ballots([[['a'], 5], [['b'], 5]]),
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'deadbeef00000000',
    }
    const natural = await count(args)
    const loser = natural.winners[0]!.id === 'a' ? 'b' : 'a'
    const overridden = await count({ ...args, overrides: { 'tb-1': loser } })
    expect(overridden.tieBreaks[0]!.method).toBe('officer_override')
    expect(overridden.winners[0]!.id).not.toBe(natural.winners[0]!.id)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- exclusion`
Expected: FAIL — cannot resolve `../src/exclusion.js`; count tests fail with no winner

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/exclusion.ts`:

```ts
import { type Fixed, ZERO } from './fixed.js'

/**
 * Bulk exclusion, as the Australian Senate count uses - WITH the safety
 * condition irv.py omits.
 *
 * Several candidates may be excluded together only while their combined
 * total stays below the next candidate's total. Otherwise the group could
 * include someone who, on transfers, would have overtaken that candidate.
 *
 * `maxExcludable` caps the set so the continuing field never drops below
 * the number of seats still to fill.
 */
export function bulkExclusionSet(
  totals: { id: string; votes: Fixed }[],
  maxExcludable: number,
): string[] {
  if (totals.length === 0 || maxExcludable < 1) return []

  const sorted = [...totals].sort((a, b) =>
    a.votes === b.votes ? a.id.localeCompare(b.id) : a.votes < b.votes ? -1 : 1,
  )

  const chosen = [sorted[0]!.id]
  let running: Fixed = sorted[0]!.votes

  for (let i = 1; i < sorted.length - 1; i++) {
    if (chosen.length >= maxExcludable) break
    const next = sorted[i + 1]!.votes
    const candidate = sorted[i]!
    if (running + candidate.votes >= next) break
    chosen.push(candidate.id)
    running += candidate.votes
  }

  return chosen.slice(0, maxExcludable)
}
```

In `packages/core/src/count.ts`, add the import:

```ts
import { bulkExclusionSet } from './exclusion.js'
```

and replace the `// exclusion arrives in Task 8` block plus its `recordRound(n, [], []); break` with:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/exclusion.ts packages/core/src/count.ts packages/core/tests/exclusion.test.ts packages/core/tests/count.exclusion.test.ts
git commit -m "feat(core): bulk exclusion with the Senate safety condition"
```

---

### Task 9: Property tests and edge cases

**Files:**
- Test: `packages/core/tests/count.property.test.ts`

**Interfaces:**
- Consumes: `count()`
- Produces: nothing — this task is confidence

- [ ] **Step 1: Write the failing test**

`packages/core/tests/count.property.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import type { CountInput } from '../src/types.js'

/** Deterministic pseudo-random generator so failures are reproducible. */
function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
}

function randomElection(seed: number): CountInput {
  const rnd = lcg(seed)
  const candidateCount = 2 + Math.floor(rnd() * 6)
  const candidates = Array.from({ length: candidateCount }, (_, i) => ({
    id: `c${i}`,
    name: `Candidate ${i}`,
  }))
  const seats = 1 + Math.floor(rnd() * Math.min(3, candidateCount))
  const ballotCount = Math.floor(rnd() * 60)
  const ballots = Array.from({ length: ballotCount }, (_, i) => {
    const shuffled = [...candidates].sort(() => rnd() - 0.5).map((c) => c.id)
    const depth = seats + Math.floor(rnd() * (candidateCount - seats + 1))
    return { id: `b${i}`, preferences: shuffled.slice(0, Math.max(seats, depth)) }
  })
  return { candidates, ballots, seats, electionId: `e${seed}`, ballotsSha256: 'aa'.repeat(8) }
}

describe('count - properties', () => {
  it('terminates and never exceeds the seat count, across 200 random elections', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomElection(seed)
      const r = await count(input)
      expect(r.winners.length).toBeLessThanOrEqual(input.seats)
      expect(new Set(r.winners.map((w) => w.id)).size).toBe(r.winners.length)
    }
  })

  it('fills every seat whenever there are enough candidates and ballots', async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomElection(seed)
      if (input.ballots.length === 0) continue
      if (input.candidates.length < input.seats) continue
      const r = await count(input)
      expect(r.winners.length).toBe(input.seats)
    }
  })

  it('is deterministic - identical input gives identical output', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomElection(seed)
      const a = await count(input)
      const b = await count(input)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }
  })

  it('is independent of ballot ordering', async () => {
    for (let seed = 1; seed <= 50; seed++) {
      const input = randomElection(seed)
      const reversed = { ...input, ballots: [...input.ballots].reverse() }
      const a = await count(input)
      const b = await count(reversed)
      expect(a.winners.map((w) => w.id)).toEqual(b.winners.map((w) => w.id))
    }
  })
})

describe('count - edge cases', () => {
  const base = { electionId: 'e', ballotsSha256: 'bb'.repeat(8) }

  it('handles a single candidate and a single seat', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'Alex' }],
      ballots: [{ id: 'b1', preferences: ['a'] }],
      seats: 1,
    })
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('handles every ballot exhausting', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      ballots: [{ id: 'b1', preferences: ['a'] }, { id: 'b2', preferences: ['b'] }],
      seats: 1,
    })
    expect(r.winners).toHaveLength(1)
  })

  it('handles seats >= candidates by electing everyone', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      ballots: [{ id: 'b1', preferences: ['a', 'b'] }],
      seats: 3,
    })
    expect(r.winners.map((w) => w.id).sort()).toEqual(['a', 'b'])
  })

  it('handles every candidate tied', async () => {
    const r = await count({
      ...base,
      candidates: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
      ballots: [
        { id: '1', preferences: ['a'] },
        { id: '2', preferences: ['b'] },
        { id: '3', preferences: ['c'] },
      ],
      seats: 1,
    })
    expect(r.winners).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- property`
Expected: Some failures are likely. Each one is a real bug in Tasks 6–8 — fix the implementation, not the test. Do not relax an assertion to make it pass.

- [ ] **Step 3: Fix whatever the properties expose**

Common causes, in order of likelihood:
- Vote conservation throwing because an elected candidate's retained quota was not accounted for — check the synthetic `-quota` paper from Task 7.
- Infinite loop when `cont.length > remainingSeats` but `bulkExclusionSet` returns an empty array — it must always return at least one candidate.
- `winners.length < seats` on exit when all candidates are exhausted — the `continuing == remaining seats` rule must fire before the exclusion branch.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/tests/count.property.test.ts packages/core/src
git commit -m "test(core): property and edge-case coverage for the count"
```

---

### Task 10: Differential test against irv.py

Proves the TypeScript count reproduces the current Python behaviour at `seats = 1`, except for the tie bug and the exclusion safety condition. This is the evidence that nothing silently changed.

**Files:**
- Create: `packages/core/tests/fixtures/irv-cases.json`
- Create: `scripts/generate-irv-fixtures.py`
- Test: `packages/core/tests/count.differential.test.ts`

**Interfaces:**
- Consumes: `count()`; `backend/irv.py` as the reference
- Produces: nothing

- [ ] **Step 1: Write the fixture generator**

`scripts/generate-irv-fixtures.py`:

```python
"""Generate differential-test fixtures from the legacy irv.py.

Run once: python3 scripts/generate-irv-fixtures.py
Cases where the old code returns no winner (its tie bug) are recorded with
"winner": null and skipped by the differential test, which asserts separately
that the new count DOES return a winner for them.
"""
import json, random, sys
sys.path.insert(0, 'backend')
from irv import run_irv

random.seed(42)
cases = []
for i in range(200):
    n = random.randint(2, 6)
    candidates = [{"id": f"c{j}", "name": f"Candidate {j}"} for j in range(n)]
    ballots = []
    for _ in range(random.randint(1, 60)):
        order = [c["id"] for c in candidates]
        random.shuffle(order)
        ballots.append(order[: random.randint(1, n)])
    rounds, winner = run_irv(candidates, ballots)
    cases.append({
        "candidates": candidates,
        "ballots": ballots,
        "winner": winner["id"] if winner else None,
    })

with open('packages/core/tests/fixtures/irv-cases.json', 'w') as f:
    json.dump(cases, f, indent=2)
print(f"wrote {len(cases)} cases, {sum(1 for c in cases if c['winner'] is None)} with no winner")
```

- [ ] **Step 2: Generate the fixtures and write the failing test**

Run: `python3 scripts/generate-irv-fixtures.py`

`packages/core/tests/count.differential.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { count } from '../src/count.js'
import cases from './fixtures/irv-cases.json' with { type: 'json' }

type Case = {
  candidates: { id: string; name: string }[]
  ballots: string[][]
  winner: string | null
}

describe('differential vs legacy irv.py at seats = 1', () => {
  it('agrees with the old winner wherever the old code produced one', async () => {
    const mismatches: string[] = []
    for (const [i, c] of (cases as Case[]).entries()) {
      if (c.winner === null) continue
      const r = await count({
        candidates: c.candidates,
        ballots: c.ballots.map((preferences, j) => ({ id: `b${j}`, preferences })),
        seats: 1,
        electionId: `case-${i}`,
        ballotsSha256: 'cc'.repeat(8),
      })
      if (r.winners[0]?.id !== c.winner) {
        mismatches.push(`case ${i}: python=${c.winner} ts=${r.winners[0]?.id}`)
      }
    }
    // Any mismatch is either a real regression or a case where irv.py's
    // missing bulk-exclusion safety test changed the outcome. Investigate
    // each one before accepting it.
    expect(mismatches).toEqual([])
  })

  it('produces a winner for cases where irv.py returned none', async () => {
    const noWinner = (cases as Case[]).filter((c) => c.winner === null)
    expect(noWinner.length).toBeGreaterThan(0) // the tie bug must be represented
    for (const [i, c] of noWinner.entries()) {
      const r = await count({
        candidates: c.candidates,
        ballots: c.ballots.map((preferences, j) => ({ id: `b${j}`, preferences })),
        seats: 1,
        electionId: `tie-${i}`,
        ballotsSha256: 'dd'.repeat(8),
      })
      expect(r.winners).toHaveLength(1)
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run -w @election/core test -- differential`
Expected: FAIL initially — investigate each mismatch. Expect some from the bulk-exclusion safety condition; confirm the new behaviour is correct before moving on, and record any accepted divergence in the test's comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-irv-fixtures.py packages/core/tests/fixtures/irv-cases.json packages/core/tests/count.differential.test.ts
git commit -m "test(core): differential test against legacy irv.py"
```

---

### Task 11: USU member export import

The export is malformed — 28 header columns, 29 data columns, shifting every field from `Membership End Date` onward. A naive parse reads `Left Group` from the wrong column and returns `0` for every row, silently granting voting rights to departed members.

**Files:**
- Create: `packages/core/src/usu-import.ts`
- Create: `packages/core/tests/fixtures/usu-sample.csv`
- Test: `packages/core/tests/usu-import.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type RollMember = { usuId: string; firstName: string; lastName: string; eligible: boolean }`, `type ImportResult = { members: RollMember[]; eligible: number; excluded: number; shifted: boolean }`, `parseUsuExport(csv: string): ImportResult`

- [ ] **Step 1: Build the fixture**

Create `packages/core/tests/fixtures/usu-sample.csv` with the real 28-column header and six 29-column data rows — four eligible, two with `Left Group = 1`. Copy the header verbatim from a real export (note `"Officer  Notes"` has two spaces). Use invented names and IDs; never commit real member data.

```
"User Identifier","Net Id","Member Identifier","First Name","Last Name","Email","Year Of Graduation","Member Type","Officer","Source Type","Membership End Date","Signup Date","Membership Payments","Events Payments","Member Tags","Sub-Groups Tags","User Tags","Officer  Notes","Last Online iOS","Last Online Android","Unsubscribed from all emails","Left Group","Left Group Reason","Dalyell Status","First Aid Expiry","Online Module Expiry","RSA Expiry","Working with Children Expiry"
"600001","2400001","11000001","Ada","Lovelace","ada@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""
"600002","2400002","11000002","Alan","Turing","alan@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""
"600003","2400003","11000003","Grace","Hopper","grace@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","1","0","","","","",""
"600004","2400004","11000004","Edsger","Dijkstra","ed@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""
"600005","2400005","11000005","Barbara","Liskov","barbara@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","1","0","","","","",""
"600006","2400006","11000006","Tony","Hoare","tony@example.com","-","","Member","0","Joined a group","12/31/2026","1/1/2026 9:00:00 AM","0","0","-","-","-","-","","","0","0","","","","",""
```

- [ ] **Step 2: Write the failing test**

`packages/core/tests/usu-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseUsuExport } from '../src/usu-import.js'

const csv = readFileSync(new URL('./fixtures/usu-sample.csv', import.meta.url), 'utf8')

describe('parseUsuExport', () => {
  it('detects the 29-column shift', () => {
    expect(parseUsuExport(csv).shifted).toBe(true)
  })

  it('reads Left Group from the SHIFTED position, not the header position', () => {
    // the bug this module exists to prevent: a naive parse reads 0 for every
    // row and grants departed members voting rights
    const r = parseUsuExport(csv)
    expect(r.excluded).toBe(2)
    expect(r.eligible).toBe(4)
  })

  it('uses Net Id as usuId', () => {
    const ada = parseUsuExport(csv).members.find((m) => m.firstName === 'Ada')!
    expect(ada.usuId).toBe('2400001') // Net Id, NOT User Identifier or Member Identifier
    expect(ada.usuId).toHaveLength(7)
  })

  it('marks departed members ineligible rather than dropping them', () => {
    const grace = parseUsuExport(csv).members.find((m) => m.firstName === 'Grace')!
    expect(grace.eligible).toBe(false)
  })

  it('imports no email or membership data', () => {
    const m = parseUsuExport(csv).members[0]!
    expect(Object.keys(m).sort()).toEqual(['eligible', 'firstName', 'lastName', 'usuId'])
  })

  it('handles a corrected 28-column export if USU ever fixes it', () => {
    const lines = csv.trim().split('\n')
    // drop the extra source-type-text field at index 10 from each data row
    const fixed = [
      lines[0]!,
      ...lines.slice(1).map((l) => {
        const parts = l.split('","')
        parts.splice(10, 1)
        return parts.join('","')
      }),
    ].join('\n')
    const r = parseUsuExport(fixed)
    expect(r.shifted).toBe(false)
    expect(r.excluded).toBe(2) // still correct
  })

  it('rejects a file with no header', () => {
    expect(() => parseUsuExport('')).toThrow(/header/i)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run -w @election/core test -- usu`
Expected: FAIL — cannot resolve `../src/usu-import.js`

- [ ] **Step 4: Write minimal implementation**

`packages/core/src/usu-import.ts`:

```ts
export type RollMember = {
  usuId: string
  firstName: string
  lastName: string
  eligible: boolean
}

export type ImportResult = {
  members: RollMember[]
  eligible: number
  excluded: number
  /** true when the export had the 29-column defect */
  shifted: boolean
}

const HEADER_COLUMNS = 28
const SHIFT_AT = 10 // an extra source-type-text field appears here

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Parse a USU member export into roll entries.
 *
 * The export is malformed: 28 header columns but 29 per data row, with an
 * unnamed source-type-text field at index 10 shifting everything after it.
 * Net Id, First Name and Last Name sit BEFORE the shift and parse either
 * way. "Left Group" sits after it - read from the header position it is 0
 * for every row, which silently grants departed members voting rights.
 *
 * Only four columns are imported. Email, membership dates and the other two
 * identifiers are deliberately discarded: the roll holds an id and a name
 * and nothing else.
 */
export function parseUsuExport(csv: string): ImportResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const headerLine = lines[0]
  if (!headerLine) throw new Error('parseUsuExport: file has no header row')

  const header = parseCsvLine(headerLine)
  const idx = (name: string) => header.indexOf(name)

  const netIdAt = idx('Net Id')
  const firstAt = idx('First Name')
  const lastAt = idx('Last Name')
  const leftAt = idx('Left Group')
  if (netIdAt < 0 || firstAt < 0 || lastAt < 0 || leftAt < 0) {
    throw new Error('parseUsuExport: header is missing a required column')
  }

  const members: RollMember[] = []
  let shifted = false

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const rowShifted = cells.length > HEADER_COLUMNS
    if (rowShifted) shifted = true

    const at = (i: number) => cells[i >= SHIFT_AT && rowShifted ? i + 1 : i]?.trim() ?? ''

    const usuId = at(netIdAt)
    if (!usuId) continue

    members.push({
      usuId,
      firstName: at(firstAt),
      lastName: at(lastAt),
      eligible: at(leftAt) !== '1',
    })
  }

  const eligible = members.filter((m) => m.eligible).length
  return { members, eligible, excluded: members.length - eligible, shifted }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run -w @election/core test -- usu`
Expected: PASS, 7 tests

- [ ] **Step 6: Verify against the real export**

Run:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parseUsuExport } from './packages/core/src/usu-import.ts'
const r = parseUsuExport(readFileSync('user_download_members_usu_91616933.csv','utf8'))
console.log({ total: r.members.length, eligible: r.eligible, excluded: r.excluded, shifted: r.shifted })
"
```

Expected: `{ total: 1302, eligible: 1298, excluded: 4, shifted: true }`

If `excluded` is 0, the shift handling is wrong — that is exactly the failure mode this module exists to prevent.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/usu-import.ts packages/core/tests/usu-import.test.ts packages/core/tests/fixtures/usu-sample.csv
git commit -m "feat(core): USU member export import with 29-column realignment"
```

---

### Task 12: Public exports and the offline recount tool

The tool that makes the audit story real: given an exported ballot CSV, re-run the count on a laptop with no network and no database.

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/recount.ts`
- Test: `packages/core/tests/recount.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the package's public surface, plus `recount(ballotsCsv: string, candidatesCsv: string, seats: number, electionId: string, ballotsSha256: string): Promise<CountResult>`

- [ ] **Step 1: Write the failing test**

`packages/core/tests/recount.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { recount } from '../src/recount.js'
import * as core from '../src/index.js'

describe('public surface', () => {
  it('exports what apps/api and the frontends need', () => {
    for (const name of [
      'count', 'validateBallot', 'minimumPreferences', 'droopQuota',
      'parseUsuExport', 'recount', 'format', 'VERSION',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })
})

describe('recount', () => {
  const candidatesCsv = 'candidate_id,name\na,Alex\nb,Bo\nc,Cass\n'
  const ballotsCsv = [
    'ballot_id,preferences',
    'b1,"a|b"', 'b2,"a|b"', 'b3,"a|b"', 'b4,"a|b"',
    'b5,"b|a"', 'b6,"b|a"', 'b7,"b|a"', 'b8,"b|a"',
    'b9,"c|a"', 'b10,"c|a"',
  ].join('\n')

  it('reproduces a count from exported CSVs alone', async () => {
    const r = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    expect(r.winners.map((w) => w.id)).toEqual(['a'])
  })

  it('gives the same result as counting the same data directly', async () => {
    const viaCsv = await recount(ballotsCsv, candidatesCsv, 1, 'e1', 'ee'.repeat(8))
    const direct = await core.count({
      candidates: [
        { id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }, { id: 'c', name: 'Cass' },
      ],
      ballots: [
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 1}`, preferences: ['a', 'b'] })),
        ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i + 5}`, preferences: ['b', 'a'] })),
        ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i + 9}`, preferences: ['c', 'a'] })),
      ],
      seats: 1,
      electionId: 'e1',
      ballotsSha256: 'ee'.repeat(8),
    })
    expect(viaCsv.winners).toEqual(direct.winners)
    expect(viaCsv.quota).toBe(direct.quota)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @election/core test -- recount`
Expected: FAIL — cannot resolve `../src/recount.js`

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/recount.ts`:

```ts
import { count } from './count.js'
import type { CountResult } from './types.js'

/**
 * Re-run a count from the exported CSVs alone - no database, no network.
 *
 * This is what makes the audit story concrete: a challenged result can be
 * recomputed in front of whoever is challenging it, from files they hold.
 */
export async function recount(
  ballotsCsv: string,
  candidatesCsv: string,
  seats: number,
  electionId: string,
  ballotsSha256: string,
): Promise<CountResult> {
  const rows = (csv: string) =>
    csv.split(/\r?\n/).filter((l) => l.trim()).slice(1)
      .map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')))

  const candidates = rows(candidatesCsv).map(([id, name]) => ({
    id: id ?? '',
    name: name ?? '',
  }))
  const ballots = rows(ballotsCsv).map(([id, prefs]) => ({
    id: id ?? '',
    preferences: (prefs ?? '').split('|').filter(Boolean),
  }))

  return count({ candidates, ballots, seats, electionId, ballotsSha256 })
}
```

`packages/core/src/index.ts`:

```ts
export const VERSION = '1.0.0'

export { type Fixed, SCALE, ZERO, fromInt, mul, div, format } from './fixed.js'
export { droopQuota } from './quota.js'
export { type BallotCheck, validateBallot, minimumPreferences } from './ballot.js'
export { bulkExclusionSet } from './exclusion.js'
export { type History, countback, deriveSeed, seededDraw } from './tiebreak.js'
export { count } from './count.js'
export { recount } from './recount.js'
export { type RollMember, type ImportResult, parseUsuExport } from './usu-import.js'
export type {
  Candidate, CountBallot, CandidateStatus, RoundCount, Round,
  TieBreakKind, TieBreakMethod, TieBreakRecord, CountInput, CountResult,
} from './types.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @election/core test && npm run -w @election/core typecheck`
Expected: PASS, all tests, no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/recount.ts packages/core/tests/recount.test.ts
git commit -m "feat(core): public exports and offline recount"
```

---

## Success criteria for the whole plan

- `npm run -w @election/core test` passes with no skipped tests.
- `npm run -w @election/core typecheck` is clean.
- `packages/core/package.json` has **zero** entries under `dependencies`.
- The real export parses to `{ total: 1302, eligible: 1298, excluded: 4, shifted: true }`.
- The differential test agrees with `irv.py` on every case where `irv.py` produced a winner, and produces a winner for every case where it did not.
- `recount()` reproduces a count from exported CSVs alone.

## Known gap: the published known-answer corpus

The spec calls for "a known-answer corpus from published Senate and Scottish
council counts". There is no task for it here, because the fixture cannot be
written without the real published data, and inventing it would produce a test
that proves nothing.

Sourcing it is a task for the implementer: take a published multi-seat count
with official round-by-round figures, encode the ballots and the expected
per-round totals, and assert against them. Until that exists, the count's
verification rests on Task 9 (200 randomised elections plus edge cases) and
Task 10 (differential against `irv.py`). Those are strong on internal
consistency and on not regressing, and weak on "does this match how a real
authority counted a real election" — which is exactly what the corpus is for.

Do not mark this plan complete without recording whether the corpus was added.

## What this plan does NOT cover

Plan 2 (`apps/api`) owns the D1 schema, `WITHOUT ROWID`, the ballot/receipt transaction, sessions and password hashing, R2 logos, rate limiting, `audit_log`, and every endpoint. Plan 3 owns the two frontends, including the rebuilt ranked-ballot UI.

`backend/` and the two old frontends stay in the tree until Plan 3 reaches cutover — `irv.py` is the differential reference and cannot be deleted before Task 10 runs.
