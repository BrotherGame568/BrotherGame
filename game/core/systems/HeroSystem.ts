/**
 * HeroSystem.ts
 * Hero roster management and mission party assignment.
 * Owner: Architecture domain
 *
 * No Phaser imports — pure game logic.
 */

import type { Hero, HeroClass, HeroStatus, MissionParty } from '@data/Hero';
import { createDefaultHero } from '@data/Hero';
import type { IHeroSystem } from './IHeroSystem';
import type { IGameStateManager } from './IGameStateManager';

let _nextHeroId = 100;
function generateHeroId(): string {
  return `hero_${_nextHeroId++}`;
}

/** Default stat spreads per class used when recruiting. */
const CLASS_STATS: Record<HeroClass, { combat: number; exploration: number; diplomacy: number }> = {
  skirmisher: { combat: 7, exploration: 3, diplomacy: 3 },
  scout:      { combat: 3, exploration: 7, diplomacy: 3 },
  envoy:      { combat: 3, exploration: 3, diplomacy: 7 },
};

const CLASS_NAMES: Record<HeroClass, string[]> = {
  skirmisher: ['Rook', 'Vex', 'Gareth', 'Thane'],
  scout:      ['Wren', 'Sparrow', 'Ash', 'Fern'],
  envoy:      ['Cassian', 'Delphi', 'Orin', 'Sage'],
};

export class HeroSystem implements IHeroSystem {
  constructor(private _gsm: IGameStateManager) {}

  getRoster(): Hero[] {
    return this._gsm.heroRoster;
  }

  getAvailable(): Hero[] {
    return this._gsm.heroRoster.filter(h => h.status === 'available');
  }

  recruit(heroClass: HeroClass): Hero {
    const availableClasses = this._gsm.cityState.availableHeroClasses;
    if (!availableClasses.includes(heroClass)) {
      throw new Error(`Hero class "${heroClass}" is not unlocked yet`);
    }

    const names = CLASS_NAMES[heroClass];
    const name = names[this._gsm.heroRoster.length % names.length]!;

    const hero = createDefaultHero({
      id: generateHeroId(),
      name,
      heroClass,
      stats: { ...CLASS_STATS[heroClass] },
      portraitId: `hero_portrait_${heroClass}`,
    });

    const roster = [...this._gsm.heroRoster, hero];
    this._gsm.setHeroRoster(roster);
    return hero;
  }

  assignToMission(party: MissionParty): void {
    const active = this.getById(party.activeHeroId);
    if (!active) throw new Error(`Hero "${party.activeHeroId}" not found`);
    if (active.status !== 'available') throw new Error(`Hero "${active.name}" is not available (status: ${active.status})`);

    this._gsm.updateHeroStatus(party.activeHeroId, { status: 'on_mission' });

    if (party.supportHeroId) {
      const support = this.getById(party.supportHeroId);
      if (!support) throw new Error(`Support hero "${party.supportHeroId}" not found`);
      if (support.status !== 'available') throw new Error(`Support hero "${support.name}" is not available`);
      if (support.id === active.id) throw new Error('Active and support hero cannot be the same');
      this._gsm.updateHeroStatus(party.supportHeroId, { status: 'on_mission' });
    }

    this._gsm.setMissionParty(party);
  }

  returnFromMission(updates: Array<{ heroId: string; newStatus: HeroStatus; experienceGained: number }>): void {
    for (const update of updates) {
      const hero = this.getById(update.heroId);
      if (hero) {
        this._gsm.updateHeroStatus(update.heroId, {
          status: update.newStatus,
          experience: hero.experience + update.experienceGained,
        });
      }
    }
    this._gsm.setMissionParty(null);
  }

  advanceCycleStatuses(): void {
    for (const hero of this._gsm.heroRoster) {
      if (hero.status === 'recovering') {
        this._gsm.updateHeroStatus(hero.id, { status: 'available' });
      } else if (hero.status === 'injured') {
        this._gsm.updateHeroStatus(hero.id, { status: 'recovering' });
      }
    }
  }

  getById(heroId: string): Hero | undefined {
    return this._gsm.heroRoster.find(h => h.id === heroId);
  }
}
