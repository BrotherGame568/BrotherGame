/**
 * CityState.ts
 * Data type for the current state of the player's floating city.
 * Owner: Architecture domain
 *
 * Pure data type — no logic, no Phaser imports.
 */

import type { BuildingSlotState } from './CityBuilding';

/**
 * Complete current state of the city, stored in GameStateManager.
 */
export interface CityState {
  /** All building slots and their current building/construction state */
  buildingSlots: BuildingSlotState[];
  /**
   * Current reach radius (in hex distance units).
   * Base value: 2. Increased by Navigator's Guild and Observatory.
   */
  reachRadius: number;
  /** IDs of hero classes currently available for recruitment */
  availableHeroClasses: string[];
  /** IDs of tech unlocks that have been completed */
  completedTechUnlocks: string[];
  /** Resource storage caps (modified by Storage Annex upgrades) */
  storageCaps: {
    tier1: number;
    tier2: number;
    tier3: number;
  };
}

/**
 * Create a default starting CityState.
 */
export function createDefaultCityState(): CityState {
  return {
    buildingSlots: [],      // Populated from building slot definitions in Phase 1
    reachRadius: 2,
    availableHeroClasses: [],
    completedTechUnlocks: [],
    storageCaps: {
      tier1: 100,
      tier2: 20,
      tier3: 5,
    },
  };
}
