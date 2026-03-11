/**
 * AirCombatScene.ts -- Top-down RTS air combat.
 * Owner: Architecture domain
 *
 * Controls:
 *   Left-click / drag  -> select unit / box-select
 *   Right-click        -> move (ground) or attack (enemy unit / base)
 *   A key              -> toggle attack-move mode for next right-click
 *   H key              -> hold position (selected units stand and fight)
 *   S key              -> stop (cancel current order)
 *   ESC                -> retreat
 */

import Phaser from 'phaser';
import type { IGameStateManager } from '@systems/IGameStateManager';
import type { IHeroSystem }        from '@systems/IHeroSystem';
import type { ServiceBundle }      from '../../src/main';
import type { MissionResult }      from '@data/MissionContext';

export const AIR_COMBAT_SCENE_KEY = 'AirCombatScene';

// -- World ------------------------------------------------------------------
const WORLD_W = 1920, WORLD_H = 1080;
const AIR_BACKGROUND_TEXTURE_KEY = 'air_battle_background';
const PLAYER_CITY_TEXTURE_KEY = 'air_player_city';
const PLAYER_BASE_X = 160, ENEMY_BASE_X = WORLD_W - 160;
const BASE_Y = WORLD_H / 2, BASE_W = 80, BASE_H = 130, BASE_HP = 800;

// -- Unit stats -------------------------------------------------------------
const UNIT_RADIUS     = 18;
const ATTACK_RANGE    = 110;
const ATTACK_COOLDOWN = 900;   // ms

const PLAYER_UNIT_HP    = 350;
const PLAYER_UNIT_ATK   = 40;
const PLAYER_UNIT_SPEED = 120;

const ENEMY_UNIT_HP     = 65;
const ENEMY_UNIT_ATK    = 9;
const ENEMY_UNIT_SPEED  = 52;

// -- Waves ------------------------------------------------------------------
const WAVE_INTERVAL_MS = 18000;
const WAVE_BASE_COUNT  = 3;

// -- Box-select drag threshold (px) ----------------------------------------
const DRAG_THRESHOLD = 8;

type UnitState = 'idle' | 'move' | 'hold' | 'attack_move';

interface AirUnit {
  id: string; x: number; y: number;
  hp: number; maxHp: number;
  speed: number; attack: number; attackRange: number;
  owner: 'player' | 'enemy';
  name: string;
  targetX: number; targetY: number;
  attackTarget: string | null;
  lastAttackMs: number;
  selected: boolean;
  state: UnitState;
  hitFlashMs: number;
}

interface CommandEcho { x: number; y: number; startMs: number; }

export class AirCombatScene extends Phaser.Scene {
  private gsm!: IGameStateManager;
  private heroSystem!: IHeroSystem;
  private services!: ServiceBundle;

  private units: AirUnit[] = [];
  private playerBaseHp = BASE_HP;
  private enemyBaseHp  = BASE_HP;
  private combatDone   = false;
  private dangerLevel  = 1;

  private gfx!: Phaser.GameObjects.Graphics;
  private playerBaseSprite: Phaser.GameObjects.Image | null = null;
  private hudText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private unitNameTexts: Map<string, Phaser.GameObjects.Text> = new Map();

  private dragStart: { x: number; y: number } | null = null;
  private isDragging = false;
  private attackMoveMode = false;
  private commandEchos: CommandEcho[] = [];

  private waveTimer  = 0;
  private waveNumber = 0;

  constructor() { super({ key: AIR_COMBAT_SCENE_KEY }); }

  init(data: ServiceBundle & { dangerLevel?: number }): void {
    this.services    = data;
    this.gsm         = data.gsm;
    this.heroSystem  = data.heroSystem;
    this.dangerLevel = data.dangerLevel ?? 1;
  }

  preload(): void {
    if (!this.textures.exists(AIR_BACKGROUND_TEXTURE_KEY)) {
      this.load.image(AIR_BACKGROUND_TEXTURE_KEY, 'backgrounds/battlebackground01.webp');
    }
    if (!this.textures.exists(PLAYER_CITY_TEXTURE_KEY)) {
      this.load.image(PLAYER_CITY_TEXTURE_KEY, 'sprites/battlecity01.webp');
    }
  }

