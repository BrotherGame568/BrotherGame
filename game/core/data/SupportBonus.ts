/**
 * SupportBonus.ts
 * Data type for stat modifiers applied by a Support hero.
 * Owner: Architecture domain
 *
 * Pure data type — no logic, no Phaser imports.
 */

/**
 * Which hero stat or mission parameter the bonus affects.
 */
export type BonusStat =
  | 'combat'          // Adds to/multiplies hero combat stat
  | 'exploration'     // Adds to/multiplies hero exploration stat
  | 'diplomacy'       // Adds to/multiplies hero diplomacy stat
  | 'resourceYield';  // Adds to/multiplies resource pickup amounts

/**
 * Whether the modifier is an absolute addition or a percentage multiplier.
 * flat: final_value = base + modifier
 * percent: final_value = base * (1 + modifier / 100)
 */
export type ModifierType = 'flat' | 'percent';

/**
 * A single stat bonus applied once at MissionScene.create()
 * from the support hero's bonusArray.
 */
export interface SupportBonus {
  stat: BonusStat;
  modifier: number;
  type: ModifierType;
}

/**
 * Apply an array of SupportBonuses to a base stat value.
 * Flat bonuses are summed first, then percent bonuses are applied.
 */
export function applyBonuses(baseStat: number, bonuses: SupportBonus[], targetStat: BonusStat): number {
  let value = baseStat;
  let percentTotal = 0;
  for (const bonus of bonuses) {
    if (bonus.stat !== targetStat) continue;
    if (bonus.type === 'flat') {
      value += bonus.modifier;
    } else {
      percentTotal += bonus.modifier;
    }
  }
  return value * (1 + percentTotal / 100);
}
