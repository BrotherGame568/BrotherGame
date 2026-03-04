# Architecture Decision Records

When the team makes a significant technical or design decision, log it here with rationale. This prevents re-litigating settled choices and gives AI agents the "why" behind the architecture.

Format:
- **Date** — when the decision was made
- **Status** — `decided` | `superseded` | `under discussion`
- **Context** — what problem was being solved
- **Decision** — what was chosen
- **Rationale** — why
- **Consequences** — what this means going forward

---

## ADR-001 — Event-Driven Cross-Domain Communication

**Date:** 2026-03-03
**Status:** decided

**Context:**
Three developers (plus AI agents) work on separate domains simultaneously. Direct function calls between domains create tight coupling — if one domain refactors its internals, other domains break.

**Decision:**
All cross-domain runtime communication goes through a central `EventBus` (publish/subscribe pattern). Domains emit named events with payloads; other domains listen for events they care about. No domain imports another domain's code directly.

**Rationale:**
- Domains can be developed in isolation as long as the event contract is respected
- Adding a new system (audio, UI, add-in module) requires only subscribing to existing events — no changes to emitting code
- AI agents working in one domain cannot accidentally break another domain by changing internals

**Consequences:**
- All event names and payloads must be documented in `docs/INTERFACES.md`
- Changing an event signature is a breaking change requiring team sign-off
- Debugging cross-domain behavior requires tracing events rather than call stacks

---

## ADR-002 — Data-Driven Entity Definitions

**Date:** 2026-03-03
**Status:** decided

**Context:**
Game entities (units, items, enemies) need to be referenced by multiple domains. Hardcoding stats and definitions in code makes balance changes require code deployments and creates duplication risk.

**Decision:**
All entity definitions live as data files in `game/core/data/`. Code reads definitions at runtime through `DataLayer`. Definitions are not duplicated in any other domain.

**Rationale:**
- Balance and content changes don't require code changes
- Levels domain can reference entity types without depending on architecture code
- Art domain can add asset IDs to definitions without touching code
- AI agents can add/modify entities by editing data files rather than code

**Consequences:**
- DataLayer must be implemented before other domains can reference entity definitions
- Data schema changes (e.g., adding a new field to EntityDef) must be coordinated across all domains that read that data

---

## ADR-003 — Asset Reference by Manifest ID

**Date:** 2026-03-03
**Status:** decided

**Context:**
Art domain owns file paths. If levels or core hardcode asset paths, any rename or reorganization by the art owner breaks other domains silently.

**Decision:**
All asset references use manifest IDs, not file paths. `game/assets/MANIFEST.md` is the registry. `AssetManifest` autoload resolves IDs to loaded resources at runtime.

**Rationale:**
- Art owner can reorganize files freely without breaking other domains (as long as manifest IDs stay stable)
- Manifest gives a clear inventory of all assets and their status
- Missing assets surface at manifest load time, not as silent path errors

**Consequences:**
- Every new asset must be registered in `MANIFEST.md` before other domains can use it
- Manifest ID renames are breaking changes — coordinate before renaming

---

## ADR-004 — Engine Choice

**Date:** _(TBD)_
**Status:** under discussion

**Context:**
Engine must support both turn-based (world map) and real-time (missions) gameplay, integrate well with git, and be accessible for AI-assisted development.

**Decision:**
_(To be filled in)_

**Options considered:**
- **Godot 4** — Free, open-source, GDScript readable by AI agents, scene system maps well to domain structure
- **Unity** — Large ecosystem, C#, paid licensing for commercial release above revenue threshold
- **Custom/Pygame** — Maximum control, significantly more build time

**Rationale:**
_(To be filled in)_

**Consequences:**
_(To be filled in — engine choice affects gitignore, CI, and project structure inside `game/`)_
