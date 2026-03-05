/**
 * ReachSystem.ts
 * Hex range queries and accessibility checks.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 * The key rule: a hex is "accessible" if it is within reach radius of cityHex
 * AND present in the current wind corridor.
 */

import type { AxialCoord, HexTile } from '@data/HexTile';
import { hexDistance, hexId } from '@data/HexTile';
import type { IReachSystem } from './IReachSystem';
import type { IGameStateManager } from './IGameStateManager';

export class ReachSystem implements IReachSystem {
  constructor(private _gsm: IGameStateManager) {}

  getAccessibleHexes(origin: AxialCoord, radius: number): HexTile[] {
    if (this._gsm.windCorridor.length === 0) {
      return this._gsm.hexMap.filter(tile => hexDistance(tile.coord, origin) <= radius);
    }
    const corridorSet = this._buildCorridorSet();
    return this._gsm.hexMap.filter(tile => {
      if (hexDistance(tile.coord, origin) > radius) return false;
      return corridorSet.has(hexId(tile.coord));
    });
  }

  isReachable(coord: AxialCoord): boolean {
    const radius = this.getCurrentRadius();
    if (hexDistance(coord, this._gsm.cityHex) > radius) return false;
    if (this._gsm.windCorridor.length === 0) return true;
    const corridorSet = this._buildCorridorSet();
    return corridorSet.has(hexId(coord));
  }

  getHexesInRadius(origin: AxialCoord, radius: number): HexTile[] {
    return this._gsm.hexMap.filter(tile => hexDistance(tile.coord, origin) <= radius);
  }

  getCurrentRadius(): number {
    return this._gsm.cityState.reachRadius;
  }

  /** Build a Set of corridor hex IDs for O(1) lookup. */
  private _buildCorridorSet(): Set<string> {
    return new Set(this._gsm.windCorridor.map(c => hexId(c)));
  }
}
