/**
 * MissionScene.ts
 * 2D side-view mission: simple terrain, resource pickups, exit zone.
 * Owner: Architecture domain
 *
 * === SCENE OWNERSHIP ===
 * Reads from GSM:  missionContext, heroRoster
 * Writes to GSM:   missionResult
 *
 * === TRANSITIONS ===
 * ← HexZoomScene   (launched after party selection)
 * → HexZoomScene   (scene stops after writing missionResult to GSM)
 *
 * Minimal version: procedural ground/platforms, resource pickups, exit zone.
 * No combat — just walk, jump, collect, and reach the exit.
 */

import Phaser from 'phaser';
import type { IGameStateManager } from '@systems/IGameStateManager';
import type { ISiteEvolutionSystem } from '@systems/ISiteEvolutionSystem';
import type { IHeroSystem } from '@systems/IHeroSystem';
import type { IResourceSystem } from '@systems/IResourceSystem';
import type { IAudioService } from '@services/IAudioService';
import type { MissionContext, MissionResult } from '@data/MissionContext';
import type { ResourceSurface } from '@data/HexTile';
import type { ServiceBundle } from '../../src/main';
import { Enemy, SmallEnemy, MediumEnemy, LargeEnemy, type EnemyVisualConfig, type PendingProjectile } from '../entities/Enemy';
import { type WeaponDef, WEAPONS } from '../entities/Weapon';

export const MISSION_SCENE_KEY = 'MissionScene';

// ── Constants ────────────────────────────────────────────────
const WORLD_W = 3600;
const WORLD_H = 1080;
const GROUND_BASE_Y = 900;    // Baseline ground level (lowest the terrain stays)
const HERO_SPEED = 260;
const JUMP_VELOCITY = -620;
const TERRAIN_COLS = 72;       // Number of terrain columns (WORLD_W / COL_W)
const COL_W = WORLD_W / TERRAIN_COLS;  // Width of each terrain column (50px)

/** Tier → pickup colour. */
const TIER_COLORS: Record<number, number> = { 1: 0x66ff66, 2: 0x6699ff, 3: 0xcc66ff };

interface AssetMetadataRecord {
  exportSize?: {
    width?: number;
    height?: number;
  };
  displaySize?: {
    width?: number;
    height?: number;
  };
  spritesheet?: {
    origin?: {
      x?: number;
      y?: number;
    };
    collisionBox?: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
  };
}

export class MissionScene extends Phaser.Scene {
  private gsm!: IGameStateManager;
  private siteEvolutionSystem!: ISiteEvolutionSystem;
  private heroSystem!: IHeroSystem;
  private resourceSystem!: IResourceSystem;
  private audioService!: IAudioService;
  private services!: ServiceBundle;

  // Game objects
  private hero!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private groundGroup!: Phaser.Physics.Arcade.StaticGroup;
  private platformGroup!: Phaser.Physics.Arcade.StaticGroup;
  private pickupGroup!: Phaser.Physics.Arcade.Group;
  private exitZone!: Phaser.GameObjects.Zone;

  // Mission state
  private context!: MissionContext;
  private resourcesGathered: Record<string, number> = {};
  private missionComplete = false;
  private isGrounded = false;
  private jumpsRemaining = 0;
  private heroNameTag: Phaser.GameObjects.Text | null = null;
  /** Per-column ground heights — terrain heightmap */
  private heightMap: number[] = [];
  private enemies: Enemy[] = [];

  // Combat
  private equippedWeapon!: WeaponDef;
  private attackCooldownUntil = 0;
  private heroFacing: 1 | -1 = 1;
  private swingGfx: Phaser.GameObjects.Graphics | null = null;
  private activeSwing: {
    angle: number; arcHalf: number; startA: number; sweepA: number;
    range: number; damage: number; hx: number; hy: number;
    startTime: number; expiresAt: number; hit: Set<Enemy>;
  } | null = null;
  private wasd!: Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;

  // Hero HP
  private heroHp     = 10;
  private heroMaxHp  = 10;
  private heroInvincibleUntil = 0;
  private heroKnockbackUntil = 0;
  private heroSwingUntil = 0;
  private heroHpDrawn = -1;
  private heroHpGfx!: Phaser.GameObjects.Graphics;

  // Projectiles (spawned by ranged enemies)
  private projectiles: Array<{
    gfx: Phaser.GameObjects.Graphics;
    x: number; y: number;
    velX: number;
    damage: number;
    expiresAt: number;
  }> = [];

  constructor() {
    super({ key: MISSION_SCENE_KEY });
  }

  init(data: ServiceBundle): void {
    this.services = data;
    this.gsm = data.gsm;
    this.siteEvolutionSystem = data.siteEvolution;
    this.heroSystem = data.heroSystem;
    this.resourceSystem = data.resourceSystem;
    this.audioService = data.audioService;
  }

  preload(): void {
    // Runtime asset paths are relative to publicDir (game/assets/).
    this.load.spritesheet('rootwalker_walk_cycle',
      'animations/rootwalker_walk_cycle.webp',
      { frameWidth: 466, frameHeight: 466 },
    );
    this.load.spritesheet('hound_walk_cycle',
      'animations/hound_walk_cycle.webp',
      { frameWidth: 213, frameHeight: 120 },
    );
    this.load.spritesheet('spiderwalkcycle',
      'animations/spiderwalkcycle.webp',
      { frameWidth: 213, frameHeight: 120 },
    );
    this.load.json('rootwalker_walk_cycle_meta', '_meta/rootwalker_walk_cycle.asset.json');
    this.load.json('hound_walk_cycle_meta', '_meta/hound_walk_cycle.asset.json');
    this.load.json('spiderwalkcycle_meta', '_meta/spiderwalkcycle.asset.json');
  }