  create(): void {
    this.combatDone    = false;
    this.playerBaseHp  = BASE_HP;
    this.enemyBaseHp   = BASE_HP;
    this.units         = [];
    this.commandEchos  = [];
    this.waveTimer     = 0;
    this.waveNumber    = 0;
    this.attackMoveMode = false;
    this.dragStart     = null;
    this.isDragging    = false;
    this.unitNameTexts.forEach(t => t.destroy());
    this.unitNameTexts.clear();

    this._drawStaticBackground();
    this.playerBaseSprite = this.add.image(PLAYER_BASE_X, BASE_Y + 8, PLAYER_CITY_TEXTURE_KEY)
      .setDisplaySize(440, 240)
      .setDepth(0.0);
    this.gfx = this.add.graphics();
    this._spawnPlayerUnits();
    this._spawnEnemyUnits();
    this._buildStaticHUD();
    this._registerInput();
  }

  // -- Input ----------------------------------------------------------------

  private _registerInput(): void {
    // Disable context menu so right-click works in-game
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (this.combatDone) return;
      if (ptr.rightButtonDown()) {
        this._handleRightClick(ptr.x, ptr.y);
        return;
      }
      if (ptr.leftButtonDown()) {
        this.dragStart  = { x: ptr.x, y: ptr.y };
        this.isDragging = false;
      }
    });

    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (!this.dragStart || !ptr.leftButtonDown()) return;
      const dx = ptr.x - this.dragStart!.x;
      const dy = ptr.y - this.dragStart!.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) this.isDragging = true;
    });

    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      if (this.combatDone) return;
      if ((ptr.event as MouseEvent).button === 0 && this.dragStart) {
        if (this.isDragging) {
          this._doBoxSelect(
            this.dragStart.x, this.dragStart.y, ptr.x, ptr.y,
            (ptr.event as MouseEvent).shiftKey,
          );
        } else {
          this._handleLeftClick(ptr.x, ptr.y, (ptr.event as MouseEvent).shiftKey);
        }
        this.dragStart  = null;
        this.isDragging = false;
      }
    });

    this.input.keyboard!.on('keydown-ESC', () => {
      if (!this.combatDone) this._endCombat('retreat');
    });
    this.input.keyboard!.on('keydown-A', () => {
      if (this.combatDone) return;
      if (this.units.some(u => u.owner === 'player' && u.selected)) {
        this.attackMoveMode = !this.attackMoveMode;
      }
    });
    this.input.keyboard!.on('keydown-H', () => {
      if (this.combatDone) return;
      this.units.filter(u => u.owner === 'player' && u.selected).forEach(u => {
        u.state         = u.state === 'hold' ? 'idle' : 'hold';
        u.attackTarget  = null;
      });
    });
    this.input.keyboard!.on('keydown-S', () => {
      if (this.combatDone) return;
      this.units.filter(u => u.owner === 'player' && u.selected).forEach(u => {
        u.state = 'idle'; u.attackTarget = null;
        u.targetX = u.x; u.targetY = u.y;
      });
    });
  }

  private _handleLeftClick(px: number, py: number, shift: boolean): void {
    const hit = this.units.find(u =>
      u.owner === 'player' && this._dist(u, { x: px, y: py }) < UNIT_RADIUS + 6
    );
    if (hit) {
      if (!shift) this.units.forEach(u => { if (u.owner === 'player') u.selected = false; });
      hit.selected = shift ? !hit.selected : true;
      this.attackMoveMode = false;
    } else if (!shift) {
      this.units.forEach(u => { if (u.owner === 'player') u.selected = false; });
      this.attackMoveMode = false;
    }
  }

  private _doBoxSelect(x1: number, y1: number, x2: number, y2: number, shift: boolean): void {
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
    if (!shift) this.units.forEach(u => { if (u.owner === 'player') u.selected = false; });
    this.units.forEach(u => {
      if (u.owner === 'player' && u.x >= minX && u.x <= maxX && u.y >= minY && u.y <= maxY)
        u.selected = true;
    });
  }

  private _handleRightClick(px: number, py: number): void {
    const sel = this.units.filter(u => u.owner === 'player' && u.selected);
    if (!sel.length) return;

    const hitEnemy = this.units.find(u =>
      u.owner === 'enemy' && this._dist(u, { x: px, y: py }) < UNIT_RADIUS + 10
    );
    if (hitEnemy) {
      sel.forEach(u => { u.attackTarget = hitEnemy.id; u.state = 'attack_move'; });
      this._addEcho(px, py); this.attackMoveMode = false; return;
    }

    if (Math.abs(px - ENEMY_BASE_X) < BASE_W / 2 + 14 && Math.abs(py - BASE_Y) < BASE_H / 2 + 14) {
      sel.forEach(u => { u.attackTarget = 'enemy_base'; u.state = 'attack_move'; });
      this._addEcho(ENEMY_BASE_X, BASE_Y); this.attackMoveMode = false; return;
    }

    const mode: UnitState = this.attackMoveMode ? 'attack_move' : 'move';
    sel.forEach((u, i) => {
      u.targetX = px; u.targetY = py + (i - (sel.length - 1) / 2) * 45;
      u.attackTarget = null; u.state = mode;
    });
    this._addEcho(px, py);
    this.attackMoveMode = false;
  }

  private _addEcho(x: number, y: number): void {
    this.commandEchos.push({ x, y, startMs: this.time.now });
    if (this.commandEchos.length > 12) this.commandEchos.shift();
  }
  // -- Update ---------------------------------------------------------------

  update(time: number, delta: number): void {
    if (this.combatDone) return;
    this.waveTimer += delta;
    if (this.waveTimer >= WAVE_INTERVAL_MS) {
      this.waveTimer -= WAVE_INTERVAL_MS;
      this._spawnEnemyWave();
    }
    this._updateUnits(time, delta);
    this._render(time);
    this._updateHUD();
    this._updateNameLabels();
  }

  // -- Spawning -------------------------------------------------------------

  private _spawnPlayerUnits(): void {
    const heroes = this.gsm.heroRoster.slice(0, 4);
    const count  = Math.max(1, heroes.length);
    for (let i = 0; i < count; i++) {
      const hero = heroes[i];
      const name = hero ? hero.name : ('Unit ' + (i + 1));
      const yOff = (i - (count - 1) / 2) * 80;
      const unit: AirUnit = {
        id: 'player_' + i,
        x: PLAYER_BASE_X + 140, y: BASE_Y + yOff,
        hp: PLAYER_UNIT_HP, maxHp: PLAYER_UNIT_HP,
        speed: PLAYER_UNIT_SPEED, attack: PLAYER_UNIT_ATK, attackRange: ATTACK_RANGE,
        owner: 'player', name,
        targetX: PLAYER_BASE_X + 140, targetY: BASE_Y + yOff,
        attackTarget: null, lastAttackMs: 0, selected: false,
        state: 'idle', hitFlashMs: -9999,
      };
      this.units.push(unit);
      const lbl = this.add.text(unit.x, unit.y - UNIT_RADIUS - 14, name, {
        fontSize: '11px', color: '#88ddff',
        stroke: '#000000', strokeThickness: 2,
      }).setOrigin(0.5, 1);
      this.unitNameTexts.set(unit.id, lbl);
    }
  }

  private _spawnEnemyUnits(): void {
    this._spawnEnemyGroup(Math.min(8, Math.max(2, this.dangerLevel + 1)), 0);
  }

  private _spawnEnemyWave(): void {
    this.waveNumber++;
    const count = Math.min(6, WAVE_BASE_COUNT + Math.floor(this.dangerLevel * 0.5) + this.waveNumber);
    this._spawnEnemyGroup(count, this.waveNumber * 100);
    this.waveText.setText('Wave ' + (this.waveNumber + 1) + ' incoming!').setAlpha(1);
    this.tweens.add({ targets: this.waveText, alpha: 0, delay: 2500, duration: 800 });
  }

  private _spawnEnemyGroup(count: number, idOffset: number): void {
    for (let i = 0; i < count; i++) {
      const yOff = (i - (count - 1) / 2) * 90;
      const hp   = ENEMY_UNIT_HP + this.dangerLevel * 5;
      const unit: AirUnit = {
        id: 'enemy_' + (idOffset + i),
        x: ENEMY_BASE_X - 140, y: BASE_Y + yOff,
        hp, maxHp: hp,
        speed: ENEMY_UNIT_SPEED,
        attack: ENEMY_UNIT_ATK + Math.floor(this.dangerLevel * 0.5),
        attackRange: ATTACK_RANGE,
        owner: 'enemy',
        name: 'Enemy ' + (idOffset + i + 1),
        targetX: PLAYER_BASE_X, targetY: BASE_Y + yOff,
        attackTarget: null, lastAttackMs: 0, selected: false,
        state: 'move', hitFlashMs: -9999,
      };
      this.units.push(unit);
    }
  }

  // -- AI & movement --------------------------------------------------------

  private _updateUnits(time: number, delta: number): void {
    const alive = this.units.filter(u => u.hp > 0);
    for (const unit of alive) {
      if (unit.owner === 'enemy') this._enemyAI(unit, alive);
      else                           this._playerUnitAI(unit, alive);
      this._moveUnit(unit, delta);
      if (unit.attackTarget && time - unit.lastAttackMs >= ATTACK_COOLDOWN)
        this._doAttack(unit, alive, time);
    }
    this.units = this.units.filter(u => u.hp > 0);
    if (this.playerBaseHp <= 0) { this._endCombat('defeat');  return; }
    if (this.enemyBaseHp  <= 0) { this._endCombat('victory'); return; }
  }

  private _enemyAI(unit: AirUnit, alive: AirUnit[]): void {
    const nearest = this._nearestOpponent(unit, alive);
    if (nearest && this._dist(unit, nearest) <= ATTACK_RANGE * 1.8) {
      unit.attackTarget = nearest.id;
      unit.targetX = nearest.x; unit.targetY = nearest.y;
    } else {
      unit.attackTarget = 'player_base';
      unit.targetX = PLAYER_BASE_X; unit.targetY = BASE_Y;
    }
  }

  private _playerUnitAI(unit: AirUnit, alive: AirUnit[]): void {
    if (unit.state === 'hold') {
      if (!unit.attackTarget) {
        const nearest = this._nearestOpponent(unit, alive);
        if (nearest && this._dist(unit, nearest) <= unit.attackRange)
          unit.attackTarget = nearest.id;
      } else {
        const tgt = alive.find(u => u.id === unit.attackTarget);
        if (!tgt) unit.attackTarget = null;
      }
      return;
    }
    if (unit.state === 'attack_move') {
      if (!unit.attackTarget) {
        const nearest = this._nearestOpponent(unit, alive);
        if (nearest && this._dist(unit, nearest) <= unit.attackRange * 1.4)
          unit.attackTarget = nearest.id;
      } else {
        const tgt = alive.find(u => u.id === unit.attackTarget);
        if (!tgt && unit.attackTarget !== 'enemy_base') unit.attackTarget = null;
      }
    }
  }

  private _moveUnit(unit: AirUnit, delta: number): void {
    if (unit.state === 'hold') return;
    const { tx, ty } = this._targetPos(unit);
    const dx = tx - unit.x, dy = ty - unit.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stopDist = unit.attackTarget ? unit.attackRange * 0.85 : 4;
    if (dist > stopDist) {
      const spd = (unit.speed * delta) / 1000;
      unit.x += (dx / dist) * spd;
      unit.y += (dy / dist) * spd;
      unit.y = Math.max(60, Math.min(WORLD_H - 60, unit.y));
    } else if (!unit.attackTarget && unit.state === 'move') {
      unit.state = 'idle';
    }
  }

  private _targetPos(unit: AirUnit): { tx: number; ty: number } {
    if (!unit.attackTarget) return { tx: unit.targetX, ty: unit.targetY };
    if (unit.attackTarget === 'player_base') return { tx: PLAYER_BASE_X, ty: BASE_Y };
    if (unit.attackTarget === 'enemy_base')  return { tx: ENEMY_BASE_X,  ty: BASE_Y };
    const tgt = this.units.find(u => u.id === unit.attackTarget && u.hp > 0);
    if (!tgt) { unit.attackTarget = null; return { tx: unit.targetX, ty: unit.targetY }; }
    return { tx: tgt.x, ty: tgt.y };
  }

  private _nearestOpponent(unit: AirUnit, alive: AirUnit[]): AirUnit | null {
    const opp = alive.filter(u => u.owner !== unit.owner);
    if (!opp.length) return null;
    return opp.reduce((b2, u) => this._dist(unit, u) < this._dist(unit, b2) ? u : b2);
  }

  private _doAttack(unit: AirUnit, alive: AirUnit[], time: number): void {
    unit.lastAttackMs = time;
    if (unit.attackTarget === 'enemy_base') {
      if (this._dist(unit, { x: ENEMY_BASE_X, y: BASE_Y }) <= unit.attackRange) {
        this.enemyBaseHp -= unit.attack; this._flashBase('enemy');
      }
      return;
    }
    if (unit.attackTarget === 'player_base') {
      if (this._dist(unit, { x: PLAYER_BASE_X, y: BASE_Y }) <= unit.attackRange) {
        this.playerBaseHp -= unit.attack; this._flashBase('player');
      }
      return;
    }
    const tgt = alive.find(u => u.id === unit.attackTarget);
    if (tgt && this._dist(unit, tgt) <= unit.attackRange) {
      tgt.hp -= unit.attack; tgt.hitFlashMs = time;
    }
  }

  private _flashBase(side: 'player' | 'enemy'): void {
    const x  = side === 'player' ? PLAYER_BASE_X : ENEMY_BASE_X;
    const fg = this.add.graphics();
    fg.fillStyle(0xff4444, 0.5);
    fg.fillRect(x - BASE_W / 2, BASE_Y - BASE_H / 2, BASE_W, BASE_H);
    this.time.delayedCall(120, () => fg.destroy());
  }

  // -- Rendering -----------------------------------------------------------

  private _render(time: number): void {
    this.gfx.clear();
    if (this.isDragging && this.dragStart) {
      const ptr = this.input.activePointer;
      this._renderBoxRect(this.dragStart.x, this.dragStart.y, ptr.x, ptr.y);
    }
    this._renderEchos(time);
    this._drawPlayerBaseStatus();
    this._drawBase(ENEMY_BASE_X,  BASE_Y, this.enemyBaseHp,  0xff3333);
    for (const unit of this.units) {
      const flashing  = (time - unit.hitFlashMs) < 150;
      const baseColor = unit.owner === 'player'
        ? (unit.selected ? 0x44ffff : 0x44aaff)
        : 0xff4444;
      const color = flashing ? 0xffffff : baseColor;
      if (unit.selected) {
        this.gfx.lineStyle(2, 0xffffff, 0.85);
        this.gfx.strokeCircle(unit.x, unit.y, UNIT_RADIUS + 5);
        this.gfx.lineStyle(1, 0xffffff, 0.12);
        this.gfx.strokeCircle(unit.x, unit.y, unit.attackRange);
      }
      if (unit.state === 'hold') {
        this.gfx.lineStyle(2, 0xffaa22, 0.7);
        this.gfx.strokeCircle(unit.x, unit.y, UNIT_RADIUS + 8);
      }
      this.gfx.fillStyle(color, 1);
      this.gfx.fillCircle(unit.x, unit.y, UNIT_RADIUS);
      const dr = unit.owner === 'player' ? 1 : -1;
      this.gfx.fillStyle(0xffffff, 0.7);
      this.gfx.fillTriangle(
        unit.x + dr * UNIT_RADIUS,        unit.y,
        unit.x + dr * (UNIT_RADIUS - 10), unit.y - 7,
        unit.x + dr * (UNIT_RADIUS - 10), unit.y + 7,
      );
      this._drawHPBar(unit.x, unit.y + UNIT_RADIUS + 4, unit.hp, unit.maxHp, 28);
    }
  }

  private _renderBoxRect(x1: number, y1: number, x2: number, y2: number): void {
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    this.gfx.fillStyle(0x44aaff, 0.08); this.gfx.fillRect(rx, ry, rw, rh);
    this.gfx.lineStyle(1, 0x44aaff, 0.7); this.gfx.strokeRect(rx, ry, rw, rh);
  }

  private _renderEchos(time: number): void {
    const ECHO_DUR = 600;
    this.commandEchos = this.commandEchos.filter(e => (time - e.startMs) < ECHO_DUR);
    for (const e of this.commandEchos) {
      const t = (time - e.startMs) / ECHO_DUR;
      this.gfx.lineStyle(2, 0x44ffaa, (1 - t) * 0.8);
      this.gfx.strokeCircle(e.x, e.y, t * 22);
    }
  }

  private _drawBase(x: number, y: number, hp: number, color: number): void {
    this.gfx.fillStyle(color, 0.85);
    this.gfx.fillRect(x - BASE_W / 2, y - BASE_H / 2, BASE_W, BASE_H);
    this.gfx.lineStyle(2, 0xffffff, 0.5);
    this.gfx.strokeRect(x - BASE_W / 2, y - BASE_H / 2, BASE_W, BASE_H);
    this._drawHPBar(x, y + BASE_H / 2 + 8, hp, BASE_HP, BASE_W);
  }

  private _drawPlayerBaseStatus(): void {
    const barWidth = Math.max(this.playerBaseSprite?.displayWidth ?? BASE_W, BASE_W);
    const barY = this.playerBaseSprite
      ? this.playerBaseSprite.y + this.playerBaseSprite.displayHeight / 2 + 8
      : BASE_Y + BASE_H / 2 + 8;
    this._drawHPBar(PLAYER_BASE_X, barY, this.playerBaseHp, BASE_HP, barWidth);
  }

  private _drawHPBar(cx: number, y: number, hp: number, maxHp: number, w: number): void {
    const r = Math.max(0, hp / maxHp);
    this.gfx.fillStyle(0x111111, 0.7); this.gfx.fillRect(cx - w / 2, y, w, 5);
    const c = r > 0.5 ? 0x44dd44 : r > 0.25 ? 0xdddd22 : 0xdd3333;
    this.gfx.fillStyle(c, 1); this.gfx.fillRect(cx - w / 2, y, w * r, 5);
  }

  // -- HUD -----------------------------------------------------------------

  private _buildStaticHUD(): void {
    const hb = this.add.graphics();
    hb.fillStyle(0x000000, 0.55); hb.fillRect(0, 0, WORLD_W, 44);
    this.add.text(WORLD_W / 2, 8, 'AIR COMBAT', {
      fontSize: '22px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 0);
    this.hudText = this.add.text(WORLD_W / 2, 30, '', {
      fontSize: '13px', color: '#cccccc',
    }).setOrigin(0.5, 0);
    this.waveText = this.add.text(WORLD_W / 2, 58, '', {
      fontSize: '16px', color: '#ff8844', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 0).setAlpha(0);
    this.add.text(PLAYER_BASE_X, BASE_Y - BASE_H / 2 - 22, 'YOUR BASE', {
      fontSize: '13px', color: '#88ccff', stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 1);
    this.add.text(ENEMY_BASE_X, BASE_Y - BASE_H / 2 - 22, 'ENEMY BASE', {
      fontSize: '13px', color: '#ff8888', stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5, 1);
    const hintBg = this.add.graphics();
    hintBg.fillStyle(0x000000, 0.45); hintBg.fillRect(0, WORLD_H - 28, WORLD_W, 28);
    this.add.text(WORLD_W / 2, WORLD_H - 14,
      'L-Click/Drag: Select   R-Click: Move/Attack   A: Attack-Move   H: Hold   S: Stop   ESC: Retreat', {
      fontSize: '12px', color: '#aaaaaa',
    }).setOrigin(0.5, 0.5);
  }

  private _updateHUD(): void {
    const ap = this.units.filter(u => u.owner === 'player').length;
    const ae = this.units.filter(u => u.owner === 'enemy').length;
    const t  = Math.max(0, Math.ceil((WAVE_INTERVAL_MS - this.waveTimer) / 1000));
    const mode = this.attackMoveMode ? '  [ATK-MOVE]' : '';
    this.hudText.setText(
      'Yours: ' + ap + '  Base: ' + Math.ceil(this.playerBaseHp) + ' HP' + mode +
      '  ||  Enemy: ' + ae + '  Base: ' + Math.ceil(this.enemyBaseHp) + ' HP  Next wave: ' + t + 's',
    );
  }

  private _updateNameLabels(): void {
    for (const unit of this.units) {
      const lbl = this.unitNameTexts.get(unit.id);
      if (lbl) lbl.setPosition(unit.x, unit.y - UNIT_RADIUS - 14);
    }
    for (const [id, lbl] of this.unitNameTexts.entries()) {
      if (!this.units.find(u => u.id === id)) { lbl.destroy(); this.unitNameTexts.delete(id); }
    }
  }

  // -- End combat ---------------------------------------------------------

  private _endCombat(outcome: 'victory' | 'defeat' | 'retreat'): void {
    if (this.combatDone) return;
    this.combatDone = true;
    const result: MissionResult = {
      outcome: outcome === 'victory' ? 'success' : outcome === 'retreat' ? 'retreat' : 'failure',
      resourcesGathered: outcome === 'victory' ? { acclivity_crystals: 10 + this.dangerLevel * 5 } : {},
      objectivesCompleted: [],
      heroStatusUpdates: [],
      siteStateChange: outcome === 'victory' ? 'visited' : null,
    };
    this.gsm.setMissionResult(result);
    this._showResultOverlay(outcome);
  }

  private _showResultOverlay(outcome: 'victory' | 'defeat' | 'retreat'): void {
    const ov = this.add.graphics();
    ov.fillStyle(0x000000, 0.7); ov.fillRect(0, 0, WORLD_W, WORLD_H);
    const titles: Record<string, string> = { victory: 'VICTORY', defeat: 'DEFEAT', retreat: 'RETREATED' };
    const clrs:   Record<string, string> = { victory: '#44ff88', defeat: '#ff4444', retreat: '#ffcc44' };
    this.add.text(WORLD_W / 2, WORLD_H / 2 - 60, titles[outcome]!, {
      fontSize: '64px', fontStyle: 'bold', color: clrs[outcome]!,
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5);
    const msgs: Record<string, string> = {
      victory: 'Enemy defeated! Resources gained.',
      defeat:  'Your base was destroyed.',
      retreat: 'Withdrew from combat.',
    };
    this.add.text(WORLD_W / 2, WORLD_H / 2 + 10, msgs[outcome]!, {
      fontSize: '22px', color: '#ffffff',
    }).setOrigin(0.5);
    this.add.text(WORLD_W / 2, WORLD_H / 2 + 70, 'Click to return to map', {
      fontSize: '18px', color: '#aaaaaa',
    }).setOrigin(0.5);
    this.time.delayedCall(400, () => {
      this.input.once('pointerdown', () => { this.scene.start('WorldMapScene', this.services); });
    });
  }

  // -- Background ----------------------------------------------------------

  private _drawStaticBackground(): void {
    this.add.image(WORLD_W / 2, WORLD_H / 2, AIR_BACKGROUND_TEXTURE_KEY)
      .setDisplaySize(WORLD_W, WORLD_H)
      .setDepth(-10);

    const overlay = this.add.graphics().setDepth(-9);
    overlay.fillStyle(0x081018, 0.18);
    overlay.fillRect(0, 0, WORLD_W, WORLD_H);
  }

  // -- Utilities -----------------------------------------------------------

  private _dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private _prng(seed: number): number {
    const x = Math.sin(seed + 1) * 10000;
    return x - Math.floor(x);
  }
}
