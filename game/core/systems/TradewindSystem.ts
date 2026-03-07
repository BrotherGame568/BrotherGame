/**
 * TradewindSystem.ts
 * Manages city movement along the persistent wind corridor network.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 *
 * The city automatically advances along its assigned WindCorridor each cycle.
 * At a WindJunction the player may switch to an intersecting corridor.
 */

import type { AxialCoord }       from '@data/HexTile';
import { hexId }                  from '@data/HexTile';
import type { WindCorridor, WindJunction }    from '@data/WindNetwork';
import type { ITradewindSystem } from './ITradewindSystem';
import type { IGameStateManager } from './IGameStateManager';

export class TradewindSystem implements ITradewindSystem {
  constructor(private _gsm: IGameStateManager) {}

  // ── Internal helpers ───────────────────────────────────────────────────

  private _activeCorridor(): WindCorridor | null {
    const id = this._gsm.currentCorridorId;
    return this._gsm.windNetwork.corridors.find(c => c.id === id) ?? null;
  }

  /**
   * Returns the junction the city is currently sitting on (exact spine-index
   * match), or null if there is none.  Only checks the **current** position.
   */
  private _junctionAtCurrentPosition(): WindJunction | null {
    const corr = this._activeCorridor();
    if (!corr) return null;

    const idx     = this._gsm.currentSpineIndex;
    const network = this._gsm.windNetwork;

    // Use the spineIndices map for an exact match — avoids triggering a
    // junction from one hex away (which caused the city to teleport on switch).
    return network.junctions.find(j =>
      j.corridorIds.includes(corr.id) &&
      j.spineIndices[corr.id] === idx,
    ) ?? null;
  }

  // ── ITradewindSystem ───────────────────────────────────────────────────

  advanceCityAlongCorridor(): void {
    const corr = this._activeCorridor();
    if (!corr) { this._gsm.advanceCycle(); return; }

    const speed = corr.speed;
    const cur   = this._gsm.currentSpineIndex;
    let nextIdx = Math.min(cur + speed, corr.spine.length - 1);

    // Stop at the first junction hex encountered within this step range so
    // that the city always lands exactly on junction hexes (not one step past).
    const network = this._gsm.windNetwork;
    for (const j of network.junctions) {
      const jIdx = j.spineIndices[corr.id];
      if (jIdx !== undefined && jIdx > cur && jIdx <= nextIdx) {
        nextIdx = Math.min(nextIdx, jIdx);
      }
    }

    this._gsm.setCurrentCorridor(corr.id, nextIdx);
    this._gsm.setCityHex(corr.spine[nextIdx]!);
    this._gsm.setWindCorridor(corr.bandHexes);
    this._gsm.advanceCycle();
  }

  isAtJunction(): boolean {
    return this._junctionAtCurrentPosition() !== null;
  }

  getUpcomingJunction(): {
    junction: WindJunction;
    options: Array<{ corridor: WindCorridor; spineIndex: number; direction: 'forward' | 'backward' }>;
  } | null {
    const junction = this._junctionAtCurrentPosition();
    if (!junction) return null;

    const activeId  = this._gsm.currentCorridorId;
    const network   = this._gsm.windNetwork;

    const options = junction.corridorIds
      .filter(cId => cId !== activeId)
      .flatMap((cId): Array<{ corridor: WindCorridor; spineIndex: number; direction: 'forward' | 'backward' }> => {
        const corr = network.corridors.find(c => c.id === cId);
        if (!corr) return [];

        // Find the junction spine index for this corridor
        const jIdx = junction.spineIndices[cId] ?? 0;

        // Wind flows from spine[0] → spine[end] — same ordering the particles use.
        // A junction option is only "forward" if there are still hexes ahead of jIdx.
        const direction: 'forward' | 'backward' =
          jIdx < corr.spine.length - 1 ? 'forward' : 'backward';
        return [{ corridor: corr, spineIndex: jIdx, direction }];
      });

    return { junction, options };
  }

  switchCorridor(corridorId: string): void {
    const network = this._gsm.windNetwork;
    const corr    = network.corridors.find(c => c.id === corridorId);
    if (!corr) return;

    // Switch at the exact junction the city is currently occupying.
    // Using the first corridor-pair match in the network can pick a completely
    // different intersection when two currents cross more than once, which
    // makes the city jump to that other corridor's endpoint/start node.
    const junction = this._junctionAtCurrentPosition();
    if (!junction || !junction.corridorIds.includes(corridorId)) return;

    const jIdx = (junction?.spineIndices[corridorId]) ?? 0;

    this._gsm.setCurrentCorridor(corridorId, jIdx);
    this._gsm.setCityHex(corr.spine[jIdx]!);
    this._gsm.setWindCorridor(corr.bandHexes);
  }

  getCorridorHexes(): AxialCoord[] {
    return this._gsm.windCorridor;
  }

  getActiveSpine(): AxialCoord[] {
    return this._activeCorridor()?.spine ?? [this._gsm.cityHex];
  }
}
