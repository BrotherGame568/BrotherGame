/**
 * game/entities/Enemy.ts
 * ============================================================
 * Reusable enemy base class + three concrete sizes.
 *
 * Attack types:
 *   'dash'   — telegraphs with an orange arrow, then lunges at the player
 *   'ranged' — telegraphs with a purple expanding ring, then fires a projectile
 *   'none'   — patrol only
 *
 * Projectiles are NOT managed here. When an enemy fires, it sets
 * `pendingProjectile`; the host scene reads and clears it each frame.
 */

import Phaser from 'phaser';

// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

export interface EnemyConfig {
  x: number;
  patrolRange: number;
  tint?: number;
  visual?: EnemyVisualConfig;
}

export interface EnemyVisualConfig {
  displayWidth: number;
  displayHeight: number;
  origin: {
    x: number;
    y: number;
  };
  collisionBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface EnemyStats {
  textureKey: string;
  maxHp:             number;
  moveSpeed:         number;
  spriteW:           number;
  spriteH:           number;
  bodyW:             number;
  bodyH:             number;
  // ── Attack ────────────────────────────────────────────
  attackType:        'dash' | 'ranged' | 'none';
  /** Horizontal distance (px) that triggers the attack sequence. */
  detectionRange:    number;
  /** How long the telegraph lasts (ms) — player's window to dodge. */
  telegraphDuration: number;
  /** How long the attack itself lasts (ms): dash travel time, or brief fire pose. */
  attackDuration:    number;
  /** Rest time before the enemy can attack again (ms). */
  attackCooldown:    number;
  /** Damage dealt (dash contact during lunge; projectile hit). */
  attackDamage:      number;
}

export interface PendingProjectile {
  x: number;
  y: number;
  dirX: 1 | -1;
  damage: number;
}

type AttackState = 'patrol' | 'telegraph' | 'attacking' | 'cooldown';

// ─────────────────────────────────────────────────────────
// Abstract base class
// ─────────────────────────────────────────────────────────
export abstract class Enemy {
  protected readonly scene: Phaser.Scene;
  protected readonly stats: EnemyStats;
  protected sprite!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  protected hpBar!: Phaser.GameObjects.Graphics;
  protected hp: number;
  protected direction: 1 | -1 = 1;
  protected isGrounded = false;

  private readonly patrolLeft: number;
  private readonly patrolRight: number;
  private readonly getGroundY: (worldX: number) => number;
  private readonly visual: EnemyVisualConfig;
  private readonly groundOffsetX: number;
  private readonly groundOffsetY: number;
  private readonly bodyGroundOffsetY: number;

  // Knockback
  private knockbackUntil = 0;
  private knockbackVelX  = 0;

  // Attack state machine
  private attackState: AttackState = 'patrol';
  private attackStateUntil = 0;
  private attackDir: 1 | -1 = 1;
  private telegraphGfx: Phaser.GameObjects.Graphics | null = null;
  private telegraphStartTime = 0;

  /** Set when this enemy fires a ranged shot. The host scene reads and clears it. */
  public pendingProjectile: PendingProjectile | null = null;

  protected abstract _drawSprite(
    gfx: Phaser.GameObjects.Graphics,
    cx: number,
    bottom: number,
  ): void;

