/**
 * IHeroSystem.ts
 * Interface for hero roster management and mission party assignment.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { Hero, HeroClass, HeroStatus, MissionParty } from '@data/Hero';

export interface IHeroSystem {
  /**
   * Returns all heroes currently in the roster.
   */
  getRoster(): Hero[];

  /**
   * Returns heroes whose status is 'available'.
   */
  getAvailable(): Hero[];

  /**
   * Recruit a new hero of the given class.
   * Throws if the hero class is not unlocked in cityState.
   * Throws if resource cost cannot be met.
   * Returns the newly created hero.
   */
  recruit(heroClass: HeroClass): Hero;

  /**
   * Assign a mission party (active + optional support hero).
   * Validates both heroes are 'available' and different.
   * Sets both heroes' status to 'on_mission'.
   */
  assignToMission(party: MissionParty): void;

  /**
   * Return heroes from a mission, applying status updates from MissionResult.
   * Called by MissionScene on completion.
   */
  returnFromMission(updates: Array<{ heroId: string; newStatus: HeroStatus; experienceGained: number }>): void;

  /**
   * Advance recovering heroes at the start of a new cycle.
   * Heroes with status 'recovering' become 'available'.
   * Heroes with status 'injured' become 'recovering'.
   */
  advanceCycleStatuses(): void;

  /**
   * Get a hero by ID. Returns undefined if not found.
   */
  getById(heroId: string): Hero | undefined;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import { createDefaultHero } from '@data/Hero';
import type { IGameStateManager } from './IGameStateManager';

export class HeroSystemStub implements IHeroSystem {
  constructor(private _gsm: IGameStateManager) {}

  getRoster(): Hero[] { return this._gsm.heroRoster; }
  getAvailable(): Hero[] { return this._gsm.heroRoster.filter(h => h.status === 'available'); }
  recruit(_heroClass: HeroClass): Hero { return createDefaultHero(); }
  assignToMission(_party: MissionParty): void { /* stub: no-op */ }
  returnFromMission(_updates: Array<{ heroId: string; newStatus: HeroStatus; experienceGained: number }>): void { /* stub: no-op */ }
  advanceCycleStatuses(): void { /* stub: no-op */ }
  getById(heroId: string): Hero | undefined { return this._gsm.heroRoster.find(h => h.id === heroId); }
}
