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

  create(): void {
    // Reset state
    this.resourcesGathered = {};
    this.missionComplete = false;
    this.isGrounded = false;

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
    this.physics.add.collider(this.hero, this.platformGroup);
    this.physics.add.overlap(this.hero, this.pickupGroup, this._onPickup as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback, undefined, this);
    this.physics.add.overlap(this.hero, this.exitZone, this._onReachExit as Phaser.Types.Physics.Arcade.ArcadePhysicsCallback, undefined, this);

    // ── Input ─────────────────────────────────────────────
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.input.keyboard!.on('keydown-ESC', () => {
      if (!this.missionComplete) this._completeMission('retreat');
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
    if (!this.isGrounded && body.velocity.y >= 0 && this.hero.y >= terrainY) {
      this.isGrounded = true;
      this.jumpsRemaining = 2; // restore both jumps on landing
    }
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

    // ── Horizontal movement ────────────────────────────────────────────────
    if (this.cursors.left.isDown) {
      body.setVelocityX(-HERO_SPEED);
    } else if (this.cursors.right.isDown) {
      body.setVelocityX(HERO_SPEED);
    } else {
      body.setVelocityX(0);
    }

    // ── Jump (double jump supported) ──────────────────────────────────────
    const jumpPressed = Phaser.Input.Keyboard.JustDown(this.cursors.up) ||
                        Phaser.Input.Keyboard.JustDown(this.cursors.space!);
    if (jumpPressed && (onGround || this.jumpsRemaining > 0)) {
      body.setVelocityY(JUMP_VELOCITY);
      this.isGrounded = false;
      this.jumpsRemaining = Math.max(0, this.jumpsRemaining - 1);
    }

    // Update name tag position to follow the hero
    if (this.heroNameTag) {
      this.heroNameTag.setPosition(this.hero.x, this.hero.y - 110);
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

    this.add.text(cam.width - 14, 14, '[ESC] Retreat', {
      fontSize: '16px', color: '#ff6666', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0);

    this.add.text(cam.width - 14, 38, '← → Move  |  ↑ / Space Jump', {
      fontSize: '15px', color: '#888888', fontFamily: 'monospace',
    }).setOrigin(1, 0).setScrollFactor(0);
  }

  private _updateMissionHUD(): void {
    const lines: string[] = [];
    for (const [id, amt] of Object.entries(this.resourcesGathered)) {
      lines.push(`${id}: ${amt}`);
    }
    this.hudText.setText(`Collected: ${lines.length > 0 ? lines.join('  ') : '(none)'}`);
  }
}