  constructor(
    scene: Phaser.Scene,
    config: EnemyConfig,
    getGroundY: (worldX: number) => number,
    stats: EnemyStats,
  ) {
    this.scene = scene;
    this.stats = stats;
    this.getGroundY = getGroundY;
    this.patrolLeft  = config.x - config.patrolRange;
    this.patrolRight = config.x + config.patrolRange;
    this.hp = stats.maxHp;
    this.visual = config.visual ?? {
      displayWidth: stats.spriteW,
      displayHeight: stats.spriteH,
      origin: { x: 0.5, y: 1 },
      collisionBox: {
        x: Math.round((stats.spriteW - stats.bodyW) / 2),
        y: Math.round(stats.spriteH - stats.bodyH),
        width: stats.bodyW,
        height: stats.bodyH,
      },
    };
    this.groundOffsetX = (0.5 - this.visual.origin.x) * this.visual.displayWidth;
    this.groundOffsetY = (1 - this.visual.origin.y) * this.visual.displayHeight;
    this.bodyGroundOffsetY = this.visual.collisionBox.y + this.visual.collisionBox.height - (this.visual.origin.y * this.visual.displayHeight);

    if (!scene.textures.exists(stats.textureKey)) {
      const gfx = scene.add.graphics();
      this._drawSprite(gfx, stats.spriteW / 2, stats.spriteH);
      gfx.generateTexture(stats.textureKey, stats.spriteW, stats.spriteH);
      gfx.destroy();
    }

    const groundY = getGroundY(config.x);
  this.sprite = scene.physics.add.sprite(config.x + this.groundOffsetX, groundY + this.groundOffsetY, stats.textureKey);
    this.sprite.setDisplaySize(this.visual.displayWidth, this.visual.displayHeight);
  this.sprite.setOrigin(0.5, 1);
    this.sprite.setCollideWorldBounds(true);

    if (config.tint !== undefined) {
      this.sprite.setTint(config.tint);
    }

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setSize(this.visual.collisionBox.width, this.visual.collisionBox.height, false);
    body.setOffset(this.visual.collisionBox.x, this.visual.collisionBox.y);
    body.setGravityY(1400);
    body.updateFromGameObject();

    this.hpBar = scene.add.graphics();
  }

  // ── Per-frame update ─────────────────────────────────────────
  update(heroX: number, _heroY: number): void {
    const body    = this.sprite.body as Phaser.Physics.Arcade.Body;
    const groundY = this.getGroundY(this.sprite.x);
    const groundedSpriteY = groundY + this.groundOffsetY;

    // Terrain following
    if (!this.isGrounded && body.velocity.y >= 0 && this.sprite.y >= groundedSpriteY - 1) {
      this.isGrounded = true;
    }
    if (this.isGrounded && (body.velocity.y < -50 || this.sprite.y < groundedSpriteY - 4)) {
      this.isGrounded = false;
    }
    if (this.isGrounded && !body.blocked.down) {
      this.sprite.y = groundedSpriteY;
      body.y = groundY - body.height + this.bodyGroundOffsetY;
      body.prev.y = body.y;
      body.prevFrame.y = body.y;
      body.velocity.y = 0;
    }

    const inKnockback = this.scene.time.now < this.knockbackUntil;
    if (inKnockback) {
      body.setVelocityX(this.knockbackVelX);
      // Interrupt any active telegraph or attack
      if (this.attackState === 'telegraph' || this.attackState === 'attacking') {
        this._clearTelegraph();
        this.attackState     = 'cooldown';
        this.attackStateUntil = this.scene.time.now + this.stats.attackCooldown * 0.5;
      }
    } else {
      this._updateAttackState(heroX);
    }

    this.sprite.setFlipX(this.direction < 0);
    this._drawHpBar();

    if (this.telegraphGfx && this.attackState === 'telegraph') {
      this._drawTelegraph(heroX);
    }
  }

  // ── Attack state machine ──────────────────────────────────────
  private _updateAttackState(heroX: number): void {
    const now  = this.scene.time.now;
    const body = this.sprite.body!;
    const dx   = heroX - this.sprite.x;
    const dist = Math.abs(dx);

    switch (this.attackState) {
      case 'patrol':
        if (this.stats.attackType !== 'none' && dist < this.stats.detectionRange) {
          // Spotted — begin telegraph
          this.attackDir        = dx >= 0 ? 1 : -1;
          this.direction        = this.attackDir;
          this.attackState      = 'telegraph';
          this.attackStateUntil = now + this.stats.telegraphDuration;
          this.telegraphStartTime = now;
          body.setVelocityX(0);
          this._showTelegraph();
        } else {
          if (this.sprite.x <= this.patrolLeft)  this.direction = 1;
          if (this.sprite.x >= this.patrolRight) this.direction = -1;
          body.setVelocityX(this.direction * this.stats.moveSpeed);
        }
        break;

      case 'telegraph':
        body.setVelocityX(0); // hold still while winding up
        if (now >= this.attackStateUntil) {
          this._clearTelegraph();
          this._executeAttack(heroX);
        }
        break;

      case 'attacking':
        if (now >= this.attackStateUntil) {
          body.setVelocityX(0);
          this.attackState      = 'cooldown';
          this.attackStateUntil = now + this.stats.attackCooldown;
        }
        // Dash: velocity set in _executeAttack continues naturally
        break;

      case 'cooldown':
        // Resume patrol during cooldown
        if (this.sprite.x <= this.patrolLeft)  this.direction = 1;
        if (this.sprite.x >= this.patrolRight) this.direction = -1;
        body.setVelocityX(this.direction * this.stats.moveSpeed);
        if (now >= this.attackStateUntil) {
          this.attackState = 'patrol';
        }
        break;
    }
  }