  create(): void {
    // ── Enemy spritesheet animations ───────────────────────────
    if (!this.anims.exists('rootwalker_walk')) {
      this.anims.create({
        key: 'rootwalker_walk',
        frames: this.anims.generateFrameNumbers('rootwalker_walk_cycle', { start: 0, end: 35 }),
        frameRate: 12,
        repeat: -1,
      });
    }
    if (!this.anims.exists('rootwalker_idle')) {
      this.anims.create({
        key: 'rootwalker_idle',
        frames: [{ key: 'rootwalker_walk_cycle', frame: 0 }],
        frameRate: 1,
        repeat: -1,
      });
    }
    if (!this.anims.exists('hound_walk')) {
      this.anims.create({
        key: 'hound_walk',
        frames: this.anims.generateFrameNumbers('hound_walk_cycle', { start: 0, end: 35 }),
        frameRate: 12,
        repeat: -1,
      });
    }
    if (!this.anims.exists('hound_idle')) {
      this.anims.create({
        key: 'hound_idle',
        frames: [{ key: 'hound_walk_cycle', frame: 0 }],
        frameRate: 1,
        repeat: -1,
      });
    }
    if (!this.anims.exists('spider_walk')) {
      this.anims.create({
        key: 'spider_walk',
        frames: this.anims.generateFrameNumbers('spiderwalkcycle', { start: 0, end: 35 }),
        frameRate: 12,
        repeat: -1,
      });
    }
    if (!this.anims.exists('spider_idle')) {
      this.anims.create({
        key: 'spider_idle',
        frames: [{ key: 'spiderwalkcycle', frame: 0 }],
        frameRate: 1,
        repeat: -1,
      });
    }

    // Reset state
    this.resourcesGathered = {};
    this.missionComplete = false;
    this.isGrounded = false;
    this.enemies = [];
    this.equippedWeapon = WEAPONS.sword;
    this.attackCooldownUntil = 0;
    this.heroFacing = 1;
    this.swingGfx = null;
    this.heroHp = this.heroMaxHp;
    this.heroInvincibleUntil = 0;
    this.projectiles = [];

    const ctx = this.gsm.missionContext;
    if (!ctx) {
      console.error('MissionScene: no missionContext on GSM');
      this.scene.start('WorldMapScene', this.services);
      return;
    }
    this.context = ctx;

    // Physics world bounds
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);

    // ── Generate heightmap first (everything depends on it) ──
    this.heightMap = this._generateHeightMap();
    const biome = this._getBiome();

    // ── Background ────────────────────────────────────────
    this._drawBackground(biome);

    // ── Ground ────────────────────────────────────────────
    this.groundGroup = this.physics.add.staticGroup();
    this.platformGroup = this.physics.add.staticGroup();
    this._buildTerrain(biome);

    // ── Enemies ───────────────────────────────────────────
    this._spawnEnemies();

    // ── Pickups ───────────────────────────────────────────
    this.pickupGroup = this.physics.add.group();
    this._spawnPickups(ctx.resourceSurface);

    // ── Exit zone ─────────────────────────────────────────
    const exitGroundY = this.heightMap[TERRAIN_COLS - 2] ?? GROUND_BASE_Y;
    this.exitZone = this.add.zone(WORLD_W - 60, exitGroundY - 70, 50, 140);
    this.physics.world.enable(this.exitZone, Phaser.Physics.Arcade.STATIC_BODY);

    // Exit marker (tall yellow rectangle)
    const exitMarker = this.add.graphics();
    exitMarker.fillStyle(0xffcc00, 0.5);
    exitMarker.fillRect(WORLD_W - 85, exitGroundY - 140, 50, 140);
    exitMarker.lineStyle(2, 0xffcc00, 1);
    exitMarker.strokeRect(WORLD_W - 85, exitGroundY - 140, 50, 140);
    this.add.text(WORLD_W - 60, exitGroundY - 155, 'EXIT', {
      fontSize: '18px', color: '#ffcc00', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);

    // ── Hero ──────────────────────────────────────────────
    this._createHero();

    // ── Collisions ────────────────────────────────────────
    // Terrain traversal is handled manually in update() via _getGroundYInterp(),
    // so groundGroup needs no collider. platformGroup still uses physics.
    this.physics.add.collider(this.hero, this.platformGroup, undefined, (hero, platform) => {
      const heroBody = (hero as Phaser.Types.Physics.Arcade.SpriteWithDynamicBody).body!;
      const platBody = (platform as Phaser.GameObjects.Zone).body as Phaser.Physics.Arcade.StaticBody;
      // Only collide when hero is moving downward and their feet are above the platform top
      return heroBody.velocity.y >= 0 && heroBody.bottom <= platBody.top + 8;
    }, this);
    this.physics.add.overlap(this.hero, this.pickupGroup, this._onPickup as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback, undefined, this);
    this.physics.add.overlap(this.hero, this.exitZone, this._onReachExit as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback, undefined, this);

    // ── Input ─────────────────────────────────────────────
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys('W,A,S,D') as Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>;
    this.input.keyboard!.on('keydown-ESC', () => {
      if (!this.missionComplete) this._completeMission('retreat');
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!this.missionComplete && pointer.leftButtonDown()) this._performAttack();
    });

    // ── Camera ────────────────────────────────────────────
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.cameras.main.startFollow(this.hero, true, 0.1, 0.1);

