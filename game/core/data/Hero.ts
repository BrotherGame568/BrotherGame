/**
 * Hero.ts
 * Data types for the hero entity.
 * Owner: Architecture domain
 *
 * Pure data types — no logic, no Phaser imports.
 */

import type { SupportBonus } from './SupportBonus';

/**
 * Available hero classes. Each class has a different stat spread.
 * New classes are unlocked by building specific city buildings.
 */
export type HeroClass = 'skirmisher' | 'scout' | 'envoy';

/**
 * Core stat values for a hero. All stats are on a 1–10 scale.
 */
export interface HeroStats {
  /** Affects attack power and hit points in MissionScene */
  combat: number;
  /** Affects interaction range and map reveal speed in MissionScene */
  exploration: number;
  /** Unlocks dialogue options at neutral/ally sites */
  diplomacy: number;
}

/**
 * Lifecycle status of a hero.
 */
export type HeroStatus =
  | 'available'   // Can be assigned to a mission party
  | 'on_mission'  // Currently in MissionScene
  | 'injured'     // Was Active hero on a failed mission; cannot be assigned
  | 'recovering'; // Injured for this cycle; becomes available next cycle start

/**
 * A hero entity stored in the hero roster.
 */
export interface Hero {
  id: string;
  name: string;
  heroClass: HeroClass;
  stats: HeroStats;
  status: HeroStatus;
  /**
   * Bonuses applied when this hero is in the Support role.
   * These are read from MissionContext.supportBonuses — this array
   * defines what the hero contributes as support.
   */
  bonusArray: SupportBonus[];
  /** Cumulative experience points from missions */
  experience: number;
  /** Asset ID for the hero portrait sprite (see MANIFEST.md) */
  portraitId: string;
}

/**
 * The two-hero party sent on a mission.
 */
export interface MissionParty {
  /** Hero ID of the player-controlled character */
  activeHeroId: string;
  /** Hero ID of the support hero (passive bonuses only); null if none assigned */
  supportHeroId: string | null;
}

/**
 * Create a default hero with all required fields.
 * Useful for testing stubs.
 */
export function createDefaultHero(overrides?: Partial<Hero>): Hero {
  return {
    id: 'hero_default',
    name: 'Unknown Hero',
    heroClass: 'skirmisher',
    stats: { combat: 5, exploration: 5, diplomacy: 5 },
    status: 'available',
    bonusArray: [],
    experience: 0,
    portraitId: 'hero_portrait_skirmisher',
    ...overrides,
  };
}
