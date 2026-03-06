/**
 * ResourceDefinitions.ts
 * Concrete resource definitions for the minimal playable version.
 * Owner: Architecture domain
 *
 * Pure data — no Phaser imports.
 * Expand this file to add new resources. All systems reference RESOURCE_DEFS
 * to look up tier, display name, etc.
 */

import type { ResourceDefinition, ResourceTier, ResourceStore } from './Resource';
import { createDefaultResourceStore } from './Resource';

// ── Definitions ───────────────────────────────────────────────

export const RESOURCE_DEFS: Record<string, ResourceDefinition> = {
  food: {
    id: 'food',
    displayName: 'Food',
    tier: 1,
    iconId: 'res_icon_food',
    description: 'Basic sustenance — gathered from any site.',
  },
  water: {
    id: 'water',
    displayName: 'Water',
    tier: 1,
    iconId: 'res_icon_water',
    description: 'Essential for city survival — found near rivers and lakes.',
  },
  acclivity_crystals: {
    id: 'acclivity_crystals',
    displayName: 'Crystals',
    tier: 2,
    iconId: 'res_icon_crystals',
    description: 'Lift fuel and trade currency — found at mid-range deposits.',
  },
  ancient_relics: {
    id: 'ancient_relics',
    displayName: 'Relics',
    tier: 3,
    iconId: 'res_icon_relics',
    description: 'Rare archaeological finds — only at far-range ruins.',
  },
};

/**
 * All resource IDs. Use this to iterate or validate IDs at runtime.
 */
export const ALL_RESOURCE_IDS = Object.keys(RESOURCE_DEFS) as ReadonlyArray<string>;

/**
 * Look up the tier of a given resource ID.
 * Throws if the resource ID is unknown.
 */
export function getResourceTier(resourceId: string): ResourceTier {
  const def = RESOURCE_DEFS[resourceId];
  if (!def) throw new Error(`Unknown resource ID: "${resourceId}"`);
  return def.tier;
}

/**
 * Look up a resource definition by ID.
 * Returns undefined if the ID is not registered.
 */
export function getResourceDef(resourceId: string): ResourceDefinition | undefined {
  return RESOURCE_DEFS[resourceId];
}

/**
 * Create a ResourceStore pre-populated with small starting amounts.
 * Used by InitialGameState to seed the player's inventory.
 */
export function seedResourceStore(): ResourceStore {
  const store = createDefaultResourceStore();
  store.tier1['food'] = 10;
  store.tier1['water'] = 10;
  store.tier2['acclivity_crystals'] = 0;
  store.tier3['ancient_relics'] = 0;
  return store;
}
