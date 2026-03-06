/**
 * SiteVisitRecord.ts
 * Data type recording a single player visit to a surface site.
 * Owner: Architecture domain
 *
 * Pure data type — no logic, no Phaser imports.
 */

import type { SiteState } from './HexTile';

/**
 * A record of one visit to a surface site hex.
 * Stored per siteId in GameStateManager.siteHistory.
 */
export interface SiteVisitRecord {
  siteId: string;
  cycleIndex: number;
  /** Mission outcome for this visit */
  outcome: 'success' | 'retreat' | 'failure' | 'skipped';
  /** Site state at the time of this visit */
  siteStateAtVisit: SiteState;
  /** Site state at the start of the NEXT visit (null until next visit occurs) */
  siteStateAtNextVisit: SiteState | null;
  /** Resources gathered during this visit */
  resourcesGathered: Record<string, number>;
}
