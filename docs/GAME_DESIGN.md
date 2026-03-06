# Game Design Document

> Status: Living document — **canonical rules reference for all agents**
> Any gameplay mechanic implemented in code must be documented here first.

---

## Concept

**BrotherGame** is a sky-city exploration and management game. The player oversees a floating city that follows the tradewinds around a vast surface world. Each cycle, the player chooses a wind route that exposes different surface sites, dispatches heroes to visit them, and uses gathered resources to grow the city's capabilities. The world evolves over time — sites change state while the city circles back around, creating a sense of a living world.

**Genre:** Strategy + Action (turn-based cycle management + real-time side-view missions)
**Platform:** Web browser
**Tone:** Adventure, exploration, wonder; bittersweet world-discovery (sites can be conquered, destroyed, or rebuilt since your last visit)

---

## Core Game Loop

```
Cycle Start
│
▼
[WorldMapScene] Player chooses one of 2–3 tradewind routes
│  Each route moves the city to a new hex position
│  Each route exposes a different set of surface hexes
│
▼
[HexZoomScene] Pseudo-isometric zoomed view around the city
│  Accessible hexes = within reachRadius AND in wind corridor
│  Player may:
│    a) Select a surface site to visit (→ Party Selection → MissionScene)
│    b) Enter the city (→ CityViewScene)
│    c) Skip and end the cycle
│
▼
[Site Evolution Pass] After returning from all actions this cycle:
│  All sites in hexes the city bypassed advance their evolution timers
│  Sites the city last visited N cycles ago may change state
│
▼
Next Cycle (return to WorldMapScene)
```

---

## Tradewind System

### Mechanics
- Each cycle start, the player receives **2–3 TradewindOption** offers.
- Each option presents: a trajectory label, the resulting city hex position, and which surface hexes will fall within interaction range.
- The player picks one. The city moves. The cycle counter increments.

### Design Goals
- Choices feel meaningful: one route might pass rich Tier 2 sites, another a dangerous Tier 3 zone or a friendly town.
- Early game: options are safe and nearby. Mid/late game: options include risky high-reward corridors as the tech tree expands access.

### Wind Option Generation Rules (to be balanced in Phase 1)
- Options are seeded deterministically from `cycleCount` + `cityHex` so the same state always produces the same offers.
- No two options should have fully overlapping wind corridors.
- At least one option per cycle should include a Tier 1 auto-resource collection hex.

---

## Hex World Map

### Overview
The surface world is a hex grid. Two representations are used:
- **WorldMapScene**: simplified 2D flat view. City is an icon. Wind corridor hexes are highlighted. Player picks a route.
- **HexZoomScene**: pseudo-isometric squished hex tilemap. Full terrain art, site markers, reach-ring overlay.

### Hex Tile Schema (`HexTile`)
| Field | Type | Description |
|---|---|---|
| `coord` | `AxialCoord` | `{ q, r }` axial coordinates |
| `distanceClass` | `'near' \| 'mid' \| 'far'` | Distance from typical city corridor center |
| `dangerLevel` | `number` (1–10) | Scales with distance class (authored at map generation) |
| `siteType` | `SiteType` | `town`, `village`, `ruin`, `deposit`, `skydock`, `empty` |
| `factionId` | `string \| null` | Controlling faction; null = unclaimed |
| `resourceSurface` | `ResourceSurface[]` | What resources this site can yield |
| `siteState` | `SiteState` | Current state (see Site Evolution below) |
| `lastVisitedCycle` | `number` | Cycle on which player last visited; -1 = never |

### Coordinate System
- Axial coordinates (`q`, `r`), flat-top orientation.
- Distance: `(|Δq| + |Δq + Δr| + |Δr|) / 2`
- Pseudo-isometric render: standard hex tilemap with `scaleY ≈ 0.55` applied to camera/tilemap.

### Level Format (Phase 1 Decision)
Evaluate and lock one of:
- **Tiled staggered hex JSON** — integrates with Phaser `Tilemap` loader natively; good tooling.
- **Custom JSON** — full control over schema; more pipeline work.
Acceptance criteria: must support all `HexTile` fields, Phaser can load and render it, range queries run in < 5ms for maps up to 500 tiles.

---

## Reach & Accessibility

### Reach Radius
- `reachRadius` is a city stat stored in `GameStateManager`.
- Starting value: **2** (hex distance units).
- Only hexes within `reachRadius` of `cityHex` AND within `windCorridor` are selectable in `HexZoomScene`.
- Out-of-reach hexes are visible at 50% alpha with a lock indicator.

### Reach Upgrades
| Building | `reachRadius` Delta | Resource Cost | Prerequisite |
|---|---|---|---|
| Navigator's Guild | +1 | 3× Tier 2 | None |
| Long-Range Observatory | +2 | 2× Tier 2 + 1× Tier 3 | Navigator's Guild |

