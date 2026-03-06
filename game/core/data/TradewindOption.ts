/**
 * TradewindOption.ts
 * Data type for a single offered wind route at cycle start.
 * Owner: Architecture domain
 *
 * Pure data type — no logic, no Phaser imports.
 */

import type { AxialCoord } from './HexTile';

/**
 * One wind route option presented to the player at the start of a cycle.
 * ITradewindSystem.generateOptions() produces 2–3 of these.
 */
export interface TradewindOption {
  id: string;
  /** Human-readable label shown to the player */
  label: string;
  /** Short flavour description of the route */
  description: string;
  /** The trajectory the city will follow (ordered hex coords) */
  trajectory: AxialCoord[];
  /** The hex position the city will occupy after following this route */
  resultingCityHex: AxialCoord;
  /**
   * All hexes within interaction range of the full trajectory path.
   * Used to determine accessible surface sites this cycle.
   */
  windCorridor: AxialCoord[];
}
