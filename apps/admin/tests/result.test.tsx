import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { stub } from './helpers.js'
import { Result } from '../src/screens/Result.js'

afterEach(() => vi.unstubAllGlobals())

const document_ = {
  election: { id: 'e1', name: 'President', seats: 1 },
  closed_at: 1, ballot_count: 3, ballots_sha256: 'ab'.repeat(32),
  computed_at: 2, overridden: false, quota: '2.00000',
  rounds: [
    {
      n: 1,
      counts: [
        { candidateId: 'a', name: 'Alex', votes: '2.00000', status: 'elected' },
        { candidateId: 'b', name: 'Bo', votes: '1.00000', status: 'continuing' },
      ],
      elected: [{ candidateId: 'a', name: 'Alex', surplus: '0.00000', transferValue: '0.00000' }],
      excluded: [],
      nonTransferable: '0.00000',
    },
  ],
  winners: [{ id: 'a', name: 'Alex' }],
  tie_breaks: [],
}

const show = (status: number, body: unknown) => {
  stub(status, body)
  renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
}

describe('Result', () => {
  it('REFUSES to show a result before the ballots are sealed', async () => {
    show(409, { error: 'no result exists until voting is closed', code: 'not_sealed' })
    expect((await screen.findByRole('alert')).textContent).toMatch(/until voting is closed/i)
  })

  it('lists the winners', async () => {
    show(200, document_)
    // Alex is also a row header in the table; this asserts the winners list.
    const winners = (await screen.findByRole('heading', { name: /^elected$/i })).nextElementSibling
    expect(winners?.tagName).toBe('OL')
    expect(winners?.textContent).toContain('Alex')
  })

  it('tabulates the rounds, with the quota and the non-transferable total', async () => {
    show(200, document_)
    const table = await screen.findByRole('table')
    expect(screen.getByRole('columnheader', { name: /round 1/i })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Bo' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: /non-transferable/i })).toBeTruthy()
    // The value is also Alex's round-1 total, so assert the labelled caption.
    const caption = table.querySelector('caption')
    expect(caption?.textContent).toMatch(/quota/i)
    expect(caption?.textContent).toContain('2.00000')
  })

  it('shows the digest beside this election\'s ballot file, so one can be checked against the other', async () => {
    show(200, document_)
    expect(await screen.findByText(document_.ballots_sha256)).toBeTruthy()
    expect(screen.getByRole('link', { name: /ballots \(csv\)/i }).getAttribute('href'))
      .toContain('/elections/e1/ballots.csv')
  })

  it.each([
    ['there were no ties', document_, /no ties to resolve/i],
    ['it supersedes an earlier result', { ...document_, overridden: true }, /supersedes an earlier one/i],
  ])('says when %s', async (_when, body, note) => {
    show(200, body)
    expect(await screen.findByText(note)).toBeTruthy()
  })
})
