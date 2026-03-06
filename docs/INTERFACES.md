# Interface & Data Type Index

> Owner: Architecture domain
> Update this file whenever an interface or data type changes status.
> All agents: check this file to see what is implemented vs. stub before writing code that depends on a system.

---

## Status Legend

| Symbol | Meaning |
|---|---|
| ⬜ | Not created yet |
| 🔄 | Stub exists (interface defined, implementation is stub/placeholder) |
| 🟡 | Partially implemented |
| ✅ | Fully implemented and tested |

---

## System Interfaces

Located in `game/core/systems/`

| Interface | File | Stub File | Status | Owner Domain |
|---|---|---|---|---|
| `IGameStateManager` | `IGameStateManager.ts` | `GameStateManagerStub.ts` | 🔄 | Architecture |
| `IResourceSystem` | `IResourceSystem.ts` | `ResourceSystemStub.ts` | 🔄 | Architecture |
| `IHeroSystem` | `IHeroSystem.ts` | `HeroSystemStub.ts` | 🔄 | Architecture |
| `ISiteEvolutionSystem` | `ISiteEvolutionSystem.ts` | `SiteEvolutionSystemStub.ts` | 🔄 | Architecture |
| `ITradewindSystem` | `ITradewindSystem.ts` | `TradewindSystemStub.ts` | 🔄 | Architecture |
| `IReachSystem` | `IReachSystem.ts` | `ReachSystemStub.ts` | 🔄 | Architecture |
| `ITechTreeSystem` | `ITechTreeSystem.ts` | `TechTreeSystemStub.ts` | 🔄 | Architecture |
| `IMissionBridge` | `IMissionBridge.ts` | _(types only, no stub)_ | 🔄 | Architecture |

---

## Service Interfaces

Located in `game/core/services/`

| Interface | File | Stub File | Status | Owner Domain |
|---|---|---|---|---|
| `IAudioService` | `IAudioService.ts` | `AudioServiceStub.ts` | 🔄 | Architecture |
| `ISaveService` | `ISaveService.ts` | `SaveServiceStub.ts` | 🔄 | Architecture |

---

## Data Types

Located in `game/core/data/`

| Type | File | Status | Notes |
|---|---|---|---|
| `HexTile`, `AxialCoord`, `SiteType`, `SiteState`, `ResourceSurface` | `HexTile.ts` | 🔄 | Hex map cell schema |
| `Hero`, `HeroClass`, `HeroStats`, `HeroStatus` | `Hero.ts` | 🔄 | Hero entity |
| `SupportBonus` | `SupportBonus.ts` | 🔄 | Mission support bonus modifier |
| `Resource`, `ResourceTier`, `ResourceStore` | `Resource.ts` | 🔄 | Three-tier resource system |
| `CityBuilding`, `BuildingSlotId`, `BuildingState` | `CityBuilding.ts` | 🔄 | City district buildings |
| `MissionContext`, `MissionResult`, `MissionObjective`, `MissionParty` | `MissionContext.ts` | 🔄 | Mission handoff contract |
| `TradewindOption` | `TradewindOption.ts` | 🔄 | Wind route offer |
| `CityState` | `CityState.ts` | 🔄 | Current city buildings and tech unlocks |
| `SiteVisitRecord` | `SiteVisitRecord.ts` | 🔄 | Per-site visit history |
| `SiteEvolutionEntry` | `SiteEvolutionTable.ts` | ⬜ | Phase 1 — authored evolution probability table |

---

## Scene Stubs

Located in `game/scenes/`

| Scene | File | Status | Notes |
|---|---|---|---|
| `WorldMapScene` | `WorldMapScene.ts` | 🔄 | 2D flat wind route selection |
| `HexZoomScene` | `HexZoomScene.ts` | 🔄 | Pseudo-isometric hex grid + site selection |
| `MissionScene` | `MissionScene.ts` | 🔄 | 2D side-view, Arcade physics |
| `CityViewScene` | `CityViewScene.ts` | 🔄 | HOMM-style building management |
| `UIScene` | `UIScene.ts` | 🔄 | Persistent HUD overlay |

---

## Entity Types

Located in `game/core/entities/`

| Type | File | Status | Notes |
|---|---|---|---|
| `Faction`, `FactionRelationship` | `Faction.ts` | ⬜ | Phase 1 |
| `Enemy` | `Enemy.ts` | ⬜ | Phase 2 |
| `Item`, `Pickup` | `Item.ts` | ⬜ | Phase 2 |

---

## Cross-Domain Contract Log

Track all agreed interface changes here. Open a Cross-Domain Interface issue for each, then record it below when resolved.

| Date | Interface Changed | Change Summary | Issue # | Approved By |
|---|---|---|---|---|
| _(none yet)_ | | | | |

---

## Phase 0 Completion Checklist

- [x] All system interface files created with full method signatures
- [x] All service interface files created with full method signatures
- [x] All stub files created — `tsc --noEmit` passes on full tree
- [x] All data type files created with all fields
- [x] All scene stub files created extending `Phaser.Scene`
- [x] `index.html` + `src/main.ts` Phaser bootstrap created — `npm run dev` opens blank Phaser window
- [x] This index is up to date with actual file state
