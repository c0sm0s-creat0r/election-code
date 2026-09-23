import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { Exports } from '../src/screens/Exports.js'
import { renderRouted } from './renderOfficer.js'

/**
 * The component shows what it was given: the files for one election, or the
 * whole-AGM files — never both. Repeating the AGM-wide ones under every election's
 * result would suggest they were about that election.
 */
describe('Exports', () => {
  it('offers the per-election files when given an election', () => {
    renderRouted(<Exports batchId="b1" electionId="e1" />)
    for (const name of [/ballots \(csv\)/i, /candidates \(csv\)/i, /sealed result \(json\)/i]) {
      expect(screen.getByRole('link', { name })).toBeTruthy()
    }
  })

  it('offers the whole-AGM files when given no election', () => {
    renderRouted(<Exports batchId="b1" electionId={undefined} />)
    expect(screen.getByRole('link', { name: /voters in every election/i }).getAttribute('href'))
      .toContain('/api/batches/b1/attendance.csv')
    expect(screen.getByRole('link', { name: /checked-in members/i }).getAttribute('href'))
      .toContain('/api/batches/b1/check-ins.csv')
    expect(screen.getByRole('link', { name: /guests \(csv\)/i })).toBeTruthy()
  })

  it('never shows both sets at once', () => {
    renderRouted(<Exports batchId="b1" electionId="e1" />)
    expect(screen.queryByRole('link', { name: /voters in every election/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /checked-in members/i })).toBeNull()
  })

  it('shows no per-election files without an election', () => {
    renderRouted(<Exports batchId="b1" electionId={undefined} />)
    expect(screen.queryByRole('link', { name: /ballots \(csv\)/i })).toBeNull()
  })

  it('links straight at the API, so the browser streams the file to disk', () => {
    // A fetch would hold a multi-megabyte CSV in a laptop's memory mid-AGM.
    renderRouted(<Exports batchId="b1" electionId="e1" />)
    const href = screen.getByRole('link', { name: /ballots \(csv\)/i }).getAttribute('href')
    expect(href).toContain('/api/batches/b1/elections/e1/ballots.csv')
  })
})
