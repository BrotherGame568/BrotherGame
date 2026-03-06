/**
 * TradewindSystem.ts
 * Generates and applies tradewind route options each cycle.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 */

import type { AxialCoord } from '@data/HexTile';
import { hexNeighbors, hexDistance, hexId } from '@data/HexTile';
import type { TradewindOption } from '@data/TradewindOption';
import type { ITradewindSystem } from './ITradewindSystem';
import type { IGameStateManager } from './IGameStateManager';

/** Direction labels for flavour text. */
const DIRECTION_LABELS: string[] = [
  'East', 'Northeast', 'Northwest', 'West', 'Southwest', 'Southeast',
];

/**
 * Simple LCG-style hash for deterministic-ish randomness per cycle+index.
 */
function hashSeed(a: number, b: number): number {
  return ((a * 2654435761 + b * 340573321) >>> 0);
}

/**
 * Compute all hexes within `radius` of any hex along `trajectory`.
 * This forms the wind corridor — the hexes the player can interact with this cycle.
 */
function computeWindCorridor(trajectory: AxialCoord[], radius: number): AxialCoord[] {
  const seen = new Set<string>();
  const result: AxialCoord[] = [];

  for (const point of trajectory) {
    // BFS expand from point up to `radius`
    const queue: Array<{ coord: AxialCoord; depth: number }> = [{ coord: point, depth: 0 }];
    const visited = new Set<string>();
    visited.add(hexId(point));

    while (queue.length > 0) {
      const current = queue.shift()!;
      const id = hexId(current.coord);

      if (!seen.has(id)) {
        seen.add(id);
        result.push(current.coord);
      }

      if (current.depth < radius) {
        for (const neighbor of hexNeighbors(current.coord)) {
          const nId = hexId(neighbor);
          if (!visited.has(nId)) {
            visited.add(nId);
            queue.push({ coord: neighbor, depth: current.depth + 1 });
          }
        }
      }
    }
  }

  return result;
}

export class TradewindSystem implements ITradewindSystem {
  constructor(private _gsm: IGameStateManager) {}

  generateOptions(cityHex: AxialCoord, cycleCount: number): TradewindOption[] {
    const neighbors = hexNeighbors(cityHex);
    const optionCount = 2 + (hashSeed(cycleCount, 7) % 2); // 2 or 3 options
    const options: TradewindOption[] = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < optionCount && i < neighbors.length; i++) {
      // Pick a unique neighbor direction for each option
      let idx: number;
      let attempts = 0;
      do {
        idx = hashSeed(cycleCount, i + attempts * 13) % neighbors.length;
        attempts++;
      } while (usedIndices.has(idx) && attempts < 20);
      usedIndices.add(idx);

      const destination = neighbors[idx]!;
      const dirLabel = DIRECTION_LABELS[idx] ?? `Direction ${idx}`;
      const trajectory = [cityHex, destination];
      const corridor = computeWindCorridor(trajectory, 2);

      options.push({
        id: `wind_c${cycleCount}_${i}`,
        label: `${dirLabel} Wind`,
        description: `The tradewinds blow ${dirLabel.toLowerCase()} toward ${hexId(destination)}.`,
        trajectory,
        resultingCityHex: destination,
        windCorridor: corridor,
      });
    }

    return options;
  }

  applyChoice(option: TradewindOption): void {
    this._gsm.setCityHex(option.resultingCityHex);
    this._gsm.setWindCorridor(option.windCorridor);
    this._gsm.setWindOptions([]);
    this._gsm.advanceCycle();
  }

  getCorridorHexes(): AxialCoord[] {
    return this._gsm.windCorridor;
  }
}
