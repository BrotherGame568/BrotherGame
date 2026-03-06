/**
 * NoiseUtils.ts
 * Shared FBM / smooth-noise helpers used by biome generation and wind network generation.
 * Owner: Architecture domain — no Phaser imports, no game logic.
 *
 * These functions were originally inlined in WorldMapScene for biome colouring.
 * Extracting them here allows WindNetworkGenerator to reuse the same noise primitives.
 */

/** Avalanche-style 32-bit finalizer hash (avoids JS float-XOR overflow). */
export function h32(n: number): number {
  n = (Math.imul((n ^ (n >>> 16)) >>> 0, 0x45d9f3b)) >>> 0;
  n = (Math.imul((n ^ (n >>> 16)) >>> 0, 0x45d9f3b)) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

/** 2-D value noise at integer grid point (ix, iy). Returns [0, 1). */
export function noise2(ix: number, iy: number): number {
  const code = (Math.imul(ix & 0xFFFF, 73856093) ^ Math.imul(iy & 0xFFFF, 19349663)) >>> 0;
  return h32(code);
}

/** Bilinear-smooth noise with S-curve interpolation. */
export function smoothNoise(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (
    noise2(x0,   y0  ) * (1 - ux) * (1 - uy) +
    noise2(x0+1, y0  ) * ux       * (1 - uy) +
    noise2(x0,   y0+1) * (1 - ux) * uy       +
    noise2(x0+1, y0+1) * ux       * uy
  );
}

/**
 * Fractional Brownian Motion — sum of `octs` octaves, returns [0, 1].
 * Each successive octave doubles frequency and halves amplitude.
 */
export function fbm(px: number, py: number, octs: number): number {
  let v = 0, amp = 1, freq = 1, tot = 0;
  for (let i = 0; i < octs; i++) {
    v += smoothNoise(px * freq, py * freq) * amp;
    tot += amp;
    amp  *= 0.5;
    freq *= 2.1;
  }
  return v / tot;
}
