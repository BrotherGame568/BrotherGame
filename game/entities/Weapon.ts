/**
 * game/entities/Weapon.ts
 * ============================================================
 * Weapon definitions for melee combat.
 * Add new entries to WEAPONS to create additional weapon types.
 */

export type WeaponId = 'sword' | 'axe' | 'spear';

export interface WeaponDef {
  id:            WeaponId;
  name:          string;
  /** Damage per hit. */
  damage:        number;
  /** Reach in pixels. */
  range:         number;
  /** Half-arc of the swing in degrees (total arc = arcDeg * 2). */
  arcDeg:        number;
  /** How long the visual swing lasts (ms). */
  swingDuration: number;
  /** Minimum time between attacks (ms). */
  cooldown:      number;
  /** Colour of the swing arc graphic. */
  color:         number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  sword: {
    id:            'sword',
    name:          'Sword',
    damage:        1,
    range:         115,
    arcDeg:        70,
    swingDuration: 120,
    cooldown:      280,
    color:         0xaaccff,
  },
  axe: {
    id:            'axe',
    name:          'Axe',
    damage:        3,
    range:         65,
    arcDeg:        55,
    swingDuration: 320,
    cooldown:      580,
    color:         0xff8833,
  },
  spear: {
    id:            'spear',
    name:          'Spear',
    damage:        1,
    range:         140,
    arcDeg:        18,
    swingDuration: 140,
    cooldown:      280,
    color:         0xffffaa,
  },
};
