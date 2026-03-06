# Architecture Document

> Owner: Architecture domain (`arch/core`)
> Status: Living document — **authoritative reference for all agents**
> Engine: **Phaser 3 + TypeScript, web browser only**

---

## Decision Record

| Decision | Value | Rationale |
|---|---|---|
| Engine | Phaser 3 | Web-native, no install friction, strong 2D/tilemap support |
| Language | TypeScript (strict) | Enforced interface contracts between agent domains |
| Target platform | Web browser only | Simplest deployment path; no wrapper needed in v1 |
| Architecture bias | Phaser-API-optimized | No engine-agnostic abstraction layer; direct Phaser usage preferred |
| World map | Hex tile surface grid | Pseudo-isometric in HexZoomScene, flat 2D in WorldMapScene |
| Missions | 2D side-view | Phaser Arcade physics, real-time combat (Starbound-style) |
| City management | Separate CityViewScene | HOMM-style painted scene with building hotspots |
| Hero system | Roster + party selection | Active hero (player char) + Support hero (bonuses) per mission |
| Level format | TBD — explicit Phase 1 milestone | Evaluate Tiled hex JSON vs. custom JSON for Phaser Tilemap loader |

---

## Scene Topology

The game runs five Phaser Scenes. The persistent `UIScene` is always active. The four gameplay scenes launch/sleep/stop based on cycle position.

```
┌─────────────────────────────────────────────────────────────────┐
│  UIScene (persistent HUD — always running)                      │
│  Resource bars (Tier 1/2/3), cycle counter, active objectives   │
└─────────────────────────────────────────────────────────────────┘
        │ layered above all gameplay scenes via Phaser scene depth

┌──────────────────┐     wind choice      ┌─────────────────────┐
│  WorldMapScene   │ ──────────────────►  │   HexZoomScene      │
│  (2D flat)       │ ◄──────────────────  │   (pseudo-isometric)│
│  city icon +     │    cycle complete     │   hex grid +        │
│  wind corridor   │                       │   site selection    │
└──────────────────┘                       └────────┬────────────┘
                                                    │ site selected
                                           ┌────────▼────────────┐
                                           │  Party Selection    │
                                           │  (modal overlay)    │
                                           │  pick Active hero   │
                                           │  pick Support hero  │
                                           └────────┬────────────┘
                                                    │ confirmed
                            ┌───────────────────────▼─────────┐
                            │  MissionScene                   │
                            │  (2D side-view, Arcade physics) │
                            │  real-time combat, pickups      │
                            └───────────────────────┬─────────┘
                                                    │ result
                                           ┌────────▼────────────┐
                                           │  HexZoomScene       │
                                           │  (resumes)          │
                                           └────────┬────────────┘
                                                    │ enter city
                                           ┌────────▼────────────┐
                                           │  CityViewScene      │
                                           │  (HOMM-style)       │
                                           │  buildings, heroes, │
                                           │  resource mgmt      │
                                           └─────────────────────┘
```

### Scene Ownership

| Scene | File | Owner | Reads from GSM | Writes to GSM |
|---|---|---|---|---|
| `WorldMapScene` | `game/scenes/WorldMapScene.ts` | Architecture | `cityHex`, `cycleCount`, `windOptions` | `cityHex`, `windCorridor` |
| `HexZoomScene` | `game/scenes/HexZoomScene.ts` | Architecture | `hexMap`, `reachRadius`, `cityHex`, `heroRoster` | `selectedSite` |
| `MissionScene` | `game/scenes/MissionScene.ts` | Architecture | `missionContext` | `missionResult`, `heroRoster` (status updates) |
| `CityViewScene` | `game/scenes/CityViewScene.ts` | Architecture | `resources`, `cityState`, `heroRoster` | `resources`, `cityState`, `heroRoster` |
| `UIScene` | `game/scenes/UIScene.ts` | Architecture | `resources`, `cycleCount` | _(read-only)_ |

### Scene Transition Contracts

**WorldMapScene → HexZoomScene**
- Trigger: player confirms wind direction choice
- Writes to GSM: `cityHex` (new position), `windCorridor` (accessible hex set)
- HexZoomScene on wake: recalculate `accessibleHexes` from `cityHex` + `reachRadius`

**HexZoomScene → MissionScene**
- Trigger: player completes party selection and confirms launch
- Passes `MissionContext` to `GameStateManager.missionContext`
- MissionScene on create: reads `missionContext`, applies hero stats + support bonuses

**MissionScene → HexZoomScene**
- Trigger: mission complete or player retreats
- Writes `MissionResult` to `GameStateManager.missionResult`
- Writes updated hero statuses (injured, available) to `GameStateManager.heroRoster`
- HexZoomScene on resume: reads result, updates site state, shows result panel

**HexZoomScene → CityViewScene**
- Trigger: player selects city hex
- No additional context needed; CityViewScene reads full city state from GSM

