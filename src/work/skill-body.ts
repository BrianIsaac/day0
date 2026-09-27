/** SHA-256 round constants: the first 32 bits of the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 initial hash: the first 32 bits of the square roots of the first 8 primes. */
const INITIAL_HASH = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * SHA-256 of some bytes, as lower-case hex (FIPS 180-4).
 *
 * @param bytes - The message.
 */
function sha256Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array(INITIAL_HASH);
  const schedule = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let t = 0; t < 16; t += 1) schedule[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const w15 = schedule[t - 15];
      const w2 = schedule[t - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      schedule[t] = (schedule[t - 16] + s0 + schedule[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + ROUND_CONSTANTS[t] + schedule[t]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + temp1) >>> 0, c, b, a, (temp1 + temp2) >>> 0];
    }
    const working = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index] + working[index]) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * The identity of a skill body, for the ledger to say which body a run used.
 *
 * Synchronous on purpose: it is computed inside the execution claim's
 * transaction, and an await on Web Crypto there hands control to the event
 * loop mid-mutation, which `convex-test` then interleaves with scheduled work.
 *
 * @param body - The skill's SKILL.md text.
 * @returns `sha256:` and the hex digest of the UTF-8 body.
 */
export function skillBodyHash(body: string): string {
  return `sha256:${sha256Hex(new TextEncoder().encode(body))}`;
}
