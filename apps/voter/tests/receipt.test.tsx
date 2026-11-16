import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/preact'
import { Receipt } from '../src/screens/Receipt.js'
import { stub } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

const recorded = { status: 'recorded', election_name: 'President' }

const show = (status: number, body: unknown, token = 't-1') => {
  stub(status, body)
  const onVoided = vi.fn()
  const { container } = render(<Receipt token={token} onVoided={onVoided} />)
  return { onVoided, container }
}

const voteAgain = () => screen.findByRole('button', { name: /vote again/i })

describe('Receipt', () => {
  it('shows a recorded ballot, its election, and the token so it can be kept', async () => {
    show(200, recorded)
    expect(await screen.findByText(/recorded/i)).toBeTruthy()
    expect(screen.getByText(/President/)).toBeTruthy()
    expect(screen.getByText('t-1')).toBeTruthy()
  })

  it('NEVER shows preferences, because a receipt that proves how you voted enables coercion', async () => {
    const { container } = show(200, recorded)
    await screen.findByText(/recorded/i)
    expect(container.textContent).not.toMatch(/preference/i)
  })

  it('reports an unknown token', async () => {
    show(404, { error: 'not found' }, 'nope')
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('does not offer to void an already-voided ballot', async () => {
    show(200, { ...recorded, status: 'voided' })
    await screen.findByText(/voided/i)
    expect(screen.queryByRole('button', { name: /vote again/i })).toBeNull()
  })

  it('voids a recorded ballot and tells the parent, so it can offer a new one', async () => {
    const { onVoided } = show(200, recorded)
    const button = await voteAgain()
    stub(200, { status: 'voided' })
    fireEvent.click(button)
    await waitFor(() => expect(onVoided).toHaveBeenCalled())
  })

  it('reports a refused void without pretending it worked', async () => {
    const { onVoided } = show(200, recorded)
    const button = await voteAgain()
    stub(409, { error: 'voting has closed', code: 'not_open' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/closed/i))
    expect(onVoided).not.toHaveBeenCalled()
  })
})