### Distance, Danger & Resources
| Distance Class | Hex Rings | Danger Level | Primary Yield |
|---|---|---|---|
| Near | 0–2 | 1–2 | Tier 1 |
| Mid | 3–4 | 3–5 | Tier 2 |
| Far | 5+ | 6–10 | Tier 3 |

---

## Resource System

### Three Tiers

**Tier 1 — Essential Goods** (food, water, basic supplies)
- Auto-generated each cycle from city base production.
- Small amounts also found at near surface sites.
- No player effort required to maintain; caps are generous.
- Used for: crew upkeep, basic city maintenance.

**Tier 2 — Lift Fuel & Trade Goods** (acclivity crystals, trade cargo)
- Found at mid-range sites; primary cycle economy currency.
- Required for: city building costs, reach upgrades, hero recruitment, trading with surface factions.
- Storage cap starts low; expands with city upgrades.

**Tier 3 — Rare Expedition Finds** (ancient relics, rare ores, arcane materials)
- Found only at far sites (requires reach upgrades to access).
- Multi-cycle mission chains may be required for full acquisition.
- Used for: major city expansions (new districts, late-game buildings), unlocking special hero classes.
- Storage cap is very tight; forces prioritization.

### Resource Store Schema (`ResourceStore`)
```typescript
interface ResourceStore {
  tier1: { [resourceId: string]: number };
  tier2: { [resourceId: string]: number };
  tier3: { [resourceId: string]: number };
  caps: { tier1: number; tier2: number; tier3: number };
}
```

### Progression Gate Summary
Tier 1 → sustain base city | Tier 2 → unlock mid-game options | Tier 3 → unlock late-game expansion
Reach upgrade requires Tier 2 → Tier 3 only accessible after reaching mid-range sites first.

---

## Site Evolution

Surface sites evolve while the city is away. The longer the gap since a last visit, the more can change.

### Site States (`SiteState`)
```
discovered      — player has visibility but not yet visited
visited         — player completed a mission here
contested       — faction conflict underway
conquered       — hostile faction has taken control
destroyed       — site is rubble; resource yield is low
recovering      — site slowly rebuilding
thriving        — site has grown since last visit (bonus resources)
abandoned       — population left; resource yield is nil
```

### Evolution Rules
- Triggered once per cycle during the **Site Evolution Pass**, after all player actions.
- Each site has an `evolutionTimer` (cycles since last visit) that increments each cycle the city does not visit.
- A `siteType` + `factionId` + `currentState` combination maps to possible next states and their probabilities.
- Example: a `village` that is `visited`, `factionId = village_neutral`, after 4 cycles without visit → 30% chance `contested`, 60% stays `visited`, 10% `thriving`.
- Balance table is defined in `game/core/data/SiteEvolutionTable.ts` (authored, not procedurally generated) and consumed by `ISiteEvolutionSystem`.

### Player Feedback
- `HexZoomScene` renders a small state-change indicator on sites that evolved since the last visit (e.g., flame icon for `conquered`, growth icon for `thriving`).
- Mission debrief compares current state to state at last visit if changed.

---

## Heroes

### Overview
Heroes are named characters recruited in `CityViewScene`. They are available for surface missions and provide the primary progression axis for the player.

### Hero Entity (`Hero`)
| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier |
| `name` | `string` | Display name |
| `class` | `HeroClass` | Determines stat spread and skill set |
| `stats` | `HeroStats` | `{ combat, exploration, diplomacy }` (1–10 scale) |
| `status` | `HeroStatus` | `available`, `on_mission`, `injured`, `recovering` |
| `bonusArray` | `SupportBonus[]` | Bonuses applied when this hero is in Support role |
| `experience` | `number` | Cumulative XP from missions |
| `portraitId` | `string` | Asset ID for portrait sprite |

### Hero Classes (initial set — expand in Phase 4)
| Class | Combat | Exploration | Diplomacy | Unlock Building |
|---|---|---|---|---|
| Skirmisher | 8 | 5 | 3 | Barracks |
| Scout | 4 | 9 | 4 | Scouting Post |
| Envoy | 3 | 5 | 9 | Diplomat's Hall |

### Roster
- All recruited heroes are stored in `GameStateManager.heroRoster`.
- Only `available` heroes can be assigned to a mission party.
- A hero is `injured` only if they were the **Active hero** on a failed mission.
- A hero is `recovering` for 1 full cycle after `injured`; becomes `available` next cycle start.
- Support heroes always return `available` regardless of mission outcome.

### Party Selection
Shown as a modal/overlay in `HexZoomScene` after selecting a site:
1. Filter roster to `available` heroes.
2. Player picks **one Active hero** (required) and optionally **one Support hero** (different from Active).
3. Support hero's `bonusArray` is flattened into the `MissionContext.supportBonuses` array.
4. Both heroes' status set to `on_mission` when `MissionScene` launches.

### Support Bonus Schema (`SupportBonus`)
```typescript
interface SupportBonus {
  stat: 'combat' | 'exploration' | 'diplomacy' | 'resourceYield';
  modifier: number;
  type: 'flat' | 'percent';
}
```
Applied once at `MissionScene.create()`. Not re-applied on reload.

