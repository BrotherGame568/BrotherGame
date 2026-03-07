# Contributing to BrotherGame

> **AI Agents:** Read [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) first. It covers the stub pattern, domain rules, and CI requirements specific to AI-assisted work.

---

## Domain Ownership

Each domain owns a branch and a set of directories. **Never modify files outside your domain without opening a Cross-Domain Interface issue first.**

| Domain | Branch | Owns | TypeScript Scope |
|---|---|---|---|
| Architecture | `arch/core` | `game/core/`, `game/scenes/`, `tsconfig.json`, `vite.config.ts`, all `I*.ts` interface files | All interface definitions |
| Levels | `levels/design` | `game/levels/`, level data JSON files | Consumes interfaces only |
| Art & Assets | `art/assets` | `game/assets/`, `game/assets/MANIFEST.md` | No TS files (asset manifests only) |
| Audio | `audio/music` | `game/audio/`, `game/audio/EVENTS.md` | No TS files (event registry only) |

### Interface File Rule
**Any PR that modifies a file matching `game/core/systems/I*.ts` or `game/core/services/I*.ts` requires sign-off from ALL four domain owners** via a Cross-Domain Interface issue (use `.github/ISSUE_TEMPLATE/cross_domain.md`). The CI will flag these automatically.

---

## CI Requirements

Every PR must pass:

1. **`npm run typecheck`** (`tsc --noEmit`) — zero TypeScript errors required. This enforces interface compliance across all domains.
2. **PR template filled** — PR body must not be empty.
3. **Branch naming** — must match `arch/`, `levels/`, `art/`, `audio/`, `chore/`, `docs/`, or `hotfix/`.

Run locally before pushing:
```bash
npm run typecheck
```

## Asset Manager

The repo includes a standalone asset-management tool for importing, processing, and maintaining saved assets.

- Location: [tools/asset_pipeline](tools/asset_pipeline)
- Guide: [tools/asset_pipeline/README.md](tools/asset_pipeline/README.md)

Common root-level commands:

```bash
npm run asset-manager:start   # recommended: start both together
npm run asset-manager:server
npm run asset-manager:dev
npm run asset-manager:build
```

Use it when working on asset ingestion, metadata updates, spritesheets, video-derived sheets, or the saved asset library.

---

## Workflow Step by Step

### Day-to-Day Work
```bash
# Start from your domain branch, up to date with develop
git checkout arch/core
git pull origin develop
git merge develop

# For a new chunk of work, make a sub-branch
git checkout -b arch/core-hero-system

# ... do your work ...

git add <specific files>
git commit -m "feat(core): implement hero roster system"

# Push sub-branch and open PR → your domain branch
git push origin arch/core-hero-system
```

### Merging to Develop
When your domain branch is stable and `npm run typecheck` passes:
1. Open a PR: **your domain branch → `develop`**
2. Fill out the PR template fully
3. Request review from at least one other domain owner
4. Address review comments
5. Merge (squash preferred)

### Releases
Architecture owner opens PR: **`develop` → `main`** at agreed milestones. All four domain owners sign off before merge.

---

## Commit Message Convention

Format: `type(scope): short description`

| Type | When |
|---|---|
| `feat` | New feature or content |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `stub` | Adding or updating a stub file (Phase 0) |
| `types` | New or updated TypeScript data types |
| `asset` | New or updated art/audio asset |
| `level` | New or updated level/map content |
| `docs` | Documentation only |
| `chore` | Tooling, build, config |
| `wip` | Work in progress (clean up before PR) |

**Scopes:** `core`, `gsm`, `hero-system`, `resource-system`, `site-evolution`, `tradewind`, `reach`, `tech-tree`, `mission-bridge`, `audio-service`, `save-service`, `world-map-scene`, `hex-zoom-scene`, `mission-scene`, `city-view-scene`, `ui-scene`, `levels`, `assets`, `audio`, `tools`

Examples:
```
stub(hero-system): add IHeroSystem interface and NotImplementedStub
types(core): add HexTile and AxialCoord data types
feat(city-view-scene): implement building slot interaction
level(world-map): add starting_region hex data
```

---

## Cross-Domain Dependencies

When your work depends on something from another domain:

1. Open a GitHub Issue using `.github/ISSUE_TEMPLATE/cross_domain.md`
2. Tag the relevant domain owner(s)
3. Agree on the TypeScript interface **before** building on it
4. The interface is defined by Architecture in `game/core/systems/I*.ts` or `game/core/services/I*.ts`
5. Document the agreed interface in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## AI-Assisted Work Guidelines

1. **Always review AI output before committing.** You are responsible for everything merged under your branch.
2. **Tag AI-generated commits** with `[ai]` at the end of the commit body:
   ```
   feat(core): generate entity registry scaffold

   [ai] Generated with Claude, reviewed and modified by <your-name>
   ```
