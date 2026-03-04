# Interface Specifications

> Owner: Architecture (@AndrewMart)
> This is the single source of truth for all cross-domain interfaces.
> **Do not implement against an interface marked `draft` without coordinating with the architecture owner.**

---

## Stability Levels

| Status | Meaning |
|---|---|
| `stable` | Frozen. Changes require a cross-domain issue and team sign-off. |
| `active` | In use, may still evolve with notice. |
| `draft` | Being designed. Do not build on yet. |
| `deprecated` | Will be removed. Migrate away. |

---

## EventBus — Global Event System

**Provided by:** `game/core/autoloads/`
**Status:** `draft`

The EventBus is the only sanctioned way for domains to communicate at runtime. All events are listed here. Using an event not in this list is not allowed.

### Emitting and Listening (pseudocode — update once engine is chosen)

```
# Emit
EventBus.emit("event_name", payload)

# Listen
EventBus.on("event_name", self._handler_function)

# Stop listening (always do this on scene exit)
EventBus.off("event_name", self._handler_function)
```

### World Map Events

| Event Name | Emitted By | Payload | Status |
|---|---|---|---|
| `turn_started` | TurnSystem | `{ player_id: string }` | `draft` |
| `turn_ended` | TurnSystem | `{ player_id: string }` | `draft` |
| `all_turns_resolved` | TurnSystem | `{}` | `draft` |
| `map_unit_moved` | WorldMap (levels) | `{ unit_id: string, from: Vector2, to: Vector2 }` | `draft` |
| `map_encounter_trigger` | WorldMap (levels) | `{ encounter_id: string, location: Vector2 }` | `draft` |
| `mission_requested` | WorldMap (levels) | `MissionContext` | `draft` |

### Mission Events

| Event Name | Emitted By | Payload | Status |
|---|---|---|---|
| `mission_started` | GameStateManager | `MissionContext` | `draft` |
| `mission_completed` | GameStateManager | `MissionResult` | `draft` |
| `objective_complete` | Mission (levels) | `{ objective_id: string }` | `draft` |
| `unit_attacked` | Unit (core) | `{ attacker_id: string, target_id: string }` | `draft` |
| `unit_died` | Unit (core) | `{ unit_id: string }` | `draft` |

### UI Events

| Event Name | Emitted By | Payload | Status |
|---|---|---|---|
| `ui_button_clicked` | UI (levels/core) | `{ button_id: string }` | `draft` |
| `ui_menu_opened` | UI | `{ menu_id: string }` | `draft` |
| `ui_menu_closed` | UI | `{ menu_id: string }` | `draft` |

---

## GameStateManager

**Provided by:** `game/core/autoloads/`
**Status:** `draft`

```
# Query current mode
GameStateManager.current_mode  # → "WORLD_MAP" | "MISSION"

# Initiate a mission (called internally — levels use EventBus.emit("mission_requested"))
GameStateManager.start_mission(context: MissionContext) → void

# Called by mission scene on completion
GameStateManager.end_mission(result: MissionResult) → void

# Save / load
GameStateManager.save_game() → void
GameStateManager.load_game() → void
```

---

## DataLayer

**Provided by:** `game/core/autoloads/`
**Status:** `draft`

```
# Get an entity definition by ID (reads from game/core/data/)
DataLayer.get_entity(id: string) → EntityDef

# Get a list of all entities of a type
DataLayer.get_entities_of_type(type: string) → EntityDef[]

# Get raw config value
DataLayer.get_config(key: string) → any
```

---

## AssetManifest

**Provided by:** `game/core/autoloads/` (reads `game/assets/MANIFEST.md` / generated registry)
**Status:** `draft`

```
# Get a loaded asset by manifest ID
AssetManifest.get(id: string) → Resource

# Check if an asset exists
AssetManifest.has(id: string) → bool
```

---

## Data Schemas

### MissionContext

Passed from World Map → GameStateManager → Mission scene.

```
MissionContext {
  mission_id:    string       # references a definition in game/core/data/
  player_units:  string[]     # list of unit IDs
  map_location:  Vector2      # where on the world map this triggered
  objectives:    Objective[]
  modifiers:     Modifier[]   # buffs/debuffs applied to this mission
}
```
**Status:** `draft`

### MissionResult

Returned from Mission scene → GameStateManager → World Map.

```
MissionResult {
  success:         bool
  units_survived:  string[]   # unit IDs
  units_lost:      string[]   # unit IDs
  loot:            string[]   # item IDs
  xp_earned:       int
  time_taken:      float
}
```
**Status:** `draft`

### EntityDef

The base shape for any entity definition in `game/core/data/`.

```
EntityDef {
  id:         string
  type:       string          # "unit" | "item" | "building" | "enemy"
  name:       string
  asset_id:   string          # references AssetManifest
  stats:      map<string, any>
  components: string[]        # list of component names to attach
}
```
**Status:** `draft`

### Objective

```
Objective {
  id:       string
  type:     string    # "eliminate" | "survive" | "escort" | "collect" | "defend"
  target:   string    # entity ID or count, depending on type
  required: bool      # false = optional objective
}
```
**Status:** `draft`

---

## Versioning

When any interface above changes:
1. Open a `cross-domain` GitHub issue
2. Get sign-off from all affected domain owners
3. Update this file — bump the version below and note what changed

**Current version:** `0.1.0-draft`
**Last updated:** 2026-03-03
**Changelog:**
- `0.1.0-draft` — Initial draft of all interfaces
