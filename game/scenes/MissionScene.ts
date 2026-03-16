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
 * ← WorldMapScene  (launched after CharacterSelectScene confirms party)
 * → WorldMapScene  (scene stops after writing missionResult to GSM)
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
import { Enemy, SmallEnemy, MediumEnemy, LargeEnemy, FlyingDasher, FlyingShooter, type EnemyVisualConfig, type PendingProjectile } from '../entities/Enemy';
import { type WeaponDef, WEAPONS } from '../entities/Weapon';

export const MISSION_SCENE_KEY = 'MissionScene';

// ── Constants ────────────────────────────────────────────────
const WORLD_W = 9000;
const WORLD_H = 1080;
const GROUND_BASE_Y = 900;    // Baseline ground level (lowest the terrain stays)
const HERO_SPEED = 260;
const JUMP_VELOCITY = -620;
const TERRAIN_COLS = 180;      // Number of terrain columns (WORLD_W / COL_W)
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
    frameRate?: number;
    frameCount?: number;
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
  private enemyGroup!: Phaser.Physics.Arcade.Group;
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

  // Parallax background + foreground layers
  private bgL3!: Phaser.GameObjects.TileSprite;
  private bgL2!: Phaser.GameObjects.TileSprite;
  private bgL1!: Phaser.GameObjects.TileSprite;

  // Combat
  private equippedWeapon!: WeaponDef;
  private attackCooldownUntil = 0;
  private heroFacing: 1 | -1 = 1;
  private _heroAnim: 'walk' | 'idle' | 'attack' = 'idle';
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
  /** Duration of the full attack animation in ms — set from metadata in create(). */
  private _heroAttackAnimDurationMs = 1500;
  /** Timestamp when the attack *animation* finishes. */
  private _heroAttackAnimUntil = 0;
  /** Display size + origin for each hero animation — set from metadata in _createHero(). */
  private _heroVisual: Record<'walk' | 'attack', { dw: number; dh: number; origX: number; origY: number }> = {
    walk:   { dw: 160, dh: 90,  origX: 0.51, origY: 0.92 },
    attack: { dw: 160, dh: 90,  origX: 0.51, origY: 0.92 },
  };
  private heroHpDrawn = -1;
  private heroHpGfx!: Phaser.GameObjects.Graphics;

  // Obstacles and moving platforms
  private obstacleGroup!: Phaser.Physics.Arcade.StaticGroup;
  private movingPlatformGroup!: Phaser.Physics.Arcade.StaticGroup;
  private placedObstacles: Array<{ x: number; w: number }> = [];
  // Shared registry of every placed platform rect (static + moving) for overlap rejection.
  // Moving platforms register their full travel range as their x-extent.
  private placedPlatforms: Array<{ minX: number; maxX: number; py: number; pw: number }> = [];
  private movingPlatforms: Array<{
    gfx: Phaser.GameObjects.Graphics;
    zone: Phaser.GameObjects.Zone;
    y: number; vx: number; minX: number; maxX: number;
  }> = [];

  // Projectiles (spawned by ranged enemies)
  private projectiles: Array<{
    gfx: Phaser.GameObjects.Graphics;
    x: number; y: number;
    velX: number; velY: number;
    radius: number;
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
    // Hero spritesheets
    if (!this.textures.exists('hero1_walk_cycle')) {
      this.load.spritesheet('hero1_walk_cycle', 'animations/hero1_walk_cycle.webp', { frameWidth: 213, frameHeight: 120 });
    }
    if (!this.textures.exists('hero1attack')) {
      this.load.spritesheet('hero1attack', 'animations/hero1attack.webp', { frameWidth: 213, frameHeight: 120 });
    }
    this.load.json('hero1_walk_cycle_meta', '_meta/hero1_walk_cycle.asset.json');
    this.load.json('hero1attack_meta', '_meta/hero1attack.asset.json');
    // Forest parallax background layers
    this.load.image('forest_l3', 'backgrounds/forest_l3.webp');
    this.load.image('forest_l2', 'backgrounds/forest_l2.webp');
    this.load.image('forest_l1', 'backgrounds/forest_l1.webp');
  }

  create(): void {
    // ── Enemy spritesheet animations ───────────────────────────
    const rootwalkerMeta = this.cache.json.get('rootwalker_walk_cycle_meta') as AssetMetadataRecord | undefined;
    const houndMeta      = this.cache.json.get('hound_walk_cycle_meta')      as AssetMetadataRecord | undefined;
    const spiderMeta     = this.cache.json.get('spiderwalkcycle_meta')       as AssetMetadataRecord | undefined;
    const rootwalkerFps  = rootwalkerMeta?.spritesheet?.frameRate ?? 12;
    const houndFps       = houndMeta?.spritesheet?.frameRate      ?? 12;
    const spiderFps      = spiderMeta?.spritesheet?.frameRate     ?? 12;

    if (!this.anims.exists('rootwalker_walk')) {
      this.anims.create({
        key: 'rootwalker_walk',
        frames: this.anims.generateFrameNumbers('rootwalker_walk_cycle', { start: 0, end: 35 }),
        frameRate: rootwalkerFps,
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
        frameRate: houndFps,
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
        frameRate: spiderFps,
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

    // ── Hero animations ────────────────────────────────────────────────────
    const heroWalkMeta   = this.cache.json.get('hero1_walk_cycle_meta') as AssetMetadataRecord | undefined;
    const heroAttackMeta = this.cache.json.get('hero1attack_meta')       as AssetMetadataRecord | undefined;
    const heroWalkFps    = heroWalkMeta?.spritesheet?.frameRate   ?? 12;
    const heroAttackFps  = heroAttackMeta?.spritesheet?.frameRate ?? 24;
    const heroAttackFrames = heroAttackMeta?.spritesheet?.frameCount ?? 36;
    // Store for use in _performAttack so cooldown matches the real animation length
    this._heroAttackAnimDurationMs = (heroAttackFrames / heroAttackFps) * 1000;

    if (!this.anims.exists('hero1_walk')) {
      this.anims.create({
        key: 'hero1_walk',
        frames: this.anims.generateFrameNumbers('hero1_walk_cycle', { start: 0, end: 35 }),
        frameRate: heroWalkFps,
        repeat: -1,
      });
    }
    if (!this.anims.exists('hero1_idle')) {
      this.anims.create({
        key: 'hero1_idle',
        frames: [{ key: 'hero1_walk_cycle', frame: 0 }],
        frameRate: 1,
        repeat: -1,
      });
    }
    if (!this.anims.exists('hero1_attack')) {
      this.anims.create({
        key: 'hero1_attack',
        frames: this.anims.generateFrameNumbers('hero1attack', { start: 0, end: heroAttackFrames - 1 }),
        frameRate: heroAttackFps,
        repeat: 0,
      });
    }

    // Reset state
    this.resourcesGathered = {};
    this.missionComplete = false;
    this.isGrounded = false;
    this.enemies = [];
    this.equippedWeapon = WEAPONS.sword;
    this.attackCooldownUntil = 0;
    this._heroAttackAnimUntil = 0;
    this.heroFacing = 1;
    this._heroAnim = 'idle';
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
    this._buildParallaxBg();

    // ── Ground ────────────────────────────────────────────
    this.groundGroup = this.physics.add.staticGroup();
    this.platformGroup = this.physics.add.staticGroup();
    this.obstacleGroup = this.physics.add.staticGroup();
    this.movingPlatformGroup = this.physics.add.staticGroup();
    this.enemyGroup = this.physics.add.group();
    this._buildTerrain(biome);
    this._buildObstacles(biome);
    this._buildMovingPlatforms(biome);
    this._buildForegroundDeco();

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
    const oneWayFilter = ((hero: Phaser.Types.Physics.Arcade.GameObjectWithBody, platform: Phaser.Types.Physics.Arcade.GameObjectWithBody) => {
      const heroBody = (hero as Phaser.Types.Physics.Arcade.SpriteWithDynamicBody).body!;
      const platBody = (platform as Phaser.GameObjects.Zone).body as Phaser.Physics.Arcade.StaticBody;
      // Use the hero's bottom position from the START of this physics step (prev.y + height)
      // instead of current bottom. This handles fast horizontal movement: even if the hero
      // has tunneled partway into the platform this frame, we still allow the landing
      // as long as they were above the platform surface at the start of the frame.
      const prevBottom = heroBody.prev.y + heroBody.height;
      return heroBody.velocity.y >= 0 && prevBottom <= platBody.top + 4;
    }) as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback;
    this.physics.add.collider(this.hero, this.platformGroup, undefined, oneWayFilter, this);
    this.physics.add.collider(this.hero, this.movingPlatformGroup, undefined, oneWayFilter, this);
    this.physics.add.collider(this.hero, this.obstacleGroup);
    // Enemy-obstacle: only resolve side collisions. Phaser's least-penetration resolution
    // can push a fast-moving enemy upward when it hits a column; filtering to side-hits
    // (enemy centre-Y within the column's vertical extent) prevents that floating bug.
    const enemyObstacleFilter = ((enemy: Phaser.Types.Physics.Arcade.GameObjectWithBody, obstacle: Phaser.Types.Physics.Arcade.GameObjectWithBody) => {
      const eb = (enemy as Phaser.GameObjects.GameObject & { body: Phaser.Physics.Arcade.Body }).body;
      const ob = (obstacle as Phaser.GameObjects.Zone).body as Phaser.Physics.Arcade.StaticBody;
      const centerY = eb.y + eb.height / 2;
      return centerY > ob.top && centerY < ob.bottom;
    }) as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback;
    this.physics.add.collider(this.enemyGroup, this.obstacleGroup, undefined, enemyObstacleFilter, this);
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
    this._updateParallax();

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
    // Mirror the origin X every frame so the foot anchor stays planted when
    // the sprite is flipped. origX in metadata assumes facing right;
    // facing left needs 1 - origX so the anchor mirrors with the texture.
    {
      const av = this._heroAnim === 'attack' ? this._heroVisual.attack : this._heroVisual.walk;
      const ox = this.heroFacing < 0 ? 1 - av.origX : av.origX;
      this.hero.setOrigin(ox, av.origY);
    }

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

    // ── Hero animation state ──────────────────────────────────────────────
    const isAttacking = this.time.now < this._heroAttackAnimUntil;
    const isMoving    = Math.abs(this.hero.body!.velocity.x) > 10 && (body.blocked.down || this.isGrounded);
    if (isAttacking) {
      if (this._heroAnim !== 'attack') {
        this._heroAnim = 'attack';
        this.hero.anims.play('hero1_attack', true);
        const v = this._heroVisual.attack;
        this.hero.setDisplaySize(v.dw, v.dh);
        this.hero.setOrigin(this.heroFacing < 0 ? 1 - v.origX : v.origX, v.origY);
      }
    } else if (isMoving) {
      if (this._heroAnim !== 'walk') {
        this._heroAnim = 'walk';
        this.hero.anims.play('hero1_walk', true);
        const v = this._heroVisual.walk;
        this.hero.setDisplaySize(v.dw, v.dh);
        this.hero.setOrigin(this.heroFacing < 0 ? 1 - v.origX : v.origX, v.origY);
      }
    } else {
      if (this._heroAnim !== 'idle') {
        this._heroAnim = 'idle';
        this.hero.anims.play('hero1_idle', true);
        const v = this._heroVisual.walk; // idle uses walk cycle texture, same visual config
        this.hero.setDisplaySize(v.dw, v.dh);
        this.hero.setOrigin(this.heroFacing < 0 ? 1 - v.origX : v.origX, v.origY);
      }
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
            // Use the metadata collision box (hitRect) for hit detection so the
            // hitbox matches exactly what was configured in the asset manager.
            const hr = enemy.hitRect;
            const hcx = hr.x + hr.width  / 2;   // hitbox centre X
            const hcy = hr.y + hr.height / 2;   // hitbox centre Y
            // Nearest point on the hitbox rect to the swing origin — for range gate
            const npx = Math.max(hr.x, Math.min(hr.x + hr.width,  sw.hx));
            const npy = Math.max(hr.y, Math.min(hr.y + hr.height, sw.hy));
            const ndx = npx - sw.hx;
            const ndy = npy - sw.hy;
            if (Math.sqrt(ndx * ndx + ndy * ndy) <= sw.range + 20) {
              // Angle test uses hitbox centre so wide enemies don't need
              // the player to aim at the exact sprite pivot.
              let enemyA = Math.atan2(hcy - sw.hy, hcx - sw.hx);
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
      p.y += p.velY * dt;

      if (now >= p.expiresAt || p.x < 0 || p.x > WORLD_W || p.y > WORLD_H) {
        p.gfx.destroy();
        this.projectiles.splice(i, 1);
        continue;
      }

      // Redraw as a glowing orb — size scales with p.radius
      const r = p.radius;
      p.gfx.clear();
      p.gfx.fillStyle(0xff4400, 0.35);
      p.gfx.fillCircle(p.x, p.y, r * 1.85);
      p.gfx.fillStyle(0xff7733, 1);
      p.gfx.fillCircle(p.x, p.y, r);
      p.gfx.fillStyle(0xffdd88, 0.9);
      p.gfx.fillCircle(p.x, p.y, r * 0.43);

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

    // ── Moving platforms ───────────────────────────────────────────────────
    for (const mp of this.movingPlatforms) {
      // Bounce at travel limits
      let newX = mp.zone.x + mp.vx * dt;
      if (newX <= mp.minX || newX >= mp.maxX) {
        mp.vx = -mp.vx;
        newX = Phaser.Math.Clamp(newX, mp.minX, mp.maxX);
      }

      // Carry the hero if standing on top (feet within 6px of platform top)
      const platTop = mp.y;
      const heroFeet = this.hero.body!.bottom;
      const heroMidX = this.hero.x;
      const halfPw = mp.zone.width / 2;
      if (
        Math.abs(heroFeet - platTop) < 6 &&
        heroMidX >= newX - halfPw &&
        heroMidX <= newX + halfPw
      ) {
        this.hero.x += newX - mp.zone.x;
      }

      // Reposition physics body and visual
      (mp.zone.body as Phaser.Physics.Arcade.StaticBody).reset(newX, mp.y + 9);
      mp.zone.setPosition(newX, mp.y + 9);
      mp.gfx.setPosition(newX, mp.y);
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

  private _buildParallaxBg(): void {
    const tileScale = WORLD_H / 1536;

    // L3: Full scene — sky, mountains, airships, ruins (furthest back)
    this.bgL3 = this.add.tileSprite(0, 0, 1920, WORLD_H, 'forest_l3')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(-30);
    this.bgL3.setTileScale(tileScale);

    // L2: Mid-layer tree (between background and terrain)
    this.bgL2 = this.add.tileSprite(0, 0, 1920, WORLD_H, 'forest_l2')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(-20);
    this.bgL2.setTileScale(tileScale);

    // L1: Near-background layer — rocks, gears, side trees (behind terrain and characters)
    this.bgL1 = this.add.tileSprite(0, 0, 1920, WORLD_H, 'forest_l1')
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(-10);
    this.bgL1.setTileScale(tileScale);
  }

  private _buildForegroundDeco(): void {
    // Spread elements across a slightly wider-than-world X range to cover
    // the extra drift introduced by scrollFactor > 1 at max camera scroll.
    const spreadX = WORLD_W * 1.15;
    const seedBase = this._hashString(this.context.missionId + '_fg');

    for (let i = 0; i < 35; i++) {
      const wx = this._pseudoRandom(seedBase + i * 7) * spreadX;
      const wy = WORLD_H - 10 - this._pseudoRandom(seedBase + i * 3) * 45;
      const kind = Math.floor(this._pseudoRandom(seedBase + i * 11) * 3);
      const alpha = 0.55 + this._pseudoRandom(seedBase + i * 5) * 0.3;

      const g = this.add.graphics()
        .setScrollFactor(1.15)
        .setDepth(2);

      if (kind === 0) {
        // Tall grass cluster
        g.lineStyle(1, 0x2a3d1a, alpha);
        for (let b = -2; b <= 2; b++) {
          const h = 35 + this._pseudoRandom(seedBase + i + b) * 40;
          const lean = b * 5 + (this._pseudoRandom(i * 3 + b) - 0.5) * 8;
          g.lineBetween(wx + b * 4, wy, wx + b * 4 + lean, wy - h);
        }
      } else if (kind === 1) {
        // Fern silhouette
        g.lineStyle(1, 0x1e3320, alpha);
        const h = 50 + this._pseudoRandom(seedBase + i * 2) * 35;
        g.lineBetween(wx, wy, wx, wy - h);
        for (let f = 1; f <= 5; f++) {
          const fy = wy - (h * f / 5.5);
          const fl = (6 - f) * 5;
          g.lineBetween(wx, fy, wx - fl, fy - 7);
          g.lineBetween(wx, fy, wx + fl, fy - 7);
        }
      } else {
        // Low bush silhouette
        g.fillStyle(0x1e3a18, alpha * 0.7);
        const bw = 25 + this._pseudoRandom(seedBase + i * 4) * 20;
        const bh = 18 + this._pseudoRandom(seedBase + i * 6) * 14;
        g.fillEllipse(wx, wy - bh / 2, bw, bh);
        g.lineStyle(1, 0x2d4f22, alpha);
        g.strokeEllipse(wx, wy - bh / 2, bw, bh);
      }
    }
  }

  private _updateParallax(): void {
    const scrollX = this.cameras.main.scrollX;
    this.bgL3.tilePositionX = scrollX * 0.05;
    this.bgL2.tilePositionX = scrollX * 0.25;
    this.bgL1.tilePositionX = scrollX * 0.6;
    // fgDeco elements use setScrollFactor(1.15) — Phaser handles drift automatically
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
    for (let pass = 0; pass < 8; pass++) {
      for (let col = 1; col < TERRAIN_COLS - 1; col++) {
        heights[col] = Math.round(
          (heights[col - 1]! + heights[col]! * 2 + heights[col + 1]!) / 4,
        );
      }
    }

    // ── Feature 4: Pit valleys ─────────────────────────────────────────────
    // Carve 3–5 dramatic dip sections. Each dip is a cosine-shaped valley that
    // drops well below the base line, creating visual gaps and slowing traversal.
    const pitCount = 3 + Math.floor(danger / 2);
    for (let p = 0; p < pitCount; p++) {
      // Keep pits away from the start (col < 10) and end (col > TERRAIN_COLS - 12)
      const centreCol = 10 + Math.floor(this._pseudoRandom(p * 67 + 13) * (TERRAIN_COLS - 25));
      const halfWidth = 4 + Math.floor(this._pseudoRandom(p * 43 + 7) * 5); // 4–8 cols wide
      const depth = 90 + this._pseudoRandom(p * 31) * 80; // 90–170px deep
      for (let dc = -halfWidth; dc <= halfWidth; dc++) {
        const c = centreCol + dc;
        if (c < 1 || c >= TERRAIN_COLS - 1) continue;
        const t = dc / halfWidth; // -1..1
        const dip = Math.cos(t * Math.PI * 0.5) * depth; // cosine profile
        heights[c] = Math.min(GROUND_BASE_Y + 20, heights[c]! + dip);
      }
    }

    // ── Feature 5: Elevated plateaus ──────────────────────────────────────
    // Raise 2–3 sections to form high shelves that the player must climb or
    // navigate around via platforms.
    const plateauCount = 2 + Math.floor(danger / 3);
    for (let p = 0; p < plateauCount; p++) {
      const centreCol = 15 + Math.floor(this._pseudoRandom(p * 89 + 41) * (TERRAIN_COLS - 30));
      const halfWidth = 5 + Math.floor(this._pseudoRandom(p * 53 + 17) * 6); // 5–10 cols
      const lift = 140 + this._pseudoRandom(p * 61) * 100; // 140–240px above baseline
      for (let dc = -halfWidth; dc <= halfWidth; dc++) {
        const c = centreCol + dc;
        if (c < 1 || c >= TERRAIN_COLS - 1) continue;
        const t = Math.abs(dc) / halfWidth;
        // Flat top with slightly ramped edges
        const raise = lift * (1 - t * 0.3);
        heights[c] = Math.max(GROUND_BASE_Y - 280, heights[c]! - raise);
      }
    }

    // Final 2-pass smooth to blend pit/plateau transitions with the surrounding terrain
    for (let pass = 0; pass < 2; pass++) {
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

    // Cross-hatch texture strip in the top ~38px of the terrain bulk
    const hatch = this.add.graphics();
    hatch.lineStyle(1, biome.groundEdge, 0.13);
    for (let col = 0; col < TERRAIN_COLS - 1; col++) {
      if (this._pseudoRandom(col * 17 + 3) > 0.45) continue;
      const x0 = col * COL_W;
      const surfY = this.heightMap[col]!;
      for (let pass = 0; pass < 3; pass++) {
        const yOff = 6 + pass * 11;
        hatch.lineBetween(x0 + 2, surfY + yOff, x0 + 10, surfY + yOff + 8);
      }
    }

    // Top edge — multi-stroke "comic ink" line
    const edgePath = new Phaser.Curves.Path(0, this.heightMap[0]!);
    for (let col = 1; col < TERRAIN_COLS; col++) {
      edgePath.lineTo(col * COL_W, this.heightMap[col]!);
    }
    const edgeGfx = this.add.graphics();
    // Pass 1 — wide soft underglow (ink bleed)
    edgeGfx.lineStyle(7, biome.groundEdge, 0.12);
    edgePath.draw(edgeGfx);
    // Pass 2 — main ink line
    edgeGfx.lineStyle(2, biome.groundEdge, 1.0);
    edgePath.draw(edgeGfx);
    // Pass 3 — bright surface highlight
    edgeGfx.lineStyle(1, 0xffffff, 0.18);
    edgePath.draw(edgeGfx);

    // Physics bodies: full-height rectangles from the surface down to the world
    // floor so the hero can't fall through even at high fall speeds.
    for (let col = 0; col < TERRAIN_COLS; col++) {
      const x = col * COL_W + COL_W / 2;
      const y = this.heightMap[col]!;
      const h = WORLD_H - y;
      const body = this.add.zone(x, y + h / 2, COL_W + 2, h);
      this.groundGroup.add(body);
    }

    // Surface detail: grass blades, ferns, and root bumps along the terrain top
    for (let col = 2; col < TERRAIN_COLS - 2; col++) {
      if (this._pseudoRandom(col * 31 + 11) > 0.38) continue;
      const cx = col * COL_W + COL_W / 2;
      const baseY = this.heightMap[col]!;
      const type = Math.floor(this._pseudoRandom(col * 7 + 2) * 3);
      const decoGfx = this.add.graphics();

      if (type === 0) {
        // Tall grass blades — 3 thin strokes fanning out
        decoGfx.lineStyle(1, biome.groundEdge, 0.55);
        for (let b = -1; b <= 1; b++) {
          const lean = b * 4 + (this._pseudoRandom(col + b * 13) - 0.5) * 3;
          const h = 8 + this._pseudoRandom(col * 3 + b) * 10;
          decoGfx.lineBetween(cx + b * 3, baseY, cx + b * 3 + lean, baseY - h);
        }
      } else if (type === 1) {
        // Fern — central stem + 4 small side fronds
        decoGfx.lineStyle(1, biome.groundEdge, 0.5);
        const h = 12 + this._pseudoRandom(col * 5) * 8;
        decoGfx.lineBetween(cx, baseY, cx, baseY - h);
        for (let f = 1; f <= 4; f++) {
          const fy = baseY - (h * f / 4.5);
          const fl = (5 - f) * 3;
          decoGfx.lineBetween(cx, fy, cx - fl, fy - 4);
          decoGfx.lineBetween(cx, fy, cx + fl, fy - 4);
        }
      } else {
        // Root bump — small arc above ground
        decoGfx.lineStyle(2, biome.groundDark, 0.5);
        const bw = 10 + this._pseudoRandom(col * 9) * 8;
        decoGfx.beginPath();
        decoGfx.arc(cx, baseY, bw / 2, Math.PI, 0, false);
        decoGfx.strokePath();
      }
    }

    // ── Jump physics constants (must match MissionScene update values) ──────
    // JUMP_VELOCITY = -620, gravity = 1400 → max single-jump height ≈ 137px,
    // full-arc air time ≈ 0.886s → max horizontal reach @ HERO_SPEED ≈ 230px.
    const JUMP_REACH_H = 175; // comfortable center-to-center horizontal gap
    const JUMP_REACH_V = 90;  // comfortable single-step climb height
    const PLAT_H = 18;        // visual/physics height of every platform

    // Reset the shared registry at the start of terrain build so it's clean per scene create.
    this.placedPlatforms = [];
    this.placedObstacles = [];

    /**
     * Find the highest (lowest Y) terrain point under the platform's footprint.
     * Samples 7 evenly-spaced X positions across the platform width.
     */
    const _minTerrainY = (px: number, pw: number): number => {
      let minY = WORLD_H;
      const samples = 7;
      for (let s = 0; s <= samples; s++) {
        const sx = px - pw / 2 + (s / samples) * pw;
        minY = Math.min(minY, this._getGroundYInterp(sx));
      }
      return minY;
    };

    /**
     * Attempt to place a platform.
     * 1. Push py up so the platform bottom clears the terrain by at least 20px.
     * 2. Reject if it overlaps any already-placed platform (static or moving).
     * Returns true if placed, false if skipped.
     */
    const _placePlatform = (px: number, pyIn: number, pw: number): boolean => {
      if (px < 80 || px > WORLD_W - 80) return false;

      // Clamp py so the bottom edge (py + PLAT_H) is ≥20px above the terrain.
      const clearance = 20;
      const maxPy = _minTerrainY(px, pw) - PLAT_H - clearance;
      const py = Math.min(pyIn, maxPy);

      if (py < 80) return false; // too close to top of world

      // Reject if this rect overlaps any previously placed platform.
      // Add a 15px gutter on all sides so they never visually touch.
      const gutter = 15;
      const pMinX = px - pw / 2;
      const pMaxX = px + pw / 2;
      for (const p of this.placedPlatforms) {
        const xOverlap = pMinX - gutter < p.maxX && pMaxX + gutter > p.minX;
        const yOverlap = Math.abs(py - p.py) < PLAT_H + gutter;
        if (xOverlap && yOverlap) return false;
      }

      this.placedPlatforms.push({ minX: pMinX, maxX: pMaxX, py, pw });

      const platGfx = this.add.graphics();
      // Drop shadow
      platGfx.fillStyle(0x000000, 0.25);
      platGfx.fillRoundedRect(px - pw / 2 + 3, py + 4, pw, PLAT_H, 3);
      // Front face — darker, gives 3D slab depth
      platGfx.fillStyle(biome.groundDark, 1.0);
      platGfx.fillRect(px - pw / 2, py + PLAT_H - 5, pw, 7);
      // Main top surface
      platGfx.fillStyle(biome.platFill, 1.0);
      platGfx.fillRoundedRect(px - pw / 2, py, pw, PLAT_H - 1, 3);
      // Top highlight
      platGfx.lineStyle(1, 0xffffff, 0.22);
      platGfx.lineBetween(px - pw / 2 + 5, py + 2, px + pw / 2 - 5, py + 2);
      // Plank division lines
      platGfx.lineStyle(1, biome.groundDark, 0.35);
      const thirds = pw / 3;
      platGfx.lineBetween(px - pw / 2 + thirds,     py + 3, px - pw / 2 + thirds,     py + PLAT_H - 4);
      platGfx.lineBetween(px - pw / 2 + thirds * 2, py + 3, px - pw / 2 + thirds * 2, py + PLAT_H - 4);
      // Outline
      platGfx.lineStyle(2, biome.platEdge, 1.0);
      platGfx.strokeRoundedRect(px - pw / 2, py, pw, PLAT_H, 3);
      const platBody = this.add.zone(px, py + PLAT_H / 2, pw, PLAT_H);
      this.platformGroup.add(platBody);
      return true;
    };

    // ── Group 1: Scattered helper platforms ──────────────────────────────────
    // Fewer, larger platforms that act as optional rest stops / shortcuts.
    const scatterCount = Math.min(10, Math.max(3, this.context.dangerLevel * 2 + 1));
    const scatterSpacing = (WORLD_W - 600) / (scatterCount + 1);
    for (let i = 0; i < scatterCount; i++) {
      const col = Math.floor(3 + (i + 1) * (TERRAIN_COLS - 6) / (scatterCount + 1));
      const surfaceY = this.heightMap[Math.min(col, TERRAIN_COLS - 1)]!;
      const px = 300 + (i + 1) * scatterSpacing + (this._pseudoRandom(i) * 60 - 30);
      const py = surfaceY - 110 - this._pseudoRandom(i + 100) * 70;
      const pw = 100 + this._pseudoRandom(i + 200) * 60; // generous width
      _placePlatform(px, py, pw);
    }

    // ── Group 2: Jump-gap chains ───────────────────────────────────────────────
    // Platforms spaced at exactly one running-jump apart horizontally.
    // A gentle rise (15px/step) rewards good timing without being punishing.
    const chainCount = 2 + Math.floor(this.context.dangerLevel / 2);
    for (let c = 0; c < chainCount; c++) {
      const anchorX = 500 + (c / chainCount) * (WORLD_W - 1400)
        + this._pseudoRandom(c * 97 + 5) * 300;
      const col = Math.floor(anchorX / COL_W);
      const surfaceY = this.heightMap[Math.min(col, TERRAIN_COLS - 1)]!;
      const anchorY = surfaceY - 100 - this._pseudoRandom(c * 71) * 60;
      const steps = 4 + Math.floor(this._pseudoRandom(c * 53) * 3); // 4–6 platforms
      const dir = this._pseudoRandom(c * 37) > 0.5 ? 1 : -1;

      for (let step = 0; step < steps; step++) {
        // Spacing jitter of ±15px keeps it slightly organic while still feeling deliberate
        const jitter = (this._pseudoRandom(c * 100 + step * 17) - 0.5) * 30;
        const px = anchorX + dir * step * (JUMP_REACH_H + jitter);
        // Small progressive rise so the chain has a goal (ascends slightly)
        const py = anchorY - step * 18 + (this._pseudoRandom(c * 100 + step * 29) - 0.5) * 8;
        // Slightly narrower platforms as the chain progresses → harder to land
        const pw = 85 - step * 4 + this._pseudoRandom(c * 100 + step * 41) * 15;
        _placePlatform(px, py, Math.max(50, pw));
      }
    }

    // ── Group 3: Vertical climbing towers ────────────────────────────────────
    // Platforms stacked in a zigzag pattern, each ~JUMP_REACH_V above the last.
    // These lead up to elevated terrain sections or just high vantage points.
    const towerCount = 2 + Math.floor(this.context.dangerLevel / 2);
    for (let t = 0; t < towerCount; t++) {
      const anchorX = 900 + (t / towerCount) * (WORLD_W - 2200)
        + this._pseudoRandom(t * 113 + 9) * 400;
      const col = Math.floor(anchorX / COL_W);
      const surfaceY = this.heightMap[Math.min(col, TERRAIN_COLS - 1)]!;
      const steps = 5 + Math.floor(this._pseudoRandom(t * 79) * 4); // 5–8 steps
      const baseDir = this._pseudoRandom(t * 43) > 0.5 ? 1 : -1;

      for (let step = 0; step < steps; step++) {
        // Zigzag: alternate sides so the player has to jump back and forth
        const side = (step % 2 === 0 ? 1 : -1) * baseDir;
        const px = anchorX + side * (JUMP_REACH_H * 0.55);
        const py = surfaceY - JUMP_REACH_V * (step + 1) - 10;
        // Narrower platforms higher up for a real challenge
        const pw = 70 - step * 3 + this._pseudoRandom(t * 100 + step * 23) * 10;
        _placePlatform(px, py, Math.max(45, pw));
      }
    }
  }

  // ── Obstacles ──────────────────────────────────────────

  private _buildObstacles(biome: ReturnType<typeof this._getBiome>): void {
    const count = 5 + Math.floor(this.context.dangerLevel * 1.5);
    const gfx = this.add.graphics();

    for (let i = 0; i < count; i++) {
      // Spread obstacles across the world, away from spawn and exit
      const x = 400 + this._pseudoRandom(i * 61 + 11) * (WORLD_W - 900);
      const groundY = this._getGroundYInterp(x);
      const w = 30 + this._pseudoRandom(i * 43) * 30;
      const h = 60 + this._pseudoRandom(i * 29 + 5) * 80;
      const top = groundY - h;

      // Stone pillar visual
      gfx.fillStyle(biome.groundDark, 1);
      gfx.fillRect(x - w / 2, top, w, h);
      gfx.lineStyle(2, biome.groundEdge, 0.6);
      gfx.strokeRect(x - w / 2, top, w, h);
      // Highlight stripe on left face
      gfx.fillStyle(0xffffff, 0.07);
      gfx.fillRect(x - w / 2, top, 5, h);
      // Crenellation on top
      const cW = Math.max(6, w / 4);
      gfx.fillStyle(biome.groundDark, 1);
      gfx.fillRect(x - w / 2, top - 10, cW, 10);
      gfx.fillRect(x + w / 2 - cW, top - 10, cW, 10);
      gfx.lineStyle(1, biome.groundEdge, 0.4);
      gfx.strokeRect(x - w / 2, top - 10, cW, 10);
      gfx.strokeRect(x + w / 2 - cW, top - 10, cW, 10);
      // Masonry joints — horizontal lines every 20px
      gfx.lineStyle(1, biome.groundDark, 0.45);
      for (let yLine = top + 20; yLine < top + h; yLine += 20) {
        gfx.lineBetween(x - w / 2, yLine, x + w / 2, yLine);
      }
      // Running bond offset on alternating rows
      gfx.lineStyle(1, biome.groundDark, 0.25);
      for (let yLine = top + 10; yLine < top + h; yLine += 20) {
        gfx.lineBetween(x, yLine, x + w / 2, yLine);
      }
      // Diagonal crack detail on ~60% of pillars
      if (this._pseudoRandom(x * 0.007 + 3) > 0.4) {
        const crackX = x - w / 2 + w * (0.3 + this._pseudoRandom(x) * 0.4);
        gfx.lineStyle(1, biome.groundDark, 0.6);
        gfx.lineBetween(crackX, top + 8, crackX - 5, top + h * 0.4);
      }

      // Physics zone — solid from all sides
      const zone = this.add.zone(x, top + h / 2, w, h);
      this.obstacleGroup.add(zone);
      this.placedObstacles.push({ x, w });
    }
  }

  // ── Moving platforms ────────────────────────────────────

  private _buildMovingPlatforms(biome: ReturnType<typeof this._getBiome>): void {
    const count = 2 + Math.floor(this.context.dangerLevel * 1.2);
    const travelRange = 200 + this.context.dangerLevel * 40;
    const PLAT_H = 18;
    const clearance = 25;

    // Use the shared registry (already populated by _buildTerrain) so moving platforms
    // don't intersect static platforms either.

    for (let i = 0; i < count; i++) {
      const anchorX = 700 + this._pseudoRandom(i * 83 + 7) * (WORLD_W - 1500);
      const pw = 80 + this._pseudoRandom(i * 31) * 60;
      const speed = 60 + this._pseudoRandom(i * 59) * 80;
      const vx = (this._pseudoRandom(i * 23) > 0.5 ? 1 : -1) * speed;
      // Clamp travel limits so the platform never leaves the world
      const minX = Math.max(pw / 2 + 50, anchorX - travelRange / 2);
      const maxX = Math.min(WORLD_W - pw / 2 - 50, anchorX + travelRange / 2);

      // Sample terrain height across the FULL travel path (including platform half-widths
      // on both ends) so the platform never dips into the ground at any point in its sweep.
      let minTerrainY = WORLD_H;
      const samples = 14;
      for (let s = 0; s <= samples; s++) {
        const sx = (minX - pw / 2) + (s / samples) * (maxX - minX + pw);
        minTerrainY = Math.min(minTerrainY, this._getGroundYInterp(
          Math.max(0, Math.min(WORLD_W, sx)),
        ));
      }

      // Desired height above anchor terrain; push up further if needed to clear path.
      const col = Math.floor(anchorX / COL_W);
      const surfaceY = this.heightMap[Math.min(col, TERRAIN_COLS - 1)]!;
      const desiredPy = surfaceY - 120 - this._pseudoRandom(i * 47) * 100;
      const py = Math.min(desiredPy, minTerrainY - PLAT_H - clearance);

      if (py < 80) continue; // would be off-screen — skip

      // Skip if the travel range overlaps another moving platform at a similar height.
      let overlaps = false;
      for (const p of this.placedPlatforms) {
        const xOverlap = minX < p.maxX + pw / 2 && maxX > p.minX - pw / 2;
        const yClose = Math.abs(py - p.py) < PLAT_H + 15;
        if (xOverlap && yClose) { overlaps = true; break; }
      }
      if (overlaps) continue;

      this.placedPlatforms.push({ minX, maxX, py, pw });

      // Visual — layered platform + white outline + arrow indicators to signal it moves
      const gfx = this.add.graphics();
      // Drop shadow
      gfx.fillStyle(0x000000, 0.25);
      gfx.fillRoundedRect(-pw / 2 + 3, 4, pw, PLAT_H, 3);
      // Front face
      gfx.fillStyle(biome.groundDark, 1.0);
      gfx.fillRect(-pw / 2, PLAT_H - 5, pw, 7);
      // Main surface
      gfx.fillStyle(biome.platFill, 1.0);
      gfx.fillRoundedRect(-pw / 2, 0, pw, PLAT_H - 1, 3);
      // Top highlight
      gfx.lineStyle(1, 0xffffff, 0.22);
      gfx.lineBetween(-pw / 2 + 5, 2, pw / 2 - 5, 2);
      // Plank lines
      gfx.lineStyle(1, biome.groundDark, 0.35);
      gfx.lineBetween(-pw / 6, 3, -pw / 6, PLAT_H - 4);
      gfx.lineBetween(pw / 6, 3, pw / 6, PLAT_H - 4);
      // White outline + arrows
      gfx.lineStyle(2, 0xffffff, 0.35);
      gfx.strokeRoundedRect(-pw / 2, 0, pw, PLAT_H, 3);
      gfx.fillStyle(0xffffff, 0.2);
      gfx.fillTriangle(-pw / 2 + 8, 9, -pw / 2 + 18, 4, -pw / 2 + 18, 14);
      gfx.fillTriangle(pw / 2 - 8, 9, pw / 2 - 18, 4, pw / 2 - 18, 14);
      gfx.setPosition(anchorX, py);

      const zone = this.add.zone(anchorX, py + PLAT_H / 2, pw, PLAT_H);
      this.movingPlatformGroup.add(zone);

      this.movingPlatforms.push({ gfx, zone, y: py, vx, minX, maxX });
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
    const smallCount        = Math.min(danger + 1, 5);
    const mediumCount       = Math.max(0, danger - 1);
    const largeCount        = Math.max(0, danger - 3);
    const flyingDasherCount = Math.min(Math.max(0, danger - 1), 3); // 1 at danger 2, up to 3 at danger 4+
    const flyingShooterCount= Math.min(Math.max(0, danger - 2), 3); // 1 at danger 3, up to 3 at danger 5+
    const total = smallCount + mediumCount + largeCount + flyingDasherCount + flyingShooterCount;
    if (total === 0) return;

    const spacing = (WORLD_W - 400) / (total + 1);
    let slot = 0;
    let lastPlacedX = 200;

    const place = (
      EnemyType: new (s: Phaser.Scene, c: { x: number; patrolRange: number; visual?: EnemyVisualConfig }, g: (x: number) => number) => Enemy,
      visual?: EnemyVisualConfig,
    ) => {
      let x = 200 + (slot + 1) * spacing + (this._pseudoRandom(slot * 13 + 7) - 0.5) * 80;
      // Push spawn clear of all pillars. Loop until stable — shifting past one
      // pillar may land on the next, so re-check until no overlaps remain.
      let dirty = true;
      while (dirty) {
        dirty = false;
        for (const obs of this.placedObstacles) {
          if (Math.abs(x - obs.x) < obs.w / 2 + 60) {
            x = obs.x + obs.w / 2 + 60;
            dirty = true;
          }
        }
      }
      const patrolRange = 80 + this._pseudoRandom(slot * 31) * 80;
      const enemy = new EnemyType(this, { x, patrolRange, visual }, gt);
      this.enemies.push(enemy);
      this.enemyGroup.add(enemy.gameObject);
      lastPlacedX = x;
      slot++;
    };

    // Place a flying enemy beside the previously placed enemy instead of its
    // own evenly-spaced slot, creating a visible "pair" in the level.
    const placePaired = (
      EnemyType: new (s: Phaser.Scene, c: { x: number; patrolRange: number; visual?: EnemyVisualConfig }, g: (x: number) => number) => Enemy,
    ) => {
      const offset = this._pseudoRandom(slot * 19 + 3) > 0.5 ? 160 : -160;
      const x      = Phaser.Math.Clamp(lastPlacedX + offset, 200, WORLD_W - 200);
      const enemy  = new EnemyType(this, { x, patrolRange: 60 }, gt);
      this.enemies.push(enemy);
      this.enemyGroup.add(enemy.gameObject);
      // slot is NOT incremented — the paired enemy shares a spacing slot
    };

    // Build a flat list of all enemies to spawn, then shuffle deterministically
    // so ground and flying types are mixed across the level instead of clumped.
    type SpawnEntry = [
      new (s: Phaser.Scene, c: { x: number; patrolRange: number; visual?: EnemyVisualConfig }, g: (x: number) => number) => Enemy,
      EnemyVisualConfig | undefined,
    ];
    const spawnList: SpawnEntry[] = [
      ...Array(smallCount).fill([SmallEnemy, smallEnemyVisual]),
      ...Array(mediumCount).fill([MediumEnemy, mediumEnemyVisual]),
      ...Array(largeCount).fill([LargeEnemy, largeEnemyVisual]),
      ...Array(flyingDasherCount).fill([FlyingDasher, undefined]),
      ...Array(flyingShooterCount).fill([FlyingShooter, undefined]),
    ];
    // Fisher-Yates shuffle using pseudoRandom so the mix is stable per seed
    for (let i = spawnList.length - 1; i > 0; i--) {
      const j = Math.floor(this._pseudoRandom(i * 37 + danger * 11) * (i + 1));
      [spawnList[i], spawnList[j]] = [spawnList[j]!, spawnList[i]!];
    }
    for (let idx = 0; idx < spawnList.length; idx++) {
      const [EnemyType, visual] = spawnList[idx]!;
      const isFlying = EnemyType === FlyingDasher || EnemyType === FlyingShooter;
      // ~40% chance a flying enemy pairs with the previous enemy (if one exists)
      const pair = isFlying && idx > 0 && this._pseudoRandom(idx * 53 + danger * 7) < 0.4;
      if (pair) {
        placePaired(EnemyType as typeof FlyingDasher);
      } else {
        place(EnemyType, visual);
      }
    }
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
    this._heroAttackAnimUntil = now + this._heroAttackAnimDurationMs;
    this.activeSwing = {
      angle: swingAngle, arcHalf, startA, sweepA: startA,
      range: weapon.range, damage: weapon.damage, hx, hy,
      startTime: now, expiresAt: now + weapon.swingDuration,
      hit: new Set(),
    };

    this._showSwingGfx();
  }

  private _spawnProjectile(data: PendingProjectile): void {
    const SPEED = 340;
    let velX: number, velY: number;
    if (data.dirY !== undefined) {
      // Aimed shot: build a proper velocity vector from the normalised direction
      const nx  = data.dirX;   // ±1
      const ny  = data.dirY;
      const len = Math.sqrt(nx * nx + ny * ny) || 1;
      velX = (nx / len) * SPEED;
      velY = (ny / len) * SPEED;
    } else {
      velX = data.dirX * SPEED;
      velY = 0;
    }
    this.projectiles.push({
      gfx:       this.add.graphics(),
      x:         data.x,
      y:         data.y,
      velX,
      velY,
      radius:    data.radius ?? 7,
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
    const walkMeta   = this.cache.json.get('hero1_walk_cycle_meta') as AssetMetadataRecord | undefined;
    const attackMeta = this.cache.json.get('hero1attack_meta')       as AssetMetadataRecord | undefined;

    const DW    = walkMeta?.displaySize?.width  ?? 160;
    const DH    = walkMeta?.displaySize?.height ?? 90;
    const origX = walkMeta?.spritesheet?.origin?.x ?? 0.51;
    const origY = walkMeta?.spritesheet?.origin?.y ?? 0.92;
    const CB_X  = walkMeta?.spritesheet?.collisionBox?.x      ?? 66;
    const CB_W  = walkMeta?.spritesheet?.collisionBox?.width  ?? 33;
    const CB_H  = walkMeta?.spritesheet?.collisionBox?.height ?? 67;
    // Phaser's body.y formula uses originY × exportFrameHeight (not displayHeight).
    // Derive CB_Y so body.bottom aligns exactly with hero.y (the visual foot point):
    //   body.bottom = hero.y  →  CB_Y = origY * exportH - CB_H
    const exportH = walkMeta?.exportSize?.height ?? 120;
    const CB_Y  = Math.round(origY * exportH) - CB_H;

    // Store per-animation visual configs so update() can swap them on transitions.
    this._heroVisual = {
      walk: { dw: DW, dh: DH, origX, origY },
      attack: {
        dw:    attackMeta?.displaySize?.width   ?? DW,
        dh:    attackMeta?.displaySize?.height  ?? DH,
        origX: attackMeta?.spritesheet?.origin?.x ?? origX,
        origY: attackMeta?.spritesheet?.origin?.y ?? origY,
      },
    };

    const groundY = (this.heightMap[2] ?? GROUND_BASE_Y);
    this.hero = this.physics.add.sprite(100, groundY, 'hero1_walk_cycle');
    this.hero.setDisplaySize(DW, DH);
    this.hero.setOrigin(origX, origY);
    this.hero.setCollideWorldBounds(true);

    // Physics body from metadata collision box (display-space coords).
    // setOffset is from frame top-left, independent of origin.
    this.hero.body!.setSize(CB_W, CB_H, false);
    this.hero.body!.setOffset(CB_X, CB_Y);
    this.hero.body!.setGravityY(1400);

    this.hero.anims.play('hero1_idle');

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
