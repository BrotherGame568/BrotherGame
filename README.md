# BrotherGame

A sky-city exploration and management game built with **Phaser 3 + TypeScript**, targeting web browsers. The player steers a floating city along tradewind routes over a hex surface world, dispatches heroes to evolving side-view surface sites, and manages a three-tier resource economy to grow the city's capabilities.

## Engine Decision

**Phaser 3 (TypeScript, web-only).** This is final. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for rationale and scene topology.

## Agent Quick-Start

> If you are an AI coding agent, **read these three documents first** before touching any file:
> 1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Scene topology, interface index, event contracts
> 2. [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) — Gameplay rules, resource system, progression
> 3. [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) — Stub pattern, domain ownership, CI requirements

## High-Level Game Loop

```
Cycle Start
  │
  ▼
WorldMapScene ── choose tradewind direction (2–3 options)
  │                city icon moves along wind corridor
  ▼
HexZoomScene ─── pseudo-isometric hex grid around city position
  │                accessible hexes = within reachRadius
  │                select surface site  ──────────────────────────────┐
  │                                                                    ▼
  │                                               Party Selection (modal)
  │                                               pick Active hero + Support hero
  │                                                                    │
  │                                                                    ▼
  │◄──────────────────────────────────────────── MissionScene (side-view, combat)
  │                collect resources, hero result written back
  │
  │                OR enter city
  │                     │
  │                     ▼
  │              CityViewScene (HOMM-style)
  │              build districts, recruit heroes, manage resources
  │◄─────────────────────────────────────────────────────────────────┘
  │
  ▼
Site evolution pass (sites change state after full circuit)
  │
  ▼
Next Cycle
```

## Repository Structure

```
BrotherGame/
├── .github/                      # PR templates, issue templates, CI workflows
├── docs/
│   ├── ARCHITECTURE.md           # [READ FIRST] Scene topology + interface map
│   ├── GAME_DESIGN.md            # [READ FIRST] All gameplay rules and systems
│   ├── AGENT_GUIDE.md            # [READ FIRST] How to work in this repo
│   └── INTERFACES.md             # Interface index and implementation status
├── game/
│   ├── core/
│   │   ├── data/                 # TypeScript data types (HexTile, Hero, Resource…)
│   │   ├── entities/             # Entity types (Hero, Faction, Building…)
│   │   ├── services/             # IAudioService, ISaveService interfaces + stubs
│   │   └── systems/              # All gameplay system interfaces + stubs
│   ├── scenes/                   # Phaser Scene stubs (one file per scene)
│   ├── levels/
│   │   ├── world_map/            # Hex map data files
│   │   ├── missions/             # Mission level data files
│   │   └── templates/            # Reusable level templates
│   ├── assets/
│   │   ├── sprites/
│   │   ├── ui/
│   │   ├── backgrounds/
│   │   └── animations/
│   └── audio/
│       ├── music/
│       ├── sfx/
│       └── ambience/
├── tools/                        # Build helpers, asset pipeline scripts
│   └── asset_pipeline/           # Standalone asset manager app + backend
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Domain Ownership

| Domain | Branch | Owns |
|---|---|---|
| Architecture | `arch/core` | `game/core/`, `game/scenes/`, `tsconfig.json`, `vite.config.ts`, all interfaces |
| Levels | `levels/design` | `game/levels/`, level data files, site evolution data |
| Art & Assets | `art/assets` | `game/assets/`, `game/assets/MANIFEST.md` |
| Audio | `audio/music` | `game/audio/`, `game/audio/EVENTS.md` |

**Interface files are cross-domain.** Any PR touching `game/core/systems/I*.ts` or `game/core/services/I*.ts` requires sign-off from ALL domain owners. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Branching Model

```
main          ← stable releases only
  └── develop ← integration (all features merge here first)
        ├── arch/core
        ├── levels/design
        ├── art/assets
        └── audio/music
```

Sub-branches: `arch/core-hero-system`, `levels/design-hex-map`, `art/assets-city-sprites`, etc.

## Phased Roadmap

| Phase | Status | Deliverable |
|---|---|---|
| **Phase 0** | 🔄 In progress | TS scaffold + all interfaces + data types + scene stubs + agent docs |
| **Phase 1** | ⬜ Not started | All contracts locked in docs; data rules, all schemas, design questions resolved |
| **Phase 2** | ⬜ Not started | System implementations behind interfaces (each domain independently) |
| **Phase 3** | ⬜ Not started | Vertical slice: full cycle playable in browser |
| **Phase 4** | ⬜ Not started | Content scaling: varied sites, tech tree, Tier 3 mission chains |

### Phase 0 Exit Criteria
- `npm run typecheck` passes with zero errors on the full stub tree
- A blank Phaser window launches in browser (`npm run dev`)
- Every interface file has a stub implementation
- Every scene has a stub class with ownership comments

## Getting Started

```bash
git clone <repo>
cd BrotherGame
npm install
npm run dev        # launch blank Phaser window in browser
npm run typecheck  # must pass before any PR
```

## Asset Manager

The repo includes a standalone asset-management tool for importing, previewing, processing, and maintaining saved assets.

- Tool location: [tools/asset_pipeline](tools/asset_pipeline)
- Tool guide: [tools/asset_pipeline/README.md](tools/asset_pipeline/README.md)

Common scripts from the repo root:

```bash
npm run asset-manager:start   # recommended: start both together
npm run asset-manager:server  # start only the local backend
npm run asset-manager:dev     # start only the frontend
npm run asset-manager:build   # validate the tool build
```

Use the asset manager to:

- add new image, spritesheet, and video-derived assets
- browse the saved asset library
- edit existing assets without creating duplicates
- update generated asset metadata and manifests

See [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) for full workflow.