---

## Mission System

### Overview
Missions are 2D side-view (platformer-style) levels triggered by selecting a surface site. Inspired by Starbound: exploration of structured levels, real-time combat, resource pickups.

### Mission Flow
1. Site selected in `HexZoomScene`
2. Party selection modal (Active + Support hero)
3. `MissionContext` written to GSM
4. `MissionScene` launches
5. Player runs mission (combat, exploration, objectives)
6. `MissionResult` written to GSM on completion
7. `MissionScene` stops, `HexZoomScene` resumes

### Mission Context (`MissionContext`)
```typescript
interface MissionContext {
  missionId: string;
  siteId: string;               // hex tile ID
  siteType: SiteType;
  dangerLevel: number;
  activeHeroId: string;
  supportHeroId: string | null;
  supportBonuses: SupportBonus[];
  resourceSurface: ResourceSurface[];  // what can be found
  objectives: MissionObjective[];
}
```

### Mission Result (`MissionResult`)
```typescript
interface MissionResult {
  outcome: 'success' | 'retreat' | 'failure';
  resourcesGathered: { [resourceId: string]: number };
  heroStatusUpdates: { heroId: string; newStatus: HeroStatus }[];
  objectivesCompleted: string[];
  siteStateChange: SiteState | null;  // null = no change
}
```

### Mission Objectives
| Type | Description |
|---|---|
| `collect` | Gather a specific item or resource amount |
| `reach` | Navigate to a location (beacon, exit, NPC) |
| `eliminate` | Defeat a specific enemy or all enemies in zone |
| `interact` | Talk to NPC, activate object, trade |

### Completion States
- **Success**: all primary objectives complete → full loot, hero returns `available`
- **Retreat**: player reaches escape zone with incomplete objectives → partial loot (50%), hero returns `available`
- **Failure**: active hero HP reaches 0 → no loot, hero returns `injured`

---

## City View

### Overview
`CityViewScene` is a HOMM-style painted scene of the floating city. The player interacts with named building slots to construct buildings, recruit heroes, and review resources.

### Building Slots
- Fixed positions in the city artwork, defined as named interactive regions.
- Each slot accepts one building type. Empty slots show a placeholder indicator.
- Building states: `empty` → `constructing` (1-cycle delay) → `built` → `upgraded` (optional second tier).

### Starting Buildings (always present)
| Building | Function |
|---|---|
| City Core | Houses city stats, cycle info, save/load |
| Supply Depot | Tier 1 resource storage (starting capacity) |
| Shipyard | Where the city's lift engines are maintained; Tier 2 fuel storage |

### Buildable Districts (initial set)
| Building | Cost | Unlocks |
|---|---|---|
| Barracks | 2× Tier 2 | Recruit Skirmisher heroes |
| Scouting Post | 2× Tier 2 | Recruit Scout heroes |
| Diplomat's Hall | 3× Tier 2 | Recruit Envoy heroes; trade with neutral factions |
| Navigator's Guild | 3× Tier 2 | `reachRadius +1` |
| Storage Annex | 2× Tier 2 | Tier 2 storage cap +50% |
| Research Spire | 1× Tier 3 | Unlock tech tree (Phase 4) |
| Long-Range Observatory | 2× Tier 2 + 1× Tier 3 | `reachRadius +2` (requires Navigator's Guild) |

---

## Faction System

### Surface Factions
| Faction Type | Default Attitude | Mission Tone |
|---|---|---|
| Village / Town | Neutral | Diplomacy/trade available; combat possible |
| Hostile Force | Hostile | Combat-focused missions |
| Sky Dock | Friendly | Trade-only; no combat |
| Ruin | None | Exploration/loot; wildlife, traps |

### Relationship States
`neutral` → `ally` → `trade_partner` (positive path)
`neutral` → `wary` → `hostile` (negative path)

Relationship state influences:
- Dialogue options available to Envoy heroes
- Whether combat triggers automatically on site entry
- Trade good availability (`trade_partner` gives bonus Tier 2 items)
- Site evolution probability weights (allies are less likely to be `conquered`)

---

## Glossary

| Term | Definition |
|---|---|
| Cycle | One full tradewind circuit period; the main game time unit |
| Wind Corridor | Set of hexes accessible during the current cycle |
| Reach Radius | City stat controlling how far heroes can travel from city hex |
| Distance Class | `near`/`mid`/`far` — baked into hex tile schema |
| HexZoomScene | Pseudo-isometric zoomed view of the hex world around the city |
| WorldMapScene | 2D flat full-world view used for wind route selection |
| Active Hero | Player-controlled character in a mission |
| Support Hero | Second mission hero providing passive stat bonuses |
| MissionContext | Data passed from HexZoomScene to MissionScene |
| MissionResult | Data returned from MissionScene to HexZoomScene |
| GSM | GameStateManager — single cross-scene state store |
| Site Evolution | Per-cycle state changes applied to unvisited (or revisited) surface sites |
