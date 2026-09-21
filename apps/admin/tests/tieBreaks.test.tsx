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
  return { onOverride }
}

describe('TieBreaks', () => {
  it('labels an EXCLUSION tie\'s control as who is EXCLUDED — never who wins', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    expect(screen.getByLabelText(/who is excluded/i)).toBeTruthy()
    expect(screen.queryByLabelText(/pick the winner|who wins|elected first/i)).toBeNull()
  })

  it('labels an ELECTION ORDER tie\'s control as who is elected FIRST', () => {
    show({ ...exclusionTie, kind: 'election_order' })
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    expect(screen.getByLabelText(/elected first/i)).toBeTruthy()
    expect(screen.queryByLabelText(/who is excluded/i)).toBeNull()
  })

  it('says what the count decided, in the language of the kind', () => {
    show()
    expect(screen.getByText(/Bo was excluded/i)).toBeTruthy()
  })

  it('shows the seed, so a candidate can re-derive the draw', () => {
    show()
    expect(screen.getByText(new RegExp(exclusionTie.seed!.slice(0, 12)))).toBeTruthy()
  })

  it('requires a reason before an override can be saved', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    expect(screen.getByRole('button', { name: /save override/i })).toHaveProperty('disabled', true)
  })

  it('rejects a whitespace-only reason', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /save override/i })).toHaveProperty('disabled', true)
  })

  it('sends resolved_id and the reason', () => {
    const { onOverride } = show()
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Drew lots at the AGM' } })
    fireEvent.change(screen.getByLabelText(/who is excluded/i), { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: /save override/i }))
    expect(onOverride).toHaveBeenCalledWith({
      tie_break_id: 'tb-1', resolved_id: 'a', reason: 'Drew lots at the AGM',
    })
  })

  it('warns that an override writes a new result and keeps the old one', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /override/i }))
    expect(screen.getByText(/both are kept/i)).toBeTruthy()
  })

  it('shows an override already in force, with its reason', () => {
    show({ ...exclusionTie, method: 'officer_override', reason: 'Returning officer drew lots' })
    expect(screen.getByText(/Returning officer drew lots/)).toBeTruthy()
  })
})
