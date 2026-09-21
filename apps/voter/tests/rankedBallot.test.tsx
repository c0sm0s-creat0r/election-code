import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/preact'
import { RankedBallot } from '../src/components/RankedBallot.js'

const candidates = [
  { id: 'a', name: 'Alex' },
  { id: 'b', name: 'Bo' },
  { id: 'c', name: 'Cass' },
  { id: 'd', name: 'Dee' },
]

const setup = (seats = 2) => {
  const onSubmit = vi.fn()
  render(<RankedBallot candidates={candidates} seats={seats} onSubmit={onSubmit} submitting={false} />)
  return { onSubmit }
}

const add = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Add ${name}` }))
const ranked = () => screen.getAllByTestId(/^ranked-/).map((li) => li.textContent ?? '')

describe('RankedBallot', () => {
  it('states the minimum in plain language', () => {
    setup(2)
    expect(screen.getByText(/rank at least 2 candidates/i)).toBeTruthy()
  })

  it('adds a candidate with a visible ordinal', () => {
    setup()
    add('Alex')
    expect(screen.getByTestId('ordinal-0').textContent).toBe('1')
    expect(ranked()[0]).toContain('Alex')
  })

  it('numbers preferences in the order they were added', () => {
    setup()
    add('Bo'); add('Alex')
    expect(screen.getByTestId('ordinal-0').textContent).toBe('1')
    expect(ranked()[0]).toContain('Bo')
    expect(ranked()[1]).toContain('Alex')
  })

  it('removes a candidate from the middle and RENUMBERS the rest', () => {
    setup()
    add('Alex'); add('Bo'); add('Cass')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }))
    expect(ranked()).toHaveLength(2)
    expect(ranked()[0]).toContain('Alex')
    expect(ranked()[1]).toContain('Cass')
    expect(screen.getByTestId('ordinal-1').textContent).toBe('2')
  })

  it('returns a removed candidate to the add list', () => {
    setup()
    add('Alex')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Alex' }))
    expect(screen.getByRole('button', { name: 'Add Alex' })).toBeTruthy()
  })

  it('moves a preference up', () => {
    setup()
    add('Alex'); add('Bo')
    fireEvent.click(screen.getByRole('button', { name: 'Move Bo up' }))
    expect(ranked()[0]).toContain('Bo')
  })

  it('moves a preference down', () => {
    setup()
    add('Alex'); add('Bo')
    fireEvent.click(screen.getByRole('button', { name: 'Move Alex down' }))
    expect(ranked()[1]).toContain('Alex')
  })

  it('DISABLES rather than hides the arrows at the boundaries', () => {
    setup()
    add('Alex'); add('Bo')
    expect(screen.getByRole('button', { name: 'Move Alex up' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Move Bo down' })).toHaveProperty('disabled', true)
  })

  it('cannot add the same candidate twice', () => {
    setup()
    add('Alex')
    expect(screen.queryByRole('button', { name: 'Add Alex' })).toBeNull()
  })

  it('DISABLES submit below the minimum', () => {
    setup(2)
    add('Alex')
    expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', true)
  })

  it('fires NO submit below the minimum', () => {
    const { onSubmit } = setup(2)
    add('Alex')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the preferences in rank order once the minimum is met', () => {
    const { onSubmit } = setup(2)
    add('Cass'); add('Alex')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).toHaveBeenCalledWith(['c', 'a'])
  })

  it('submits the order after a reorder, not the order they were added', () => {
    const { onSubmit } = setup(2)
    add('Alex'); add('Bo')
    fireEvent.click(screen.getByRole('button', { name: 'Move Bo up' }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).toHaveBeenCalledWith(['b', 'a'])
  })

  it('announces progress in a live region', () => {
    setup(2)
    add('Alex')
    expect(screen.getByRole('status').textContent).toMatch(/1 of 2/i)
  })

  it('requires one preference when there is a single seat', () => {
    const { onSubmit } = setup(1)
    add('Alex')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).toHaveBeenCalledWith(['a'])
  })

  it('never asks for more preferences than there are candidates', () => {
    // minimumPreferences is min(seats, candidateCount): 6 seats, 4 candidates
    const onSubmit = vi.fn()
    render(<RankedBallot candidates={candidates} seats={6} onSubmit={onSubmit} submitting={false} />)
    add('Alex'); add('Bo'); add('Cass'); add('Dee')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).toHaveBeenCalledWith(['a', 'b', 'c', 'd'])
  })

  it('disables submit while a submission is in flight', () => {
    render(<RankedBallot candidates={candidates} seats={1} onSubmit={vi.fn()} submitting={true} />)
    expect(screen.getByRole('button', { name: /submit/i })).toHaveProperty('disabled', true)
  })

  it('lets a voter rank beyond the minimum', () => {
    const { onSubmit } = setup(1)
    add('Alex'); add('Bo'); add('Cass')
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    expect(onSubmit).toHaveBeenCalledWith(['a', 'b', 'c'])
  })
})
