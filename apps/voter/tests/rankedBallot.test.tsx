import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/preact'
import { RankedBallot } from '../src/components/RankedBallot.js'

const candidates = [
  { id: 'a', name: 'Alex' },
  { id: 'b', name: 'Bo' },
  { id: 'c', name: 'Cass' },
  { id: 'd', name: 'Dee' },
]

const setup = (seats = 2, submitting = false) => {
  const onSubmit = vi.fn()
  render(<RankedBallot candidates={candidates} seats={seats} onSubmit={onSubmit} submitting={submitting} />)
  return onSubmit
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name })
const tap = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const add = (...names: string[]) => names.forEach((name) => tap(`Add ${name}`))
/** The ranking as shown: ordinal, then name. */
const ranked = () => screen.queryAllByTestId(/^ranked-/).map((li, index) =>
  `${screen.getByTestId(`ordinal-${index}`).textContent} ${li.querySelector('.candidate-name')!.lastChild!.textContent}`)

describe('RankedBallot', () => {
  it('numbers preferences in the order they were added, and offers each candidate once', () => {
    setup()
    add('Bo', 'Alex')
    expect(ranked()).toEqual(['1 Bo', '2 Alex'])
    expect(button('Add Bo')).toBeNull()
  })

  it('removes a candidate from the middle, RENUMBERS the rest, and offers them again', () => {
    setup()
    add('Alex', 'Bo', 'Cass')
    tap('Remove Bo')
    expect(ranked()).toEqual(['1 Alex', '2 Cass'])
    expect(button('Add Bo')).toBeTruthy()
  })

  it('moves a preference up and down, and submits the order shown, not the order added', () => {
    const onSubmit = setup()
    add('Alex', 'Bo')
    // DISABLED rather than hidden at the boundaries, so rows do not reflow
    expect(button('Move Alex up')).toHaveProperty('disabled', true)
    expect(button('Move Bo down')).toHaveProperty('disabled', true)

    tap('Move Bo up')
    expect(ranked()).toEqual(['1 Bo', '2 Alex'])
    tap('Move Bo down')
    expect(ranked()).toEqual(['1 Alex', '2 Bo'])
    tap('Move Bo up')
    tap(/submit/i)
    expect(onSubmit).toHaveBeenCalledWith(['b', 'a'])
  })

  it('states the minimum, announces progress, and fires NO submit below it', () => {
    const onSubmit = setup(2)
    expect(screen.getByText(/rank at least 2 candidates/i)).toBeTruthy()
    add('Alex')
    expect(screen.getByRole('status').textContent).toMatch(/1 of 2/i)
    expect(button(/submit/i)).toHaveProperty('disabled', true)
    tap(/submit/i)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['one preference for a single seat', 1, ['Alex'], ['a']],
    ['more than the minimum, if the voter ranks them', 1, ['Alex', 'Bo', 'Cass'], ['a', 'b', 'c']],
    // minimumPreferences is min(seats, candidateCount): 6 seats, 4 candidates
    ['every candidate when there are fewer than seats', 6, ['Alex', 'Bo', 'Cass', 'Dee'], ['a', 'b', 'c', 'd']],
  ])('accepts %s', (_what, seats, picks, preferences) => {
    const onSubmit = setup(seats)
    add(...picks)
    tap(/submit/i)
    expect(onSubmit).toHaveBeenCalledWith(preferences)
  })

  it('disables submit while a submission is in flight', () => {
    setup(1, true)
    expect(button(/submit/i)).toHaveProperty('disabled', true)
  })
})
