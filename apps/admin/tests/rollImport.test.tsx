import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RollImport } from '../src/screens/RollImport.js'

afterEach(() => vi.unstubAllGlobals())

const stub = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })))

const upload = () => {
  const file = new File(['"Net Id","First Name"\n'], 'members.csv', { type: 'text/csv' })
  fireEvent.change(screen.getByLabelText(/member export/i), { target: { files: [file] } })
}

describe('RollImport', () => {
  it('previews counts without importing', async () => {
    stub(200, { total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: true })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByText(/4 eligible/i)).toBeTruthy())
    expect(screen.getByText(/2 excluded/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^import/i })).toBeTruthy()
  })

  it('ALWAYS shows skipped, even at zero — it is the number nobody looks for', async () => {
    stub(200, { total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: false })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByText(/0 skipped/i)).toBeTruthy())
  })

  it('WARNS when rows were skipped, because the export dropped members', async () => {
    stub(200, { total: 6, eligible: 4, excluded: 1, skipped: 1, shifted: false })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/skipped/i))
  })

  it('notes when the export had the column-shift defect', async () => {
    stub(200, { total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: true })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByText(/realigned/i)).toBeTruthy())
  })

  it('does not offer to import before a preview exists', () => {
    render(<RollImport batchId="b1" />)
    expect(screen.queryByRole('button', { name: /^import/i })).toBeNull()
  })

  it('reports a corrupt export without importing', async () => {
    stub(400, { error: 'unterminated quoted field' })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^import/i })).toBeNull()
  })

  it('confirms the import with the committed counts', async () => {
    stub(200, { total: 6, eligible: 4, excluded: 2, skipped: 0, shifted: false })
    render(<RollImport batchId="b1" />)
    upload()
    await waitFor(() => expect(screen.getByRole('button', { name: /^import/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^import/i }))
    await waitFor(() => expect(screen.getByText(/imported/i)).toBeTruthy())
  })
})
