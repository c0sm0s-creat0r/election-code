/**
 * PBKDF2-HMAC-SHA256 via WebCrypto. Argon2 and bcrypt would need WASM.
 *
 * 100,000 iterations is the Workers ceiling. Production throws
 * NotSupportedError above it; local workerd does not. Do not raise it.
 * verifyPassword reads the count from the stored value, so a hash written at
 * a higher count by `wrangler dev` against the remote database fails in
 * production. Reset that password.
 *
 * Format: pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>
 */
import { timingSafeEqual } from './timing-safe-equal.js'

const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256

const b64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

async function derive(plain: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(plain), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_BITS)
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const bits = await derive(plain, salt, ITERATIONS)
  return `${SCHEME}$${ITERATIONS}$${b64(salt.buffer)}$${b64(bits)}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4) return false
  const [scheme, iterStr, saltB64, hashB64] = parts as [string, string, string, string]
  if (scheme !== SCHEME) return false
  const iterations = Number(iterStr)
  if (!Number.isInteger(iterations) || iterations < 1) return false
  try {
    const bits = await derive(plain, unb64(saltB64), iterations)
    return timingSafeEqual(new Uint8Array(bits), unb64(hashB64))
  } catch {
    return false
  }
}
