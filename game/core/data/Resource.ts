/**
 * Resource.ts
 * Data types for the three-tier resource system.
 * Owner: Architecture domain
 *
 * Pure data types — no logic, no Phaser imports.
 */

/** The three resource tiers. */
export type ResourceTier = 1 | 2 | 3;

/**
 * A single resource type definition.
 * Resource type definitions are loaded from game/core/data/resourceDefinitions.json (Phase 1).
 */
export interface ResourceDefinition {
  id: string;
  displayName: string;
  tier: ResourceTier;
  /** Asset ID for the pickup icon (see MANIFEST.md) */
  iconId: string;
  /** Short description for UI tooltips */
  description: string;
}

/**
 * A flat map of resource quantities, keyed by resourceId.
 */
export type ResourceQuantityMap = Record<string, number>;

/**
 * The full resource store held in GameStateManager.
 * Tracks current quantities and storage caps per tier.
 */
export interface ResourceStore {
  tier1: ResourceQuantityMap;
  tier2: ResourceQuantityMap;
  tier3: ResourceQuantityMap;
  caps: {
    tier1: number;
    tier2: number;
    tier3: number;
  };
}

/**
 * Create a default empty ResourceStore with starting caps.
 */
export function createDefaultResourceStore(): ResourceStore {
  return {
    tier1: {},
    tier2: {},
    tier3: {},
    caps: {
      tier1: 100,
      tier2: 20,
      tier3: 5,
    },
  };
}

/**
 * Get the total quantity of all resources in a single tier.
 */
export function tierTotal(store: ResourceStore, tier: ResourceTier): number {
  const map = tier === 1 ? store.tier1 : tier === 2 ? store.tier2 : store.tier3;
  return Object.values(map).reduce((sum, v) => sum + v, 0);
}
