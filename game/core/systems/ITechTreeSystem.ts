/**
 * ITechTreeSystem.ts
 * Interface for city tech tree and building unlock rules.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { CityBuilding, BuildingId } from '@data/CityBuilding';

export interface ITechTreeSystem {
  /**
   * Returns true if all prerequisites for `buildingId` are met
   * and the player has sufficient resources.
   */
  canBuild(buildingId: BuildingId | string): boolean;

  /**
   * Start construction of a building in the given slot.
   * Spends resources, sets slot state to 'constructing', records completion cycle.
   * Throws if canBuild returns false.
   */
  startConstruction(buildingId: BuildingId | string, slotId: string): void;

  /**
   * Called at cycle start to complete any buildings whose constructionCycles have elapsed.
   * Applies building effects (reach delta, hero class unlocks, storage cap changes).
   * Returns IDs of buildings completed this cycle.
   */
  processCycleCompletions(currentCycle: number): string[];

  /**
   * Returns the full definition of a building by ID.
   * Returns undefined if the building ID is not in the definitions list.
   */
  getBuildingDefinition(buildingId: BuildingId | string): CityBuilding | undefined;

  /**
   * Returns all building IDs that are currently built (state = 'built' or 'upgraded').
   */
  getBuiltBuildings(): string[];

  /**
   * Returns all building IDs that the player can currently start constructing.
   */
  getAvailableBuildings(): string[];
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import type { IGameStateManager } from './IGameStateManager';

export class TechTreeSystemStub implements ITechTreeSystem {
  constructor(private _gsm: IGameStateManager) {}

  canBuild(_buildingId: string): boolean { return false; }
  startConstruction(_buildingId: string, _slotId: string): void { throw new Error('TechTreeSystem not implemented'); }
  processCycleCompletions(_currentCycle: number): string[] { return []; }
  getBuildingDefinition(_buildingId: string): CityBuilding | undefined { return undefined; }
  getBuiltBuildings(): string[] { return []; }
  getAvailableBuildings(): string[] { return []; }
}
