/**
 * IReachSystem.ts
 * Interface for hex range queries and accessibility checks.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { AxialCoord, HexTile } from '@data/HexTile';

export interface IReachSystem {
  /**
   * Returns all HexTiles within `radius` hex distance of `origin`
   * that are also within the current windCorridor.
   * These are the tiles the player may select in HexZoomScene.
   */
  getAccessibleHexes(origin: AxialCoord, radius: number): HexTile[];

  /**
   * Returns true if the given hex is within reach radius AND in wind corridor.
   */
  isReachable(coord: AxialCoord): boolean;

  /**
   * Returns all hex tiles within `radius` of `origin`, regardless of wind corridor.
   * Used for rendering the reach-ring overlay.
   */
  getHexesInRadius(origin: AxialCoord, radius: number): HexTile[];

  /**
   * Returns the current reach radius from city state.
   */
  getCurrentRadius(): number;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import { hexDistance } from '@data/HexTile';
import type { IGameStateManager } from './IGameStateManager';

export class ReachSystemStub implements IReachSystem {
  constructor(private _gsm: IGameStateManager) {}

  getAccessibleHexes(origin: AxialCoord, radius: number): HexTile[] {
    return this._gsm.hexMap.filter(tile => hexDistance(tile.coord, origin) <= radius);
  }

  isReachable(coord: AxialCoord): boolean {
    const radius = this.getCurrentRadius();
    return hexDistance(coord, this._gsm.cityHex) <= radius;
  }

  getHexesInRadius(origin: AxialCoord, radius: number): HexTile[] {
    return this._gsm.hexMap.filter(tile => hexDistance(tile.coord, origin) <= radius);
  }

  getCurrentRadius(): number { return this._gsm.cityState.reachRadius; }
}
