/**
 * InitialGameState.ts
 * Seeds the GameStateManager with starting data for a new game.
 * Owner: Architecture domain
 *
 * Pure data — no Phaser imports.
 * Called once from BootScene before any gameplay scene starts.
 */

import type { IGameStateManager } from '@systems/IGameStateManager';
import type { BuildingSlotState } from './CityBuilding';
import { BUILDING_IDS } from './CityBuilding';
import { generateHexMap } from './MapGenerator';
import { seedResourceStore } from './ResourceDefinitions';
import { createDefaultHero } from './Hero';
import { createDefaultCityState } from './CityState';
import { generateWindNetwork } from './WindNetworkGenerator';
import { hexDistance, hexId } from './HexTile';

// ── Building slot layout ──────────────────────────────────────
// 7 building slots with predetermined IDs matching BUILDING_IDS.
// All start empty. CityViewScene renders these in a grid.

function createStartingBuildingSlots(): BuildingSlotState[] {
  return Object.values(BUILDING_IDS).map((id): BuildingSlotState => ({
    slotId: id,
    buildingId: null,
    state: 'empty',
    completionCycle: -1,
  }));
}

// ── Starting hero roster ──────────────────────────────────────

function createStartingHeroes() {
  return [
    createDefaultHero({
      id: 'hero_kael',
      name: 'Kael',
      heroClass: 'skirmisher',
      stats: { combat: 7, exploration: 4, diplomacy: 3 },
      portraitId: 'kael_the_iron_skirmisher',
    }),
    createDefaultHero({
      id: 'hero_lyra',
      name: 'Lyra',
      heroClass: 'scout',
      stats: { combat: 3, exploration: 7, diplomacy: 4 },
      bonusArray: [
        { stat: 'exploration', modifier: 2, type: 'flat' },
      ],
      portraitId: 'lyra_the_vellum_scout',
    }),
  ];
}

// ── Public API ────────────────────────────────────────────────

/**
 * Initialize all GSM state for a fresh game.
 * Must be called exactly once before launching WorldMapScene.
 */
export function initializeGameState(gsm: IGameStateManager): void {
  // Generate the hex map (radius 5 → ~91 hexes for a richer neighbourhood view)
  const hexMap = generateHexMap(5);
  gsm.setHexMap(hexMap);

  // City starts at center
  gsm.setCityHex({ q: 0, r: 0 });

  // Starting resources
  gsm.setResources(seedResourceStore());

  // Starting hero roster
  gsm.setHeroRoster(createStartingHeroes());

  // City state with building slots
  const cityState = createDefaultCityState();
  cityState.buildingSlots = createStartingBuildingSlots();
  cityState.availableHeroClasses = ['skirmisher', 'scout'];
  gsm.setCityState(cityState);

  // Wind state is empty until first WorldMapScene generates options
  gsm.setWindCorridor([]);
  gsm.setWindOptions([]);

  // Generate the persistent wind corridor network (seed 42 → deterministic world)
  const WORLD_RADIUS = 60;
  const windNetwork = generateWindNetwork(WORLD_RADIUS, 39);
  gsm.setWindNetwork(windNetwork);

  // Find the starting corridor: pick the one whose spine passes closest to origin
  const origin = { q: 0, r: 0 };
  let bestCorridorId = '';
  let bestSpineIdx   = 0;
  let bestDist       = Infinity;
  for (const corridor of windNetwork.corridors) {
    for (let i = 0; i < corridor.spine.length; i++) {
      const d = hexDistance(corridor.spine[i]!, origin);
      if (d < bestDist) {
        bestDist       = d;
        bestCorridorId = corridor.id;
        bestSpineIdx   = i;
      }
    }
  }
  if (bestCorridorId) {
    const startCorridor = windNetwork.corridors.find(c => c.id === bestCorridorId)!;
    gsm.setCurrentCorridor(bestCorridorId, bestSpineIdx);
    gsm.setCityHex(startCorridor.spine[bestSpineIdx]!);
    gsm.setWindCorridor(startCorridor.bandHexes);
  }

  // No active mission
  gsm.setMissionParty(null);
  gsm.setMissionContext(null);
  gsm.setMissionResult(null);
}
