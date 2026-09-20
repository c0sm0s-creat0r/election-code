/**
 * Constant-time byte comparison. Never short-circuit on the first differing
 * byte — used everywhere a secret (password hash, session signature, the
 * super-admin key) is compared against attacker-supplied input.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
