/**
 * IResourceSystem.ts
 * Interface for all resource-related operations.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 */

import type { ResourceStore, ResourceTier } from '@data/Resource';

export interface IResourceSystem {
  /**
   * Add a quantity of a resource to the store.
   * Silently clamps to storage cap if exceeded.
   */
  add(resourceId: string, amount: number): void;

  /**
   * Spend a quantity of a resource.
   * Throws if insufficient quantity available.
   */
  spend(resourceId: string, amount: number): void;

  /**
   * Returns true if the store contains at least `amount` of `resourceId`.
   */
  canAfford(resourceId: string, amount: number): boolean;

  /**
   * Returns true if ALL entries in the cost map can be afforded simultaneously.
   */
  canAffordAll(costs: Record<string, number>): boolean;

  /**
   * Spend all resources in a cost map atomically.
   * Throws if any resource is insufficient (no partial spend).
   */
  spendAll(costs: Record<string, number>): void;

  /**
   * Returns the tier of a given resource by ID.
   * Looks up from resource definitions.
   */
  getTier(resourceId: string): ResourceTier;

  /**
   * Returns a read-only snapshot of the current store.
   */
  getStore(): Readonly<ResourceStore>;

  /**
   * Update a storage cap for a given tier.
   */
  setCap(tier: ResourceTier, newCap: number): void;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
import type { IGameStateManager } from './IGameStateManager';

export class ResourceSystemStub implements IResourceSystem {
  constructor(private _gsm: IGameStateManager) {}

  add(_resourceId: string, _amount: number): void { /* stub: no-op */ }
  spend(_resourceId: string, _amount: number): void { /* stub: no-op */ }
  canAfford(_resourceId: string, _amount: number): boolean { return true; }
  canAffordAll(_costs: Record<string, number>): boolean { return true; }
  spendAll(_costs: Record<string, number>): void { /* stub: no-op */ }
  getTier(_resourceId: string): ResourceTier { return 1; }
  getStore(): Readonly<ResourceStore> { return this._gsm.resources; }
  setCap(_tier: ResourceTier, _newCap: number): void { /* stub: no-op */ }
}
