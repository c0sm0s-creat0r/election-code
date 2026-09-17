/**
 * PBKDF2-HMAC-SHA256 via WebCrypto.
 *
 * Argon2 and bcrypt are deliberately not used: both need a WASM build on
 * Workers, where PBKDF2 is native. 210,000 iterations follows OWASP guidance
 * for PBKDF2-HMAC-SHA256.
 *
 * Encoded form: pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>
 */
const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 210_000
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

/** Constant-time comparison. Never short-circuit on the first differing byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
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
