# BrotherGame — AI Agent Context

This file is read automatically by Claude and other AI coding assistants at the start of every session. Follow everything here precisely.

---

## What This Project Is

A 2D video game with two gameplay modes:
- **World Map** — turn-based strategic layer (movement, resources, decisions)
- **Missions** — real-time action scenarios triggered from the world map

The codebase is split across four domains with separate owners. You are working in one domain at a time. Stay in your lane.

---

## The Most Important Rule: Domain Isolation

**Domains communicate through interfaces only. Never import or directly call code from another domain.**

```
ALLOWED:   game/core/   →  (defines interfaces)
ALLOWED:   game/levels/ →  calls core interfaces
ALLOWED:   game/levels/ →  emits/listens to events defined in core
FORBIDDEN: game/levels/ →  imports from game/assets/
FORBIDDEN: game/assets/ →  imports from game/audio/
FORBIDDEN: any domain   →  modifies files outside its folder
```

If you need something from another domain that doesn't exist yet, **stop and open a GitHub issue** tagged `cross-domain`. Do not work around it by reaching across the boundary.

---

## Domain Ownership

| Domain | Folder | Owner |
|---|---|---|
| Architecture | `game/core/` | @AndrewMart |
| Levels | `game/levels/` | @AMarkMartin |
| Art & Assets | `game/assets/` | @abe-mart |
| Audio | `game/audio/` | @AMarkMartin |

**Before writing any code, confirm which domain you are working in and read that domain's `README.md`.**

---

## Design Principles (Non-Negotiable)

1. **Event-driven communication.** Systems talk to each other through events/signals, not direct function calls across domains. This is what makes parallel development safe.

2. **Data over hardcoding.** Game configuration, balance values, asset paths, and level data live in data files (`game/core/data/`), not in code. Code reads data; it doesn't contain it.

3. **Shared entities, separate behavior.** The entity definitions in `game/core/entities/` are the shared vocabulary of the whole game. Levels, Art, and Audio reference these definitions but never redefine them.

4. **Interfaces are stable contracts.** Once an interface is listed in `docs/INTERFACES.md`, treat it as frozen unless a cross-domain issue has been opened and resolved. Do not change interface signatures unilaterally.

5. **No side effects outside your domain folder.** If you find yourself editing a file outside your domain's folder, stop and reconsider. The only exception is `docs/` — any domain can update documentation via PR.

---

## Asset Storage and Phaser Usage

When working with visual assets, follow these rules:

1. **Saved game assets live under `game/assets/` by category.**
	- `game/assets/sprites/`
	- `game/assets/animations/`
	- `game/assets/backgrounds/`
	- `game/assets/ui/`

2. **Structured asset metadata is part of the source of truth.**
	- Per-asset metadata: `game/assets/_meta/*.asset.json`
	- Generated catalog: `game/assets/manifest.catalog.json`
	- Generated markdown summary: `game/assets/MANIFEST.generated.md`

3. **Use the standalone Asset Manager for ingestion and updates whenever possible.**
	The tool in `tools/asset_pipeline/` is the supported workflow for:
	- importing new assets
	- generating spritesheets from video
	- updating metadata
	- editing existing assets without creating duplicates

4. **Do not hardcode ad hoc asset paths in gameplay code.**
	If an asset is managed by the tool, prefer the catalog/metadata naming and keep runtime asset keys stable.

5. **Phaser should load runtime assets by web path, not filesystem path.**
	Use paths relative to the served asset root, such as:
	- `sprites/my_unit.webp`
	- `animations/walk_cycle_spider.webp`
	- `backgrounds/sky_ruins.webp`

6. **In Phaser scenes, preload first, then create stable keys.**
	Typical pattern:
	- `this.load.image('city_bg', 'backgrounds/city_bg.webp')`
	- `this.load.spritesheet('rootwalker', 'animations/rootwalker.webp', { frameWidth, frameHeight })`
	- create animations once with stable keys like `rootwalker_walk`

7. **For spritesheets, metadata matters.**
	Origin, collision box, frame rate, columns, and rows belong in metadata/tooling and should stay aligned with Phaser runtime setup.

8. **Video imports are stored as generated spritesheets, not original videos.**
	If an existing video-derived asset is reopened, it should be treated as editing the generated spritesheet output.

---

## File You Must Read

Before working on any domain, read:
- `docs/INTERFACES.md` — all cross-domain interfaces and their current stability status
- Your domain's `README.md` (e.g., `game/levels/README.md`)
- `docs/ARCHITECTURE.md` — system design overview

---

## Commit Convention

Format: `type(scope): short description`

Types: `feat`, `fix`, `refactor`, `asset`, `level`, `docs`, `chore`, `wip`
Scopes: `core`, `turn-system`, `real-time`, `levels`, `world-map`, `missions`, `assets`, `audio`, `ui`, `tools`

Always end AI-generated commits with:
```
[ai] Generated with Claude, reviewed by <owner-name>
```

---

## What You Must Never Do

- Push directly to `develop` or `main`
- Modify files outside your assigned domain folder (except `docs/`)
- Change an interface in `docs/INTERFACES.md` without opening a cross-domain issue first
- Hardcode asset paths, balance values, or level data into code
- Create new cross-domain dependencies without team agreement
- Delete or rename existing interface functions that other domains depend on