**CityViewScene → HexZoomScene**
- Trigger: player closes city view
- Writes any resource/building/hero changes to GSM before suspending

---

## GameStateManager (GSM)

**Location:** `game/core/systems/IGameStateManager.ts` (interface) + implementation in `game/core/systems/GameStateManager.ts`
**Role:** Single source of truth, lives at the Phaser `Game` level (not inside any Scene). All scenes import the GSM singleton.

### GSM State Shape

```typescript
interface IGameState {
  // Cycle
  cycleCount: number;

  // City position
  cityHex: AxialCoord;
  windCorridor: AxialCoord[];    // hexes accessible this cycle
  windOptions: TradewindOption[]; // offered to player at cycle start

  // Reach
  reachRadius: number;           // in hex distance units; default 2

  // Resources
  resources: ResourceStore;      // { tier1: TierResources, tier2: TierResources, tier3: TierResources }

  // Heroes
  heroRoster: Hero[];
  missionParty: MissionParty | null; // { activeHeroId, supportHeroId | null }

  // Mission handoff
  missionContext: MissionContext | null;
  missionResult: MissionResult | null;

  // Map
  hexMap: HexTile[];

  // City
  cityState: CityState;          // districts built, tech unlocks, storage caps

  // History
  siteHistory: Map<string, SiteVisitRecord[]>;
}
```

Full typings: `game/core/data/` files.

---

## Interface Index

All system boundaries are TypeScript `interface`s. Scenes consume interfaces — not concrete implementations. This lets any system be replaced or extended without touching scene code.

| Interface | File | Purpose |
|---|---|---|
| `IGameStateManager` | `game/core/systems/IGameStateManager.ts` | Full cross-scene state store |
| `IResourceSystem` | `game/core/systems/IResourceSystem.ts` | add/spend/check resources |
| `IHeroSystem` | `game/core/systems/IHeroSystem.ts` | roster, recruit, assign, status |
| `ISiteEvolutionSystem` | `game/core/systems/ISiteEvolutionSystem.ts` | per-cycle site state updates |
| `ITradewindSystem` | `game/core/systems/ITradewindSystem.ts` | generate/apply wind options |
| `IReachSystem` | `game/core/systems/IReachSystem.ts` | hex range queries |
| `ITechTreeSystem` | `game/core/systems/ITechTreeSystem.ts` | building unlock rules |
| `IMissionBridge` | `game/core/systems/IMissionBridge.ts` | MissionContext / MissionResult types |
| `IAudioService` | `game/core/services/IAudioService.ts` | play/stop/ambience |
| `ISaveService` | `game/core/services/ISaveService.ts` | save/load/hasSave |

See [docs/INTERFACES.md](INTERFACES.md) for implementation status of each.

> **Interface change rule:** Any PR that modifies an interface file requires sign-off from ALL domain owners via a Cross-Domain Interface issue.

---

## Data Type Index

Pure TypeScript types (no logic). Safe to import from any domain.

| Type | File | Description |
|---|---|---|
| `HexTile` | `game/core/data/HexTile.ts` | Hex map cell with coords, site, faction, state |
| `Hero` | `game/core/data/Hero.ts` | Hero entity: stats, class, status, bonus array |
| `SupportBonus` | `game/core/data/SupportBonus.ts` | Stat modifier applied by support hero |
| `Resource` / `ResourceTier` | `game/core/data/Resource.ts` | Three-tier resource system types |
| `CityBuilding` | `game/core/data/CityBuilding.ts` | Building: slot, cost, unlocks, reach delta |
| `MissionContext` / `MissionResult` | `game/core/data/MissionContext.ts` | Mission handoff contracts |
| `AxialCoord` | `game/core/data/HexTile.ts` | `{ q: number; r: number }` |
| `TradewindOption` | `game/core/data/TradewindOption.ts` | One offered wind path |
| `CityState` | `game/core/data/CityState.ts` | Current city buildings, upgrades, caps |
| `SiteVisitRecord` | `game/core/data/SiteVisitRecord.ts` | History of a hex site across cycles |

---

## Hex Coordinate System

- **Axial coordinates** (`q`, `r`) — standard flat-top hex grid.
- `WorldMapScene`: renders city as a single icon moving along corridors; hexes are simplified nodes for trajectory display.
- `HexZoomScene`: renders full hex tilemap with pseudo-isometric squish. Achieved via `camera.setZoom()` + tilemap `scaleY ≈ 0.55`. No additional plugin required.
- Distance function: `hexDistance(a, b) = (|a.q - b.q| + |a.q + a.r - b.q - b.r| + |a.r - b.r|) / 2`
- `IReachSystem.getAccessibleHexes(cityHex, reachRadius)` returns all hexes within that distance and within the current `windCorridor`.

---

## Reach & Danger Scaling