    // ── HUD (in-scene, not UIScene) ──────────────────────
    this._createMissionHUD();
  }

  update(): void {
    if (this.missionComplete) return;

    const body = this.hero.body!;

    // ── Smooth terrain following ───────────────────────────────────────────
    // Instead of relying on physics collision with per-column bodies (which
    // creates discrete snaps at every column boundary), we interpolate the
    // heightmap and pin the hero's feet to that smooth surface each frame.
    // Physics collision is only used for floating platforms.
    const terrainY = this._getGroundYInterp(this.hero.x);

    // Detect landing: falling downward and feet have reached terrain level
    const wasGrounded = this.isGrounded;
    if (!this.isGrounded && body.velocity.y >= 0 && this.hero.y >= terrainY) {
      this.isGrounded = true;
      this.jumpsRemaining = 2; // restore both jumps on landing
    }
    if (!wasGrounded && this.isGrounded) { this._spawnLandingDust(); }
    // Go airborne: jumped, or walked off a ledge (feet above terrain)
    if (this.isGrounded && (body.velocity.y < -50 || this.hero.y < terrainY - 4)) {
      this.isGrounded = false;
    }
    // While grounded on terrain, pin feet to the interpolated surface.
    // We avoid body.reset() because it calls stop() which zeros ALL velocity
    // (including X), preventing horizontal movement. Direct body.y assignment
    // corrects only the vertical position and leaves velocity.x intact.
    if (this.isGrounded && !body.blocked.down) {
      body.y = terrainY - body.height; // feet = body.bottom = terrainY
      body.prev.y = body.y;            // tell Phaser this isn't a teleport
      body.velocity.y = 0;
    }

    const onGround = body.blocked.down || this.isGrounded;
    // Restore jumps when landing on a platform too
    if (body.blocked.down && this.jumpsRemaining < 2) {
      this.jumpsRemaining = 2;
    }

    // ── Horizontal movement (arrows or WASD) ──────────────────────────────
    if (this.time.now < this.heroKnockbackUntil || this.time.now < this.heroSwingUntil) {
      // Let physics/friction carry the knockback velocity — don't overwrite it
    } else {
      const movingLeft  = this.cursors.left.isDown  || this.wasd.A.isDown;
      const movingRight = this.cursors.right.isDown || this.wasd.D.isDown;
      if (movingLeft) {
        body.setVelocityX(-HERO_SPEED);
      } else if (movingRight) {
        body.setVelocityX(HERO_SPEED);
      } else {
        body.setVelocityX(0);
      }
    }
    const ptr = this.input.activePointer;
    this.heroFacing = ptr.worldX >= this.hero.x ? 1 : -1;
    this.hero.setFlipX(this.heroFacing < 0);

    // ── Jump (double jump supported — Up, Space, or W) ────────────────────
    const jumpPressed = Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
                        Phaser.Input.Keyboard.JustDown(this.cursors.space!) ||
                        Phaser.Input.Keyboard.JustDown(this.wasd.W);
    if (jumpPressed && (onGround || this.jumpsRemaining > 0)) {
      body.setVelocityY(JUMP_VELOCITY);
      this.isGrounded = false;
      this.jumpsRemaining = Math.max(0, this.jumpsRemaining - 1);
    }

    // Update name tag position to follow the hero
    if (this.heroNameTag) {
      this.heroNameTag.setPosition(this.hero.x, this.hero.y - 110);
    }

    // Update enemies + contact damage
    const now   = this.time.now;
    const heroX = this.hero.x;
    const heroY = this.hero.body!.y + this.hero.body!.height / 2;

    // Keep swing arc following the hero and advance the sweep
    if (this.activeSwing) {
      if (now > this.activeSwing.expiresAt) {
        this.swingGfx?.destroy();
        this.swingGfx  = null;
        this.activeSwing = null;
      } else {
        const sw = this.activeSwing;
        sw.hx = this.hero.x + this.heroFacing * this.hero.body!.width * 0.3;
        sw.hy = this.hero.y - this.hero.body!.height * 0.7;
        const t = Math.min(1, (now - sw.startTime) / (sw.expiresAt - sw.startTime));
        sw.sweepA = sw.startA + 2 * sw.arcHalf * t;
        this._redrawSwingGfx(sw.hx, sw.hy, sw.startA, sw.sweepA, t);
      }
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      enemy.update(heroX, heroY);

      // Spawn any projectile the enemy fired this frame
      if (enemy.pendingProjectile) {
        this._spawnProjectile(enemy.pendingProjectile);
        enemy.pendingProjectile = null;
      }

      if (enemy.isDead) {
        enemy.destroy();
        this.enemies.splice(i, 1);
        continue;
      }

      // Per-enemy swing hit detection (must run before contact damage)
      let hitBySwingThisFrame = false;
      if (this.activeSwing) {
        const sw = this.activeSwing;
        if (!sw.hit.has(enemy)) {
            const dx = enemy.gameObject.x - sw.hx;
            const dy = enemy.centerY    - sw.hy;
            if (Math.sqrt(dx * dx + dy * dy) <= sw.range + 20) {
              // Normalize enemy angle into [startA, startA + 2π) then check sweep
              let enemyA = Math.atan2(dy, dx);
              while (enemyA < sw.startA) enemyA += 2 * Math.PI;
              while (enemyA >= sw.startA + 2 * Math.PI) enemyA -= 2 * Math.PI;
              if (enemyA <= sw.sweepA) {
                const wasAlive = !enemy.isDead;
                enemy.takeDamage(sw.damage);
                enemy.knockback(this.heroFacing);
                sw.hit.add(enemy);
                hitBySwingThisFrame = true;
                // Brief invincibility window on hit so the player can't take
                // simultaneous contact damage — rewards good timing
                this.heroInvincibleUntil = Math.max(
                  this.heroInvincibleUntil, now + 200,
                );
                // Killing blow gets a bigger shake; regular hit gets a small one
                if (wasAlive && enemy.isDead) {
                  this.cameras.main.shake(130, 0.009);
                } else {
                  this.cameras.main.shake(60, 0.004);
                }
                // Aerial bounce — hitting an enemy while airborne pops you back up
                if (!this.isGrounded) {
                  this.hero.body!.setVelocityY(-600);
                  this.jumpsRemaining = Math.min(this.jumpsRemaining + 1, 2);
                }
              }
            }
          }
        }
      // AABB contact damage — skipped if this enemy was just interrupted by a swing
      if (!hitBySwingThisFrame && now >= this.heroInvincibleUntil) {
        const hb = this.hero.body!;
        const eb = enemy.gameObject.body as Phaser.Physics.Arcade.Body;
        if (hb.x < eb.x + eb.width  && hb.x + hb.width  > eb.x &&
            hb.y < eb.y + eb.height && hb.y + hb.height > eb.y) {
          this.heroHp = Math.max(0, this.heroHp - enemy.contactDamage);
          this.heroInvincibleUntil = now + 800;
          const pushDir = this.hero.x < enemy.gameObject.x ? -1 : 1;
          this.hero.body!.setVelocityX(pushDir * 420);
          this.hero.body!.setVelocityY(-320);
          this.heroKnockbackUntil = now + 350;
          this.isGrounded = false;
          this.cameras.main.shake(80, 0.006);
          this._flashHeroTint();
          if (this.heroHp <= 0) { this._completeMission('failure'); return; }
        }
      }
    }

    // Update projectiles
    const dt = this.game.loop.delta / 1000;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]!;
      p.x += p.velX * dt;

      if (now >= p.expiresAt || p.x < 0 || p.x > WORLD_W) {
        p.gfx.destroy();
        this.projectiles.splice(i, 1);
        continue;
      }

      // Redraw as a glowing orb
      p.gfx.clear();
      p.gfx.fillStyle(0xff4400, 0.35);
      p.gfx.fillCircle(p.x, p.y, 13);
      p.gfx.fillStyle(0xff7733, 1);
      p.gfx.fillCircle(p.x, p.y, 7);
      p.gfx.fillStyle(0xffdd88, 0.9);
      p.gfx.fillCircle(p.x, p.y, 3);

      // Hero collision
      if (now >= this.heroInvincibleUntil) {
        const hb = this.hero.body!;
        if (p.x > hb.x && p.x < hb.x + hb.width &&
            p.y > hb.y && p.y < hb.y + hb.height) {
          this.heroHp = Math.max(0, this.heroHp - p.damage);
          this.heroInvincibleUntil = now + 600;
          this._flashHeroTint();
          p.gfx.destroy();
          this.projectiles.splice(i, 1);
          if (this.heroHp <= 0) { this._completeMission('failure'); return; }
        }
      }
    }

    // Update HUD
    this._updateMissionHUD();
  }

  // ── Biome & background ──────────────────────────────────

  private _getBiome(): { sky: number; ground: number; groundEdge: number; groundDark: number; platFill: number; platEdge: number; name: string } {
    switch (this.context.siteType) {
      case 'town':    return { sky: 0x334466, ground: 0x556644, groundEdge: 0x77aa55, groundDark: 0x445533, platFill: 0x887744, platEdge: 0xaa9966, name: 'town' };
      case 'village': return { sky: 0x445566, ground: 0x447744, groundEdge: 0x66bb66, groundDark: 0x336633, platFill: 0x775533, platEdge: 0x997755, name: 'village' };
      case 'ruin':    return { sky: 0x222233, ground: 0x554433, groundEdge: 0x886644, groundDark: 0x443322, platFill: 0x665544, platEdge: 0x887766, name: 'ruin' };
      case 'deposit': return { sky: 0x332233, ground: 0x555544, groundEdge: 0xaaaa55, groundDark: 0x444433, platFill: 0x888855, platEdge: 0xbbbb77, name: 'deposit' };
      case 'skydock': return { sky: 0x223355, ground: 0x445577, groundEdge: 0x6688aa, groundDark: 0x334466, platFill: 0x556688, platEdge: 0x7799bb, name: 'skydock' };
      default:        return { sky: 0x1a2a1a, ground: 0x336633, groundEdge: 0x44aa44, groundDark: 0x224422, platFill: 0x664422, platEdge: 0x886644, name: 'wild' };
    }
  }

  private _drawBackground(biome: ReturnType<typeof this._getBiome>): void {
    // Base sky fill
    this.add.graphics()
      .fillStyle(biome.sky, 1)
      .fillRect(0, 0, WORLD_W, WORLD_H);

    // Parallax cloud/haze layers
    const haze = this.add.graphics();
    haze.fillStyle(0xffffff, 0.03);
    for (let i = 0; i < 8; i++) {
      const cx = this._pseudoRandom(i * 37 + 5) * WORLD_W;
      const cy = 80 + this._pseudoRandom(i * 13 + 7) * 200;
      const rx = 120 + this._pseudoRandom(i * 53) * 200;
      const ry = 20 + this._pseudoRandom(i * 29) * 30;
      haze.fillEllipse(cx, cy, rx * 2, ry * 2);
    }

    // Distant hills (back layer — subtle)
    const backHills = this.add.graphics();
    backHills.fillStyle(biome.ground, 0.2);
    backHills.beginPath();
    backHills.moveTo(0, WORLD_H);
    for (let x = 0; x <= WORLD_W; x += 60) {
      const hillY = GROUND_BASE_Y - 200
        + Math.sin(x * 0.002 + 1.5) * 60
        + Math.sin(x * 0.005 + 3.0) * 30;
      backHills.lineTo(x, hillY);
    }
    backHills.lineTo(WORLD_W, WORLD_H);
    backHills.closePath();
    backHills.fillPath();
  }

  // ── Terrain generation ─────────────────────────────────

  /** Generates a per-column heightmap using layered sine waves, seeded by missionId. */
  private _generateHeightMap(): number[] {
    const heights: number[] = [];
    const seed = this._hashString(this.context.missionId);
    const danger = this.context.dangerLevel;

    // Amplitude scales with danger (more extreme terrain at higher danger)
    const amp1 = 40 + danger * 12;   // primary rolling hills
    const amp2 = 20 + danger * 6;    // medium frequency bumps
    const amp3 = 8 + danger * 3;     // fine noise

    // Frequency offsets (seeded)
    const off1 = (seed % 100) * 0.1;
    const off2 = ((seed >> 4) % 100) * 0.1;
    const off3 = ((seed >> 8) % 100) * 0.1;

    for (let col = 0; col < TERRAIN_COLS; col++) {
      const t = col / TERRAIN_COLS;

      // Layered sinusoidal landscape
      let h = GROUND_BASE_Y
        - Math.sin(t * Math.PI * 2.0 + off1) * amp1
        - Math.sin(t * Math.PI * 5.0 + off2) * amp2
        - Math.sin(t * Math.PI * 11.0 + off3) * amp3;

      // Flatten the edges so the hero can walk on/off easily
      const edgeFade = Math.min(col, TERRAIN_COLS - 1 - col, 5) / 5;
      h = GROUND_BASE_Y + (h - GROUND_BASE_Y) * edgeFade;

      // Clamp to reasonable range
      h = Math.max(GROUND_BASE_Y - 260, Math.min(GROUND_BASE_Y + 20, h));

      heights.push(Math.round(h));
    }

    // Smooth the heightmap with several passes of a weighted moving average.
    // This reduces abrupt height differences between adjacent columns so the
    // hero can traverse gradual slopes without getting blocked.
    for (let pass = 0; pass < 8; pass++) {
      for (let col = 1; col < TERRAIN_COLS - 1; col++) {
        heights[col] = Math.round(
          (heights[col - 1]! + heights[col]! * 2 + heights[col + 1]!) / 4,
        );
      }
    }

    return heights;
  }

  private _buildTerrain(biome: ReturnType<typeof this._getBiome>): void {
    const gfx = this.add.graphics();

    // Draw the filled terrain polygon
    gfx.fillStyle(biome.ground, 1);
    gfx.beginPath();
    gfx.moveTo(0, WORLD_H);

    for (let col = 0; col < TERRAIN_COLS; col++) {
      const x = col * COL_W;
      const y = this.heightMap[col]!;
      gfx.lineTo(x, y);
    }
    gfx.lineTo(WORLD_W, this.heightMap[TERRAIN_COLS - 1]!);
    gfx.lineTo(WORLD_W, WORLD_H);
    gfx.closePath();
    gfx.fillPath();

    // Draw a darker sub-surface layer for visual depth
    gfx.fillStyle(biome.groundDark, 1);
    gfx.beginPath();
    gfx.moveTo(0, WORLD_H);
    for (let col = 0; col < TERRAIN_COLS; col++) {
      gfx.lineTo(col * COL_W, this.heightMap[col]! + 30);
    }
    gfx.lineTo(WORLD_W, this.heightMap[TERRAIN_COLS - 1]! + 30);
    gfx.lineTo(WORLD_W, WORLD_H);
    gfx.closePath();
    gfx.fillPath();

    // Top edge line (grass/surface edge)
    gfx.lineStyle(3, biome.groundEdge, 1);
    gfx.beginPath();
    gfx.moveTo(0, this.heightMap[0]!);
    for (let col = 1; col < TERRAIN_COLS; col++) {
      gfx.lineTo(col * COL_W, this.heightMap[col]!);
    }
    gfx.strokePath();

    // Physics bodies: full-height rectangles from the surface down to the world
    // floor so the hero can't fall through even at high fall speeds.
    for (let col = 0; col < TERRAIN_COLS; col++) {
      const x = col * COL_W + COL_W / 2;
      const y = this.heightMap[col]!;
      const h = WORLD_H - y;
      const body = this.add.zone(x, y + h / 2, COL_W + 2, h);
      this.groundGroup.add(body);
    }

    // Surface detail: tiny grass tufts / rubble marks along the top
    const detailGfx = this.add.graphics();
    detailGfx.lineStyle(1, biome.groundEdge, 0.5);
    for (let col = 1; col < TERRAIN_COLS - 1; col++) {
      if (this._pseudoRandom(col * 17 + 11) > 0.5) continue;
      const bx = col * COL_W + this._pseudoRandom(col * 7) * COL_W;
      const by = this.heightMap[col]!;
      const tuftH = 4 + this._pseudoRandom(col * 31) * 8;
      detailGfx.lineBetween(bx, by, bx - 3, by - tuftH);
      detailGfx.lineBetween(bx, by, bx + 3, by - tuftH);
    }

    // Floating platforms (number scales with danger level)
    const platformCount = Math.min(8, Math.max(2, this.context.dangerLevel + 1));
    const platformSpacing = (WORLD_W - 600) / (platformCount + 1);

    for (let i = 0; i < platformCount; i++) {
      const col = Math.floor(3 + (i + 1) * (TERRAIN_COLS - 6) / (platformCount + 1));
      const surfaceY = this.heightMap[Math.min(col, TERRAIN_COLS - 1)]!;
      const px = 300 + (i + 1) * platformSpacing + (this._pseudoRandom(i) * 40 - 20);
      const py = surfaceY - 100 - (this._pseudoRandom(i + 100) * 80);
      const pw = 90 + this._pseudoRandom(i + 200) * 70;

      // Platform visuals
      const platGfx = this.add.graphics();
      platGfx.fillStyle(biome.platFill, 1);
      platGfx.fillRoundedRect(px - pw / 2, py, pw, 18, 4);
      platGfx.lineStyle(2, biome.platEdge, 1);
      platGfx.strokeRoundedRect(px - pw / 2, py, pw, 18, 4);

      // Subtle underside shadow
      platGfx.fillStyle(0x000000, 0.15);
      platGfx.fillRect(px - pw / 2 + 4, py + 18, pw - 8, 6);

      const platBody = this.add.zone(px, py + 9, pw, 18);
      this.platformGroup.add(platBody);
    }
  }

  // ── Enemy spawning ─────────────────────────────────────

  private _spawnEnemies(): void {
    const danger = this.context.dangerLevel;
    const gt = this._getGroundYInterp.bind(this);
    const largeEnemyVisual  = this._getEnemyVisualConfig('rootwalker_walk_cycle_meta');
    const mediumEnemyVisual = this._getEnemyVisualConfig('hound_walk_cycle_meta');
    const smallEnemyVisual  = this._getEnemyVisualConfig('spiderwalkcycle_meta');

    // Scale counts with danger level (1–5)
    const smallCount  = Math.min(danger + 1, 5);
    const mediumCount = Math.max(0, danger - 1);
    const largeCount  = Math.max(0, danger - 3);
    const total = smallCount + mediumCount + largeCount;
    if (total === 0) return;

    const spacing = (WORLD_W - 400) / (total + 1);
    let slot = 0;

    const place = (
      EnemyType: new (s: Phaser.Scene, c: { x: number; patrolRange: number; visual?: EnemyVisualConfig }, g: (x: number) => number) => Enemy,
      visual?: EnemyVisualConfig,
    ) => {
      const x = 200 + (slot + 1) * spacing + (this._pseudoRandom(slot * 13 + 7) - 0.5) * 80;
      const patrolRange = 80 + this._pseudoRandom(slot * 31) * 80;
      this.enemies.push(new EnemyType(this, { x, patrolRange, visual }, gt));
      slot++;
    };

    for (let i = 0; i < smallCount;  i++) place(SmallEnemy, smallEnemyVisual);
    for (let i = 0; i < mediumCount; i++) place(MediumEnemy, mediumEnemyVisual);
    for (let i = 0; i < largeCount;  i++) place(LargeEnemy, largeEnemyVisual);
  }

  private _getEnemyVisualConfig(cacheKey: string): EnemyVisualConfig | undefined {
    const metadata = this.cache.json.get(cacheKey) as AssetMetadataRecord | undefined;
    const exportWidth  = metadata?.exportSize?.width;
    const exportHeight = metadata?.exportSize?.height;
    const displayWidth = metadata?.displaySize?.width;
    const displayHeight = metadata?.displaySize?.height;
    const originX = metadata?.spritesheet?.origin?.x;
    const originY = metadata?.spritesheet?.origin?.y;
    const collisionBox = metadata?.spritesheet?.collisionBox;

    if (
      !displayWidth
      || !displayHeight
      || originX === undefined
      || originY === undefined
      || !collisionBox
      || collisionBox.x === undefined
      || collisionBox.y === undefined
      || collisionBox.width === undefined
      || collisionBox.height === undefined
    ) {
      return undefined;
    }

    // Scale collision box from frame-pixel space to display-pixel space.
    // If exportSize is missing, assume the box was already authored in display space.
    const scaleX = (exportWidth  && displayWidth)  ? displayWidth  / exportWidth  : 1;
    const scaleY = (exportHeight && displayHeight) ? displayHeight / exportHeight : 1;

    return {
      displayWidth,
      displayHeight,
      origin: {
        x: originX,
        y: originY,
      },
      collisionBox: {
        x:      Math.round(collisionBox.x      * scaleX),
        y:      Math.round(collisionBox.y      * scaleY),
        width:  Math.round(collisionBox.width  * scaleX),
        height: Math.round(collisionBox.height * scaleY),
      },
    };
  }

  // ── Combat ─────────────────────────────────────────────

  private _performAttack(): void {
    const now = this.time.now;
    if (now < this.attackCooldownUntil) return;
    this.attackCooldownUntil = now + this.equippedWeapon.cooldown;

    const weapon = this.equippedWeapon;
    // Origin at the hero's hand — offset toward facing side, at shoulder height.
    // Expressed as fractions of body dimensions so it scales with any sprite.
    const hx = this.hero.x + this.heroFacing * this.hero.body!.width * 0.3;
    const hy = this.hero.y - this.hero.body!.height * 0.7;

    const ptr = this.input.activePointer;
    const swingAngle = Math.atan2(ptr.worldY - hy, ptr.worldX - hx);
    const arcHalf = (weapon.arcDeg * Math.PI) / 180;

    const startA = swingAngle - arcHalf;
    this.heroSwingUntil = now + weapon.swingDuration;
    this.activeSwing = {
      angle: swingAngle, arcHalf, startA, sweepA: startA,
      range: weapon.range, damage: weapon.damage, hx, hy,
      startTime: now, expiresAt: now + weapon.swingDuration,
      hit: new Set(),
    };

    this._showSwingGfx();
  }

  private _spawnProjectile(data: PendingProjectile): void {
    this.projectiles.push({
      gfx:       this.add.graphics(),
      x:         data.x,
      y:         data.y,
      velX:      data.dirX * 340,
      damage:    data.damage,
      expiresAt: this.time.now + 3000,
    });
  }

  // Tween target object used by _flashHeroTint so we can cancel mid-flash
  private readonly _heroTintProgress = { v: 51 };

  /** Flash the hero red then smoothly fade back to normal. */
  private _flashHeroTint(): void {
    this.tweens.killTweensOf(this._heroTintProgress);
    this._heroTintProgress.v = 51;
    this.hero.setTint(0xff3333);
    this.tweens.add({
      targets: this._heroTintProgress,
      v: 255,
      duration: 380,
      ease: 'Linear',
      onUpdate: () => {
        const v = Math.round(this._heroTintProgress.v);
        this.hero.setTint(Phaser.Display.Color.GetColor(255, v, v));
      },
      onComplete: () => { this.hero.clearTint(); },
    });
  }

  private _spawnLandingDust(): void {
    const x = this.hero.x;
    const y = this.hero.y; // origin is (0.5, 1) so hero.y = feet
    const dust = this.add.graphics();
    dust.fillStyle(0xbbbbbb, 0.45);
    dust.fillCircle(-10, 0, 7);
    dust.fillCircle(10, 0, 7);
    dust.fillCircle(0, 0, 10);
    dust.setPosition(x, y);
    this.tweens.add({
      targets: dust,
      alpha: 0,
      scaleX: 2.8,
      scaleY: 0.2,
      duration: 220,
      ease: 'Cubic.Out',
      onComplete: () => { dust.destroy(); },
    });
  }

  private _showSwingGfx(): void {
    this.swingGfx?.destroy();
    this.swingGfx = this.add.graphics();
  }

  private _redrawSwingGfx(hx: number, hy: number, startA: number, sweepA: number, t: number): void {
    if (!this.swingGfx) return;
    const weapon = this.equippedWeapon;
    const totalArc = sweepA - startA;
    this.swingGfx.clear();

    // Fading swept fill — pizza-slice shape that dissolves as the swing progresses
    this.swingGfx.fillStyle(weapon.color, 0.28 * (1 - t));
    this.swingGfx.beginPath();
    this.swingGfx.moveTo(hx, hy);
    this.swingGfx.arc(hx, hy, weapon.range, startA, sweepA);
    this.swingGfx.closePath();
    this.swingGfx.fillPath();

    // Layered whoosh streaks — ghost blade positions trailing behind the current angle.
    const streaks = [
      { offset: 0.20, lengthFrac: 0.88, alpha: 0.28 },
      { offset: 0.38, lengthFrac: 0.72, alpha: 0.16 },
      { offset: 0.55, lengthFrac: 0.55, alpha: 0.08 },
    ];
    for (const s of streaks) {
      const ghostA = sweepA - totalArc * s.offset;
      if (ghostA < startA) continue;
      const len = weapon.range * s.lengthFrac;
      this.swingGfx.lineStyle(3, weapon.color, s.alpha * (1 - t * 0.5));
      this.swingGfx.beginPath();
      this.swingGfx.moveTo(hx, hy);
      this.swingGfx.lineTo(hx + Math.cos(ghostA) * len, hy + Math.sin(ghostA) * len);
      this.swingGfx.strokePath();
    }

    // Blade — bright leading line, tapers in alpha as swing ends
    this.swingGfx.lineStyle(4, weapon.color, 0.92 * (1 - t * 0.25));
    this.swingGfx.beginPath();
    this.swingGfx.moveTo(hx, hy);
    this.swingGfx.lineTo(
      hx + Math.cos(sweepA) * weapon.range,
      hy + Math.sin(sweepA) * weapon.range,
    );
    this.swingGfx.strokePath();

    // White tip glint that fades quickly
    this.swingGfx.fillStyle(0xffffff, 0.75 * (1 - t));
    this.swingGfx.fillCircle(
      hx + Math.cos(sweepA) * weapon.range,
      hy + Math.sin(sweepA) * weapon.range,
      3,
    );
  }

  /** Simple deterministic pseudo-random from a seed number (0..1). */
  private _pseudoRandom(seed: number): number {
    return ((Math.sin(seed * 12.9898 + 78.233) * 43758.5453) % 1 + 1) % 1;
  }

  /** Simple string hash to get a stable numeric seed. */
  private _hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /** Look up terrain height at a given world X coordinate. */
  private _getGroundY(worldX: number): number {
    const col = Math.floor(worldX / COL_W);
    const clampedCol = Math.max(0, Math.min(TERRAIN_COLS - 1, col));
    return this.heightMap[clampedCol]!;
  }

  /** Linearly interpolates terrain height between adjacent columns.
   *  Returns a smooth, continuous Y value as worldX changes — no step snapping. */
  private _getGroundYInterp(worldX: number): number {
    const exactCol = worldX / COL_W;
    const col = Math.floor(exactCol);
    const frac = exactCol - col;
    const y0 = this.heightMap[Math.max(0, Math.min(TERRAIN_COLS - 1, col))]!;
    const y1 = this.heightMap[Math.max(0, Math.min(TERRAIN_COLS - 1, col + 1))]!;
    return y0 + (y1 - y0) * frac;
  }

  // ── Pickups ────────────────────────────────────────────

  private _spawnPickups(surfaces: ResourceSurface[]): void {
    let pickupIndex = 0;
    for (const surface of surfaces) {
      const count = surface.baseYield;
      for (let i = 0; i < count; i++) {
        const x = 180 + this._pseudoRandom(pickupIndex * 7 + 3) * (WORLD_W - 400);
        const y = this._getGroundY(x) - 30;
        const tier = surface.tier;
        const color = TIER_COLORS[tier] ?? 0xffffff;

        // Draw pickup as a circle
        const gfx = this.add.graphics();
        gfx.fillStyle(color, 1);
        gfx.fillCircle(0, 0, 15);
        gfx.lineStyle(1, 0xffffff, 0.5);
        gfx.strokeCircle(0, 0, 15);
        gfx.setPosition(x, y);

        // Tier label
        const tierLabel = this.add.text(x, y, `${tier}`, {
          fontSize: '14px', color: '#000000', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5);

        // Physics body via a sprite-like zone
        const pickupBody = this.add.zone(x, y, 30, 30);
        this.physics.world.enable(pickupBody);
        (pickupBody.body as Phaser.Physics.Arcade.Body).setAllowGravity(false);
        this.pickupGroup.add(pickupBody);

        // Store resource data on the zone
        pickupBody.setData('resourceId', surface.resourceId);
        pickupBody.setData('tier', tier);
        pickupBody.setData('gfx', gfx);
        pickupBody.setData('label', tierLabel);

        pickupIndex++;
      }
    }
  }

  // ── Hero ───────────────────────────────────────────────

  private _createHero(): void {
    // Texture dimensions. All draw commands are offset by (ox, oy) so every
    // pixel lands inside the 0..TW, 0..TH capture area (negative coords are clipped).
    //   Character spans: x -20..+20, y -32..+44  (relative to centre-bottom)
    //   With ox=24, oy=38: x 4..44 ✓  y 6..82 ✓  within 48×84
    const TW = 48;
    const TH = 84;
    const ox = TW / 2;   // horizontal centre = 24
    const oy = 38;        // vertical offset to clear hair (hair top = oy-32 = 6)

    const heroGfx = this.add.graphics();

    // -- Body (torso) --
    heroGfx.fillStyle(0x3366aa, 1);
    heroGfx.fillRoundedRect(ox - 14, oy - 10, 28, 32, 4);

    // -- Legs --
    heroGfx.fillStyle(0x224477, 1);
    heroGfx.fillRect(ox - 12, oy + 22, 10, 20);   // left leg
    heroGfx.fillRect(ox + 2,  oy + 22, 10, 20);   // right leg

    // -- Boots --
    heroGfx.fillStyle(0x443322, 1);
    heroGfx.fillRoundedRect(ox - 14, oy + 38, 12, 6, 2);  // left boot
    heroGfx.fillRoundedRect(ox + 2,  oy + 38, 12, 6, 2);  // right boot

    // -- Head --
    heroGfx.fillStyle(0xddbb88, 1);
    heroGfx.fillCircle(ox, oy - 20, 12);

    // -- Hair --
    heroGfx.fillStyle(0x553311, 1);
    heroGfx.fillRect(ox - 12, oy - 32, 24, 8);   // hair top
    heroGfx.fillRect(ox - 12, oy - 28,  4, 8);   // hair left side
    heroGfx.fillRect(ox + 8,  oy - 28,  4, 8);   // hair right side

    // -- Eyes --
    heroGfx.fillStyle(0xffffff, 1);
    heroGfx.fillCircle(ox - 5, oy - 22, 3);
    heroGfx.fillCircle(ox + 5, oy - 22, 3);
    heroGfx.fillStyle(0x223344, 1);
    heroGfx.fillCircle(ox - 4, oy - 22, 1.5);
    heroGfx.fillCircle(ox + 6, oy - 22, 1.5);

    // -- Arms --
    heroGfx.fillStyle(0x3366aa, 1);
    heroGfx.fillRect(ox - 20, oy - 6, 8, 22);    // left arm
    heroGfx.fillRect(ox + 12, oy - 6, 8, 22);    // right arm

    // -- Hands --
    heroGfx.fillStyle(0xddbb88, 1);
    heroGfx.fillCircle(ox - 16, oy + 18, 4);
    heroGfx.fillCircle(ox + 16, oy + 18, 4);

    // -- Belt --
    heroGfx.fillStyle(0x665533, 1);
    heroGfx.fillRect(ox - 14, oy + 18, 28, 5);

    // -- Outline --
    heroGfx.lineStyle(1.5, 0x1a1a2e, 0.6);
    heroGfx.strokeCircle(ox, oy - 20, 12);
    heroGfx.strokeRoundedRect(ox - 14, oy - 10, 28, 32, 4);

    heroGfx.generateTexture('hero_placeholder', TW, TH);
    heroGfx.destroy();

    // Spawn with origin (0.5, 1) so the sprite's bottom edge sits exactly on
    // the ground surface. No manual y-offset arithmetic needed.
    const groundY = (this.heightMap[2] ?? GROUND_BASE_Y);
    this.hero = this.physics.add.sprite(100, groundY, 'hero_placeholder');
    this.hero.setOrigin(0.5, 1);
    this.hero.setCollideWorldBounds(true);

    // Physics body: 28×70, positioned so its bottom aligns with the sprite's
    // bottom (y = TH = 84 in frame space). setOffset is always from frame
    // top-left regardless of origin.
    // Body occupies (10, 14) → (38, 84) → bottom at frame bottom → on ground.
    this.hero.body!.setSize(28, 70, false);
    this.hero.body!.setOffset((TW - 28) / 2, TH - 70);  // (10, 14)
    this.hero.body!.setGravityY(1400);

    // Hero name label (scrolls with the world)
    const activeHero = this.heroSystem.getById(this.context.activeHeroId);
    if (activeHero) {
      this.heroNameTag = this.add.text(100, groundY - 110, activeHero.name, {
        fontSize: '16px', color: '#66aaff', fontFamily: 'monospace',
      }).setOrigin(0.5);
    }
  }

  // ── Collision callbacks ────────────────────────────────

  private _onPickup(_hero: Phaser.GameObjects.GameObject, pickup: Phaser.GameObjects.GameObject): void {
    const zone = pickup as Phaser.GameObjects.Zone;
    const resourceId = zone.getData('resourceId') as string;
    const gfx = zone.getData('gfx') as Phaser.GameObjects.Graphics | undefined;
    const label = zone.getData('label') as Phaser.GameObjects.Text | undefined;

    // Increment gathered count
    this.resourcesGathered[resourceId] = (this.resourcesGathered[resourceId] ?? 0) + 1;

    // Floating "+1 <resource>" text that drifts up and fades
    const floatText = this.add.text(zone.x, zone.y - 10, `+1 ${resourceId}`, {
      fontSize: '16px', color: '#88ff88', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.tweens.add({
      targets: floatText,
      y: zone.y - 65,
      alpha: 0,
      duration: 700,
      ease: 'Cubic.Out',
      onComplete: () => { floatText.destroy(); },
    });

    // Remove the visual and the zone
    gfx?.destroy();
    label?.destroy();
    zone.destroy();
  }

  private _onReachExit(): void {
    if (!this.missionComplete) {
      this._completeMission('success');
    }
  }

  // ── Mission completion ─────────────────────────────────

  private _completeMission(outcome: 'success' | 'retreat' | 'failure'): void {
    this.missionComplete = true;
    this.hero.body!.setVelocity(0, 0);
    this.hero.body!.setGravityY(0); // prevent falling through terrain during the exit delay

    // Freeze all enemies — update() stops running after missionComplete, so gravity
    // would otherwise keep pulling them through the terrain.
    for (const enemy of this.enemies) {
      enemy.gameObject.body.setVelocity(0, 0);
      enemy.gameObject.body.setGravityY(0);
    }

    this.activeSwing = null;

    // Destroy any in-flight projectiles
    for (const p of this.projectiles) { p.gfx.destroy(); }
    this.projectiles = [];

    // Build hero status updates
    const heroUpdates = [
      {
        heroId: this.context.activeHeroId,
        newStatus: (outcome === 'failure' ? 'injured' : 'available') as 'available' | 'injured',
        experienceGained: outcome === 'success' ? 20 : outcome === 'retreat' ? 5 : 0,
      },
    ];
    if (this.context.supportHeroId) {
      heroUpdates.push({
        heroId: this.context.supportHeroId,
        newStatus: 'available' as const,
        experienceGained: outcome === 'success' ? 10 : 2,
      });
    }

    // Determine site state change
    let siteStateChange: MissionResult['siteStateChange'] = null;
    if (outcome === 'success') {
      siteStateChange = 'visited';
    }

    const result: MissionResult = {
      outcome,
      resourcesGathered: outcome === 'failure' ? {} : this.resourcesGathered,
      heroStatusUpdates: heroUpdates,
      objectivesCompleted: outcome === 'success'
        ? this.context.objectives.map(o => o.id)
        : [],
      siteStateChange,
    };

    // Write result to GSM
    this.gsm.setMissionResult(result);

    // Return heroes from mission
    this.heroSystem.returnFromMission(heroUpdates);

    // Update site state
    if (siteStateChange) {
      this.siteEvolutionSystem.applySiteStateChange(
        this.context.siteId, siteStateChange, this.gsm.cycleCount,
      );
    }

    // Mark site as visited on the hex tile
    this.gsm.updateHexTile(this.context.siteId, {
      lastVisitedCycle: this.gsm.cycleCount,
    });

    // Clear mission context
    this.gsm.setMissionContext(null);

    // Brief delay then return to hex map
    this.time.delayedCall(600, () => {
      console.log('[Mission] returning to WorldMapScene, services:', !!this.services);
      this.scene.start('WorldMapScene', this.services);
    });
  }

  // ── In-scene HUD ───────────────────────────────────────

  private hudText!: Phaser.GameObjects.Text;
  private siteLabel!: Phaser.GameObjects.Text;

  private _createMissionHUD(): void {
    const cam = this.cameras.main;

    this.siteLabel = this.add.text(14, 14,
      `${this.context.siteType.toUpperCase()} — Danger ${this.context.dangerLevel}`,
      { fontSize: '22px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold' },
    ).setScrollFactor(0);

    this.hudText = this.add.text(14, 44, '', {
      fontSize: '18px', color: '#aaccaa', fontFamily: 'monospace',
    }).setScrollFactor(0);

    // Hero HP bar
    this.add.text(14, 72, 'HP', {
      fontSize: '15px', color: '#ff6666', fontFamily: 'monospace',
    }).setScrollFactor(0);
    this.heroHpGfx = this.add.graphics().setScrollFactor(0);

    this.add.text(cam.width - 14, 14, '[ESC] Retreat', {
      fontSize: '16px', color: '#ff6666', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0);

    this.add.text(cam.width - 14, 38, 'WASD / Arrows: Move & Jump', {
      fontSize: '15px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0);

    this.add.text(cam.width - 14, 58, `[Click] ${this.equippedWeapon.name}`, {
      fontSize: '15px', color: '#ffddaa', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0);
  }

  private _updateMissionHUD(): void {
    const lines: string[] = [];
    for (const [id, amt] of Object.entries(this.resourcesGathered)) {
      lines.push(`${id}: ${amt}`);
    }
    this.hudText.setText(`Collected: ${lines.length > 0 ? lines.join('  ') : '(none)'}`);

    // Redraw HP bar only when HP has changed
    if (this.heroHp === this.heroHpDrawn) return;
    this.heroHpDrawn = this.heroHp;
    const pct = this.heroHp / this.heroMaxHp;
    const barX = 40; const barY = 73; const barW = 140; const barH = 11;
    this.heroHpGfx.clear();
    this.heroHpGfx.fillStyle(0x440000, 0.85);
    this.heroHpGfx.fillRect(barX, barY, barW, barH);
    const hpColor = pct > 0.6 ? 0x44ee44 : pct > 0.3 ? 0xffaa00 : 0xff2200;
    this.heroHpGfx.fillStyle(hpColor, 1);
    this.heroHpGfx.fillRect(barX, barY, barW * pct, barH);
  }
}
