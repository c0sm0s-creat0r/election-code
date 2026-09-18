import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('stores algorithm, iterations and salt in the encoded form', async () => {
    const stored = await hashPassword('x')
    const [scheme, iterations] = stored.split('$')
    expect(scheme).toBe('pbkdf2-sha256')
    expect(Number(iterations)).toBeGreaterThanOrEqual(210_000)
    expect(stored.split('$')).toHaveLength(4)
  })

  it('never stores the plaintext', async () => {
    expect(await hashPassword('hunter2')).not.toContain('hunter2')
  })

  it('returns false rather than throwing on a malformed stored value', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2-sha256$210000$!!!$###')).toBe(false)
  })
})
