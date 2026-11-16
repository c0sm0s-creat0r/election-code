import { describe, it, expect, vi, afterEach } from 'vitest'
import { forgetReceipt, readReceipts, rememberReceipt } from '../src/receipts.js'
import { stubStorage } from './helpers.js'

afterEach(() => vi.unstubAllGlobals())

describe('held receipts', () => {
  it('remembers a token per society, because one device may vote at two AGMs', () => {
    stubStorage()
    expect(rememberReceipt('b1', 'e1', 'tok-1')).toEqual({ e1: 'tok-1' })
    rememberReceipt('b2', 'e1', 'tok-2')
    expect(readReceipts('b1')).toEqual({ e1: 'tok-1' })
    expect(readReceipts('b2')).toEqual({ e1: 'tok-2' })
  })

  it('forgets a voided ballot, so the election is offered again', () => {
    stubStorage()
    rememberReceipt('b1', 'e1', 'tok-1')
    rememberReceipt('b1', 'e2', 'tok-2')
    expect(forgetReceipt('b1', 'e1')).toEqual({ e2: 'tok-2' })
  })

  it('SURVIVES STORAGE THAT THROWS, which is the whole reason for the guards', () => {
    // Safari's private mode. A voter there must still be able to vote.
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied, clear: denied })
    expect(readReceipts('b1')).toEqual({})
    expect(rememberReceipt('b1', 'e1', 'tok-1')).toEqual({ e1: 'tok-1' })
    expect(forgetReceipt('b1', 'e1')).toEqual({})
  })

  it('ignores a stored value that is not a map of tokens', () => {
    // anyone can edit their own localStorage
    for (const [stored, held] of [
      ['["not", "an", "object"]', {}],
      ['{"e1": 7, "e2": "tok-2"}', { e2: 'tok-2' }],
      ['not json at all', {}],
    ] as const) {
      stubStorage({ 'election:receipts:b1': stored })
      expect(readReceipts('b1')).toEqual(held)
    }
  })
})