| Distance Class | Hex Ring | Default Danger | Primary Resource Tier | Unlock Required |
|---|---|---|---|---|
| Near | 0–2 | Low (1–2) | Tier 1 | None (starting radius) |
| Mid | 3–4 | Medium (3–5) | Tier 2 | Navigator's Guild (reach +1) |
| Far | 5+ | High (6–10) | Tier 3 | Long-Range Observatory (reach +2) |

Out-of-reach hexes render in `HexZoomScene` with `50%` alpha tint and are non-interactive. A reach-ring overlay communicates the current boundary.

---

## Mission System

**Physics:** Phaser Arcade physics (sufficient for side-view platformer combat).
**Player character:** Determined by `missionContext.activeHero`. Hero stats map to:
- `combat` → attack power + hit points
- `exploration` → interaction range + map reveal speed
- `diplomacy` → dialogue options available at neutral/ally sites

**Support hero bonuses:** Applied once at `MissionScene.create()` from `missionContext.supportBonus` array. Bonuses are flat or percent modifiers on the above stats, or on `resourceYieldMultiplier`.

**Mission completion triggers:**
1. All primary objectives complete → success
2. Player retreats (escape zone reached) → partial success (reduced loot)
3. Player character HP reaches 0 → failure

**Result effects (written to GSM on scene exit):**
- Resources added to `ResourceStore`
- Active hero status → `available` (success/retreat) or `injured` (failure)
- Support hero status → always returns `available`
- `siteHistory` record appended
- Site state updated per `ISiteEvolutionSystem` rules

---

## City View System

**Scene type:** `CityViewScene` — no physics, sprite + interactive zones.
**Layout:** A painted background of the floating city. Fixed building slot positions are defined as named interactive rectangles (hotspot regions). Each slot has:
- A `buildingSlotId` (string)
- An accepted `CityBuilding.id`
- Visual states: `empty` / `constructing` / `built` / `upgraded`

**Interactions in `CityViewScene`:**
- Click empty slot → show building options + cost
- Click built slot → show upgrade options or unit production
- Side panel: current Tier 1/2/3 resource counts, cycle info
- Hero panel: roster list, recruit button (requires Barracks or equivalent)

---

## Tradewind System

Each cycle start, `ITradewindSystem.generateOptions(cityHex)` returns 2–3 `TradewindOption` objects. Each option contains:
- A trajectory (array of hexes the city will pass through)
- The resulting `cityHex` after following that wind
- The `windCorridor` (all hexes within interaction range of the path)
- A brief descriptive label (e.g., "Southern Trade Route — fertile lowlands")

The player picks one. `ITradewindSystem.applyChoice(option)` writes the new `cityHex` and `windCorridor` to GSM and advances `cycleCount`.

---

## Cross-Domain Contracts

| Contract | Provided By | Consumed By | Defined In |
|---|---|---|---|
| All system interfaces | Architecture | All domains | `game/core/systems/I*.ts` |
| All service interfaces | Architecture | All domains | `game/core/services/I*.ts` |
| Data type definitions | Architecture | All domains | `game/core/data/*.ts` |
| Asset path manifest | Art | Architecture, Levels | `game/assets/MANIFEST.md` |
| Audio event names | Audio | Architecture | `game/audio/EVENTS.md` |
| Hex map data files | Levels | Architecture | `game/levels/world_map/*.json` |
| Mission level data | Levels | Architecture | `game/levels/missions/*.json` |

---

## Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Interface files | `I` prefix, PascalCase | `IHeroSystem.ts` |
| Stub classes | `*Stub` suffix | `HeroSystemStub` |
| Scene files | PascalCase, `Scene` suffix | `WorldMapScene.ts` |
| Data type files | PascalCase | `HexTile.ts` |
| TypeScript path aliases | `@` prefix | `@systems/IHeroSystem` |
| Audio event names | `snake_case` | `city_building_complete` |
| Hex map data | `snake_case` JSON | `starting_region.json` |

---

## Path Aliases (`tsconfig.json`)

```
@scenes/*   → game/scenes/*
@systems/*  → game/core/systems/*
@services/* → game/core/services/*
@data/*     → game/core/data/*
@entities/* → game/core/entities/*
@assets/*   → game/assets/*
```
**Variables/Functions:** `snake_case`
**Signals/Events:** `verb_noun` (e.g., `turn_started`, `mission_completed`)

---

## Add-In System (Future)

The architecture should leave room for additional gameplay modes and content packs:
- New mission types (stealth, escort, siege)
- New world map systems (diplomacy, economy)
- Multiplayer extension

Because core systems communicate through events rather than direct calls, new modules can subscribe to existing events without touching existing code. New gameplay modes follow the same `MissionContext`/`MissionResult` handoff pattern.

---

## Related Documents

| Document | Purpose |
|---|---|
| `docs/INTERFACES.md` | Canonical interface specs — read before writing any cross-domain code |
| `docs/GAME_DESIGN.md` | Feature intentions and design decisions |
| `docs/DECISIONS.md` | Architecture Decision Records — why things are the way they are |
| `CLAUDE.md` | AI agent rules and project-wide constraints |
