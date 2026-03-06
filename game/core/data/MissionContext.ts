/**
 * MissionContext.ts
 * Mission handoff contract between HexZoomScene and MissionScene.
 * Owner: Architecture domain
 *
 * These types define the exact data passed TO a mission and returned FROM it.
 * Any change to these types is a cross-domain breaking change — open an issue first.
 */

import type { SiteType, SiteState, ResourceSurface } from './HexTile';
import type { HeroStatus } from './Hero';
import type { SupportBonus } from './SupportBonus';

/** A single mission objective. */
export interface MissionObjective {
  id: string;
  type: 'collect' | 'reach' | 'eliminate' | 'interact';
  description: string;
  /** Whether the player must complete this objective for a 'success' outcome */
  isPrimary: boolean;
  /** Target quantity (for collect objectives) */
  targetAmount?: number;
  /** Target entity or location ID (for reach/eliminate/interact) */
  targetId?: string;
}

/**
 * All data passed from HexZoomScene → GameStateManager → MissionScene.
 * MissionScene reads this from GSM at scene create.
 */
export interface MissionContext {
  missionId: string;
  /** The hex tile ID of the site being visited */
  siteId: string;
  siteType: SiteType;
  /** 1–10 danger level; drives enemy difficulty */
  dangerLevel: number;
  /** Hero ID of the player-controlled character */
  activeHeroId: string;
  /** Hero ID of the passive support hero; null if none selected */
  supportHeroId: string | null;
  /**
   * Flattened bonus array from the support hero.
   * Applied once at MissionScene.create().
   */
  supportBonuses: SupportBonus[];
  /** Resources available to gather in this mission */
  resourceSurface: ResourceSurface[];
  objectives: MissionObjective[];
}

/**
 * Data returned from MissionScene → GameStateManager → HexZoomScene.
 * HexZoomScene reads this from GSM after MissionScene stops.
 */
export interface MissionResult {
  outcome: 'success' | 'retreat' | 'failure';
  /** Resources gathered during the mission, keyed by resourceId */
  resourcesGathered: Record<string, number>;
  /** Status updates to apply to heroes in the roster */
  heroStatusUpdates: Array<{
    heroId: string;
    newStatus: HeroStatus;
    experienceGained: number;
  }>;
  /** IDs of objectives that were completed */
  objectivesCompleted: string[];
  /**
   * New site state to apply after the mission.
   * null = site state does not change due to this visit.
   */
  siteStateChange: SiteState | null;
}

/**
 * Create a default empty MissionContext for stub/testing purposes.
 */
export function createDefaultMissionContext(overrides?: Partial<MissionContext>): MissionContext {
  return {
    missionId: 'mission_default',
    siteId: 'q0_r0',
    siteType: 'ruin',
    dangerLevel: 1,
    activeHeroId: 'hero_default',
    supportHeroId: null,
    supportBonuses: [],
    resourceSurface: [],
    objectives: [],
    ...overrides,
  };
}
