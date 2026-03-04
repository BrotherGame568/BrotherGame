# game/levels — Levels Domain

**Owner:** @AMarkMartin
**Branch:** `levels/design`

---

## What This Domain Is

The levels domain owns all content that defines where and how gameplay takes place:
- World map layout, regions, and tile/node data
- Mission scene definitions and objectives
- Scene composition (placing entities defined by core into levels)
- Level templates for reuse

**You compose scenes from pieces defined elsewhere. You do not define new entity types or systems.**

---

## What You Are Allowed to Touch

```
game/levels/            ← everything in here
docs/GAME_DESIGN.md     ← update world map and mission design sections
```

## What You Must Not Touch

```
game/core/      ← architecture domain — request changes via cross-domain issue
game/assets/    ← art domain
game/audio/     ← audio domain (but you CAN trigger audio events — see below)
```

---

## Folder Structure

```
game/levels/
├── world_map/      # Map layout, region data, tile/node definitions
├── missions/       # Individual mission scenes and objective data
└── templates/      # Reusable level/scene templates
```

---

## How to Use Core Systems

**Never import core systems directly into level scripts.** Use the interfaces:

```
# To start a mission from the world map:
EventBus.emit("mission_requested", mission_context)

# To listen for turn events on the world map:
EventBus.on("turn_started", self._on_turn_started)
EventBus.on("turn_ended", self._on_turn_ended)

# To read entity definitions:
var unit_def = DataLayer.get_entity("soldier")  # reads from game/core/data/
```

Full interface reference: `docs/INTERFACES.md`

---

## How to Trigger Audio

Levels trigger audio through events — never by calling audio code directly:

```
EventBus.emit("map_encounter_trigger")
EventBus.emit("mission_start")
EventBus.emit("objective_complete")
```

Full event list: `game/audio/EVENTS.md`

---

## How to Reference Assets

Reference assets by their manifest ID, not by hardcoded path:

```
# Good
var sprite = AssetManifest.get("player_idle")

# Bad — breaks if art owner moves the file
var sprite = load("res://game/assets/sprites/player/idle.png")
```

Full asset registry: `game/assets/MANIFEST.md`

---

## If You Need Something That Doesn't Exist Yet

Open a GitHub issue tagged `cross-domain` and tag the relevant owner. Do not reach across domain boundaries to work around a missing interface.