3. **Do not let AI agents push to `develop` or `main`** — AI work goes to sub-branches.
4. **AI agents must run `npm run typecheck`** before generating a commit or PR. Do not submit code that fails type-checking.
5. **Agents read three docs before touching any file:** `docs/ARCHITECTURE.md`, `docs/GAME_DESIGN.md`, `docs/AGENT_GUIDE.md`.

---

## Pull Request Checklist

See `.github/pull_request_template.md` — fill it out completely. PRs without a filled template will not be reviewed.

---

## File Ownership Quick Reference

| Directory / File | Owner | Change Rule |
|---|---|---|
| `game/core/systems/I*.ts` | Architecture | Cross-domain sign-off required |
| `game/core/services/I*.ts` | Architecture | Cross-domain sign-off required |
| `game/core/data/*.ts` | Architecture | PR to `arch/core` |
| `game/core/entities/*.ts` | Architecture | PR to `arch/core` |
| `game/scenes/*.ts` | Architecture | PR to `arch/core` |
| `game/levels/` | Levels | PR to `levels/design` |
| `game/assets/` | Art | PR to `art/assets` |
| `game/audio/` | Audio | PR to `audio/music` |
| `docs/` | All | PR preferred for major changes |
| `tsconfig.json`, `vite.config.ts`, `package.json` | Architecture | PR to `arch/core` |
| `tools/` | Architecture | PR to `arch/core` |

| Branch | Owner | Scope |
|---|---|---|
| `arch/core` | Architecture | Core systems, data, entity framework |
| `levels/design` | Levels | World map, missions, scene layout |
| `art/assets` | Art | All visual assets, style guide |
| `audio/music` | Audio | Music, SFX, ambience |

**Rule:** Never commit directly to `develop` or `main`. Always work via your domain branch or a sub-branch.

---

## Workflow Step by Step

### Day-to-Day Work
```bash
# Start from your domain branch, up to date with develop
git checkout arch/core
git pull origin develop
git merge develop

# For a new chunk of work, make a sub-branch
git checkout -b arch/core-turn-system

# ... do your work ...

git add <specific files>
git commit -m "feat(core): implement turn queue system"

# Push sub-branch and open PR → your domain branch
git push origin arch/core-turn-system
```

### Merging to Develop
When your domain branch is stable and tested:
1. Open a PR: **your domain branch → `develop`**
2. Fill out the PR template fully
3. Request review from at least one other team member
4. Address review comments
5. Merge (squash or merge commit — team decides)

### Releases
The architecture owner opens a PR: **`develop` → `main`** at agreed milestones. All owners sign off before merge.

---

## Commit Message Convention

Format: `type(scope): short description`

| Type | When |
|---|---|
| `feat` | New feature or content |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `asset` | New or updated art/audio asset |
| `level` | New or updated level/map content |
| `docs` | Documentation only |
| `chore` | Tooling, build, config |
| `wip` | Work in progress (use sparingly, clean up before PR) |

**Scopes:** `core`, `turn-system`, `real-time`, `levels`, `world-map`, `missions`, `assets`, `audio`, `ui`, `tools`

Examples:
```
feat(core): add entity component system base
fix(turn-system): resolve end-of-turn event ordering bug
asset(sprites): add player character idle animation
level(world-map): add starting region tile data
```

---

## AI-Assisted Work Guidelines

When an AI agent is generating code or assets in your domain:

1. **Always review AI output before committing.** You are responsible for everything merged under your branch.
2. **Tag AI-generated commits** with `[ai]` at the end of the commit body:
   ```
   feat(core): generate entity registry scaffold

   [ai] Generated with Claude, reviewed and modified by <your-name>
   ```
3. **Do not let AI agents push to `develop` or `main`** — AI work goes to sub-branches under your domain branch, and you merge after review.
4. **Context files:** AI agents may create `.agent_context/` folders for their working notes. These are gitignored and should never be committed.

---

## Cross-Domain Dependencies

When your work requires something from another domain (e.g., Art needs a sprite size spec from Architecture):

1. Open a GitHub Issue tagged `cross-domain`
2. Tag the relevant domain owner
3. Agree on the interface/contract **before** building on it
4. Document the agreed interface in `docs/ARCHITECTURE.md` or the relevant design doc

---

## Pull Request Checklist

See `.github/pull_request_template.md` — fill it out completely. PRs without a filled template will not be reviewed.

---

## File Ownership Quick Reference

| Directory | Owner | Notes |
|---|---|---|
| `game/core/` | Architecture | Changes here affect everyone — communicate |
| `game/levels/` | Levels | Reference core entities but don't modify them |
| `game/assets/` | Art | Exported-ready formats only in repo |
| `game/audio/` | Audio | Compressed formats in repo; raw project files optional |
| `docs/` | All | Anyone can update, PR preferred for major changes |
| `tools/` | Architecture | With input from all domains |
