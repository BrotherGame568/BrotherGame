/**
 * IMissionBridge.ts
 * Re-exports the core mission handoff types as a single import point.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 *
 * Scenes and systems should import from here rather than from MissionContext.ts
 * directly, so that this file can enforce versioning and validate the contract.
 */

export type {
  MissionContext,
  MissionResult,
  MissionObjective,
} from '@data/MissionContext';

export type {
  MissionParty,
} from '@data/Hero';

export type {
  SupportBonus,
  BonusStat,
  ModifierType,
} from '@data/SupportBonus';

export { applyBonuses } from '@data/SupportBonus';
export { createDefaultMissionContext } from '@data/MissionContext';
