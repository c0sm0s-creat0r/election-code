import { describe, it, expect, vi, afterEach } from 'vitest'
import { forgetReceipt, readReceipts, rememberReceipt } from '../src/receipts.js'

afterEach(() => vi.unstubAllGlobals())

const withStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  })
  return store
}

/** Every method throws, the way Safari's private mode does. */
const withBrokenStorage = () =>
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('denied') },
    clear: () => { throw new Error('denied') },
  })

describe('held receipts', () => {
  it('remembers a token and reads it back', () => {
    withStorage()
    expect(rememberReceipt('b1', 'e1', 'tok-1')).toEqual({ e1: 'tok-1' })
    expect(readReceipts('b1')).toEqual({ e1: 'tok-1' })
  })

  it('keeps societies apart, because one device may vote at two AGMs', () => {
    withStorage()
    rememberReceipt('b1', 'e1', 'tok-1')
    rememberReceipt('b2', 'e1', 'tok-2')
    expect(readReceipts('b1')).toEqual({ e1: 'tok-1' })
    expect(readReceipts('b2')).toEqual({ e1: 'tok-2' })
  })

  it('forgets a voided ballot, so the election is offered again', () => {
    withStorage()
    rememberReceipt('b1', 'e1', 'tok-1')
    rememberReceipt('b1', 'e2', 'tok-2')
    expect(forgetReceipt('b1', 'e1')).toEqual({ e2: 'tok-2' })
  })

  it('SURVIVES STORAGE THAT THROWS, which is the whole reason for the guards', () => {
    // A voter in private mode must still be able to vote. Losing the token costs
    // them the receipt; an exception would cost them the ballot.
    withBrokenStorage()
    expect(readReceipts('b1')).toEqual({})
    expect(rememberReceipt('b1', 'e1', 'tok-1')).toEqual({ e1: 'tok-1' })
    expect(forgetReceipt('b1', 'e1')).toEqual({})
  })

  it('ignores a stored value that is not a map of tokens', () => {
    // Anyone can edit their own localStorage. A non-string where a token belongs
    // would otherwise reach the receipt lookup as one.
    withStorage({ 'election:receipts:b1': '["not", "an", "object"]' })
    expect(readReceipts('b1')).toEqual({})

    withStorage({ 'election:receipts:b1': '{"e1": 7, "e2": "tok-2"}' })
    expect(readReceipts('b1')).toEqual({ e2: 'tok-2' })

    withStorage({ 'election:receipts:b1': 'not json at all' })
    expect(readReceipts('b1')).toEqual({})
  })
})
