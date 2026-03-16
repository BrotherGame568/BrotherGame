/**
 * AirCombatScene.ts — Action-RPG / Tower Defense hybrid.
 * Hero-led Siege with Persistent Base Defence.
 *
 * OVERVIEW
 *   The player controls a single hero in an overhead view.
 *   • Defend your base (left) against incoming enemy waves.
 *   • Siege the enemy Stronghold (right): breach the gate, destroy the Core.
 *   • Two optional quest camps in the mid-field yield bonus resources.
 *
 * WIN    Destroy the enemy Stronghold Core.
 * LOSE   Player base HP reaches 0.
 *
 * CONTROLS
 *   WASD / Arrow keys  → move hero
 *   Left-click         → move to point
 *   Space              → dash (2 s cooldown)
 *   ESC                → retreat
 */

import Phaser from 'phaser';
import type { IGameStateManager } from '@systems/IGameStateManager';
import type { IHeroSystem }        from '@systems/IHeroSystem';
import type { ServiceBundle }      from '../../src/main';
import type { MissionResult }      from '@data/MissionContext';

export const AIR_COMBAT_SCENE_KEY = 'AirCombatScene';

// ── World ────────────────────────────────────────────────────────────────────
const WORLD_W = 1920;
const WORLD_H = 1080;

// ── Player base ──────────────────────────────────────────────────────────────
const BASE_X   = 180;
const BASE_Y   = WORLD_H / 2; // 540
const BASE_HP  = 1000;

// ── Hero ─────────────────────────────────────────────────────────────────────
const HERO_R       = 20;
const HERO_SPEED   = 230;
const HERO_HP      = 500;
const HERO_ATK     = 55;
const HERO_ATK_R   = 100;
const HERO_ATK_CD  = 750;   // ms
const DASH_DUR     = 180;   // ms
const DASH_SPD_MUL = 3.5;
const DASH_CD      = 2000;  // ms

// ── Defence turrets ──────────────────────────────────────────────────────────
const TURRET_R     = 14;
const TURRET_HP    = 350;
const TURRET_ATK   = 28;
const TURRET_RANGE = 260;
const TURRET_CD    = 1100;  // ms

const TURRET_POSITIONS = [
  { x: BASE_X, y: 330 },
  { x: BASE_X, y: 750 },
];

// ── Enemy marchers (wave) ────────────────────────────────────────────────────
const MARCH_R      = 16;
const MARCH_HP_BASE  = 80;
const MARCH_ATK_BASE = 12;
const MARCH_SPEED  = 62;
const MARCH_ATK_R  = 95;
const MARCH_ATK_CD = 1200;
const WAVE_MS      = 22000;

// ── Fort guards ──────────────────────────────────────────────────────────────
const GUARD_HP_BASE  = 120;
const GUARD_ATK_BASE = 18;
const GUARD_SPEED    = 90;
const GUARD_ATK_R    = 95;
const GUARD_ATK_CD   = 1000;
const GUARD_DETECT   = 230;
const GUARD_LEASH    = 380;

// ── Fort structures ───────────────────────────────────────────────────────────
const WALL_X       = 1590;
const WALL_HW      = 18;           // half-thickness of wall
const GATE_HH      = 110;          // gate half-height → gate spans 220 px
const WALL_TOP_CY  = (BASE_Y - GATE_HH) / 2;                              // ~215
const WALL_TOP_HH  = (BASE_Y - GATE_HH) / 2;                              // ~215
const WALL_BOT_CY  = BASE_Y + GATE_HH + (WORLD_H - BASE_Y - GATE_HH) / 2; // ~865
const WALL_BOT_HH  = (WORLD_H - BASE_Y - GATE_HH) / 2;                    // ~215
const GATE_HP_MAX  = 500;
const TOWER_HP     = 700;
const TOWER_ATK    = 22;
const TOWER_RANGE  = 290;
const TOWER_CD     = 1500;
const CORE_R       = 45;
const CORE_X       = 1800;
const CORE_HP_MAX  = 1200;

// ── Quest camps ───────────────────────────────────────────────────────────────
const CAMP_DATA = [
  { id: 'camp_a', x: 720,  y: 330, label: 'Enemy Camp A' },
  { id: 'camp_b', x: 1100, y: 720, label: 'Enemy Camp B' },
];
const GUARDS_PER_CAMP  = 3;
const CAMP_BONUS_EACH  = 30; // extra crystals per cleared camp

// ── Interfaces ────────────────────────────────────────────────────────────────

interface HeroState {
  name: string;
  x: number; y: number;
  hp: number; maxHp: number;
  lastAttackMs: number;
  isDashing: boolean;
  dashEndMs: number;
  dashDirX: number; dashDirY: number;
  dashCooldown: number;         // remaining cooldown ms
  moveTargetX: number; moveTargetY: number;
  isMovingToClick: boolean;
  hitFlashMs: number;
}

