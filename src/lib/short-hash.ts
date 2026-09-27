/** The FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A stable 32-bit FNV-1a digest of a string's UTF-8 bytes.
 *
 * Synchronous and dependency-free so the browser, the Convex runtime and Node
 * compute the same value. It is an identity key, not a security measure.
 *
 * @returns An unsigned 32-bit integer.
 */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * A short, lowercase base-36 digest of a string, always seven characters.
 *
 * @returns The digest, left-padded with `0`.
 */
export function shortHash(text: string): string {
  return fnv1a32(text).toString(36).padStart(7, '0');
}