  private _showTelegraph(): void {
    this.telegraphGfx = this.scene.add.graphics();
    this.sprite.setTint(this.stats.attackType === 'dash' ? 0xff7700 : 0xaa44ff);
  }

  private _clearTelegraph(): void {
    this.telegraphGfx?.destroy();
    this.telegraphGfx = null;
    this.sprite.clearTint();
  }

  /** Redrawn every frame while in telegraph state. */
  private _drawTelegraph(heroX: number): void {
    if (!this.telegraphGfx) return;
    const sx      = this.sprite.x;
    const sy      = this.sprite.y - this.stats.bodyH * 0.6;
    const now     = this.scene.time.now;
    const progress = Math.min(1, (now - this.telegraphStartTime) / this.stats.telegraphDuration);

    this.telegraphGfx.clear();

    if (this.stats.attackType === 'dash') {
      // Pulsing "!" above the enemy's head
      const pulse = 0.55 + Math.sin(now * 0.015) * 0.35;
      const hx    = sx;
      const hy    = this.sprite.y - this.stats.bodyH - 18;
      this.telegraphGfx.fillStyle(0xff8800, pulse);
      this.telegraphGfx.fillRect(hx - 3, hy - 14, 6, 10); // stem
      this.telegraphGfx.fillCircle(hx, hy + 1, 3.5);       // dot

      // Growing arrow pointing in attack direction
      const arrowBaseX = sx + this.attackDir * (this.stats.bodyW * 0.5 + 4);
      const arrowTipX  = arrowBaseX + this.attackDir * (10 + progress * 18);
      this.telegraphGfx.fillStyle(0xff8800, pulse);
      this.telegraphGfx.fillTriangle(
        arrowTipX, sy,
        arrowBaseX, sy - 9,
        arrowBaseX, sy + 9,
      );
    } else {
      // Expanding purple ring around enemy
      const maxR   = 55;
      const radius = maxR * progress;
      const alpha  = 0.75 - progress * 0.25;
      this.telegraphGfx.lineStyle(3, 0xcc88ff, alpha);
      this.telegraphGfx.strokeCircle(sx, this.sprite.y - this.stats.bodyH / 2, radius);

      // Aiming dotted line toward hero
      const lineDir = heroX >= sx ? 1 : -1;
      const lineLen = Math.min(this.stats.detectionRange * 0.45, Math.abs(heroX - sx));
      this.telegraphGfx.lineStyle(2, 0xff88ff, alpha * 0.5);
      this.telegraphGfx.beginPath();
      this.telegraphGfx.moveTo(sx, sy);
      this.telegraphGfx.lineTo(sx + lineDir * lineLen, sy);
      this.telegraphGfx.strokePath();
    }
  }

  private _executeAttack(heroX: number): void {
    this.attackState      = 'attacking';
    this.attackStateUntil = this.scene.time.now + this.stats.attackDuration;

    if (this.stats.attackType === 'dash') {
      const dashDir: 1 | -1 = heroX >= this.sprite.x ? 1 : -1;
      this.direction = dashDir;
      this.sprite.body!.setVelocityX(dashDir * 520);
    } else if (this.stats.attackType === 'ranged') {
      const projDir: 1 | -1 = heroX >= this.sprite.x ? 1 : -1;
      this.direction = projDir;
      this.pendingProjectile = {
        x:      this.sprite.x + projDir * (this.stats.spriteW / 2 + 8),
        y:      this.centerY,
        dirX:   projDir,
        damage: this.stats.attackDamage,
      };
    }
  }

