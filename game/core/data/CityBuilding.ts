/**
 * CityBuilding.ts
 * Data types for city buildings and their slot assignments.
 * Owner: Architecture domain
 *
 * Pure data types — no logic, no Phaser imports.
 */

import type { ResourceQuantityMap } from './Resource';

/** Visual state of a building slot. */
export type BuildingState = 'empty' | 'constructing' | 'built' | 'upgraded';

/**
 * A named position in the CityViewScene where a building can be placed.
 * Corresponds to an interactive region in the city background artwork.
 */
export type BuildingSlotId = string;

/**
 * Definition of a buildable city building.
 * Loaded from game/core/data/buildingDefinitions.json (Phase 1).
 */
export interface CityBuilding {
  id: string;
  displayName: string;
  description: string;
  /** Which slot(s) this building may be placed in */
  slotId: BuildingSlotId;
  /** Resource cost to start construction (requires all listed resources) */
  cost: ResourceQuantityMap;
  /** Building whose id must be 'built' before this one can be constructed */
  prerequisiteId: string | null;
  /**
   * How much the city's reachRadius increases when this building is built.
   * 0 for buildings that don't affect reach.
   */
  reachRadiusDelta: number;
  /** IDs of hero classes this building unlocks for recruitment */
  unlocksHeroClasses: string[];
  /** Asset ID for the built building sprite (see MANIFEST.md) */
  spriteId: string;
  /** Number of cycles required for construction (0 = instant) */
  constructionCycles: number;
}

/**
 * Current state of a single building slot in the player's city.
 */
export interface BuildingSlotState {
  slotId: BuildingSlotId;
  buildingId: string | null;     // null = empty slot
  state: BuildingState;
  /** Cycle on which construction completes; -1 if not constructing */
  completionCycle: number;
}

/**
 * All building definitions available in the game (starting set).
 * Actual balance data is in buildingDefinitions.json — this is the type only.
 */
export const BUILDING_IDS = {
  BARRACKS: 'barracks',
  SCOUTING_POST: 'scouting_post',
  DIPLOMATS_HALL: 'diplomats_hall',
  NAVIGATORS_GUILD: 'navigators_guild',
  STORAGE_ANNEX: 'storage_annex',
  RESEARCH_SPIRE: 'research_spire',
  OBSERVATORY: 'long_range_observatory',
} as const;

export type BuildingId = typeof BUILDING_IDS[keyof typeof BUILDING_IDS];
