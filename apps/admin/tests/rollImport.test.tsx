import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RollImport } from '../src/screens/RollImport.js'
import { stub } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const preview = { total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: false }

const upload = () => {
  const file = new File(['"Net Id","First Name"\n'], 'members.csv', { type: 'text/csv' })
  fireEvent.change(screen.getByLabelText(/member export/i), { target: { files: [file] } })
}

/** Uploads a file the API answers with `body`. */
const showPreview = (status: number, body: unknown) => {
  stub(status, body)
  render(<RollImport batchId="b1" />)
  upload()
}

const importButton = () => screen.queryByRole('button', { name: /^import/i })

describe('RollImport', () => {
  it('previews the counts without importing, and notes a realigned export', async () => {
    showPreview(200, { ...preview, shifted: true })
    expect(await screen.findByText(/4 eligible/i)).toBeTruthy()
    expect(screen.getByText(/2 excluded/i)).toBeTruthy()
    // ALWAYS shown, even at zero: it is the number nobody looks for
    expect(screen.getByText(/0 skipped/i)).toBeTruthy()
    // the export's column-shift defect
    expect(screen.getByText(/realigned/i)).toBeTruthy()
    expect(importButton()).toBeTruthy()
  })

  it('WARNS when rows were skipped, because the export dropped members', async () => {
    showPreview(200, { ...preview, excluded: 1, skipped: 1 })
    expect((await screen.findByRole('alert')).textContent).toMatch(/skipped/i)
  })

  it('offers no import before a preview exists, or for a corrupt export', async () => {
    render(<RollImport batchId="b1" />)
    expect(importButton()).toBeNull()
    stub(400, { error: 'unterminated quoted field' })
    upload()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(importButton()).toBeNull()
  })

  it('confirms the import with the committed counts', async () => {
    showPreview(200, preview)
    fireEvent.click(await screen.findByRole('button', { name: /^import/i }))
    expect(await screen.findByText(/imported/i)).toBeTruthy()
  })
})