interface Turret {
  id: string;
  x: number; y: number;
  hp: number; maxHp: number;
  lastAttackMs: number;
  destroyed: boolean;
}

interface EnemyUnit {
  id: string;
  kind: 'marcher' | 'guard' | 'camp_guard';
  campId?: string;
  x: number; y: number;
  hp: number; maxHp: number;
  speed: number;
  attack: number;
  attackRange: number;
  attackCd: number;
  lastAttackMs: number;
  originX: number; originY: number;
  hitFlashMs: number;
}

type FortType = 'wall_top' | 'wall_bot' | 'gate' | 'tower' | 'core';

interface FortBlock {
  id: string;
  type: FortType;
  cx: number; cy: number;
  hw: number; hh: number;   // half-extents (used for collision + rendering)
  hp: number; maxHp: number;
  attack?: number;
  attackRange?: number;
  attackCd?: number;
  lastAttackMs?: number;
  destroyed: boolean;
}

interface QuestCamp {
  id: string;
  x: number; y: number;
  label: string;
  cleared: boolean;
  guardIds: Set<string>;
}

// ── Scene ─────────────────────────────────────────────────────────────────────

export class AirCombatScene extends Phaser.Scene {
  private gsm!: IGameStateManager;
  private heroSystem!: IHeroSystem; // reserved for future hero stat integration
  private services!: ServiceBundle;
  private dangerLevel = 1;

  private hero!: HeroState;
  private turrets: Turret[] = [];
  private enemies: EnemyUnit[] = [];
  private fortBlocks: FortBlock[] = [];
  private camps: QuestCamp[] = [];

  private playerBaseHp = BASE_HP;
  private sceneDone    = false;
  private campsCleared = 0;
  private waveTimer    = 0;
  private waveNumber   = 0;
  private enemyCounter = 0;

  private gfx!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private objectiveText!: Phaser.GameObjects.Text;

  private keys!: {
    W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key;
    UP: Phaser.Input.Keyboard.Key; DOWN: Phaser.Input.Keyboard.Key;
    LEFT: Phaser.Input.Keyboard.Key; RIGHT: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };

  constructor() { super({ key: AIR_COMBAT_SCENE_KEY }); }

  init(data: ServiceBundle & { dangerLevel?: number }): void {
    this.services    = data;
    this.gsm         = data.gsm;
    this.heroSystem  = data.heroSystem;
    this.dangerLevel = data.dangerLevel ?? this.gsm.missionContext?.dangerLevel ?? 1;
  }

  preload(): void {
    if (!this.textures.exists('air_battle_bg')) {
      this.load.image('air_battle_bg', 'backgrounds/battlebackground01.webp');
    }
    if (!this.textures.exists('air_player_city')) {
      this.load.image('air_player_city', 'sprites/battlecity01.webp');
    }
  }

