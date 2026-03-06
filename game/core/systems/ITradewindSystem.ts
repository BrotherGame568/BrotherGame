/**
 * ITradewindSystem.ts
 * Interface for generating and applying tradewind route options each cycle.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { AxialCoord } from '@data/HexTile';
import type { TradewindOption } from '@data/TradewindOption';

export interface ITradewindSystem {
  /**
   * Generate 2–3 wind route options for the current cycle.
   * Options are deterministic given the same cityHex and cycleCount.
   * Returns an array of TradewindOption, always length 2–3.
   */
  generateOptions(cityHex: AxialCoord, cycleCount: number): TradewindOption[];

  /**
   * Apply a chosen TradewindOption.
   * Updates GameStateManager: cityHex, windCorridor, cycleCount.
   * Called when the player confirms their route choice in WorldMapScene.
   */
  applyChoice(option: TradewindOption): void;

  /**
   * Returns the current wind corridor hexes (accessible this cycle).
   */
  getCorridorHexes(): AxialCoord[];
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import type { IGameStateManager } from './IGameStateManager';

export class TradewindSystemStub implements ITradewindSystem {
  constructor(private _gsm: IGameStateManager) {}

  generateOptions(_cityHex: AxialCoord, _cycleCount: number): TradewindOption[] {
    // Return a single placeholder option so scenes don't crash
    return [{
      id: 'stub_option_0',
      label: 'Stub Route',
      description: 'Placeholder wind route (stub)',
      trajectory: [_cityHex],
      resultingCityHex: _cityHex,
      windCorridor: [_cityHex],
    }];
  }

  applyChoice(option: TradewindOption): void {
    this._gsm.setCityHex(option.resultingCityHex);
    this._gsm.setWindCorridor(option.windCorridor);
    this._gsm.advanceCycle();
  }

  getCorridorHexes(): AxialCoord[] { return this._gsm.windCorridor; }
}
