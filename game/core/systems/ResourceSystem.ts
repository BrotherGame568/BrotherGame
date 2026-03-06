/**
 * ResourceSystem.ts
 * Resource add/spend/query operations backed by GSM's ResourceStore.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 */

import type { ResourceStore, ResourceTier } from '@data/Resource';
import { getResourceTier } from '@data/ResourceDefinitions';
import type { IResourceSystem } from './IResourceSystem';
import type { IGameStateManager } from './IGameStateManager';

export class ResourceSystem implements IResourceSystem {
  constructor(private _gsm: IGameStateManager) {}

  add(resourceId: string, amount: number): void {
    const tier = this.getTier(resourceId);
    const store = this._gsm.resources;
    const map = this._tierMap(store, tier);
    const cap = this._tierCap(store, tier);
    const current = map[resourceId] ?? 0;
    map[resourceId] = Math.min(current + amount, cap);
    // Write back (GSM stores by reference, but be explicit)
    this._gsm.setResources(store);
  }

  spend(resourceId: string, amount: number): void {
    if (!this.canAfford(resourceId, amount)) {
      throw new Error(`Cannot afford ${amount} of "${resourceId}"`);
    }
    const tier = this.getTier(resourceId);
    const map = this._tierMap(this._gsm.resources, tier);
    map[resourceId] = (map[resourceId] ?? 0) - amount;
    this._gsm.setResources(this._gsm.resources);
  }

  canAfford(resourceId: string, amount: number): boolean {
    const tier = this.getTier(resourceId);
    const map = this._tierMap(this._gsm.resources, tier);
    return (map[resourceId] ?? 0) >= amount;
  }

  canAffordAll(costs: Record<string, number>): boolean {
    return Object.entries(costs).every(([id, amt]) => this.canAfford(id, amt));
  }

  spendAll(costs: Record<string, number>): void {
    if (!this.canAffordAll(costs)) {
      throw new Error('Cannot afford all resources in cost map');
    }
    for (const [id, amt] of Object.entries(costs)) {
      this.spend(id, amt);
    }
  }

  getTier(resourceId: string): ResourceTier {
    return getResourceTier(resourceId);
  }

  getStore(): Readonly<ResourceStore> {
    return this._gsm.resources;
  }

  setCap(tier: ResourceTier, newCap: number): void {
    const store = this._gsm.resources;
    if (tier === 1) store.caps.tier1 = newCap;
    else if (tier === 2) store.caps.tier2 = newCap;
    else store.caps.tier3 = newCap;
    this._gsm.setResources(store);
  }

  // ── Private helpers ───────────────────────────────────────

  private _tierMap(store: ResourceStore, tier: ResourceTier): Record<string, number> {
    if (tier === 1) return store.tier1;
    if (tier === 2) return store.tier2;
    return store.tier3;
  }

  private _tierCap(store: ResourceStore, tier: ResourceTier): number {
    if (tier === 1) return store.caps.tier1;
    if (tier === 2) return store.caps.tier2;
    return store.caps.tier3;
  }
}
