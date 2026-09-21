/**
 * Identify an image by its bytes.
 *
 * The legacy implementation used `allowed_file()`, which checked the filename's
 * extension — a value the uploader chooses, so the check was decoration. Naming
 * a payload `logo.png` was enough to store it and have it served back from the
 * society's own origin. This reads the magic bytes instead.
 *
 * **SVG is deliberately absent.** It is XML, it can carry `<script>`, and it
 * has no magic number to sniff — so it is unsupported rather than
 * special-cased. A raster logo is what a society needs on a ballot page.
 */
export type ImageType = { ext: 'png' | 'jpeg' | 'gif' | 'webp'; mime: string }

export function detectImageType(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...expected: number[]): boolean =>
    expected.every((value, i) => bytes[offset + i] === value)

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpeg', mime: 'image/jpeg' }
  // GIF87a and GIF89a share the first four bytes.
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { ext: 'gif', mime: 'image/gif' }
  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}
