/**
 * WindNetwork.ts
 * Persistent wind current network — data types and name pool.
 * Owner: Architecture domain
 *
 * Pure data — no Phaser imports, no game logic.
 * Generated once at world creation by WindNetworkGenerator; stored in GSM.
 */

import type { AxialCoord } from './HexTile';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * A single named wind current.
 * Winds follow curving, organic paths across the world map.
 * The city travels along a corridor's spine at `speed` hexes per cycle.
 */
export interface WindCorridor {
  id: string;
  /** Human-readable name shown to the player, e.g. "Boreal Gyre". */
  name: string;
  /**
   * Ordered spine hexes — the centerline the city follows.
   * Index 0 is the start; index spine.length-1 is the terminus.
   */
  spine: AxialCoord[];
  /**
   * All hexes within `BAND_RADIUS` of the spine.
   * Used by ReachSystem to determine accessible sites this cycle.
   */
  bandHexes: AxialCoord[];
  /** How many spine hexes the city advances per cycle on this corridor. */
  speed: number;
  /** Display colour as a 24-bit hex number (e.g. 0x3399ff). */
  color: number;
}

/**
 * A point where two or more corridor spines share a hex.
 * Only at junctions can the player switch to a different wind current.
 */
export interface WindJunction {
  id: string;
  /** World hex at the centre of this junction. */
  hex: AxialCoord;
  /** IDs of every WindCorridor passing through this junction. */
  corridorIds: string[];
  /**
   * For each corridor, the index within its `spine` array
   * that is closest to this junction hex.
   */
  spineIndices: Record<string, number>;
}

/**
 * The full persistent wind network.
 * Generated once, stored on GSM, rendered in WorldMapScene throughout the game.
 */
export interface WindNetwork {
  corridors: WindCorridor[];
  junctions: WindJunction[];
}

// ---------------------------------------------------------------------------
// Name pool — 40 thematic wind-current names
// ---------------------------------------------------------------------------

export const WIND_NAMES: string[] = [
  'Boreal Gyre',
  'Amber Drift',
  'Shattered Trades',
  'Pale Monsoon',
  'Iron Thermocline',
  'Gilded Zephyr',
  'Grey Roaring',
  'Scarlet Easterlies',
  'Obsidian Vent',
  'Verdant Surge',
  'Salt Caravan',
  'Hollow Wind',
  'Ember Trades',
  'Cobalt Current',
  'Silver Squall',
  'The Long Reach',
  'Forgotten Gale',
  'Dust Rider',
  'Thorn Passage',
  'Jade Spiral',
  'Cradle Stream',
  'Volcanic Draft',
  'Bone Jet',
  'Silk Road Wind',
  'Ashen Torrent',
  'Evening Thermocline',
  'Root Current',
  'Widow Drift',
  'Cinder Bloom',
  'Glacial Trade',
  'Copper Tacking',
  'Spiral Reach',
  'Night Trades',
  'Meridian Flow',
  'The Wandering',
  'Fracture Current',
  'Tide Whisper',
  'Solar Rake',
  'Deep Gust',
  'Crown Wind',
];

// ---------------------------------------------------------------------------
// Visual colour palette for corridors
// ---------------------------------------------------------------------------

// Soft, atmospheric wind colours — muted pastels evoking sky, mist, and air.
export const CORRIDOR_COLORS: number[] = [
  0x9bd4f0, // pale sky blue
  0x7ecfcf, // soft cyan
  0xb4dcc8, // seafoam
  0xc8c0e8, // pale lavender
  0xe8d890, // pale gold / sunlit
  0xf0bcb4, // blush rose
  0xb0d4a0, // sage green
  0x8fb8d8, // dusty blue
  0xd4bce0, // soft mauve
  0xa8d4ac, // mint mist
  0xe8cca0, // warm cream
  0xb4c8e0, // slate mist
];

// ---------------------------------------------------------------------------
// Empty sentinel
// ---------------------------------------------------------------------------

export const EMPTY_WIND_NETWORK: WindNetwork = { corridors: [], junctions: [] };
