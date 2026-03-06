/**
 * ITradewindSystem.ts
 * Interface for managing city movement along the persistent wind corridor network.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 *
 * Design: corridors are persistent road-networks generated once at world
 * creation.  The city automatically advances each cycle and can only switch
 * currents at junction hexes where two or more corridor spines intersect.
 */

import type { AxialCoord } from '@data/HexTile';
import type { WindCorridor, WindJunction } from '@data/WindNetwork';

export interface ITradewindSystem {
  /**
   * Advance the city `speed` spine steps along the current corridor.
   * Updates GSM: cityHex, currentSpineIndex, windCorridor (band hexes), cycleCount.
   * Stops at the terminus if the city would overshoot.
   */
  advanceCityAlongCorridor(): void;

  /**
   * True when the city's current spine position is at or within 1 step of
   * a WindJunction.
   */
  isAtJunction(): boolean;

  /**
   * Return the nearest upcoming junction within LOOK_AHEAD spine steps, plus
   * the corridor options available there (excluding the city's current corridor).
   * Returns null when no junction is reachable ahead.
   */
  getUpcomingJunction(): {
    junction: WindJunction;
    options: Array<{ corridor: WindCorridor; spineIndex: number; direction: 'forward' | 'backward' }>;
  } | null;

  /**
   * Switch the city to a different corridor at the current junction.
   * corridorId must be one returned by getUpcomingJunction().
   * Updates GSM: currentCorridorId, currentSpineIndex, windCorridor.
   */
  switchCorridor(corridorId: string): void;

  /**
   * Returns the band hexes of the current active corridor.
   * Consumed by ReachSystem to determine accessible mission sites this cycle.
   */
  getCorridorHexes(): AxialCoord[];

  /** Returns the full ordered spine of the current active corridor. */
  getActiveSpine(): AxialCoord[];
}

// ---------------------------------------------------------------------------
// STUB — replaced by TradewindSystem
// ---------------------------------------------------------------------------

import type { IGameStateManager } from './IGameStateManager';

export class TradewindSystemStub implements ITradewindSystem {
  constructor(private _gsm: IGameStateManager) {}
  advanceCityAlongCorridor(): void { this._gsm.advanceCycle(); }
  isAtJunction(): boolean { return false; }
  getUpcomingJunction(): null { return null; }
  switchCorridor(_corridorId: string): void { /* no-op */ }
  getCorridorHexes(): AxialCoord[] { return this._gsm.windCorridor; }
  getActiveSpine(): AxialCoord[] { return [this._gsm.cityHex]; }
}