  // ── HP bar ───────────────────────────────────────────────────
  private _drawHpBar(): void {
    const sx   = this.sprite.x;
    const sy   = this.sprite.y - this.stats.bodyH - 6;
    const barW = Math.max(this.stats.bodyW, 24);
    const pct  = this.hp / this.stats.maxHp;

    this.hpBar.clear();
    this.hpBar.fillStyle(0x220000, 0.85);
    this.hpBar.fillRect(sx - barW / 2, sy, barW, 4);
    const fillColor = pct > 0.6 ? 0x22ee44 : pct > 0.3 ? 0xffaa00 : 0xff2200;
    this.hpBar.fillStyle(fillColor, 1);
    this.hpBar.fillRect(sx - barW / 2, sy, barW * pct, 4);
  }

  // ── Combat API ───────────────────────────────────────────────
  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
  }

  /** Push the enemy away. dirX: 1 = push right, -1 = push left. */
  knockback(dirX: 1 | -1): void {
    this.knockbackUntil = this.scene.time.now + 200;
    this.knockbackVelX  = dirX * 280;
    this.sprite.body!.setVelocityY(-200);
    this.isGrounded = false;
    this.sprite.setAlpha(0.35);
    this.scene.time.delayedCall(120, () => { this.sprite.setAlpha(1); });
  }

  get isDead(): boolean { return this.hp <= 0; }

  get gameObject(): Phaser.Types.Physics.Arcade.SpriteWithDynamicBody {
    return this.sprite;
  }

  get centerY(): number {
    return this.sprite.y - this.stats.bodyH / 2;
  }

  /** Returns higher damage when mid-dash so the lunge hurts more than a brush. */
  get contactDamage(): number {
    return this.attackState === 'attacking' && this.stats.attackType === 'dash'
      ? this.stats.attackDamage
      : 1;
  }

  destroy(): void {
    this._clearTelegraph();
    this.hpBar.destroy();
    this.sprite.destroy();
  }
}

// ─────────────────────────────────────────────────────────
// Small Enemy — fast scout; dash or ranged variant
// ─────────────────────────────────────────────────────────
export class SmallEnemy extends Enemy {
  constructor(
    scene: Phaser.Scene,
    config: EnemyConfig,
    getGroundY: (worldX: number) => number,
    variant: 'dash' | 'ranged' = 'dash',
  ) {
    const attackStats = variant === 'dash'
      ? { attackType: 'dash'   as const, detectionRange: 220, telegraphDuration: 520, attackDuration: 320, attackCooldown: 2200, attackDamage: 1 }
      : { attackType: 'ranged' as const, detectionRange: 300, telegraphDuration: 420, attackDuration: 100, attackCooldown: 1800, attackDamage: 1 };
    super(scene, config, getGroundY, {
      textureKey: 'enemy_small',
      maxHp: 2, moveSpeed: 90, spriteW: 28, spriteH: 36, bodyW: 18, bodyH: 30,
      ...attackStats,
    });
  }

  protected _drawSprite(gfx: Phaser.GameObjects.Graphics, cx: number, bottom: number): void {
    // Legs
    gfx.fillStyle(0xcc3311, 1);
    gfx.fillRect(cx - 7, bottom - 9, 5, 9);
    gfx.fillRect(cx + 2,  bottom - 9, 5, 9);
    // Body
    gfx.fillStyle(0xff5533, 1);
    gfx.fillRoundedRect(cx - 9, bottom - 27, 18, 20, 3);
    // Head
    gfx.fillStyle(0xee4422, 1);
    gfx.fillCircle(cx, bottom - 30, 9);
    // Eyes
    gfx.fillStyle(0xffff00, 1);
    gfx.fillCircle(cx - 3, bottom - 32, 2);
    gfx.fillCircle(cx + 3, bottom - 32, 2);
    gfx.fillStyle(0x222200, 1);
    gfx.fillCircle(cx - 3, bottom - 32, 1);
    gfx.fillCircle(cx + 3, bottom - 32, 1);
    // Outline
    gfx.lineStyle(1, 0x221100, 0.7);
    gfx.strokeCircle(cx, bottom - 30, 9);
    gfx.strokeRoundedRect(cx - 9, bottom - 27, 18, 20, 3);
  }
}