  create(): void {
    // Reset all state
    this.enemies      = [];
    this.turrets      = [];
    this.fortBlocks   = [];
    this.camps        = [];
    this.waveTimer    = 0;
    this.waveNumber   = 0;
    this.enemyCounter = 0;
    this.playerBaseHp = BASE_HP;
    this.sceneDone    = false;
    this.campsCleared = 0;

    // Background
    this.add.image(WORLD_W / 2, WORLD_H / 2, 'air_battle_bg')
      .setDisplaySize(WORLD_W, WORLD_H).setDepth(-10);
    this.add.image(BASE_X, BASE_Y + 8, 'air_player_city')
      .setDisplaySize(420, 230).setDepth(-1);

    this.gfx = this.add.graphics();

    // Resolve hero name from roster
    const ctx      = this.gsm.missionContext;
    const heroData = this.gsm.heroRoster.find(h => h.id === ctx?.activeHeroId);
    const heroName = heroData?.name ?? 'Hero';

    this._buildHero(heroName);
    this._buildTurrets();
    this._buildFort();
    this._buildCamps();
    this._spawnInitialForce();
    this._buildHUD();
    this._registerInput();
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  private _buildHero(name: string): void {
    this.hero = {
      name,
      x: BASE_X + 160, y: BASE_Y,
      hp: HERO_HP, maxHp: HERO_HP,
      lastAttackMs: 0,
      isDashing: false, dashEndMs: 0,
      dashDirX: 1, dashDirY: 0,
      dashCooldown: 0,
      moveTargetX: BASE_X + 160, moveTargetY: BASE_Y,
      isMovingToClick: false,
      hitFlashMs: -9999,
    };
  }

  private _buildTurrets(): void {
    TURRET_POSITIONS.forEach((pos, i) => {
      this.turrets.push({
        id: 'turret_' + i,
        x: pos.x, y: pos.y,
        hp: TURRET_HP, maxHp: TURRET_HP,
        lastAttackMs: 0,
        destroyed: false,
      });
    });
  }

  private _buildFort(): void {
    // Non-destructible wall segments
    this.fortBlocks.push({
      id: 'wall_top', type: 'wall_top',
      cx: WALL_X, cy: WALL_TOP_CY, hw: WALL_HW, hh: WALL_TOP_HH,
      hp: 9999, maxHp: 9999, destroyed: false,
    });
    this.fortBlocks.push({
      id: 'wall_bot', type: 'wall_bot',
      cx: WALL_X, cy: WALL_BOT_CY, hw: WALL_HW, hh: WALL_BOT_HH,
      hp: 9999, maxHp: 9999, destroyed: false,
    });

    // Gate — destroyable, blocks hero passage until broken
    this.fortBlocks.push({
      id: 'gate', type: 'gate',
      cx: WALL_X, cy: BASE_Y, hw: WALL_HW, hh: GATE_HH,
      hp: GATE_HP_MAX, maxHp: GATE_HP_MAX, destroyed: false,
    });

    // Flanking towers — attack hero when in range
    [
      { id: 'tower_top', cx: WALL_X + 38, cy: BASE_Y - GATE_HH - 30 },
      { id: 'tower_bot', cx: WALL_X + 38, cy: BASE_Y + GATE_HH + 30 },
    ].forEach(t => {
      this.fortBlocks.push({
        id: t.id, type: 'tower',
        cx: t.cx, cy: t.cy, hw: 28, hh: 28,
        hp: TOWER_HP, maxHp: TOWER_HP,
        attack: TOWER_ATK, attackRange: TOWER_RANGE,
        attackCd: TOWER_CD, lastAttackMs: 0,
        destroyed: false,
      });
    });

    // Stronghold core — primary win objective
    this.fortBlocks.push({
      id: 'core', type: 'core',
      cx: CORE_X, cy: BASE_Y, hw: CORE_R, hh: CORE_R,
      hp: CORE_HP_MAX, maxHp: CORE_HP_MAX,
      destroyed: false,
    });
  }

  private _buildCamps(): void {
    CAMP_DATA.forEach(cd => {
      const camp: QuestCamp = {
        id: cd.id, x: cd.x, y: cd.y, label: cd.label,
        cleared: false, guardIds: new Set(),
      };
      this.camps.push(camp);
      for (let i = 0; i < GUARDS_PER_CAMP; i++) {
        const angle = (i / GUARDS_PER_CAMP) * Math.PI * 2;
        const e = this._makeEnemy('camp_guard', cd.x + Math.cos(angle) * 55, cd.y + Math.sin(angle) * 55, cd.id);
        camp.guardIds.add(e.id);
        this.enemies.push(e);
      }
    });
  }

  private _spawnInitialForce(): void {
    // Fort guards defending the core
    [
      { x: CORE_X - 110, y: BASE_Y - 80 },
      { x: CORE_X - 70,  y: BASE_Y + 100 },
      { x: CORE_X + 60,  y: BASE_Y - 40 },
    ].forEach(pos => this.enemies.push(this._makeEnemy('guard', pos.x, pos.y)));

    // First marcher wave
    this._spawnWave(/* initial */ true);
  }

  private _makeEnemy(kind: EnemyUnit['kind'], x: number, y: number, campId?: string): EnemyUnit {
    const dl      = this.dangerLevel;
    const isGuard = kind !== 'marcher';
    return {
      id: 'e' + (this.enemyCounter++),
      kind, campId,
      x, y,
      hp:          (isGuard ? GUARD_HP_BASE  : MARCH_HP_BASE)  + dl * 6,
      maxHp:       (isGuard ? GUARD_HP_BASE  : MARCH_HP_BASE)  + dl * 6,
      speed:       isGuard ? GUARD_SPEED  : MARCH_SPEED,
      attack:      (isGuard ? GUARD_ATK_BASE : MARCH_ATK_BASE) + Math.floor(dl * 0.5),
      attackRange: isGuard ? GUARD_ATK_R  : MARCH_ATK_R,
      attackCd:    isGuard ? GUARD_ATK_CD : MARCH_ATK_CD,
      lastAttackMs: 0,
      originX: x, originY: y,
      hitFlashMs: -9999,
    };
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private _registerInput(): void {
    this.game.canvas.addEventListener('contextmenu', e => e.preventDefault());
    const kb = this.input.keyboard!;
    this.keys = {
      W:     kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A:     kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S:     kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D:     kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      UP:    kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      DOWN:  kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      LEFT:  kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      RIGHT: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      SPACE: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };
    kb.on('keydown-SPACE', () => { if (!this.sceneDone) this._tryDash(); });
    kb.on('keydown-ESC',   () => { if (!this.sceneDone) this._endCombat('retreat'); });
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (this.sceneDone || !ptr.leftButtonDown()) return;
      this.hero.moveTargetX    = ptr.x;
      this.hero.moveTargetY    = ptr.y;
      this.hero.isMovingToClick = true;
    });
  }

