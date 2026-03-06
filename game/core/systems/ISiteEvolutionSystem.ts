/**
 * ISiteEvolutionSystem.ts
 * Interface for per-cycle surface site state evolution.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { HexTile, SiteState } from '@data/HexTile';

export interface ISiteEvolutionSystem {
  /**
   * Run the evolution pass for all hex tiles.
   * Called once per cycle after all player actions.
   * Updates siteState and evolutionTimer on each HexTile via GSM.
   * Returns an array of siteIds that changed state this cycle.
   */
  runEvolutionPass(currentCycle: number): string[];

  /**
   * Get the current state of a site by its hex tile ID.
   */
  getSiteState(siteId: string): SiteState;

  /**
   * Apply a specific state change to a site (used by MissionScene on result).
   */
  applySiteStateChange(siteId: string, newState: SiteState, cycle: number): void;

  /**
   * Get all sites that changed state during the most recent evolution pass.
   * Used by HexZoomScene to show state-change indicators.
   */
  getRecentlyChangedSites(): string[];
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import type { IGameStateManager } from './IGameStateManager';

export class SiteEvolutionSystemStub implements ISiteEvolutionSystem {
  private _recentlyChanged: string[] = [];

  constructor(private _gsm: IGameStateManager) {}

  runEvolutionPass(_currentCycle: number): string[] { return []; }
  getSiteState(siteId: string): SiteState {
    return this._gsm.getHexById(siteId)?.siteState ?? 'undiscovered';
  }
  applySiteStateChange(siteId: string, newState: SiteState, _cycle: number): void {
    this._gsm.updateHexTile(siteId, { siteState: newState });
  }
  getRecentlyChangedSites(): string[] { return this._recentlyChanged; }
}
