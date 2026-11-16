import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { Ballot } from '../src/screens/Ballot.js'
import { stub, stubOffline } from './helpers.js'

const election = {
  id: 'e1',
  name: 'President',
  seats: 1,
  status: 'open' as const,
  candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
}

afterEach(() => vi.unstubAllGlobals())

const renderBallot = (overrides: Partial<Parameters<typeof Ballot>[0]> = {}) => {
  const props = {
    batchId: 'b1', election,
    onBack: vi.fn(), onCast: vi.fn(), onSessionLost: vi.fn(),
    ...overrides,
  }
  render(<Ballot {...props} />)
  return props
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /submit/i }))

const castForAlex = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add Alex' }))
  submit()
}

const alertText = async () => (await screen.findByRole('alert')).textContent ?? ''

describe('Ballot', () => {
  it('names its election, and OFFERS A WAY OUT WITHOUT VOTING, so a ballot is not a trap', () => {
    const { onBack } = renderBallot()
    expect(screen.getByRole('heading', { name: 'President' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /all elections/i }))
    expect(onBack).toHaveBeenCalled()
  })

  it('hands the receipt token up, from one request however often submit is tapped', async () => {
    const spy = stub(201, { receipt_token: 'tok-1' })
    const { onCast } = renderBallot()
    castForAlex()
    submit()
    await waitFor(() => expect(onCast).toHaveBeenCalledWith('tok-1'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['sends an un-checked-in voter to the check-in desk',
      403, { error: 'not eligible', code: 'not_eligible' }, /check-in desk/i],
    ['reports an already-recorded ballot without implying failure',
      409, { error: 'already voted', code: 'already_voted' }, /already recorded/i],
    ['shows a validation reason from the server verbatim',
      400, { error: 'Rank at least 2 candidate(s).', code: 'invalid_ballot' }, /Rank at least 2 candidate\(s\)\./],
  ])('%s', async (_name, status, body, message) => {
    stub(status, body)
    renderBallot()
    castForAlex()
    const text = await alertText()
    expect(text).toMatch(message)
    expect(text).not.toMatch(/failed|error/i)
  })

  it('SAYS PLAINLY that a lost response means no receipt, and does not imply failure', async () => {
    // The ballot may have committed. No retry is offered.
    stubOffline()
    renderBallot()
    castForAlex()
    const text = await alertText()
    expect(text).toMatch(/may have been recorded/i)
    expect(text).toMatch(/receipt/i)
    expect(text).not.toMatch(/failed|try again|resubmit/i)
  })

  it('reports a lapsed session upward WITH the draft, so it is not lost', async () => {
    stub(401, { error: 'unauthenticated', code: 'no_session' })
    const { onSessionLost } = renderBallot()
    castForAlex()
    await waitFor(() => expect(onSessionLost).toHaveBeenCalledWith(['a']))
  })

  it('restores a draft handed back after a re-sign-in', () => {
    renderBallot({ initialRanking: ['b'] })
    expect(screen.getByTestId('ordinal-0').textContent).toBe('1')
    expect(screen.getByTestId('ranked-0').textContent).toContain('Bo')
  })
})
