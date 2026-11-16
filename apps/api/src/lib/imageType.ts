/**
 * Identify an image by its magic bytes, never by filename.
 *
 * No SVG: it is XML, can carry `<script>`, and has no magic number.
 */
export type ImageType = { ext: 'png' | 'jpeg' | 'gif' | 'webp'; mime: string }

export function detectImageType(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...expected: number[]): boolean =>
    expected.every((value, i) => bytes[offset + i] === value)

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: 'jpeg', mime: 'image/jpeg' }
  // GIF87a and GIF89a share the first four bytes.
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { ext: 'gif', mime: 'image/gif' }
  // RIFF....WEBP: skip the four size bytes between the markers.
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}
