// Vitest seam for expo-crypto: a deterministic stand-in for
// getRandomBytesAsync backed by a seeded xorshift generator.
let state = 0x9e3779b9;

function nextByte(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state & 0xff;
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < out.length; i++) out[i] = nextByte();
  return out;
}

/** Test helper: reseed the generator between tests. */
export function __seed(seed: number): void {
  state = seed >>> 0 || 0x9e3779b9;
}
