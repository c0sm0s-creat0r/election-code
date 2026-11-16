import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { Exports } from '../src/screens/Exports.js'
import { renderRouted } from './renderOfficer.js'

const link = (name: RegExp) => screen.queryByRole('link', { name })

/** Shows the files for one election or the whole-AGM files, never both. */
describe('Exports', () => {
  it('offers only the per-election files when given an election, linked straight at the API', () => {
    renderRouted(<Exports batchId="b1" electionId="e1" />)
    // a link streams to disk; a fetch would hold the whole CSV in memory
    expect(link(/ballots \(csv\)/i)?.getAttribute('href'))
      .toContain('/api/batches/b1/elections/e1/ballots.csv')
    expect(link(/candidates \(csv\)/i)).toBeTruthy()
    expect(link(/sealed result \(json\)/i)).toBeTruthy()
    expect(link(/voters in every election/i)).toBeNull()
    expect(link(/checked-in members/i)).toBeNull()
  })

  it('offers only the whole-AGM files when given no election', () => {
    renderRouted(<Exports batchId="b1" electionId={undefined} />)
    expect(link(/voters in every election/i)?.getAttribute('href'))
      .toContain('/api/batches/b1/attendance.csv')
    expect(link(/checked-in members/i)?.getAttribute('href'))
      .toContain('/api/batches/b1/check-ins.csv')
    expect(link(/guests \(csv\)/i)).toBeTruthy()
    expect(link(/ballots \(csv\)/i)).toBeNull()
  })
})
