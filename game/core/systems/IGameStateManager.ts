/**
 * IGameStateManager.ts
 * Central state store interface — single source of truth for all cross-scene data.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 * All scenes and systems read/write game state through this interface.
 */

import type { AxialCoord, HexTile } from '@data/HexTile';
import type { Hero, MissionParty } from '@data/Hero';
import type { ResourceStore } from '@data/Resource';
import type { MissionContext, MissionResult } from '@data/MissionContext';
import type { TradewindOption } from '@data/TradewindOption';
import type { CityState } from '@data/CityState';
import type { SiteVisitRecord } from '@data/SiteVisitRecord';

export interface IGameStateManager {
  // --- Cycle state ---
  readonly cycleCount: number;
  advanceCycle(): void;

  // --- City position & tradewinds ---
  readonly cityHex: AxialCoord;
  readonly windCorridor: AxialCoord[];
  readonly windOptions: TradewindOption[];
  setCityHex(hex: AxialCoord): void;
  setWindCorridor(corridor: AxialCoord[]): void;
  setWindOptions(options: TradewindOption[]): void;

  // --- Resources ---
  readonly resources: ResourceStore;
  setResources(store: ResourceStore): void;

  // --- Hero roster ---
  readonly heroRoster: Hero[];
  setHeroRoster(roster: Hero[]): void;
  updateHeroStatus(heroId: string, updates: Partial<Hero>): void;

  // --- Mission party ---
  readonly missionParty: MissionParty | null;
  setMissionParty(party: MissionParty | null): void;

  // --- Mission handoff ---
  readonly missionContext: MissionContext | null;
  readonly missionResult: MissionResult | null;
  setMissionContext(context: MissionContext | null): void;
  setMissionResult(result: MissionResult | null): void;

  // --- Hex map ---
  readonly hexMap: HexTile[];
  setHexMap(map: HexTile[]): void;
  getHexById(id: string): HexTile | undefined;
  getHexByCoord(coord: AxialCoord): HexTile | undefined;
  updateHexTile(id: string, updates: Partial<HexTile>): void;

  // --- City state ---
  readonly cityState: CityState;
  setCityState(state: CityState): void;
  updateCityState(updates: Partial<CityState>): void;

  // --- Site history ---
  getSiteHistory(siteId: string): SiteVisitRecord[];
  appendSiteVisit(record: SiteVisitRecord): void;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import { createDefaultResourceStore } from '@data/Resource';
import { createDefaultCityState } from '@data/CityState';
import { hexId } from '@data/HexTile';

export class GameStateManagerStub implements IGameStateManager {
  cycleCount = 0;
  cityHex: AxialCoord = { q: 0, r: 0 };
  windCorridor: AxialCoord[] = [];
  windOptions: TradewindOption[] = [];
  resources: ResourceStore = createDefaultResourceStore();
  heroRoster: Hero[] = [];
  missionParty: MissionParty | null = null;
  missionContext: MissionContext | null = null;
  missionResult: MissionResult | null = null;
  hexMap: HexTile[] = [];
  cityState: CityState = createDefaultCityState();
  private _siteHistory: Map<string, SiteVisitRecord[]> = new Map();

  advanceCycle(): void { this.cycleCount++; }
  setCityHex(hex: AxialCoord): void { this.cityHex = hex; }
  setWindCorridor(corridor: AxialCoord[]): void { this.windCorridor = corridor; }
  setWindOptions(options: TradewindOption[]): void { this.windOptions = options; }
  setResources(store: ResourceStore): void { this.resources = store; }
  setHeroRoster(roster: Hero[]): void { this.heroRoster = roster; }
  updateHeroStatus(heroId: string, updates: Partial<Hero>): void {
    const idx = this.heroRoster.findIndex(h => h.id === heroId);
    if (idx >= 0) Object.assign(this.heroRoster[idx]!, updates);
  }
  setMissionParty(party: MissionParty | null): void { this.missionParty = party; }
  setMissionContext(context: MissionContext | null): void { this.missionContext = context; }
  setMissionResult(result: MissionResult | null): void { this.missionResult = result; }
  setHexMap(map: HexTile[]): void { this.hexMap = map; }
  getHexById(id: string): HexTile | undefined { return this.hexMap.find(h => h.id === id); }
  getHexByCoord(coord: AxialCoord): HexTile | undefined {
    return this.hexMap.find(h => h.id === hexId(coord));
  }
  updateHexTile(id: string, updates: Partial<HexTile>): void {
    const idx = this.hexMap.findIndex(h => h.id === id);
    if (idx >= 0) Object.assign(this.hexMap[idx]!, updates);
  }
  setCityState(state: CityState): void { this.cityState = state; }
  updateCityState(updates: Partial<CityState>): void { Object.assign(this.cityState, updates); }
  getSiteHistory(siteId: string): SiteVisitRecord[] { return this._siteHistory.get(siteId) ?? []; }
  appendSiteVisit(record: SiteVisitRecord): void {
    const existing = this._siteHistory.get(record.siteId) ?? [];
    existing.push(record);
    this._siteHistory.set(record.siteId, existing);
  }
}
