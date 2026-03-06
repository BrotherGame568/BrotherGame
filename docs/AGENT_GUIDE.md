# Agent Guide

> Audience: AI coding agents working in this repository
> Read this document, `ARCHITECTURE.md`, and `GAME_DESIGN.md` **before touching any file**.

---

## Three Documents to Read First

| Document | What it answers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | What scenes exist, what interfaces exist, what data flows where |
| [GAME_DESIGN.md](GAME_DESIGN.md) | What the game rules are, all gameplay mechanics |
| This document | How to work safely in the repo without breaking other agents |

---

## Core Rule: Interfaces Are Contracts

All system boundaries are TypeScript `interface` files in `game/core/systems/` and `game/core/services/`. These are the contracts between domains.

**You must:**
- Import interfaces by their `@systems/` or `@services/` path alias, never by relative path from a scene or implementation file.
- Implement the full interface in your concrete class (no missing methods).
- Run `npm run typecheck` before every commit. Zero errors is the only acceptable state.

**You must NOT:**
- Modify an interface file without opening a Cross-Domain Interface issue and getting all domain owners to agree.
- Add new public methods to a concrete class and call them from another domain — that new method should become part of the interface first.
- Cast to `any` to work around type errors. Fix the type error instead.

---

## The Stub Pattern

Every system and service begins as a stub. A stub:
- Is a class that `implements` its interface.
- Has every required method returning a safe default value or throwing a `NotImplementedError`.
- Is importable and type-checks without errors.
- Is clearly marked `// STUB` at the top of the file.

This means you can always write scene code that calls `this.heroSystem.getAvailable()` and the project will compile, even if `HeroSystem` is not implemented yet.

### Stub Template

```typescript
// STUB — replace with full implementation
import type { IHeroSystem } from '@systems/IHeroSystem';
import type { Hero } from '@data/Hero';

export class HeroSystemStub implements IHeroSystem {
  getAvailable(): Hero[] {
    return []; // safe default
  }

  recruit(_heroClass: string): Hero {
    throw new Error('HeroSystem not implemented');
  }

  // ... all other interface methods ...
}
```

### NotImplementedError vs Safe Default
- Use a **safe default** (empty array, `null`, `false`, `0`) for read-only methods that scenes call on every frame or during render. This prevents crashes during Phase 0.
- Use `throw new Error('X not implemented')` for write/action methods that should never be called until the system is real.

---

## Phase 0 Checklist (Current Phase)

Phase 0 is complete when:
- [ ] `npm run typecheck` passes with zero errors on the full tree
- [ ] `npm run dev` opens a blank Phaser window in the browser
- [ ] Every interface file in `game/core/systems/` has a corresponding `*Stub.ts`
- [ ] Every interface file in `game/core/services/` has a corresponding `*Stub.ts`
- [ ] Every scene in `game/scenes/` has a stub class extending `Phaser.Scene`
- [ ] All data types in `game/core/data/` are defined

---

## Path Aliases

Always use path aliases in `import` statements. Never use deep relative paths (`../../../`) across domain boundaries.

| Alias | Resolves to |
|---|---|
| `@scenes/*` | `game/scenes/*` |
| `@systems/*` | `game/core/systems/*` |
| `@services/*` | `game/core/services/*` |
| `@data/*` | `game/core/data/*` |
| `@entities/*` | `game/core/entities/*` |
| `@assets/*` | `game/assets/*` |

---

## Working on a System (Step-by-Step)

1. **Read the interface** (`game/core/systems/I<YourSystem>.ts`). Understand every method signature.
2. **Read `GAME_DESIGN.md`** for the rules your system must enforce.
3. **Create your implementation file** at `game/core/systems/<YourSystem>.ts`. Implement the full interface.
4. **Register it in `GameStateManager`** — swap the stub out for your concrete class.
5. **Run `npm run typecheck`** — fix all errors before proceeding.
6. **Write or update the relevant scene** to use the new system via its interface.
7. **Open PR** to your domain branch with filled template.

---

## Working on a Scene (Step-by-Step)

1. **Read the scene's stub** in `game/scenes/`. The ownership comment at the top tells you what this scene reads/writes from GSM.
2. **Only read GSM fields listed in your scene's "Reads from GSM" column** (see ARCHITECTURE.md Scene Ownership table).
3. **Only write GSM fields listed in your scene's "Writes to GSM" column**.
4. **Call systems via their interfaces** — never instantiate a concrete system class inside a scene.
5. **Scene transitions:** follow the transition contracts in ARCHITECTURE.md exactly. Do not add undocumented state side-effects on scene transitions.

---

## Working on Data Types

Data types in `game/core/data/` are pure TypeScript types — no logic, no Phaser imports.

- Define a type → export it.
- Never add methods or class logic to data types.
- If you need a factory function, add it as a separate exported function in the same file (e.g., `createDefaultHero(): Hero`).
- If you need to add a field to a data type, check ARCHITECTURE.md and GAME_DESIGN.md first to confirm the design intent.

---

## Working on Level Data

Level data files live in `game/levels/world_map/` and `game/levels/missions/`. They are JSON files.

- Hex map files follow the `HexTile` schema in `game/core/data/HexTile.ts`.
- Mission files follow the `MissionLevelData` schema (defined by Architecture in Phase 1).
- The Levels domain owns these files. Architecture defines the schema. If the schema needs to change, open a Cross-Domain Interface issue.

---

## Audio Events

All audio event names are defined in `game/audio/EVENTS.md`. When implementing a system that triggers sound:

1. Check `EVENTS.md` for the correct event name.
2. Call `this.audioService.play('event_name')` via the `IAudioService` interface.
3. Do NOT hardcode audio file paths in scene or system code.
4. If you need a new event name, open a PR updating `EVENTS.md` (Audio domain) first.

---

## Asset Loading

All asset paths and specs are in `game/assets/MANIFEST.md`. When loading assets in a scene's `preload()`:

1. Check `MANIFEST.md` for the asset ID and path.
2. Use the asset ID (not the raw path) as the Phaser texture key.
3. Do NOT hardcode pixel dimensions — use the spec in `MANIFEST.md`.
4. If an asset does not yet exist, use a placeholder and mark it `placeholder` in the manifest.

---

## CI and PR Requirements

Your PR will be automatically rejected if:
- `npm run typecheck` fails (checked by CI `typecheck` job)
- The PR description body is empty
- The branch name does not match naming conventions

Your PR requires ALL domain owner sign-offs if:
- Any file matching `game/core/systems/I*.ts` or `game/core/services/I*.ts` is modified

---

## Common Mistakes to Avoid

| Mistake | Correct Approach |
|---|---|
| Importing a concrete class from another domain | Import the interface instead |
| Skipping `typecheck` before committing | Always run `npm run typecheck` first |
| Adding logic to data type files | Keep data types pure; logic goes in system classes |
| Calling methods not on the interface | Add the method to the interface via Cross-Domain issue |
| Hardcoding asset paths | Use `MANIFEST.md` IDs |
| Hardcoding audio file paths | Use `EVENTS.md` event names via `IAudioService` |
| Writing to GSM fields your scene doesn't own | Only write the GSM fields listed in your scene's ownership row |
| Creating a new file in another domain's directory | Open a Cross-Domain issue first |
