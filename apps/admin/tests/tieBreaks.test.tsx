import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { TieBreakRecord } from '@election/core'
import { TieBreaks } from '../src/components/TieBreaks.js'

const candidates = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }]

const exclusionTie: TieBreakRecord = {
  id: 'tb-1', kind: 'exclusion', round: 1, candidates: ['a', 'b'], resolved: 'b',
  method: 'seeded_draw', resolvedAtRound: null, seed: 'ab'.repeat(32), reason: null,
}

const show = (tie: TieBreakRecord = exclusionTie) => {
  const onOverride = vi.fn()
  render(<TieBreaks tieBreaks={[tie]} candidates={candidates} onOverride={onOverride} />)
  return onOverride
}

const startOverride = () => fireEvent.click(screen.getByRole('button', { name: /override/i }))

describe('TieBreaks', () => {
  // For an exclusion the resolved id is who is EXCLUDED, never who wins.
  it.each([
    ['exclusion', /who is excluded/i, /pick the winner|who wins|elected first/i],
    ['election_order', /elected first/i, /who is excluded/i],
  ] as const)('labels the control for an %s tie by what it decides', (kind, label, wrongLabel) => {
    show({ ...exclusionTie, kind })
    startOverride()
    expect(screen.getByLabelText(label)).toBeTruthy()
    expect(screen.queryByLabelText(wrongLabel)).toBeNull()
  })

  it('says what the count decided, and shows the seed so the draw can be re-derived', () => {
    show()
    expect(screen.getByText(/Bo was excluded/i)).toBeTruthy()
    expect(screen.getByText(new RegExp(exclusionTie.seed!.slice(0, 12)))).toBeTruthy()
  })

  it('requires a real reason, then sends resolved_id and the reason', () => {
    const onOverride = show()
    startOverride()
    // an override writes a new result and keeps the old one
    expect(screen.getByText(/both are kept/i)).toBeTruthy()
    const save = screen.getByRole('button', { name: /save override/i })
    const reason = (value: string) =>
      fireEvent.change(screen.getByLabelText(/reason/i), { target: { value } })

    fireEvent.change(screen.getByLabelText(/who is excluded/i), { target: { value: 'a' } })
    expect(save).toHaveProperty('disabled', true)
    reason('   ')
    expect(save).toHaveProperty('disabled', true)

    reason('Drew lots at the AGM')
    fireEvent.click(save)
    expect(onOverride).toHaveBeenCalledWith({
      tie_break_id: 'tb-1', resolved_id: 'a', reason: 'Drew lots at the AGM',
    })
  })

  it('shows an override already in force, with its reason', () => {
    show({ ...exclusionTie, method: 'officer_override', reason: 'Returning officer drew lots' })
    expect(screen.getByText(/Returning officer drew lots/)).toBeTruthy()
  })
})