// ─────────────────────────────────────────────────────────
// Medium Enemy — balanced warrior, dash attack
// ─────────────────────────────────────────────────────────
export class MediumEnemy extends Enemy {
  constructor(
    scene: Phaser.Scene,
    config: EnemyConfig,
    getGroundY: (worldX: number) => number,
  ) {
    super(scene, config, getGroundY, {
      textureKey: 'hound_walk_cycle',
      maxHp:      5,
      moveSpeed:  55,
      spriteW:    42,
      spriteH:    58,
      bodyW:      26,
      bodyH:      50,
      attackType:        'dash',
      detectionRange:    280,
      telegraphDuration: 680,
      attackDuration:    380,
      attackCooldown:    2600,
      attackDamage:      2,
    });

    this.sprite.play('hound_idle');
  }

  protected _drawSprite(gfx: Phaser.GameObjects.Graphics, cx: number, bottom: number): void {
    // Legs
    gfx.fillStyle(0x553388, 1);
    gfx.fillRect(cx - 10, bottom - 16, 8,  16);
    gfx.fillRect(cx + 2,  bottom - 16, 8,  16);
    // Body
    gfx.fillStyle(0x7744bb, 1);
    gfx.fillRoundedRect(cx - 13, bottom - 42, 26, 28, 4);
    // Arms
    gfx.fillRect(cx - 19, bottom - 40, 6, 18);
    gfx.fillRect(cx + 13, bottom - 40, 6, 18);
    // Head
    gfx.fillStyle(0x9966cc, 1);
    gfx.fillRoundedRect(cx - 10, bottom - 58, 20, 18, 5);
    // Eyes
    gfx.fillStyle(0xff4400, 1);
    gfx.fillCircle(cx - 4, bottom - 50, 2.5);
    gfx.fillCircle(cx + 4, bottom - 50, 2.5);
    // Outline
    gfx.lineStyle(1.5, 0x221133, 0.7);
    gfx.strokeRoundedRect(cx - 13, bottom - 42, 26, 28, 4);
    gfx.strokeRoundedRect(cx - 10, bottom - 58, 20, 18, 5);
  }

  override update(heroX: number, heroY: number): void {
    super.update(heroX, heroY);
    const velX = this.sprite.body!.velocity.x;
    if (velX !== 0) {
      this.sprite.play('hound_walk', true);
    } else {
      this.sprite.play('hound_idle', true);
    }
  }
}

// ─────────────────────────────────────────────────────────
// Large Enemy — RootWalker; slow brute, ranged attack
// ─────────────────────────────────────────────────────────
export class LargeEnemy extends Enemy {
  constructor(
    scene: Phaser.Scene,
    config: EnemyConfig,
    getGroundY: (worldX: number) => number,
  ) {
    super(scene, config, getGroundY, {
      // 'rootwalker_walk_cycle' spritesheet must be loaded in the host scene's preload()
      textureKey: 'rootwalker_walk_cycle',
      maxHp:      12,
      moveSpeed:  35,
      spriteW:    150,
      spriteH:    400,
      bodyW:       90,
      bodyH:      110,
      attackType:        'ranged',
      detectionRange:    480,
      telegraphDuration: 950,
      attackDuration:    150,
      attackCooldown:    3200,
      attackDamage:      2,
    });

    // Start on idle immediately
    this.sprite.play('rootwalker_idle');
  }

  /** No-op: the sprite sheet replaces the procedural placeholder. */
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  protected _drawSprite(_gfx: Phaser.GameObjects.Graphics, _cx: number, _bottom: number): void {}

  override update(heroX: number, heroY: number): void {
    super.update(heroX, heroY);
    const velX = this.sprite.body!.velocity.x;
    if (velX !== 0) {
      this.sprite.play('rootwalker_walk', true);
    } else {
      this.sprite.play('rootwalker_idle', true);
    }
  }
}
