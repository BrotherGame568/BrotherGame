---
name: Cross-Domain Interface
about: Agree on a TypeScript interface contract between two domains before implementation begins
labels: cross-domain, needs-discussion
---

## Interface File
<!-- Which file in game/core/systems/ or game/core/services/ defines this boundary? -->
`game/core/systems/I___.ts`

## Interface to Define
<!-- What boundary is being agreed on? e.g., "IReachSystem — accessible hexes filtered by reachRadius" -->

## Requesting Domain
<!-- Which domain needs to call this interface? Architecture / Levels / Art / Audio -->

## Providing Domain
<!-- Which domain owns the concrete implementation? -->

## Proposed TypeScript Interface Diff
<!-- Paste the proposed interface below. Use exact TypeScript syntax — this becomes the binding contract. -->

```typescript
// game/core/systems/IExampleSystem.ts

export interface IExampleSystem {
  /**
   * Brief description.
   * @param input - describe input
   * @returns describe return value and when it can be undefined
   */
  exampleMethod(input: ExampleInput): ExampleResult;
}

export interface ExampleInput {
  id: string;
}

export interface ExampleResult {
  success: boolean;
  value?: number;
}

/** Stub for Phase 0 — returns safe defaults only. */
export class ExampleSystemStub implements IExampleSystem {
  exampleMethod(_input: ExampleInput): ExampleResult {
    return { success: false };
  }
}
```

## Data Types Affected
<!-- List any new or changed types in game/core/data/ this interface depends on. -->
- [ ] `game/core/data/___.ts` — NEW / MODIFIED

## Scenes Affected
<!-- Which scenes will call this interface? Check all that apply. -->
- [ ] `WorldMapScene`
- [ ] `HexZoomScene`
- [ ] `MissionScene`
- [ ] `CityViewScene`
- [ ] `UIScene`

## GSM State Shape Impact
<!-- Does this change IGameStateManager? -->
- [ ] No GSM changes
- [ ] Yes — new/changed fields: ___

## Open Questions
<!-- What remains undecided? -->
-

## Approval Checklist
All four domain owners must approve before any implementation PR is merged.

- [ ] **Architecture**: @___ — interface and types consistent with ARCHITECTURE.md
- [ ] **Levels**: @___ — scene contracts correct for level requirements
- [ ] **Art**: @___ — no unexpected asset format changes
- [ ] **Audio**: @___ — audio event names match EVENTS.md

## Linked PRs
<!-- PRs that implement this interface once approved -->
-