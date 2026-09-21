/**
 * SHA-256, hex.
 *
 * One implementation because two of its callers are the **writer** and the
 * **reader** of `ballot.receipt_hash`: `routes/ballots.ts` derives it from a
 * freshly minted token, `routes/receipts.ts` derives it again from a token a
 * voter presents. Any divergence between them makes every receipt
 * un-lookupable, and no single test covers both spellings.
 */
const toHex = (digest: ArrayBuffer): string =>
  Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: workers-types wants a
 *  view whose buffer is an ArrayBuffer, which is what `await file.arrayBuffer()`
 *  produces. */
export async function sha256HexBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}
