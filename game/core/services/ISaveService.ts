/**
 * ISaveService.ts
 * Interface for game save and load operations.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 * Save data is serialized from IGameStateManager state.
 */

import type { IGameStateManager } from '@systems/IGameStateManager';

export interface ISaveService {
  /**
   * Serialize current GameStateManager state and persist it.
   * In Phase 0–2: uses localStorage. Phase 3+: may use IndexedDB or server.
   */
  save(gsm: IGameStateManager): void;

  /**
   * Load persisted state and apply it to GameStateManager.
   * Throws if save data is missing or corrupt.
   */
  load(gsm: IGameStateManager): void;

  /**
   * Returns true if a valid save exists.
   */
  hasSave(): boolean;

  /**
   * Delete the current save.
   */
  deleteSave(): void;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
export class SaveServiceStub implements ISaveService {
  save(_gsm: IGameStateManager): void { /* stub: no-op */ }
  load(_gsm: IGameStateManager): void { throw new Error('SaveService not implemented'); }
  hasSave(): boolean { return false; }
  deleteSave(): void { /* stub: no-op */ }
}
