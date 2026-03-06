/**
 * HexTile.ts
 * Data types for the hex world map grid.
 * Owner: Architecture domain
 *
 * Pure data types — no logic, no Phaser imports.
 */

/** Axial coordinate for flat-top hex grid. */
export interface AxialCoord {
  q: number;
  r: number;
}

/**
 * Distance class baked into each hex tile at map-generation time.
 * Determines resource tier availability and danger level range.
 * near = rings 0–2, mid = rings 3–4, far = rings 5+
 */
export type DistanceClass = 'near' | 'mid' | 'far';

/**
 * What type of surface site occupies this hex.
 */
export type SiteType =
  | 'town'      // Inhabited town; diplomacy + trade possible
  | 'village'   // Small settlement; diplomacy possible
  | 'ruin'      // Abandoned structure; exploration + loot
  | 'deposit'   // Natural resource deposit; extraction mission
  | 'skydock'   // Sky dock; trade with sky cities
  | 'empty';    // No notable feature; auto Tier 1 yield only

/**
 * Current lifecycle state of a surface site.
 * Changes between player visits via ISiteEvolutionSystem.
 */
export type SiteState =
  | 'undiscovered'  // Player has no visibility yet
  | 'discovered'    // Visible but not visited
  | 'visited'       // Player completed a mission here
  | 'contested'     // Faction conflict underway
  | 'conquered'     // Hostile faction controls the site
  | 'destroyed'     // Site is rubble; minimal resource yield
  | 'recovering'    // Slowly rebuilding after destruction
  | 'thriving'      // Grown since last visit; bonus resources
  | 'abandoned';    // Population left; no resource yield

/**
 * Describes what resources a hex site can yield in a mission.
 */
export interface ResourceSurface {
  resourceId: string;
  tier: 1 | 2 | 3;
  /** Base yield amount before hero bonuses */
  baseYield: number;
}

/**
 * A single cell in the hex world map.
 */
export interface HexTile {
  /** Unique string identifier, e.g. "q0_r0" */
  id: string;
  coord: AxialCoord;
  distanceClass: DistanceClass;
  /** 1–10 scale; scales with distanceClass */
  dangerLevel: number;
  siteType: SiteType;
  /** Controlling faction ID; null = unclaimed */
  factionId: string | null;
  /** Resources available to gather in a mission */
  resourceSurface: ResourceSurface[];
  siteState: SiteState;
  /** Cycle index on which player last visited; -1 = never */
  lastVisitedCycle: number;
  /** Internal counter incremented each cycle city does not visit */
  evolutionTimer: number;
}

/**
 * Compute axial distance between two hex tiles.
 */
export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/**
 * Get all six axial neighbors of a given coordinate.
 */
export function hexNeighbors(coord: AxialCoord): AxialCoord[] {
  const directions: AxialCoord[] = [
    { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
    { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
  ];
  return directions.map(d => ({ q: coord.q + d.q, r: coord.r + d.r }));
}

/**
 * Create a default HexTile ID string from axial coordinates.
 */
export function hexId(coord: AxialCoord): string {
  return `q${coord.q}_r${coord.r}`;
}
