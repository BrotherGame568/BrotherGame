/**
 * SiteEvolutionSystem.ts
 * Per-cycle surface site state evolution.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 *
 * Minimal implementation: visited sites slowly recover over cycles
 * if unvisited. This demonstrates the evolution mechanic without
 * needing a full probability table.
 */

import type { SiteState } from '@data/HexTile';
import type { ISiteEvolutionSystem } from './ISiteEvolutionSystem';
import type { IGameStateManager } from './IGameStateManager';

/** How many un-visited cycles before a 'visited' site begins recovering. */
const RECOVERY_THRESHOLD = 3;
/** How many cycles a 'recovering' site takes to become 'thriving'. */
const THRIVING_THRESHOLD = 2;

export class SiteEvolutionSystem implements ISiteEvolutionSystem {
  private _recentlyChanged: string[] = [];

  constructor(private _gsm: IGameStateManager) {}

  runEvolutionPass(currentCycle: number): string[] {
    const changed: string[] = [];

    for (const tile of this._gsm.hexMap) {
      // Only evolve non-empty, non-city hexes that have been discovered
      if (tile.siteType === 'empty') continue;
      if (tile.siteState === 'undiscovered') continue;

      // Increment evolution timer for unvisited hexes
      const cyclesSinceVisit = tile.lastVisitedCycle >= 0
        ? currentCycle - tile.lastVisitedCycle
        : 0;

      let newState: SiteState | null = null;

      switch (tile.siteState) {
        case 'visited':
          if (cyclesSinceVisit >= RECOVERY_THRESHOLD) {
            newState = 'recovering';
          }
          break;

        case 'recovering':
          // Timer based: evolve to thriving after enough cycles
          if (cyclesSinceVisit >= RECOVERY_THRESHOLD + THRIVING_THRESHOLD) {
            newState = 'thriving';
          }
          break;

        case 'contested':
          // Contested sites may become conquered if unvisited
          if (cyclesSinceVisit >= 2) {
            newState = 'conquered';
          }
          break;

        case 'destroyed':
          if (cyclesSinceVisit >= RECOVERY_THRESHOLD) {
            newState = 'recovering';
          }
          break;

        // discovered, conquered, thriving, abandoned — no auto-evolution in minimal version
        default:
          break;
      }

      if (newState) {
        this._gsm.updateHexTile(tile.id, {
          siteState: newState,
          evolutionTimer: tile.evolutionTimer + 1,
        });
        changed.push(tile.id);
      }
    }

    this._recentlyChanged = changed;
    return changed;
  }

  getSiteState(siteId: string): SiteState {
    return this._gsm.getHexById(siteId)?.siteState ?? 'undiscovered';
  }

  applySiteStateChange(siteId: string, newState: SiteState, cycle: number): void {
    this._gsm.updateHexTile(siteId, {
      siteState: newState,
      lastVisitedCycle: cycle,
    });
  }

  getRecentlyChangedSites(): string[] {
    return this._recentlyChanged;
  }
}
