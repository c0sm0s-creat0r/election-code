import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

describe('password hashing', () => {
  it('verifies the right password and no other', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  // Production Workers throw above 100,000 iterations; local workerd does not.
  // Only this test catches a count over the cap.
  it('encodes scheme, salt and exactly 100,000 iterations, and never the plaintext', async () => {
    const stored = await hashPassword('hunter2')
    const parts = stored.split('$')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('pbkdf2-sha256')
    expect(Number(parts[1])).toBe(100_000)
    expect(stored).not.toContain('hunter2')
  })

  it('returns false rather than throwing on a malformed stored value', async () => {
    for (const stored of ['garbage', '', 'pbkdf2-sha256$210000$!!!$###']) {
      expect(await verifyPassword('x', stored)).toBe(false)
    }
  })
})
