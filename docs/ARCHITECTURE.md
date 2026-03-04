# Architecture Document

> Owner: Architecture domain
> Status: Living document — update as systems are built

---

## Modularity Principles (Read First)

These rules exist so all three developers — and their AI agents — can work in parallel without breaking each other's work.

**1. Domains communicate through interfaces only.**
No domain imports code from another domain's folder. All runtime communication goes through `EventBus` events. All data access goes through `DataLayer` or `AssetManifest`. See `docs/INTERFACES.md`.

**2. Interfaces are stable contracts.**
Once an interface is marked `active` in `docs/INTERFACES.md`, it cannot change without a `cross-domain` GitHub issue and team sign-off. Treat breaking an interface the same as breaking a public API.

**3. Data lives in data files, not in code.**
Balance values, entity definitions, asset paths, and level data all live in `game/core/data/`. Code reads data — it does not contain it. This lets content change without code changes.

**4. Shared vocabulary lives in core.**
Entity types, event names, data schemas — anything referenced by more than one domain is defined in `game/core/` and owned by the architecture owner. Other domains never redefine these.

**5. Scenes compose; they don't define.**
Level scenes place and configure entities defined by core. They do not define new entity behavior inline. If a new behavior is needed, it goes in core (via cross-domain issue if needed).

---

## Engine Decision

**Status: TBD** — Finalize before first implementation sprint.

| Option | Pros | Cons |
|---|---|---|
| Godot 4 | Free, open-source, GDScript easy for AI agents, excellent scene system | Smaller ecosystem |
| Unity | Huge ecosystem, C#, asset store | Subscription cost, heavier |
| Custom / Pygame | Full control | Much more build time |

**Decision record:** _(fill in once decided)_

---

## High-Level System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BrotherGame                          │
│                                                         │
│  ┌──────────────────┐    ┌──────────────────────────┐  │
│  │   World Map       │    │      Mission Scene       │  │
│  │  (Turn-Based)     │◄──►│      (Real-Time)         │  │
│  └──────────────────┘    └──────────────────────────┘  │
│           │                          │                  │
│           └──────────┬───────────────┘                  │
│                      ▼                                   │
│              ┌──────────────┐                           │
│              │  Core Layer  │                           │
│              │  - Entities  │                           │
│              │  - Data/State│                           │
│              │  - Events    │                           │
│              │  - Services  │                           │
│              └──────────────┘                           │
└─────────────────────────────────────────────────────────┘
```

---

## Core Systems

### 1. Game State Manager
**Location:** `game/core/autoloads/`
**Purpose:** Single source of truth for current game state (which mode is active, global flags, save data).

- Manages transitions between World Map and Mission modes
- Serializes/deserializes save state
- Emits global events (signals/events) that other systems listen to

### 2. Turn System
**Location:** `game/core/systems/turn_based/`
**Purpose:** Controls turn order, action points, and end-of-turn resolution on the World Map.

Interface for Levels domain:
```
# TurnSystem provides:
start_turn(player_id)
end_turn(player_id)
signal turn_started(player_id)
signal turn_ended(player_id)
signal all_turns_resolved()
```

### 3. Real-Time System
**Location:** `game/core/systems/real_time/`
**Purpose:** Game loop, physics/collision management, input handling during Missions.

Interface for Levels domain:
```
# RealTimeSystem provides:
enter_mission(mission_data: MissionData)
exit_mission(result: MissionResult)
signal mission_started(mission_data)
signal mission_completed(result)
```

### 4. Entity Framework
**Location:** `game/core/entities/`
**Purpose:** Defines base classes / components for all game objects (units, buildings, items, enemies).

- Entities are engine-agnostic data structs where possible
- Components are composable: a unit can have MovementComponent, CombatComponent, etc.
- Both World Map and Mission scenes use the same entity definitions

### 5. Data Layer
**Location:** `game/core/data/`
**Purpose:** Game configuration, balance data, and asset manifests.

- Prefer data files (JSON/CSV/resource files) over hardcoded values
- Levels domain reads unit/item definitions from here
- Art domain provides asset path manifest here

---

## World Map ↔ Mission Handoff

When a mission is triggered from the World Map:

1. World Map serializes relevant context into `MissionContext` data object
2. `GameStateManager` stores context and initiates mode transition
3. Mission scene loads with `MissionContext` applied
4. On mission complete, `MissionResult` is returned to `GameStateManager`
5. World Map resumes, applies result (XP, loot, map changes)

```
MissionContext {
  mission_id: string
  player_units: Unit[]
  map_location: Vector2
  objectives: Objective[]
  modifiers: Modifier[]
}

MissionResult {
  success: bool
  units_survived: Unit[]
  loot: Item[]
  xp_earned: int
  time_taken: float
}
```

---

## Cross-Domain Contracts

| Interface | Provided By | Consumed By | Defined In |
|---|---|---|---|
| Entity data format | Architecture | Levels, Art | This doc + `game/core/entities/` |
| Asset path manifest | Art | Architecture, Levels | `game/assets/MANIFEST.md` |
| Audio event names | Audio | Architecture | `game/audio/EVENTS.md` |
| Mission data schema | Architecture | Levels | This doc |
| Tile/map format | Architecture | Levels | TBD |

> Whenever a contract changes, open a Cross-Domain Interface issue and update this table.

---

## Naming Conventions

**Files:** `snake_case` for scripts/code files
**Classes/Types:** `PascalCase`
**Constants:** `UPPER_SNAKE_CASE`
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
