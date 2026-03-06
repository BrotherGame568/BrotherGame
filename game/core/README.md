# game/core — Architecture Domain

**Owner:** @AndrewMart
**Branch:** `arch/core`

---

## What This Domain Is

The core layer is the foundation everything else builds on. It defines:
- The shared entity model (units, items, objects)
- The turn-based and real-time system controllers
- The game state manager (mode transitions, save/load)
- All cross-domain interfaces and event definitions
- Game data / configuration files

**If something needs to be shared between two or more other domains, it belongs here.**

---

## What You Are Allowed to Touch

```
game/core/              ← everything in here
docs/ARCHITECTURE.md    ← update as systems are built
docs/INTERFACES.md      ← update when interfaces change (see process below)
docs/DECISIONS.md       ← log decisions made
```

## What You Must Not Touch

```
game/levels/    ← levels domain
game/assets/    ← art domain
game/audio/     ← audio domain
```

---

## Folder Structure

```
game/core/
├── systems/
│   ├── turn_based/     # Turn queue, action points, end-of-turn resolution
│   └── real_time/      # Game loop, input routing, physics during missions
├── entities/           # Base entity definitions and components
├── data/               # JSON/resource config files (balance, manifests)
└── autoloads/          # Global singletons: GameStateManager, EventBus, etc.
```

---

## Key Responsibilities

### GameStateManager (`autoloads/`)
- Single source of truth for current game mode (`WORLD_MAP` or `MISSION`)
- Handles `MissionContext` packaging and `MissionResult` unpacking
- Owns the save/load pipeline

### EventBus (`autoloads/`)
- Global event/signal dispatcher
- All cross-domain communication goes through here
- See `docs/INTERFACES.md` for the full event catalog

### Entity Framework (`entities/`)
- Define base classes and components here
- Other domains extend or reference these — never redefine them elsewhere
- Components should be composable (MovementComponent, CombatComponent, etc.)

### Data Layer (`data/`)
- All game config in data files, not hardcoded
- Levels reads unit/item definitions from here
- Art provides asset manifest here

---

## Changing an Interface

Any change to a function signature, event name, or data schema in `docs/INTERFACES.md` **requires**:
1. Open a `cross-domain` GitHub issue describing the change
2. Get sign-off from affected domain owners
3. Update `docs/INTERFACES.md` and bump the version
4. Notify team before merging

Do not change interfaces in a hurry. Other domains may have already coded against them.
