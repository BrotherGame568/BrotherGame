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
