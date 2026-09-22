import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderRouted } from './renderOfficer.js'
import { Result } from '../src/screens/Result.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

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

describe('Result', () => {
  it('REFUSES to show a result before the ballots are sealed', async () => {
    stub(409, { error: 'no result exists until voting is closed', code: 'not_sealed' })
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/until voting is closed/i))
  })

  it('lists the winners', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    // Alex appears in the winners list AND as a row header in the table, which
    // is correct; this asserts the winners list specifically.
    await waitFor(() => expect(screen.getByRole('heading', { name: /^elected$/i })).toBeTruthy())
    const winners = screen.getByRole('heading', { name: /^elected$/i }).nextElementSibling
    expect(winners?.tagName).toBe('OL')
    expect(winners?.textContent).toContain('Alex')
  })

  it('renders a column per round and a row per candidate', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: /round 1/i })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Bo' })).toBeTruthy()
  })

  it('shows the quota on the table itself', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    // The value also appears as Alex's round-1 total, which is the point of a
    // quota — so this asserts the caption, where it is labelled.
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy())
    const caption = screen.getByRole('table').querySelector('caption')
    expect(caption?.textContent).toMatch(/quota/i)
    expect(caption?.textContent).toContain('2.00000')
  })

  it('keeps the non-transferable total in view', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByRole('rowheader', { name: /non-transferable/i })).toBeTruthy())
  })

  it('shows the digest, so it can be checked against the export', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(document_.ballots_sha256)).toBeTruthy())
  })

  it('says when a result supersedes an earlier one', async () => {
    stub(200, { ...document_, overridden: true })
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(/supersedes an earlier one/i)).toBeTruthy())
  })

  it('says so when there were no ties', async () => {
    stub(200, document_)
    renderRouted(<Result batchId="b1" electionId="e1" slug="soc" />)
    await waitFor(() => expect(screen.getByText(/no ties to resolve/i)).toBeTruthy())
  })
})
