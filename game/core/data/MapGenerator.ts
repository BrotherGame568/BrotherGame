/**
 * MapGenerator.ts
 * Procedural hex map generation for the minimal playable version.
 * Owner: Architecture domain
 *
 * Pure data — no Phaser imports.
 * Generates a hex disk of a given radius, assigns site types,
 * danger levels, and resource surfaces based on distance from center.
 */

import type { HexTile, DistanceClass, SiteType, ResourceSurface } from './HexTile';
import { hexId, hexDistance } from './HexTile';

// ── Internal helpers ──────────────────────────────────────────

/** Simple seeded-ish random using cycle + coord for reproducibility within a session. */
function pick<T>(items: T[], seed: number): T {
  return items[Math.abs(seed) % items.length]!;
}

/** Returns a pseudo-random integer in [min, max] given a seed. */
function randInt(min: number, max: number, seed: number): number {
  // Simple LCG-style hash for determinism within the same map generation call
  const hash = (Math.abs(seed * 2654435761) >>> 0) % (max - min + 1);
  return min + hash;
}

/** Weighted site type distribution. */
const SITE_WEIGHTS: Array<{ type: SiteType; weight: number }> = [
  { type: 'empty',   weight: 40 },
  { type: 'town',    weight: 15 },
  { type: 'village', weight: 15 },
  { type: 'ruin',    weight: 15 },
  { type: 'deposit', weight: 10 },
  { type: 'skydock', weight: 5  },
];

const TOTAL_WEIGHT = SITE_WEIGHTS.reduce((s, w) => s + w.weight, 0);

function pickSiteType(seed: number): SiteType {
  let roll = Math.abs(seed * 2654435761 >>> 0) % TOTAL_WEIGHT;
  for (const entry of SITE_WEIGHTS) {
    roll -= entry.weight;
    if (roll < 0) return entry.type;
  }
  return 'empty';
}

// ── Distance class logic ──────────────────────────────────────

function getDistanceClass(dist: number): DistanceClass {
  if (dist <= 1) return 'near';
  if (dist <= 2) return 'mid';
  return 'far';
}

// ── Resource surface generation ───────────────────────────────

function generateResourceSurface(distClass: DistanceClass, siteType: SiteType, seed: number): ResourceSurface[] {
  if (siteType === 'empty') {
    // Empty hexes yield only a small amount of tier-1
    return [{ resourceId: 'food', tier: 1, baseYield: 2 }];
  }

  const surfaces: ResourceSurface[] = [];

  // Tier 1 always available for non-empty sites
  const t1Resource = (seed % 2 === 0) ? 'food' : 'water';
  surfaces.push({ resourceId: t1Resource, tier: 1, baseYield: 3 + randInt(0, 3, seed) });

  // Tier 2 available at mid and far
  if (distClass === 'mid' || distClass === 'far') {
    surfaces.push({ resourceId: 'acclivity_crystals', tier: 2, baseYield: 1 + randInt(0, 2, seed + 100) });
  }

  // Tier 3 available only at far
  if (distClass === 'far') {
    surfaces.push({ resourceId: 'ancient_relics', tier: 3, baseYield: 1 });
  }

  return surfaces;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Generate a hex disk of the given radius centered at (0, 0).
 * Returns an array of HexTile objects ready to be set on GSM.
 *
 * @param radius - map radius in hex rings (e.g. 3 → ~37 hexes)
 */
export function generateHexMap(radius: number): HexTile[] {
  const tiles: HexTile[] = [];
  const center = { q: 0, r: 0 };

  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      const s = -q - r;
      // Only include hexes within the hex disk (axial constraint)
      if (Math.abs(s) > radius) continue;

      const coord = { q, r };
      const dist = hexDistance(coord, center);
      const isCenter = q === 0 && r === 0;

      const distClass = getDistanceClass(dist);
      const seed = q * 1000 + r; // deterministic per-hex seed

      const siteType: SiteType = isCenter ? 'empty' : pickSiteType(seed);
      const dangerLevel = isCenter
        ? 0
        : Math.min(10, Math.max(1, Math.floor(dist * 2) + randInt(0, 2, seed + 50)));

      const tile: HexTile = {
        id: hexId(coord),
        coord,
        distanceClass: distClass,
        dangerLevel,
        siteType,
        factionId: null,
        resourceSurface: isCenter ? [] : generateResourceSurface(distClass, siteType, seed),
        siteState: isCenter ? 'visited' : 'undiscovered',
        lastVisitedCycle: isCenter ? 0 : -1,
        evolutionTimer: 0,
      };

      tiles.push(tile);
    }
  }

  return tiles;
}
