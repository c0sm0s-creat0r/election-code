/**
 * SHA-256, hex. ballots.ts writes `ballot.receipt_hash` with it and
 * receipts.ts must derive the same value.
 */
const toHex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** `Uint8Array<ArrayBuffer>`: workers-types wants a view over an ArrayBuffer. */
export async function sha256HexBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}