  private _tryDash(): void {
    const h = this.hero;
    if (h.dashCooldown > 0) return;
    // Dash toward click target, or rightward if no target
    let dx = h.moveTargetX - h.x;
    let dy = h.moveTargetY - h.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    h.isDashing   = true;
    h.dashEndMs   = this.time.now + DASH_DUR;
    h.dashDirX    = dx;
    h.dashDirY    = dy;
    h.dashCooldown = DASH_CD;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(time: number, delta: number): void {
    if (this.sceneDone) return;
    this.waveTimer += delta;
    if (this.waveTimer >= WAVE_MS) {
      this.waveTimer -= WAVE_MS;
      this._spawnWave(false);
    }
    this._updateHero(time, delta);
    this._updateEnemies(time, delta);
    this._updateTurrets(time);
    this._updateFortTowers(time);
    this._checkCamps();
    this._checkWinLose();
    this._render(time);
    this._updateHUD(time);
  }

  // ── Hero ──────────────────────────────────────────────────────────────────

  private _updateHero(time: number, delta: number): void {
    const h  = this.hero;
    const dt = delta / 1000;

    // Tick dash state
    if (h.isDashing && time > h.dashEndMs) h.isDashing = false;
    if (h.dashCooldown > 0) h.dashCooldown = Math.max(0, h.dashCooldown - delta);

    // Movement
    if (h.isDashing) {
      this._applyHeroMove(h.dashDirX, h.dashDirY, HERO_SPEED * DASH_SPD_MUL, dt);
    } else {
      let dx = 0, dy = 0;
      if (this.keys.W.isDown || this.keys.UP.isDown)    dy -= 1;
      if (this.keys.S.isDown || this.keys.DOWN.isDown)  dy += 1;
      if (this.keys.A.isDown || this.keys.LEFT.isDown)  dx -= 1;
      if (this.keys.D.isDown || this.keys.RIGHT.isDown) dx += 1;

      if (dx !== 0 || dy !== 0) {
        h.isMovingToClick = false;
        const len = Math.sqrt(dx * dx + dy * dy);
        this._applyHeroMove(dx / len, dy / len, HERO_SPEED, dt);
      } else if (h.isMovingToClick) {
        const tdx = h.moveTargetX - h.x;
        const tdy = h.moveTargetY - h.y;
        const d   = Math.sqrt(tdx * tdx + tdy * tdy);
        if (d < 8) { h.isMovingToClick = false; }
        else       { this._applyHeroMove(tdx / d, tdy / d, HERO_SPEED, dt); }
      }
    }

    // Auto-attack: prefer nearby enemies, then fort structures
    if (time - h.lastAttackMs >= HERO_ATK_CD) {
      const enemy = this._nearestEnemyTo(h, HERO_ATK_R);
      if (enemy) {
        h.lastAttackMs = time;
        enemy.hp -= HERO_ATK;
        enemy.hitFlashMs = time;
        if (enemy.hp <= 0) this._killEnemy(enemy);
      } else {
        const block = this._nearestAttackableFort();
        if (block) {
          h.lastAttackMs = time;
          block.hp -= HERO_ATK;
          if (block.hp <= 0) block.destroyed = true;
        }
      }
    }
  }

  private _applyHeroMove(dx: number, dy: number, speed: number, dt: number): void {
    const h  = this.hero;
    const nx = Math.max(HERO_R, Math.min(WORLD_W - HERO_R, h.x + dx * speed * dt));
    const ny = Math.max(HERO_R, Math.min(WORLD_H - HERO_R, h.y + dy * speed * dt));
    if (!this._heroOverlapsBlocks(nx, ny)) {
      h.x = nx; h.y = ny;
    } else {
      // Wall-sliding: try each axis independently
      const sx = Math.max(HERO_R, Math.min(WORLD_W - HERO_R, h.x + dx * speed * dt));
      if (!this._heroOverlapsBlocks(sx, h.y)) { h.x = sx; }
      const sy = Math.max(HERO_R, Math.min(WORLD_H - HERO_R, h.y + dy * speed * dt));
      if (!this._heroOverlapsBlocks(h.x, sy)) { h.y = sy; }
    }
  }

  /** AABB-circle overlap: only wall_top / wall_bot / gate block hero movement. */
  private _heroOverlapsBlocks(hx: number, hy: number): boolean {
    for (const b of this.fortBlocks) {
      if (b.destroyed) continue;
      if (b.type !== 'wall_top' && b.type !== 'wall_bot' && b.type !== 'gate') continue;
      const cx  = Math.max(b.cx - b.hw, Math.min(hx, b.cx + b.hw));
      const cy  = Math.max(b.cy - b.hh, Math.min(hy, b.cy + b.hh));
      const dx  = hx - cx, dy = hy - cy;
      if (dx * dx + dy * dy < HERO_R * HERO_R) return true;
    }
    return false;
  }

  private _nearestAttackableFort(): FortBlock | null {
    const ATTACK_TYPES: FortType[] = ['gate', 'tower', 'core'];
    let best: FortBlock | null = null;
    let bestD = HERO_ATK_R + 35; // slightly extended for structures
    for (const b of this.fortBlocks) {
      if (b.destroyed || !ATTACK_TYPES.includes(b.type)) continue;
      const d = this._dist(this.hero, { x: b.cx, y: b.cy });
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private _killEnemy(e: EnemyUnit): void {
    if (e.campId) {
      const camp = this.camps.find(c => c.id === e.campId);
      if (camp) camp.guardIds.delete(e.id);
    }
    this.enemies = this.enemies.filter(u => u.id !== e.id);
  }

  // ── Enemy AI ──────────────────────────────────────────────────────────────

  private _updateEnemies(time: number, delta: number): void {
    const dt = delta / 1000;
    // Iterate over a snapshot — _killEnemy mutates this.enemies
    for (const e of [...this.enemies]) {
      if (e.kind === 'marcher') this._tickMarcher(e, time, dt);
      else                      this._tickGuard(e, time, dt);
    }
    this.enemies = this.enemies.filter(e => e.hp > 0);
  }

  private _tickMarcher(e: EnemyUnit, time: number, dt: number): void {
    const h      = this.hero;
    const heroD  = this._dist(e, h);

    if (heroD < MARCH_ATK_R * 1.8) {
      // Divert to attack hero
      this._moveToward(e, h.x, h.y, dt);
      if (heroD <= e.attackRange && time - e.lastAttackMs >= e.attackCd) {
        e.lastAttackMs = time;
        h.hp -= e.attack;
        h.hitFlashMs = time;
        if (h.hp <= 0) { this._endCombat('defeat'); return; }
      }
    } else {
      // March toward nearest base target (turret or base itself)
      const tgt = this._closestBaseTarget(e);
      this._moveToward(e, tgt.x, tgt.y, dt);
      const tgtD = this._dist(e, tgt);
      if (tgtD <= e.attackRange && time - e.lastAttackMs >= e.attackCd) {
        e.lastAttackMs = time;
        if (tgt.turret) {
          tgt.turret.hp -= e.attack;
          if (tgt.turret.hp <= 0) tgt.turret.destroyed = true;
        } else {
          this.playerBaseHp -= e.attack;
        }
      }
    }
  }

  private _closestBaseTarget(e: EnemyUnit): { x: number; y: number; turret?: Turret } {
    let bestDist = this._dist(e, { x: BASE_X, y: BASE_Y });
    let best: { x: number; y: number; turret?: Turret } = { x: BASE_X, y: BASE_Y };
    for (const t of this.turrets) {
      if (t.destroyed) continue;
      const d = this._dist(e, t);
      if (d < bestDist) { bestDist = d; best = { x: t.x, y: t.y, turret: t }; }
    }
    return best;
  }

  private _tickGuard(e: EnemyUnit, time: number, dt: number): void {
    const h      = this.hero;
    const heroD  = this._dist(e, h);
    const homeD  = this._dist(e, { x: e.originX, y: e.originY });

    if (heroD < GUARD_DETECT) {
      // Chase and attack
      this._moveToward(e, h.x, h.y, dt);
      if (heroD <= e.attackRange && time - e.lastAttackMs >= e.attackCd) {
        e.lastAttackMs = time;
        h.hp -= e.attack;
        h.hitFlashMs = time;
        if (h.hp <= 0) { this._endCombat('defeat'); return; }
      }
    } else if (homeD > GUARD_LEASH) {
      // Leash: return to origin
      this._moveToward(e, e.originX, e.originY, dt);
    }
    // else: idle at post
  }

  private _moveToward(e: EnemyUnit, tx: number, ty: number, dt: number): void {
    const dx = tx - e.x, dy = ty - e.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d < 2) return;
    e.x = Math.max(MARCH_R, Math.min(WORLD_W - MARCH_R, e.x + (dx / d) * e.speed * dt));
    e.y = Math.max(MARCH_R, Math.min(WORLD_H - MARCH_R, e.y + (dy / d) * e.speed * dt));
  }

  // ── Turret AI ─────────────────────────────────────────────────────────────

  private _updateTurrets(time: number): void {
    for (const t of this.turrets) {
      if (t.destroyed || time - t.lastAttackMs < TURRET_CD) continue;
      const target = this._nearestEnemyTo(t, TURRET_RANGE);
      if (!target) continue;
      t.lastAttackMs = time;
      target.hp -= TURRET_ATK;
      target.hitFlashMs = time;
      if (target.hp <= 0) this._killEnemy(target);
    }
  }

  // ── Fort tower AI ─────────────────────────────────────────────────────────

  private _updateFortTowers(time: number): void {
    for (const b of this.fortBlocks) {
      if (b.type !== 'tower' || b.destroyed) continue;
      if (!b.attack || !b.attackRange || !b.attackCd) continue;
      if (time - (b.lastAttackMs ?? 0) < b.attackCd) continue;
      if (this._dist({ x: b.cx, y: b.cy }, this.hero) <= b.attackRange) {
        b.lastAttackMs = time;
        this.hero.hp  -= b.attack;
        this.hero.hitFlashMs = time;
        if (this.hero.hp <= 0) this._endCombat('defeat');
      }
    }
  }

  // ── Waves ─────────────────────────────────────────────────────────────────

  private _spawnWave(initial: boolean): void {
    if (!initial) {
      this.waveNumber++;
      this.waveText.setText('Wave ' + this.waveNumber + ' incoming!').setAlpha(1);
      this.tweens.add({ targets: this.waveText, alpha: 0, delay: 2500, duration: 700 });
    }
    const count = Math.min(8, 3 + Math.floor(this.dangerLevel * 0.5) + (initial ? 0 : this.waveNumber));
    // Spawn from inside the fort (east of wall), march westward through their own gate
    for (let i = 0; i < count; i++) {
      const y = 120 + (i / Math.max(count - 1, 1)) * (WORLD_H - 240);
      this.enemies.push(this._makeEnemy('marcher', WALL_X + 80, y));
    }
  }

  // ── Quest camps ───────────────────────────────────────────────────────────

  private _checkCamps(): void {
    for (const camp of this.camps) {
      if (camp.cleared) continue;
      const allDead = [...camp.guardIds].every(id => !this.enemies.find(e => e.id === id));
      if (allDead) { camp.cleared = true; this.campsCleared++; }
    }
  }

  // ── Win / lose ────────────────────────────────────────────────────────────

  private _checkWinLose(): void {
    if (this.fortBlocks.find(b => b.type === 'core')?.destroyed) {
      this._endCombat('victory');
    } else if (this.playerBaseHp <= 0) {
      this._endCombat('defeat');
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private _render(time: number): void {
    this.gfx.clear();
    this._renderBase();
    this._renderTurrets();
    this._renderFort(time);
    this._renderCamps();
    this._renderEnemies(time);
    this._renderHero(time);
  }

  private _renderBase(): void {
    this._drawHPBar(BASE_X, BASE_Y + 130, this.playerBaseHp, BASE_HP, 120);
  }

  private _renderTurrets(): void {
    for (const t of this.turrets) {
      if (t.destroyed) {
        this.gfx.fillStyle(0x555555, 0.5);
        this.gfx.fillCircle(t.x, t.y, TURRET_R);
        continue;
      }
      this.gfx.fillStyle(0x22aaff, 1);
      this.gfx.fillCircle(t.x, t.y, TURRET_R);
      this.gfx.lineStyle(1, 0x22aaff, 0.15);
      this.gfx.strokeCircle(t.x, t.y, TURRET_RANGE);
      this._drawHPBar(t.x, t.y + TURRET_R + 4, t.hp, t.maxHp, 30);
    }
  }

  private _renderFort(time: number): void {
    for (const b of this.fortBlocks) {
      if (b.destroyed) continue;
      switch (b.type) {
        case 'wall_top':
        case 'wall_bot':
          this.gfx.fillStyle(0x887755, 1);
          this.gfx.fillRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          this.gfx.lineStyle(2, 0xddcc88, 0.5);
          this.gfx.strokeRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          break;

        case 'gate': {
          const ratio = b.hp / b.maxHp;
          const gateColor = ratio > 0.5 ? 0xaa6622 : ratio > 0.25 ? 0xcc7722 : 0xff4411;
          this.gfx.fillStyle(gateColor, 1);
          this.gfx.fillRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          this.gfx.lineStyle(2, 0xffaa44, 0.8);
          this.gfx.strokeRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          this._drawHPBar(b.cx, b.cy + b.hh + 6, b.hp, b.maxHp, 48);
          break;
        }

        case 'tower':
          this.gfx.fillStyle(0x553311, 1);
          this.gfx.fillRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          this.gfx.lineStyle(2, 0xff8844, 0.7);
          this.gfx.strokeRect(b.cx - b.hw, b.cy - b.hh, b.hw * 2, b.hh * 2);
          this._drawHPBar(b.cx, b.cy + b.hh + 5, b.hp, b.maxHp, 40);
          break;

        case 'core': {
          const pulse = 0.65 + 0.35 * Math.sin(time * 0.004);
          this.gfx.fillStyle(0xdd2200, pulse);
          this.gfx.fillCircle(b.cx, b.cy, CORE_R);
          this.gfx.lineStyle(3, 0xff6633, 0.9);
          this.gfx.strokeCircle(b.cx, b.cy, CORE_R);
          this._drawHPBar(b.cx, b.cy + CORE_R + 8, b.hp, b.maxHp, 70);
          break;
        }
      }
    }
  }

  private _renderCamps(): void {
    for (const camp of this.camps) {
      const color = camp.cleared ? 0x44dd44 : 0xddaa22;
      this.gfx.fillStyle(color, 0.12);
      this.gfx.fillCircle(camp.x, camp.y, 44);
      this.gfx.lineStyle(2, color, 0.6);
      this.gfx.strokeCircle(camp.x, camp.y, 44);
    }
  }

  private _renderEnemies(time: number): void {
    for (const e of this.enemies) {
      const flash   = (time - e.hitFlashMs) < 150;
      const base    = e.kind === 'marcher' ? 0xff4444 : 0xff8833;
      this.gfx.fillStyle(flash ? 0xffffff : base, 1);
      this.gfx.fillCircle(e.x, e.y, MARCH_R);
      this._drawHPBar(e.x, e.y + MARCH_R + 3, e.hp, e.maxHp, 26);
    }
  }

  private _renderHero(time: number): void {
    const h     = this.hero;
    const flash = (time - h.hitFlashMs) < 150;
    const color = flash ? 0xffffff : (h.isDashing ? 0xffff44 : 0xffcc22);

    // Attack radius guide (faint)
    this.gfx.lineStyle(1, 0xffcc22, 0.16);
    this.gfx.strokeCircle(h.x, h.y, HERO_ATK_R);

    this.gfx.fillStyle(color, 1);
    this.gfx.fillCircle(h.x, h.y, HERO_R);
    this.gfx.lineStyle(2, 0xffffff, 0.9);
    this.gfx.strokeCircle(h.x, h.y, HERO_R);

    // Facing arrow
    this.gfx.fillStyle(0xffffff, 0.8);
    const dr = h.x < WALL_X ? 1 : -1;
    this.gfx.fillTriangle(
      h.x + dr * HERO_R,        h.y,
      h.x + dr * (HERO_R - 10), h.y - 7,
      h.x + dr * (HERO_R - 10), h.y + 7,
    );

    this._drawHPBar(h.x, h.y + HERO_R + 5, h.hp, h.maxHp, 34);

    // Dash cooldown arc
    if (h.dashCooldown > 0) {
      const frac = h.dashCooldown / DASH_CD;
      this.gfx.lineStyle(3, 0xffff44, 0.55);
      this.gfx.beginPath();
      this.gfx.arc(h.x, h.y, HERO_R + 9, -Math.PI / 2, -Math.PI / 2 + (1 - frac) * Math.PI * 2, false);
      this.gfx.strokePath();
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  private _buildHUD(): void {
    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.55);
    bg.fillRect(0, 0, WORLD_W, 46);

    this.add.text(WORLD_W / 2, 8, 'SIEGE', {
      fontSize: '22px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    this.hudText = this.add.text(WORLD_W / 2, 30, '', {
      fontSize: '13px', color: '#cccccc',
    }).setOrigin(0.5, 0);

    this.waveText = this.add.text(WORLD_W / 2, 60, '', {
      fontSize: '17px', color: '#ff8844', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 0).setAlpha(0);

    this.add.text(BASE_X, BASE_Y - 150, 'YOUR BASE', {
      fontSize: '13px', color: '#88ccff',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 1);

    this.add.text(WALL_X + 20, 20, 'ENEMY STRONGHOLD', {
      fontSize: '13px', color: '#ff8888',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0, 0);

    this.add.text(CORE_X, BASE_Y - CORE_R - 22, 'CORE', {
      fontSize: '13px', color: '#ff4422',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 1);

    for (const cd of CAMP_DATA) {
      this.add.text(cd.x, cd.y - 52, cd.label, {
        fontSize: '12px', color: '#ffcc44',
        stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5, 1);
    }

    this.objectiveText = this.add.text(14, 54, '', {
      fontSize: '12px', color: '#aaffaa',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0, 0);

    const hintBg = this.add.graphics();
    hintBg.fillStyle(0x000000, 0.45);
    hintBg.fillRect(0, WORLD_H - 28, WORLD_W, 28);
    this.add.text(WORLD_W / 2, WORLD_H - 14,
      'WASD / Click: Move   Space: Dash   Attack is automatic   Destroy the CORE to win   ESC: Retreat', {
      fontSize: '12px', color: '#aaaaaa',
    }).setOrigin(0.5, 0.5);
  }

  private _updateHUD(_time: number): void {
    const gate = this.fortBlocks.find(b => b.type === 'gate');
    const core = this.fortBlocks.find(b => b.type === 'core');
    const dashStr  = this.hero.dashCooldown > 0
      ? 'Dash: ' + (this.hero.dashCooldown / 1000).toFixed(1) + 's'
      : 'Dash: Ready';
    const waveNext = Math.max(0, Math.ceil((WAVE_MS - this.waveTimer) / 1000));

    this.hudText.setText(
      'Base: ' + Math.ceil(this.playerBaseHp) + ' HP' +
      '  |  Hero: ' + Math.ceil(this.hero.hp) + ' HP' +
      '  |  ' + dashStr +
      '  |  Gate: ' + (gate?.destroyed ? 'BREACHED' : Math.ceil(gate?.hp ?? 0) + ' HP') +
      '  |  Core: ' + Math.ceil(core?.hp ?? 0) + ' HP' +
      '  |  Next wave: ' + waveNext + 's',
    );

    const campsStr = this.camps.map(c => (c.cleared ? '[✓]' : '[ ]') + ' ' + c.label).join('   ');
    this.objectiveText.setText('Optional: ' + campsStr);
  }

  // ── End combat ────────────────────────────────────────────────────────────

  private _endCombat(outcome: 'victory' | 'defeat' | 'retreat'): void {
    if (this.sceneDone) return;
    this.sceneDone = true;

    const crystals = outcome === 'victory'
      ? 10 + this.dangerLevel * 5 + this.campsCleared * CAMP_BONUS_EACH
      : 0;

    const result: MissionResult = {
      outcome:             outcome === 'victory' ? 'success' : outcome === 'retreat' ? 'retreat' : 'failure',
      resourcesGathered:   outcome === 'victory' ? { acclivity_crystals: crystals } : {},
      heroStatusUpdates:   [],
      objectivesCompleted: this.camps.filter(c => c.cleared).map(c => c.id),
      siteStateChange:     outcome === 'victory' ? 'visited' : null,
    };
    this.gsm.setMissionResult(result);
    this._showResultOverlay(outcome, crystals);
  }

  private _showResultOverlay(outcome: 'victory' | 'defeat' | 'retreat', crystals: number): void {
    const ov = this.add.graphics();
    ov.fillStyle(0x000000, 0.72);
    ov.fillRect(0, 0, WORLD_W, WORLD_H);

    const titles = { victory: 'VICTORY', defeat: 'DEFEAT', retreat: 'RETREATED' } as const;
    const colors = { victory: '#44ff88', defeat: '#ff4444', retreat: '#ffcc44' } as const;

    this.add.text(WORLD_W / 2, WORLD_H / 2 - 70, titles[outcome], {
      fontSize: '64px', fontStyle: 'bold', color: colors[outcome],
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5);

    const msgs = {
      victory: `Stronghold destroyed!  +${crystals} acclivity crystals`,
      defeat:  'Your base was destroyed.',
      retreat: 'Withdrew from the siege.',
    } as const;
    this.add.text(WORLD_W / 2, WORLD_H / 2 + 10, msgs[outcome], {
      fontSize: '22px', color: '#ffffff',
    }).setOrigin(0.5);

    if (outcome === 'victory' && this.campsCleared > 0) {
      this.add.text(WORLD_W / 2, WORLD_H / 2 + 46,
        `Camps cleared: ${this.campsCleared}  (+${this.campsCleared * CAMP_BONUS_EACH} bonus crystals)`, {
        fontSize: '16px', color: '#aaffaa',
      }).setOrigin(0.5);
    }

    this.add.text(WORLD_W / 2, WORLD_H / 2 + 94, 'Click to return to map', {
      fontSize: '18px', color: '#aaaaaa',
    }).setOrigin(0.5);

    this.time.delayedCall(500, () => {
      this.input.once('pointerdown', () => {
        this.scene.start('WorldMapScene', this.services);
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _nearestEnemyTo(pos: { x: number; y: number }, range: number): EnemyUnit | null {
    let best: EnemyUnit | null = null;
    let bestD = range;
    for (const e of this.enemies) {
      const d = this._dist(pos, e);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  private _drawHPBar(cx: number, y: number, hp: number, maxHp: number, w: number): void {
    const r = Math.max(0, hp / maxHp);
    this.gfx.fillStyle(0x111111, 0.7);
    this.gfx.fillRect(cx - w / 2, y, w, 5);
    const c = r > 0.5 ? 0x44dd44 : r > 0.25 ? 0xdddd22 : 0xdd3333;
    this.gfx.fillStyle(c, 1);
    this.gfx.fillRect(cx - w / 2, y, w * r, 5);
  }

  private _dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}
