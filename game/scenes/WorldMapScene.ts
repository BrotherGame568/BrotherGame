/**
 * WorldMapScene.ts  -- MERGED MAP (replaces WorldMapScene + HexZoomScene)
 * Single navigable world map:
 *   Zoom out  => procedural world colour mosaic + wind corridor bands
 *   Zoom in   => game tile labels appear, hex grid becomes interactive
 */

import Phaser from 'phaser';
import type { IGameStateManager }       from '@systems/IGameStateManager';
import type { ITradewindSystem }        from '@systems/ITradewindSystem';
import type { IReachSystem }            from '@systems/IReachSystem';
import type { ISiteEvolutionSystem }    from '@systems/ISiteEvolutionSystem';
import type { IHeroSystem }             from '@systems/IHeroSystem';
import type { IResourceSystem }         from '@systems/IResourceSystem';
import type { IAudioService }           from '@services/IAudioService';
import type { HexTile, AxialCoord }     from '@data/HexTile';
import { hexId, hexDistance }           from '@data/HexTile';
import type { Hero }                    from '@data/Hero';
import type { WindCorridor, WindJunction } from '@data/WindNetwork';
import { fbm }                          from '@data/NoiseUtils';
import type { ServiceBundle }           from '../../src/main';
import cityZoomUrl                      from '@assets/sprites/CityZoom.png';

export const WORLD_MAP_SCENE_KEY = 'WorldMapScene';

// ── Constants
const SQRT3        = Math.sqrt(3);
const WORLD_RADIUS = 60;   // large world — feel vast when panning
const TILE_R       = 12;
const TILE_SY      = 0.55;
const GAME_RADIUS  = 1;   // city influence: city hex + immediate 6 neighbours
const LABEL_ZOOM   = 3.5;
const MIN_ZOOM     = 0.12; // allows zooming out to see most of the map
const MAX_ZOOM     = 14.0;
// Starting zoom: show roughly a 22-ring viewport width, not the whole map
const INITIAL_ZOOM = 2.0;

// ── Particle system tuning ─────────────────────────────────────────────────
/** Particles per corridor for the inactive (ghost) corridors. */
const GHOST_PARTICLE_COUNT  = 50;   // baseline — scaled by corridor length
/** Particles per corridor for the active (prominent) corridor. */
const ACTIVE_PARTICLE_COUNT = 110;  // baseline
/** Reference spine length (hexes) used to normalise per-corridor particle counts. */
const PARTICLE_REF_LEN      = 10;
/** Swirl frequency in rad / ms — controls subtle time-varying drift within band. */
const SWIRL_FREQ            = 0.0010;
/** Half-width of the particle stream (px in mapContainer space). */
const BAND_SPREAD_ACTIVE    = TILE_R * 2.0;
const BAND_SPREAD_GHOST     = TILE_R * 1.5;
/** Small time-varying drift added on top of the static cross-band position. */
const STREAM_DRIFT          = TILE_R * 0.3;

/**
 * Returns a biome colour for world hex (q, r).
 *
 * Elevation = FBM + a continental-shelf boost that raises the centre of the
 * world above sea level, guaranteeing land near the city regardless of noise.
 * Moisture is an independent FBM channel controlling vegetation type.
 */
function worldTileColor(q: number, r: number): number {
  const nx = q + r * 0.5;
  const ny = r * 0.866;
  const sc = 1 / 8;   // coarser scale → bigger blobs, clearly visible at zoom 2

  const rawE = fbm((nx + 31.5) * sc, (ny + 17.3) * sc, 4);
  const rawM = fbm((nx - 53.1) * sc, (ny + 44.7) * sc, 3);

  // Continental shelf: smooth +0.45 boost at centre, fading to 0 at radius 48
  const dist  = Math.sqrt(nx * nx + ny * ny * (1 / 0.75));
  const shelf = Math.max(0, (1 - dist / 48)) * 0.45;

  const e = Math.max(0, Math.min(1, rawE + shelf - 0.10));
  const m = rawM;

  // ── Water ────────────────────────────────────────────────
  if (e < 0.08) return 0x020c18;   // abyssal trench
  if (e < 0.18) return 0x071828;   // deep ocean
  if (e < 0.28) return 0x0d2e52;   // open ocean
  if (e < 0.36) return 0x165c80;   // shallow sea
  if (e < 0.42) return m > 0.52 ? 0x2a8060 : 0xb8aa72; // mangrove / sand beach

  // ── Alpine ───────────────────────────────────────────────
  if (e > 0.90) return 0xdce8f0;   // snow peaks
  if (e > 0.78) return m < 0.38 ? 0x7c6a50 : 0x606858; // bare rock / alpine

  // ── Mainland (by moisture) ────────────────────────────────
  if (m > 0.74) return e > 0.64 ? 0x1e6828 : 0x30943c; // dense rainforest
  if (m > 0.60) return e > 0.64 ? 0x347838 : 0x46a84e; // temperate forest
  if (m > 0.48) return e > 0.63 ? 0x4e9040 : 0x66b84e; // woodland / mixed
  if (m > 0.36) return e > 0.62 ? 0x70a030 : 0x96c840; // grassland / plains
  if (m > 0.24) return e > 0.60 ? 0x8c8c28 : 0xb0b038; // savanna / dry grass
  if (m > 0.14) return e > 0.58 ? 0xa07832 : 0xc8a84a; // scrub / steppe
  return e > 0.56 ? 0xb86820 : 0xe0b85a;                // desert / golden dunes
}


const SITE_DISPLAY: Record<string, { label: string; color: number }> = {
  town:    { label: 'Town',    color: 0x3388dd },
  village: { label: 'Village', color: 0x33aa66 },
  ruin:    { label: 'Ruin',    color: 0xaa6633 },
  deposit: { label: 'Deposit', color: 0xcccc33 },
  skydock: { label: 'Dock',    color: 0xcc33cc },
  empty:   { label: '',        color: 0x445566 },
};

const STATE_COLORS: Record<string, number> = {
  undiscovered: 0x333333, discovered: 0x666666, visited: 0x88aa88,
  contested:    0xdd6633, conquered: 0xcc3333, destroyed: 0x444444,
  recovering:   0x5599aa, thriving: 0x33dd66, abandoned: 0x777777,
};

function tilePx(q: number, r: number): { x: number; y: number } {
  return {
    x: TILE_R * (1.5 * q),
    y: TILE_R * (SQRT3 * 0.5 * q + SQRT3 * r) * TILE_SY,
  };
}

function tilePts(cx: number, cy: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    pts.push(new Phaser.Geom.Point(cx + TILE_R * Math.cos(a), cy + TILE_R * Math.sin(a) * TILE_SY));
  }
  return pts;
}

interface ScreenHexLabel {
  coord: AxialCoord;
  text: Phaser.GameObjects.Text;
}

export class WorldMapScene extends Phaser.Scene {
  private gsm!:             IGameStateManager;
  private tradewindSystem!: ITradewindSystem;
  private reachSystem!:     IReachSystem;
  private siteEvolution!:   ISiteEvolutionSystem;
  private heroSystem!:      IHeroSystem;
  private resourceSystem!:  IResourceSystem;
  private audioService!:    IAudioService;
  private services!:        ServiceBundle;

  private mapContainer!:      Phaser.GameObjects.Container;
  private gameTileContainer!: Phaser.GameObjects.Container;
  private labelObjects:  Phaser.GameObjects.GameObject[] = [];
  private screenLabels: ScreenHexLabel[] = [];
  /** Static graphics layer: all corridor bands, spines, junction markers. */
  private _networkGfx:    Phaser.GameObjects.Graphics | null = null;
  /** Reference to the world terrain graphics layer (for zoom-based alpha). */
  private _terrainGfx:    Phaser.GameObjects.Graphics | null = null;
  /** Permanent outline ring drawn at the edge of the reachable hex area. */
  private _reachOutlineGfx: Phaser.GameObjects.Graphics | null = null;
  /** Terrain fill graphics for each game tile — hidden when zoomed far out. */
  private _gameTileGfxList: Phaser.GameObjects.Graphics[] = [];
  /** Dark distance fog drawn between terrain and corridors. */
  private _fogGfx:            Phaser.GameObjects.Graphics | null = null;
  /** Interactive zones along corridor spines for hover detection. */
  private _corridorZones:     Phaser.GameObjects.Zone[] = [];
  /** Temporary highlight drawn over a hovered corridor. */
  private _hoverGfx:          Phaser.GameObjects.Graphics | null = null;
  /** Floating name tag shown while hovering a corridor. */
  private _corridorNameLabel: Phaser.GameObjects.Text | null = null;
  /** ID of the corridor currently under the pointer (null if none). */
  private _hoveredCorridorId: string | null = null;
  /** Fast lookup: bandHex ID → corridor ID, rebuilt by _renderWindNetwork(). */
  private _corridorBandSets: Map<string, string> = new Map();
  /** One shared Graphics redrawn every frame for all streak/streamline particles. */
  private _streamGfx: Phaser.GameObjects.Graphics | null = null;
  /** Pure data records describing each animated streak — no Phaser objects per streak. */
  private _particleData: Array<{
    t: number;          // position [0..1] along spine
    speed: number;      // advance per second (normalised)
    corridorIdx: number;
    phase: number;      // per-particle drift phase
    lateralT: number;   // static cross-band offset [-1..1]
    bandSpread: number;      // half-width of corridor band (px, mapContainer space)
    color: number;           // hex colour
    alpha: number;           // peak alpha (modulated by fade)
    streakPx: number;        // base streak length in mapContainer px
    streakMult: number;      // per-particle length multiplier [0.3..2.0]
    fadePhase: number;       // phase offset for the slow fade-in/out sine
    fadePeriod: number;      // full fade cycle duration in ms
  }> = [];
  /** Junction selection panel. */
  private _junctionOverlay: Phaser.GameObjects.Container | null = null;
  private cityDot: Phaser.GameObjects.Graphics | null = null;
  /** Zoomed-in city sprite (CityZoom.png), bobbing gently. Hidden when zoomed out. */
  private _citySprite:   Phaser.GameObjects.Image | null = null;
  private _cityBobBaseY: number = 0;
  /** True while the city movement tween is playing — blocks new End Cycle clicks. */
  private _cityMoving    = false;
  /** Ghost preview orb+trail drawn when hovering the End Cycle button. */
  private _previewGfx:   Phaser.GameObjects.Graphics | null = null;
  /** True while the pointer is over the End Cycle button — suppresses corridor hover. */
  private _overEndCycleBtn = false;
  /** Background Graphics for the End Cycle button, kept in sync with endCycleBtn. */
  private _endCycleBtnGfx: Phaser.GameObjects.Graphics | null = null;
  /** Sub-label beneath the End Cycle button text, kept in sync with endCycleBtn. */
  private _endCycleBtnSubLbl: Phaser.GameObjects.Text | null = null;

  private currentZoom = 1;
  private isDragging  = false;
  private mapPointerDown = false;
  private dragStartX  = 0;
  private dragStartY  = 0;
  private ctnrStartX  = 0;
  private ctnrStartY  = 0;
  private mapCtrY     = 0;

  private routeOverlay:   Phaser.GameObjects.Container | null = null;
  private modalContainer: Phaser.GameObjects.Container | null = null;
  private resultOverlay:  Phaser.GameObjects.Container | null = null;

  private titleText!:    Phaser.GameObjects.Text;
  private endCycleBtn!:  Phaser.GameObjects.Text;
  private zoomHintText!: Phaser.GameObjects.Text;

  constructor() { super({ key: WORLD_MAP_SCENE_KEY }); }

  init(data: ServiceBundle): void {
    this.services        = data;
    this.gsm             = data.gsm;
    this.tradewindSystem = data.tradewindSystem;
    this.reachSystem     = data.reachSystem;
    this.siteEvolution   = data.siteEvolution;
    this.heroSystem      = data.heroSystem;
    this.resourceSystem  = data.resourceSystem;
    this.audioService    = data.audioService;

    // Clear stale game-object references from any previous run.
    // Phaser destroys all display objects on scene.start() but TypeScript
    // class fields still hold the old (now-destroyed) references, which are
    // truthy objects — accessing them after destruction crashes with
    // "Cannot read properties of null (reading 'drawImage')".
    this.zoomHintText    = null!;
    this.titleText       = null!;
    this.endCycleBtn     = null!;
    this.labelObjects    = [];
    this.screenLabels    = [];
    this._networkGfx         = null;
    this._terrainGfx          = null;
    this._reachOutlineGfx     = null;
    this._streamGfx           = null;
    this._particleData        = [];
    this._junctionOverlay     = null;
    this._fogGfx              = null;
    this._corridorZones       = [];
    this._hoverGfx            = null;
    this._corridorNameLabel   = null;
    this._hoveredCorridorId   = null;
    this._corridorBandSets    = new Map();
    this.cityDot              = null;
    this._citySprite           = null;
    this._cityMoving           = false;
    this._previewGfx           = null;
    this._overEndCycleBtn      = false;
    this._endCycleBtnGfx       = null;
    this._endCycleBtnSubLbl    = null;
    this.routeOverlay    = null;
    this.modalContainer  = null;
    this.resultOverlay   = null;
  }

  preload(): void {
    if (!this.textures.exists('city_zoom')) {
      this.load.image('city_zoom', cityZoomUrl);
    }
  }

  create(): void {
    console.log('[WorldMap] create() called, gsm:', !!this.gsm, 'services:', !!this.services);
    try {
      this._createInternal();
    } catch (e) {
      console.error('[WorldMap] create() threw:', e);
      // Show on-screen error so it's visible in-game
      this.add.text(20, 20, 'WorldMap error: ' + String(e), {
        fontSize: '14px', color: '#ff4444', fontFamily: 'monospace', wordWrap: { width: 900 },
      });
    }
  }

  private _createInternal(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    this._discoverReachableHexes();
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { show(): void }).show();

    this.add.graphics().fillStyle(0x04040e, 1).fillRect(0, 0, W, H);

    const TITLE_H  = 0;   // no title bar — map uses the full height
    const HINT_H   = 32;
    const mapAreaH = H - TITLE_H - HINT_H;
    this.mapCtrY   = TITLE_H + mapAreaH / 2;

    // Start zoomed so the player sees a local neighbourhood, not the whole
    // 120-ring diameter world. INITIAL_ZOOM ≈ 2 shows ~22 hex-ring viewport.
    this.currentZoom = INITIAL_ZOOM;

    this.mapContainer = this.add.container(W / 2, this.mapCtrY);
    this.mapContainer.setScale(this.currentZoom);
    this._buildWorldBackground();
    this._buildFogOverlay();         // distance-based dark veil between terrain and corridors
    this._renderWindNetwork();       // persistent corridor bands + spines + junction markers

    this.gameTileContainer = this.add.container(0, 0);
    this.mapContainer.add(this.gameTileContainer);
    this._buildGameTiles();
    this._buildParticles();      // animated dots flowing along corridor spines
    this._updateLabelVisibility();

    // Track pointer: update name label position + corridor hover detection
    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      this._corridorNameLabel?.setPosition(ptr.x + 14, ptr.y - 24);
      if (!this.isDragging) {
        // Suppress corridor hover when the End Cycle button or junction panel is active.
        if (this._overEndCycleBtn) { this._onCorridorOut(); return; }
        if (this.routeOverlay)     { return; }  // card pointerover owns highlight while panel is open
        // Corridor hover only active when zoomed out (game tiles take focus when zoomed in).
        if (this.currentZoom >= LABEL_ZOOM) return;
        // Convert screen → mapContainer local → axial hex
        const lx    = (ptr.x - this.mapContainer.x) / this.currentZoom;
        const ly    = (ptr.y - this.mapContainer.y) / this.currentZoom;
        const q     = Math.round(lx / (TILE_R * 1.5));
        const r     = Math.round((ly / (TILE_R * SQRT3 * TILE_SY)) - q * 0.5);
        const hId   = hexId({ q, r });
        const corrId = this._corridorBandSets.get(hId) ?? null;
        if (corrId !== this._hoveredCorridorId) {
          this._hoveredCorridorId = corrId;
          if (corrId) {
            const corr = this.gsm.windNetwork.corridors.find(c => c.id === corrId);
            if (corr) this._onCorridorHover(corr);
          } else {
            this._onCorridorOut();
          }
        }
      }
    });

    this._renderHintLine(W, H, HINT_H);
    this._renderEndCycleButton(W, H);

    this.input.on('wheel', (_p: unknown, _g: unknown, _dx: number, dy: number) => {
      const factor = dy > 0 ? 0.88 : (1 / 0.88);
      this.currentZoom = Phaser.Math.Clamp(this.currentZoom * factor, MIN_ZOOM, MAX_ZOOM);
      this.mapContainer.setScale(this.currentZoom);
      this._updateLabelVisibility();
      this._updateScreenLabelTransforms();
    });

    const mapBg = this.add.rectangle(W / 2, this.mapCtrY, W, mapAreaH, 0, 0).setInteractive();
    this.children.sendToBack(mapBg);
    mapBg.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.mapPointerDown = true;
      this.isDragging = false;
      this.dragStartX = p.x;
      this.dragStartY = p.y;
      this.ctnrStartX = this.mapContainer.x;
      this.ctnrStartY = this.mapContainer.y;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.mapPointerDown) return;
      const moved = Math.hypot(p.x - this.dragStartX, p.y - this.dragStartY);
      if (moved < 6 && !this.isDragging) return;
      this.isDragging = true;
      this.mapContainer.x = this.ctnrStartX + (p.x - this.dragStartX);
      this.mapContainer.y = this.ctnrStartY + (p.y - this.dragStartY);
      this._updateScreenLabelTransforms();
    });
    this.input.on('pointerup', () => {
      this.mapPointerDown = false;
      this.isDragging = false;
    });

    if (this.gsm.missionResult) this._showMissionResult();
  }

  private _buildWorldBackground(): void {
    const gfx = this.add.graphics();
    this._terrainGfx = gfx;
    this.mapContainer.add(gfx);
    for (let q = -WORLD_RADIUS; q <= WORLD_RADIUS; q++) {
      for (let r = -WORLD_RADIUS; r <= WORLD_RADIUS; r++) {
        if (Math.abs(-q - r) > WORLD_RADIUS) continue;
        const { x, y } = tilePx(q, r);
        const pts = tilePts(x, y);
        gfx.fillStyle(worldTileColor(q, r), 0.80);
        gfx.fillPoints(pts, true);
        gfx.lineStyle(1, 0x000000, 0.30);
        gfx.strokePoints(pts, true);
      }
    }
  }

  private _drawReachOutline(gfx: Phaser.GameObjects.Graphics, center: AxialCoord): void {
    gfx.clear();

    // Edge i of tilePts (vertex i → vertex i+1) has outward normal at (30 + 60*i)°.
    const HEX_DIR_OFFSETS: Array<{ dq: number; dr: number }> = [
      { dq:  1, dr:  0 },  // edge 0
      { dq:  0, dr:  1 },  // edge 1
      { dq: -1, dr:  1 },  // edge 2
      { dq: -1, dr:  0 },  // edge 3
      { dq:  0, dr: -1 },  // edge 4
      { dq:  1, dr: -1 },  // edge 5
    ];

    // Enumerate every hex at exactly GAME_RADIUS distance from center, derived
    // purely from axial coordinates — no hexMap lookup (hexMap is sparse, only
    // radius-5, so most city positions would leave sides of the ring empty).
    const ringCoords: AxialCoord[] = [];
    for (let dq = -GAME_RADIUS; dq <= GAME_RADIUS; dq++) {
      for (let dr = -GAME_RADIUS; dr <= GAME_RADIUS; dr++) {
        const ds = -dq - dr;
        if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds)) !== GAME_RADIUS) continue;
        ringCoords.push({ q: center.q + dq, r: center.r + dr });
      }
    }

    const outerEdges: Array<[number, number, number, number]> = [];
    for (const coord of ringCoords) {
      const { x: tx, y: ty } = tilePx(coord.q, coord.r);
      const tpts = tilePts(tx, ty);
      for (let ei = 0; ei < 6; ei++) {
        const nb = HEX_DIR_OFFSETS[ei]!;
        const nq = coord.q + nb.dq;
        const nr = coord.r + nb.dr;
        if (hexDistance({ q: nq, r: nr }, center) <= GAME_RADIUS) continue;
        const vA = tpts[ei]!;
        const vB = tpts[(ei + 1) % 6]!;
        outerEdges.push([vA.x, vA.y, vB.x, vB.y]);
      }
    }

    // Wide soft halo pass
    gfx.lineStyle(6, 0x4af0ff, 0.20);
    for (const [ax, ay, bx, by] of outerEdges) {
      gfx.beginPath(); gfx.moveTo(ax, ay); gfx.lineTo(bx, by); gfx.strokePath();
    }
    // Tight bright core pass
    gfx.lineStyle(2, 0x4af0ff, 0.90);
    for (const [ax, ay, bx, by] of outerEdges) {
      gfx.beginPath(); gfx.moveTo(ax, ay); gfx.lineTo(bx, by); gfx.strokePath();
    }
  }

  private _buildGameTiles(): void {
    this._reachOutlineGfx?.destroy();
    this._reachOutlineGfx = null;
    this.gameTileContainer.removeAll(true);
    for (const lbl of this.screenLabels) lbl.text.destroy();
    this.screenLabels = [];
    this.labelObjects = [];
    this._gameTileGfxList = [];

    const cityId = hexId(this.gsm.cityHex);

    for (const tile of this.gsm.hexMap) {
      if (hexDistance(tile.coord, this.gsm.cityHex) > GAME_RADIUS) continue;

      const isCity   = tile.id === cityId;
      const display  = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
      const { x, y } = tilePx(tile.coord.q, tile.coord.r);
      const pts       = tilePts(x, y);

      const terrColor = worldTileColor(tile.coord.q, tile.coord.r);

      const tileGfx = this.add.graphics();
      this.gameTileContainer.add(tileGfx);
      this._gameTileGfxList.push(tileGfx);

      const drawTile = (hovered: boolean) => {
        tileGfx.clear();
        if (isCity) {
          // City hex: normal terrain fill with amber outline (orb drawn separately).
          tileGfx.fillStyle(terrColor, hovered ? 0.90 : 0.75);
          tileGfx.fillPoints(pts, true);
          tileGfx.lineStyle(hovered ? 2.5 : 1.5, 0xf7c948, hovered ? 1 : 0.70);
          tileGfx.strokePoints(pts, true);
        } else {
          tileGfx.fillStyle(terrColor, hovered ? 0.82 : 0.60);
          tileGfx.fillPoints(pts, true);
          if (hovered) {
            tileGfx.fillStyle(display.color, 0.25);
            tileGfx.fillPoints(pts, true);
          }
          tileGfx.lineStyle(hovered ? 2.5 : 1.5, display.color, hovered ? 1 : 0.70);
          tileGfx.strokePoints(pts, true);
        }
      };
      drawTile(false);

      // Text labels for non-empty non-city tiles in range.
      if (!isCity && tile.siteType !== 'empty') {
        const lbl = this.add.text(0, 0, display.label, {
          fontSize: '8px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5).setAlpha(0).setDepth(20);
        this.screenLabels.push({ coord: tile.coord, text: lbl });
      }

      // All tiles in range are interactive.
      const zone = this.add.zone(x, y, TILE_R * 1.7, TILE_R * 1.3).setInteractive({ useHandCursor: true });
      this.gameTileContainer.add(zone);
      zone.on('pointerover', () => {
        if (this.currentZoom < LABEL_ZOOM) return;
        drawTile(true);
      });
      zone.on('pointerout', () => {
        if (this.currentZoom < LABEL_ZOOM) return;
        drawTile(false);
      });
      zone.on('pointerdown', () => {
        if (this.currentZoom < LABEL_ZOOM) return;
        if (this.isDragging) return;
        if (isCity) { this._openCityView(); }
        else        { this._openPartySelection(tile); }
      });
    }

    const { x: cx, y: cy } = tilePx(this.gsm.cityHex.q, this.gsm.cityHex.r);

    // ── Influence boundary ring ──────────────────────────────────────────────
    const ringGfx = this.add.graphics();
    this._drawReachOutline(ringGfx, this.gsm.cityHex);
    this.mapContainer.add(ringGfx);
    this.mapContainer.bringToTop(ringGfx);
    this._reachOutlineGfx = ringGfx;

    // ── City glowing orb ────────────────────────────────────────────────────
    // Four concentric fills: wide soft halo shrinking to a bright white core.
    const dotGfx = this.add.graphics();
    dotGfx.fillStyle(0xf7c948, 0.08); dotGfx.fillCircle(cx, cy, TILE_R * 0.95);
    dotGfx.fillStyle(0xf7c948, 0.18); dotGfx.fillCircle(cx, cy, TILE_R * 0.65);
    dotGfx.fillStyle(0xf7c948, 0.55); dotGfx.fillCircle(cx, cy, TILE_R * 0.38);
    dotGfx.fillStyle(0xffffff,  0.90); dotGfx.fillCircle(cx, cy, TILE_R * 0.14);
    this.gameTileContainer.add(dotGfx);
    this.cityDot = dotGfx;

    // ── Zoomed-in city sprite ───────────────────────────────────────────────
    const sprSize = TILE_R * 1.2;  // roughly the same footprint as the orb
    const spr = this.add.image(cx, cy, 'city_zoom')
      .setDisplaySize(sprSize, sprSize)
      .setAlpha(0)   // _updateLabelVisibility() will show it when zoomed in
      .setDepth(10);
    this.gameTileContainer.add(spr);
    this._citySprite   = spr;
    this._cityBobBaseY = cy -3;
    this._updateScreenLabelTransforms();
  }

  private _makeCityIcon(cx: number, cy: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setAlpha(0);
    // Base platform
    g.fillStyle(0x6b4f1d, 1);
    g.fillRoundedRect(cx - 9, cy + 3, 18, 3, 1);

    // Main tower body
    g.fillStyle(0xf2c94c, 1);
    g.fillRect(cx - 2.5, cy - 8, 5, 11);

    // Roof
    g.fillStyle(0xffe08a, 1);
    g.fillTriangle(cx - 3.5, cy - 8, cx + 3.5, cy - 8, cx, cy - 13);

    // Side houses
    g.fillStyle(0xd9a93f, 1);
    g.fillRect(cx - 8, cy - 3, 4, 6);
    g.fillRect(cx + 4, cy - 2, 4, 5);

    // Crisp outline (no glow)
    g.lineStyle(1.25, 0x2b1d08, 0.95);
    g.strokeRoundedRect(cx - 9, cy + 3, 18, 3, 1);
    g.strokeRect(cx - 2.5, cy - 8, 5, 11);
    g.strokeRect(cx - 8, cy - 3, 4, 6);
    g.strokeRect(cx + 4, cy - 2, 4, 5);
    return g;
  }

  private _updateLabelVisibility(): void {
    // Smooth fade: ramp from 0→1 over the zoom band [FADE_START … LABEL_ZOOM].
    const FADE_START = LABEL_ZOOM * 0.50;   // starts fading at ~zoom 1.75
    const fadeT = Phaser.Math.Clamp(
      (this.currentZoom - FADE_START) / (LABEL_ZOOM - FADE_START), 0, 1,
    );
    // Quintic ease-in-out: very gentle at both ends, steeper in the middle.
    const t = fadeT < 0.5
      ? 16 * fadeT * fadeT * fadeT * fadeT * fadeT
      : 1 - Math.pow(-2 * fadeT + 2, 5) / 32;

    const show = t > 0.5;  // binary threshold used only for text content swap
    for (const obj of this.labelObjects) {
      const go = obj as { setAlpha?: (v: number) => void };
      if (go.setAlpha) go.setAlpha(t);
    }
    if (this.zoomHintText) {
      const zStr = this.currentZoom.toFixed(1);
      this.zoomHintText.setText(
        show
          ? 'Click a hex to interact   |   Scroll to zoom   |   Drag to pan'
          : 'Scroll in to reveal the local map   (zoom: ' + zStr + 'x)',
      );
    }
    // City: sprite fades in with zoom, orb fades out with it.
    if (this._citySprite) this._citySprite.setAlpha(t);
    if (this.cityDot)     this.cityDot.setAlpha(1 - t);
    for (const lbl of this.screenLabels) {
      lbl.text.setAlpha(t);
    }
    // Terrain fills fade in; ring stays at full alpha always.
    for (const gfx of this._gameTileGfxList) {
      gfx.setAlpha(t);
    }
    // Clear corridor hover highlight once we're mostly zoomed in.
    if (show) this._onCorridorOut();
    // Terrain fades to near-invisible when zoomed far out; particles take over.
    const zoomT = Phaser.Math.Clamp(
      (this.currentZoom - MIN_ZOOM) / (INITIAL_ZOOM - MIN_ZOOM), 0, 1);
    if (this._terrainGfx) this._terrainGfx.setAlpha(0.20 + zoomT * 0.60);
  }

  private _updateScreenLabelTransforms(): void {
    const zoomFontSize = Phaser.Math.Clamp(10 + (this.currentZoom - LABEL_ZOOM) * 1.6, 10, 16);
    for (const lbl of this.screenLabels) {
      const local = tilePx(lbl.coord.q, lbl.coord.r);
      const screenX = this.mapContainer.x + local.x * this.currentZoom;
      const screenY = this.mapContainer.y + local.y * this.currentZoom - 4;
      lbl.text.setPosition(screenX, screenY);
      lbl.text.setFontSize(zoomFontSize);
    }
  }

  // ── Wind corridor network rendering ──────────────────────────────────────

  /**
   * Draw the persistent wind network:
   *  - No band hexes visible by default (shown only on hover via _onCorridorHover).
   *  - No spine centre-line (particles ARE the corridor visual).
   *  - Arrow direction indicators at each spine midpoint (subtle).
   *  - Junction markers where corridors meet.
   *  - Rebuilds _corridorBandSets for pointer hover hit-testing.
   */
  private _renderWindNetwork(): void {
    this._networkGfx?.destroy();
    this._networkGfx = null;

    // Clear any stale hover state from the previous network build
    this._hoveredCorridorId = null;
    this._hoverGfx?.clear();
    this._corridorNameLabel?.setVisible(false);

    const network  = this.gsm.windNetwork;
    const activeId = this.gsm.currentCorridorId;
    if (network.corridors.length === 0) return;

    // ── Build fast hex-to-corridor lookup for pointer hit-testing ──────────
    this._corridorBandSets.clear();
    for (const corr of network.corridors) {
      for (const h of corr.bandHexes) {
        const id = hexId(h);
        // Active corridor wins overlapping cells so hovering it is easier
        if (!this._corridorBandSets.has(id) || corr.id === activeId) {
          this._corridorBandSets.set(id, corr.id);
        }
      }
    }

    const gfx = this.add.graphics();

    // // ── Arrow direction indicators (subtle, one per corridor at midpoint) ──
    // for (const corr of network.corridors) {
    //   const isActive = corr.id === activeId;
    //   const midIdx   = Math.floor(corr.spine.length / 2);
    //   if (midIdx < 1) continue;
    //   const tip  = tilePx(corr.spine[midIdx]!.q,     corr.spine[midIdx]!.r);
    //   const base = tilePx(corr.spine[midIdx - 1]!.q, corr.spine[midIdx - 1]!.r);
    //   const ang  = Math.atan2(tip.y - base.y, tip.x - base.x);
    //   const AL   = TILE_R * 1.2, AW = TILE_R * 0.50;
    //   gfx.fillStyle(corr.color, isActive ? 0.70 : 0.38);
    //   gfx.fillTriangle(
    //     tip.x + Math.cos(ang) * AL,       tip.y + Math.sin(ang) * AL,
    //     tip.x + Math.cos(ang + 2.4) * AW, tip.y + Math.sin(ang + 2.4) * AW,
    //     tip.x + Math.cos(ang - 2.4) * AW, tip.y + Math.sin(ang - 2.4) * AW,
    //   );
    // }

    // ── Junction markers — soft rings where corridors cross ─────────────────
    // (drawn only on hover — see _onCorridorHover)

    this.mapContainer.add(gfx);
    this._networkGfx = gfx;
  }

  /** Draw translucent band hexes over a corridor when the player hovers it. */
  private _onCorridorHover(corr: WindCorridor): void {
    if (!this._hoverGfx) {
      this._hoverGfx = this.add.graphics();
      this.mapContainer.add(this._hoverGfx);
    } else {
      this._hoverGfx.clear();
    }
    const gfx = this._hoverGfx;
    for (const c of corr.bandHexes) {
      const { x, y } = tilePx(c.q, c.r);
      const pts = tilePts(x, y);
      gfx.fillStyle(corr.color, 0.15);
      gfx.fillPoints(pts, true);
      gfx.lineStyle(1, corr.color, 0.30);
      gfx.strokePoints(pts, true);
    }
    // ── Junction markers on hovered corridor ──────────────────────────────
    for (const j of this.gsm.windNetwork.junctions) {
      if (!j.corridorIds.includes(corr.id)) continue;
      const { x: jx, y: jy } = tilePx(j.hex.q, j.hex.r);
      gfx.fillStyle(0xffffff, 0.65);
      gfx.fillCircle(jx, jy, TILE_R * 0.28);
      gfx.lineStyle(1.5, 0xffffff, 0.45);
      gfx.strokeCircle(jx, jy, TILE_R * 0.55);
    }
    if (!this._corridorNameLabel) {
      this._corridorNameLabel = this.add.text(0, 0, corr.name, {
        fontSize: '13px', color: '#ffffff', fontFamily: 'monospace',
        backgroundColor: '#000000bb', padding: { x: 7, y: 4 },
      }).setDepth(200);
    } else {
      this._corridorNameLabel.setText(corr.name);
      this._corridorNameLabel.setVisible(true);
    }
  }

  /** Clear hover highlight and name label when pointer leaves a corridor. */
  private _onCorridorOut(): void {
    this._hoverGfx?.clear();
    this._corridorNameLabel?.setVisible(false);
  }

  /**
   * Build the streamline particle system.
   * Creates one shared Graphics (redrawn every frame) and a plain data record
   * per streak — no individual Phaser objects per particle.
   */
  private _buildParticles(): void {
    // Destroy previous shared graphics if any
    this._streamGfx?.destroy();
    this._streamGfx = null;
    this._particleData = [];

    const network  = this.gsm.windNetwork;
    const activeId = this.gsm.currentCorridorId;

    // Single Graphics layer that will be cleared + redrawn each frame
    const gfx = this.add.graphics();
    this.mapContainer.add(gfx);
    this._streamGfx = gfx;

    for (let ci = 0; ci < network.corridors.length; ci++) {
      const corr       = network.corridors[ci]!;
      const isActive   = corr.id === activeId;
      // Scale particle count proportionally to corridor length so short
      // corridors aren't over-crowded and long ones aren't sparse.
      const lenRatio   = Math.sqrt(corr.spine.length / PARTICLE_REF_LEN);
      const baseCount  = isActive ? ACTIVE_PARTICLE_COUNT : GHOST_PARTICLE_COUNT;
      const count      = Math.max(8, Math.round(baseCount * lenRatio));
      const alpha      = isActive ? 0.60 : 0.28;
      const color      = isActive ? 0x82FFFC : corr.color;
      const travSecs   = isActive ? 40.0 : 116.0;
      const bandSpread = isActive ? BAND_SPREAD_ACTIVE : BAND_SPREAD_GHOST;
      const streakPx   = isActive ? TILE_R * 4.2 : TILE_R * 2.6;

      for (let pi = 0; pi < count; pi++) {
        const t0         = ((pi / count) + Math.random() * (1 / count)) % 1;
        const phase      = Math.random() * Math.PI * 2;
        // Gaussian lateral distribution — dense near spine centre, sparse at edges.
        const u1 = Math.random(), u2 = Math.random();
        const z  = Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2);
        const lateralT   = Math.max(-1, Math.min(1, z * 0.38));
        // Per-particle tail-length multiplier: log-normal so most are moderate
        // but occasional long wisps appear.
        const u3         = Math.random(), u4 = Math.random();
        const zl         = Math.sqrt(-2 * Math.log(u3 + 1e-9)) * Math.cos(2 * Math.PI * u4);
        const streakMult = Math.max(0.3, Math.min(2.2, Math.exp(zl * 0.45)));
        // Slow, random fade cycle: 4–14 s period.
        const fadePhase  = Math.random() * Math.PI * 2;
        const fadePeriod = (4000 + Math.random() * 10000);
        this._particleData.push({
          t: t0, speed: 1.0 / travSecs, corridorIdx: ci,
          phase, lateralT, bandSpread, color, alpha, streakPx,
          streakMult, fadePhase, fadePeriod,
        });
      }
    }
  }

  /** Get interpolated pixel position at fractional spine index t in [0..1]. */
  private _spinePixel(corr: WindCorridor, t: number): { x: number; y: number } {
    const spine = corr.spine;
    if (spine.length === 0) return { x: 0, y: 0 };
    const raw = t * (spine.length - 1);
    const lo  = Math.floor(raw);
    const hi  = Math.min(lo + 1, spine.length - 1);
    const fr  = raw - lo;
    const a   = tilePx(spine[lo]!.q, spine[lo]!.r);
    const b   = tilePx(spine[hi]!.q, spine[hi]!.r);
    // Wrap-seam guard: adjacent spine hexes on opposite world edges produce a
    // pixel delta hundreds of tiles wide.  Interpolating between them draws a
    // line straight through the map centre.  Snap to the nearer endpoint so
    // the pts gap-break in update() can detect and clip the seam instead.
    const sdx = b.x - a.x, sdy = b.y - a.y;
    if (sdx * sdx + sdy * sdy > (TILE_R * 4) * (TILE_R * 4)) {
      return fr < 0.5 ? a : b;
    }
    return { x: a.x + sdx * fr, y: a.y + sdy * fr };
  }

  update(time: number, delta: number): void {
    const dt      = delta / 1000;
    const network = this.gsm.windNetwork;
    const gfx     = this._streamGfx;
    if (!gfx) return;

    // ── Gently bob the city sprite (suppressed during movement tween) ───────────────
    if (this._citySprite && this._citySprite.alpha > 0 && !this._cityMoving) {
      this._citySprite.y = this._cityBobBaseY + Math.sin(time * 0.0005) * TILE_R * 0.12;
    }

    gfx.clear();

    // Number of spine samples that make up the curved tail (excluding head).
    const N_SEG = 14;

    for (const p of this._particleData) {
      p.t = (p.t + p.speed * dt) % 1;
      const corr = network.corridors[p.corridorIdx];
      if (!corr || corr.spine.length < 2) continue;

      // Per-particle streak length with individual multiplier.
      const effectiveStreak = p.streakPx * p.streakMult;
      const spineApproxPx   = corr.spine.length * TILE_R * 1.5;
      const tStep           = Math.min(effectiveStreak / spineApproxPx / N_SEG, 0.010);

      // Slow fade-in/out: smooth sine, always positive [0..1].
      const fadeAlpha = 0.5 + 0.5 * Math.sin(time / p.fadePeriod * Math.PI * 2 + p.fadePhase);
      const drawAlpha = p.alpha * fadeAlpha;

      // Lateral offset: static strip + slow turbulent drift
      const drift  = Math.sin(time * SWIRL_FREQ + p.phase) * STREAM_DRIFT;
      const offset = p.lateralT * p.bandSpread + drift;

      // Sample N_SEG+1 world positions — CLAMPED to [0,1], never wrapping.
      // This means a particle near t=0 has a shorter tail, which is fine and
      // completely avoids the straight-line artefact at the seam.
      // Adaptive tangent half-window: spans ≥ 2 hex-steps so the pixel delta
      // between back/forward samples is always non-trivial.  Computed once per
      // particle, outside the tail-sample loop.
      const halfWin = Math.max(0.040, 2.0 / (corr.spine.length - 1));

      const pts: Array<{ x: number; y: number }> = [];
      for (let i = N_SEG; i >= 0; i--) {
        const ts = Math.max(0, p.t - i * tStep);

        const tsBk  = Math.max(0,   ts - halfWin);
        const tsFw  = Math.min(1.0, ts + halfWin);
        const sBk   = this._spinePixel(corr, tsBk);
        const sFw   = this._spinePixel(corr, tsFw);
        const dx = sFw.x - sBk.x;
        const dy = sFw.y - sBk.y;
        // Genuine world-wrap artifacts produce pixel deltas of 1000+ px
        // (world diameter = ~1440 px).  Legitimate tangent windows are ≤ ~200 px.
        // Using TILE_R * 30 = 360 px gives a safe gap between the two.
        const dlRaw = Math.sqrt(dx * dx + dy * dy);
        const isWrapStraddle = dlRaw > TILE_R * 30;
        const dl = isWrapStraddle ? 1 : (dlRaw || 1);
        const px = isWrapStraddle ? 0 : -dy / dl;
        const py = isWrapStraddle ? 0 :  dx / dl;
        const spos = this._spinePixel(corr, ts);
        // Abort tail early if we crossed a world-wrap point (large pixel gap).
        if (pts.length > 0) {
          const prev = pts[pts.length - 1]!;
          const gx = spos.x - prev.x, gy = spos.y - prev.y;
          if (gx * gx + gy * gy > (TILE_R * 8) * (TILE_R * 8)) break;
        }
        pts.push({ x: spos.x + px * offset, y: spos.y + py * offset });

        // Stop adding tail samples once we've hit the spine start.
        if (ts === 0) break;
      }
      if (pts.length < 2) continue;

      // Draw segments: quadratic alpha fade * per-particle fade envelope.
      // At low zoom particles become brighter/thicker to stay visible.
      const zT     = Phaser.Math.Clamp(
        (this.currentZoom - MIN_ZOOM) / (INITIAL_ZOOM - MIN_ZOOM), 0, 1);
      const pBoost = 1 + (1 - zT) * 1.5;   // up to 2.5× at min zoom

      // Boost brightness on the hovered corridor (skip the active corridor —
      // it's already the brightest).
      const isHovered  = !!this._hoveredCorridorId && corr.id === this._hoveredCorridorId;
      const isActive   = corr.id === this.gsm.currentCorridorId;
      const hoverBoost = (isHovered && !isActive) ? 2.8 : 1.0;

      for (let si = 0; si < pts.length - 1; si++) {
        const frac = si / (pts.length - 1);   // 0 = near tail, 1 = near head
        const segA = Math.min(1, drawAlpha * pBoost * hoverBoost * (frac * frac));
        const w    = Math.min(2.0, (0.5 + frac * 1.0) * Math.min(pBoost, 1.6) * (isHovered && !isActive ? 1.4 : 1.0));
        if (segA < 0.012) continue;
        gfx.lineStyle(w, p.color, segA);
        gfx.lineBetween(pts[si]!.x, pts[si]!.y, pts[si + 1]!.x, pts[si + 1]!.y);
      }
    }
  }

  // ── Cycle advance + junction logic ────────────────────────────────────────

  /** Called when the player clicks "End Cycle". Advances city and checks for junction. */
  private _onEndCycleTick(): void {
    if (this._cityMoving) return;
    this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
    this.heroSystem.advanceCycleStatuses();
    this._doAdvanceTick();
  }

  /**
   * Core advance-and-animate step, shared by End Cycle and junction resolution.
   * Assumes corridor / GSM are already in the desired state before calling.
   * Does NOT run the evolution pass — callers are responsible for that.
   */
  private _doAdvanceTick(): void {
    // Capture the path BEFORE advancing so we can animate the orb through the waypoints.
    const corrPre = this.gsm.windNetwork.corridors.find(c => c.id === this.gsm.currentCorridorId);
    const fromIdx = this.gsm.currentSpineIndex;
    const fromHex = corrPre?.spine[fromIdx] ?? this.gsm.cityHex;

    this.tradewindSystem.advanceCityAlongCorridor();
    const toIdx = this.gsm.currentSpineIndex;

    // Waypoints: the hexes the city passes through this cycle (inclusive of start and end).
    const waypoints: Array<{ x: number; y: number }> =
      (corrPre && toIdx > fromIdx)
        ? corrPre.spine.slice(fromIdx, toIdx + 1).map(h => tilePx(h.q, h.r))
        : [tilePx(this.gsm.cityHex.q, this.gsm.cityHex.r)];

    // Rebuild world state at the destination immediately.
    this._buildFogOverlay();
    this._discoverReachableHexes();
    this._buildGameTiles();
    this._updateLabelVisibility();
    this._previewGfx?.clear();

    if (waypoints.length < 2) {
      this._reachOutlineGfx?.setAlpha(1);
      this.endCycleBtn?.setVisible(true).setAlpha(1).setInteractive({ useHandCursor: true });
      this._endCycleBtnGfx?.setVisible(true).setAlpha(1);
      this._endCycleBtnSubLbl?.setVisible(true).setAlpha(1);
      this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Hex Map');
      if (this.tradewindSystem.isAtJunction()) this._showJunctionModal();
      return;
    }

    // The destination ring is rebuilt immediately, but stays hidden until the
    // travel animation reaches the new position.
    this._reachOutlineGfx?.setAlpha(0);

    // Lock input and dim button during travel.
    this._cityMoving = true;
    this.endCycleBtn?.setVisible(true).setAlpha(0.35).disableInteractive();
    this._endCycleBtnGfx?.setVisible(true).setAlpha(0.35);
    this._endCycleBtnSubLbl?.setVisible(true).setAlpha(0.35);
    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Moving…');

    this._animateCityMove(waypoints, fromHex, () => {
      this._cityMoving = false;
      this.endCycleBtn?.setAlpha(1).setInteractive({ useHandCursor: true });
      this._endCycleBtnGfx?.setAlpha(1);
      this._endCycleBtnSubLbl?.setAlpha(1);
      this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Hex Map');
      if (this.tradewindSystem.isAtJunction()) this._showJunctionModal();
    });
  }

  /**
   * Animate the city orb and sprite from waypoints[0] through to waypoints[last].
   * The city graphics were already rebuilt at the destination by _onEndCycleTick;
   * this offsets them back to the start and tweens them forward step by step.
   * On completion pans the camera to re-centre on the new city hex, then calls onComplete.
   */
  private _animateCityMove(
    waypoints: Array<{ x: number; y: number }>,
    fromHex: AxialCoord,
    onComplete: () => void,
  ): void {
    const toPx   = waypoints[waypoints.length - 1]!;
    const fromPx = waypoints[0]!;

    // Offset city visuals back to the starting pixel before the tween begins.
    if (this.cityDot) {
      this.cityDot.x = fromPx.x - toPx.x;
      this.cityDot.y = fromPx.y - toPx.y;
    }
    if (this._citySprite) {
      this._citySprite.x = fromPx.x;
      this._citySprite.y = fromPx.y;
      this._cityBobBaseY  = fromPx.y;
    }

    // Build Catmull-Rom control points: duplicate endpoints so the spline
    // passes exactly through first and last waypoints without curl.
    const pts = [fromPx, ...waypoints, toPx];

    /**
     * Sample the Catmull-Rom spline for global t ∈ [0,1].
     * `pts` has N+2 entries (first/last duplicated); the N segments are pts[1..N].
     */
    const sampleCR = (t: number): { x: number; y: number } => {
      const n   = pts.length - 3;   // number of curve segments
      const seg = Math.min(Math.floor(t * n), n - 1);
      const lt  = t * n - seg;      // local t within this segment [0..1]
      const p0  = pts[seg]!;
      const p1  = pts[seg + 1]!;
      const p2  = pts[seg + 2]!;
      const p3  = pts[seg + 3]!;
      // Standard Catmull-Rom formula (α = 0.5)
      const t2  = lt * lt, t3 = t2 * lt;
      return {
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * lt
           + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
           + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * lt
           + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
           + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      };
    };

    // Wake contrail — accumulates sampled positions each frame.
    const wake   = this.add.graphics().setDepth(5);
    this.gameTileContainer.add(wake);
    const lastPt = { x: fromPx.x, y: fromPx.y };

    const oldRing = this.add.graphics();
    this._drawReachOutline(oldRing, fromHex);
    this.mapContainer.add(oldRing);
    this.mapContainer.bringToTop(oldRing);
    this._reachOutlineGfx && this.mapContainer.bringToTop(this._reachOutlineGfx);

    const proxy   = { t: 0 };
    const totalMs = Math.max(600, waypoints.length * 480);   // ~480 ms per spine step

    this.tweens.add({
      targets: oldRing,
      alpha: 0,
      duration: 220,
      ease: 'Sine.easeInOut',
      onComplete: () => oldRing.destroy(),
    });
    if (this._reachOutlineGfx) {
      this.tweens.add({
        targets: this._reachOutlineGfx,
        alpha: 1,
        delay: Math.max(0, totalMs - 220),
        duration: 220,
        ease: 'Sine.easeInOut',
      });
    }

    this.tweens.add({
      targets:  proxy,
      t:        1,
      duration: totalMs,
      ease:     'Sine.easeInOut',
      onUpdate: () => {
        const pos = sampleCR(proxy.t);
        if (this.cityDot) {
          this.cityDot.x = pos.x - toPx.x;
          this.cityDot.y = pos.y - toPx.y;
        }
        if (this._citySprite) {
          this._citySprite.x = pos.x;
          this._citySprite.y = pos.y;
          this._cityBobBaseY  = pos.y;
        }
        // Amber wake contrail — draw each segment from last sampled to current.
        wake.lineStyle(2.5, 0xf0c040, 0.40);
        wake.lineBetween(lastPt.x, lastPt.y, pos.x, pos.y);
        lastPt.x = pos.x;
        lastPt.y = pos.y;
      },
      onComplete: () => {
        // Fade out wake and pan camera simultaneously.
        this.tweens.add({ targets: wake, alpha: 0, duration: 300,
          onComplete: () => wake.destroy() });
        const W = this.scale.width;
        this.tweens.add({
          targets:  this.mapContainer,
          x: W / 2 - toPx.x * this.currentZoom,
          y: this.mapCtrY - toPx.y * this.currentZoom,
          duration: 350,
          ease:     'Sine.easeInOut',
          onUpdate: () => this._updateScreenLabelTransforms(),
          onComplete: () => {
            if (this.cityDot)     { this.cityDot.x = 0;           this.cityDot.y = 0; }
            if (this._citySprite) { this._citySprite.x = toPx.x;  this._cityBobBaseY = toPx.y; }
            this._reachOutlineGfx?.setAlpha(1);
            this._updateLabelVisibility();
            onComplete();
          },
        });
      },
    });
  }

  /** Draw a ghost preview of the next move destination; called on End Cycle button hover. */
  private _showEndCyclePreview(): void {
    if (this._cityMoving) return;
    const corr = this.gsm.windNetwork.corridors.find(c => c.id === this.gsm.currentCorridorId);
    if (!corr) return;
    this._showBranchPreview(corr, this.gsm.currentSpineIndex);
  }

  /**
   * Draw a ghost orb + dashed trail showing the next advance step for
   * `corr` starting at `fromSpineIdx`.  Used by both the End Cycle button
   * hover and the junction card hover.
   */
  private _showBranchPreview(
    corr:         WindCorridor,
    fromSpineIdx: number,
  ): void {
    if (this._cityMoving) return;
    if (corr.spine.length < 2) return;

    const preIdx = Math.min(fromSpineIdx + corr.speed, corr.spine.length - 1);
    if (preIdx === fromSpineIdx) return; // at terminus — nothing to preview

    if (!this._previewGfx) {
      this._previewGfx = this.add.graphics().setDepth(12);
      this.mapContainer.add(this._previewGfx);
    }
    this._previewGfx.clear();
    const gfx = this._previewGfx;

    // Ghost orb at the destination.
    const { x: px, y: py } = tilePx(corr.spine[preIdx]!.q, corr.spine[preIdx]!.r);
    gfx.fillStyle(0xf7c948, 0.04); gfx.fillCircle(px, py, TILE_R * 0.95);
    gfx.fillStyle(0xf7c948, 0.10); gfx.fillCircle(px, py, TILE_R * 0.65);
    gfx.fillStyle(0xf7c948, 0.22); gfx.fillCircle(px, py, TILE_R * 0.38);
    gfx.fillStyle(0xffffff,  0.40); gfx.fillCircle(px, py, TILE_R * 0.14);

    // Dashed trail from fromSpineIdx to preview destination.
    for (let si = fromSpineIdx; si < preIdx; si++) {
      const a  = tilePx(corr.spine[si]!.q,     corr.spine[si]!.r);
      const b  = tilePx(corr.spine[si + 1]!.q, corr.spine[si + 1]!.r);
      const dx = b.x - a.x, dy = b.y - a.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      const DASH = 4, GAP = 4;
      for (let d = 0; d < segLen; d += DASH + GAP) {
        const t0 = d / segLen;
        const t1 = Math.min((d + DASH) / segLen, 1);
        gfx.lineStyle(1.5, 0xf7c948, 0.40);
        gfx.lineBetween(a.x + dx * t0, a.y + dy * t0, a.x + dx * t1, a.y + dy * t1);
      }
    }
  }

  /** Slide the junction panel off-screen (down) then destroy it. */
  private _dismissJunctionModal(onDone?: () => void): void {
    if (!this.routeOverlay) { onDone?.(); return; }
    const H       = this.scale.height;
    const PANEL_H = Math.min(Math.floor(H * 0.42), 330);
    const overlay = this.routeOverlay;
    this.routeOverlay = null; // prevent re-entry immediately
    this.tweens.add({
      targets:  overlay,
      y:        PANEL_H,
      duration: 180,
      ease:     'Sine.easeIn',
      onComplete: () => { overlay.destroy(true); onDone?.(); },
    });
  }

  /**
   * Show a bottom panel listing corridors available at the upcoming junction.
   * The player can switch to a different current or stay on the current one.
   */
  private _showJunctionModal(): void {
    if (this.routeOverlay) return;

    // Reset button-hover flag — it may be true if the player clicked End Cycle
    // to reach this junction (pointer was over the button at click time).
    this._overEndCycleBtn = false;

    const result = this.tradewindSystem.getUpcomingJunction();
    if (!result) return;

    // Only offer corridors where the wind is still blowing forward from this point.
    const forwardOptions = result.options.filter(o => o.direction === 'forward');

    // If there are no actual switch options (all alternate corridors are at
    // their terminal end), silently dismiss — the player stays on course.
    if (forwardOptions.length === 0) return;

    const W = this.scale.width;
    const H = this.scale.height;

    this.routeOverlay = this.add.container(0, 0).setDepth(50);
    const PANEL_H = Math.min(Math.floor(H * 0.42), 330);
    const panelY  = H - PANEL_H;

    // ── Backdrop ──────────────────────────────────────────────────────
    const backdrop = this.add.graphics();
    backdrop.fillStyle(0x010810, 0.97);
    backdrop.fillRect(0, panelY, W, PANEL_H);
    // Top accent: two-pass glow border
    backdrop.lineStyle(6, 0x1a4a6a, 0.30);
    backdrop.lineBetween(0, panelY, W, panelY);
    backdrop.lineStyle(1.5, 0x2a6a9a, 0.90);
    backdrop.lineBetween(0, panelY, W, panelY);
    this.routeOverlay.add(backdrop);

    // ── Header ───────────────────────────────────────────────────────
    this.routeOverlay.add(
      this.add.text(W / 2, panelY + 14,
        '⬡  WIND JUNCTION  ⬡', {
          fontSize: '18px', color: '#4a8aaa', fontFamily: 'monospace', fontStyle: 'bold',
        }).setOrigin(0.5, 0),
    );
    this.routeOverlay.add(
      this.add.text(W / 2, panelY + 38,
        'Choose your current — you will advance one step immediately', {
          fontSize: '12px', color: '#2a4a5a', fontFamily: 'monospace',
        }).setOrigin(0.5, 0),
    );

    // ── Build card list ────────────────────────────────────────────────
    const activeCorrId   = this.gsm.currentCorridorId;
    const activeCorridor = this.gsm.windNetwork.corridors.find(c => c.id === activeCorrId);
    const curSpineIdx    = this.gsm.currentSpineIndex;

    type CardData = {
      name: string; speed: number; color: number;
      corridorId: string | null;
      hexesAhead: number;
      previewSpineIdx: number;
    };
    const allCards: CardData[] = [];

    if (activeCorridor) {
      const hexesAhead = activeCorridor.spine.length - 1 - curSpineIdx;
      allCards.push({
        name: activeCorridor.name, speed: activeCorridor.speed,
        color: 0xf7c948, corridorId: null, hexesAhead,
        previewSpineIdx: curSpineIdx,
      });
    }
    for (const opt of forwardOptions) {
      const hexesAhead = opt.corridor.spine.length - 1 - opt.spineIndex;
      allCards.push({
        name: opt.corridor.name, speed: opt.corridor.speed,
        color: opt.corridor.color, corridorId: opt.corridor.id, hexesAhead,
        previewSpineIdx: opt.spineIndex,
      });
    }

    const cardW  = 260;
    const cardH  = Math.min(Math.floor(PANEL_H * 0.80), 190);
    const gap    = 18;
    const totalW = allCards.length * (cardW + gap) - gap;
    const startX = Math.max(20, (W - totalW) / 2);
    const startY = panelY + 58;
    const STRIP  = 40;  // colour-band height at card top

    for (let ci = 0; ci < allCards.length; ci++) {
      const card   = allCards[ci]!;
      const x      = startX + ci * (cardW + gap);
      const isStay = card.corridorId === null;
      const col    = card.color;

      const corrObj = isStay
        ? activeCorridor
        : this.gsm.windNetwork.corridors.find(c => c.id === card.corridorId);

      const gcard = this.add.graphics();
      const drawCard = (hov: boolean) => {
        gcard.clear();
        // Card body
        gcard.fillStyle(0x050e1e, hov ? 0.98 : 0.88);
        gcard.fillRoundedRect(x, startY, cardW, cardH, 8);
        // Top colour strip
        gcard.fillStyle(col, hov ? 0.28 : 0.18);
        gcard.fillRoundedRect(x, startY, cardW, STRIP,
          { tl: 8, tr: 8, bl: 0, br: 0 } as unknown as number);
        // Left accent bar
        gcard.fillStyle(col, hov ? 1.0 : 0.70);
        gcard.fillRoundedRect(x, startY, 4, cardH,
          { tl: 8, tr: 0, bl: 8, br: 0 } as unknown as number);
        // Border
        if (hov) {
          // Wide soft glow
          gcard.lineStyle(8, col, 0.15);
          gcard.strokeRoundedRect(x - 2, startY - 2, cardW + 4, cardH + 4, 10);
        }
        gcard.lineStyle(hov ? 2.5 : 1.5, hov ? col : col, hov ? 0.95 : 0.35);
        gcard.strokeRoundedRect(x, startY, cardW, cardH, 8);
        // Divider above action area
        gcard.lineStyle(1, col, hov ? 0.25 : 0.12);
        gcard.lineBetween(x + 12, startY + cardH - 36, x + cardW - 12, startY + cardH - 36);
      };
      drawCard(false);
      this.routeOverlay!.add(gcard);

      // Current name in the colour strip
      const nameLabel = this.add.text(x + cardW / 2, startY + STRIP / 2, card.name, {
        fontSize: '17px', color: '#' + col.toString(16).padStart(6, '0'),
        fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5);

      // Route detail
      const hexN     = card.hexesAhead;
      const hexWord  = hexN === 1 ? '1 hex ahead' : `${hexN} hexes ahead`;
      const subLine  = isStay ? hexWord : `board here  ·  ${hexWord}`;
      const subLabel = this.add.text(x + 16, startY + STRIP + 10, subLine, {
        fontSize: '13px', color: '#6090a0', fontFamily: 'monospace',
      }).setOrigin(0, 0);

      // Speed pips
      const pips      = '◆'.repeat(card.speed) + '◇'.repeat(Math.max(0, 3 - card.speed));
      const speedWord = card.speed === 1 ? 'slow' : card.speed === 2 ? 'steady' : 'swift';
      const colHex    = '#' + col.toString(16).padStart(6, '0');
      const speedLabel = this.add.text(x + 16, startY + STRIP + 32, pips + '  ' + speedWord, {
        fontSize: '14px', color: colHex, fontFamily: 'monospace',
      }).setOrigin(0, 0);

      // Bottom action label
      const actionText = isStay ? '▼  HOLD COURSE' : '▶  BOARD CURRENT';
      const actionCol  = isStay ? '#776040' : '#3a80a0';
      const actionLabel = this.add.text(x + cardW / 2, startY + cardH - 18, actionText, {
        fontSize: '13px', color: actionCol, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5, 0.5);

      for (const t of [nameLabel, subLabel, speedLabel, actionLabel]) {
        this.routeOverlay!.add(t);
      }

      const hit = this.add.zone(x + cardW / 2, startY + cardH / 2, cardW, cardH)
        .setInteractive({ useHandCursor: true });
      this.routeOverlay!.add(hit);

      hit.on('pointerover', () => {
        drawCard(true);
        if (corrObj) {
          this._onCorridorHover(corrObj);
          this._showBranchPreview(corrObj, card.previewSpineIdx);
        }
      });
      hit.on('pointerout', () => {
        drawCard(false);
        this._onCorridorOut();
        this._previewGfx?.clear();
      });
      hit.on('pointerdown', () => {
        this._onCorridorOut();
        this._previewGfx?.clear();
        if (card.corridorId) {
          // Branch switch: switch corridor then immediately advance one cycle.
          this._dismissJunctionModal(() => {
            this.tradewindSystem.switchCorridor(card.corridorId!);
            this._renderWindNetwork();
            this._buildParticles();
            this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
            this.heroSystem.advanceCycleStatuses();
            this._doAdvanceTick();
          });
        } else {
          // Stay — advance one cycle on the current corridor immediately.
          this._dismissJunctionModal(() => {
            this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
            this.heroSystem.advanceCycleStatuses();
            this._doAdvanceTick();
          });
        }
      });
    }

    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Wind Junction');
    this.endCycleBtn?.setVisible(false);
    this._endCycleBtnGfx?.setVisible(false);
    this._endCycleBtnSubLbl?.setVisible(false);

    // Slide panel up from off-screen bottom.
    this.routeOverlay.y = PANEL_H;
    this.tweens.add({ targets: this.routeOverlay, y: 0, duration: 220, ease: 'Back.easeOut' });
  }

  /**
   * Switch corridor and advance immediately — kept for any external callers.
   * Direct card clicks in _showJunctionModal now inline this logic.
   */
  private _applyCorridorSwitch(corridorId: string): void {
    this._onCorridorOut();
    this._previewGfx?.clear();
    this._dismissJunctionModal(() => {
      this.tradewindSystem.switchCorridor(corridorId);
      this._renderWindNetwork();
      this._buildParticles();
      this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
      this.heroSystem.advanceCycleStatuses();
      this._doAdvanceTick();
    });
  }

  /**
   * Draw a distance-based dark veil between the terrain and the corridor
   * network.  Tiles near the city stay bright; distant tiles fade to near-black,
   * making the corridor colours much easier to read.
   * Inserted at mapContainer index 1 (above terrain, below corridors).
   */
  private _buildFogOverlay(): void {
    if (this._fogGfx) {
      this._fogGfx.destroy();
      this._fogGfx = null;
    }
    const { q: cq, r: cr } = this.gsm.cityHex;
    const gfx = this.add.graphics();

    for (let q = -WORLD_RADIUS; q <= WORLD_RADIUS; q++) {
      for (let r = -WORLD_RADIUS; r <= WORLD_RADIUS; r++) {
        if (Math.abs(-q - r) > WORLD_RADIUS) continue;
        const d = hexDistance({ q, r }, { q: cq, r: cr });
        if (d <= 6) continue;                                    // full brightness near city
    const alpha = Math.min(0.45, (d - 6) / 32 * 0.45);     // ramp to 45% black at dist 38+
        const { x, y } = tilePx(q, r);
        gfx.fillStyle(0x000000, alpha);
        gfx.fillPoints(tilePts(x, y), true);
      }
    }

    // Always sits at z-index 1 — above terrain (0), below corridor network (2+)
    this.mapContainer.addAt(gfx, 1);
    this._fogGfx = gfx;
  }

  private _renderHintLine(W: number, H: number, hintH: number): void {
    const bar = this.add.graphics();
    bar.fillStyle(0x000000, 0.50);
    bar.fillRect(0, H - hintH, W, hintH);
    bar.lineStyle(1, 0x0e1e2e, 1.0);
    bar.lineBetween(0, H - hintH, W, H - hintH);

    // Cycle / state label — left side of hint bar.
    this.titleText = this.add.text(12, H - hintH / 2,
      'Cycle ' + this.gsm.cycleCount + '  —  Hex Map', {
        fontSize: '11px', color: '#334455', fontFamily: 'monospace',
      }).setOrigin(0, 0.5);

    // Zoom hint — right of centre.
    const zStr = this.currentZoom.toFixed(1);
    this.zoomHintText = this.add.text(W / 2 + 40, H - hintH / 2,
      'Scroll to zoom   ·   Drag to pan   (zoom: ' + zStr + 'x)', {
        fontSize: '11px', color: '#334455', fontFamily: 'monospace',
      }).setOrigin(0.5);
  }

  private _renderEndCycleButton(W: number, H: number): void {
    const UI_BAR_H = 56;  // UIScene's persistent resource bar height (rendered above this scene)
    const bw = 240;
    const bh = 72;
    // Sit the button directly on top of UIScene's bar (which always renders above this scene).
    const bx = W - bw - 22;
    const by = H - UI_BAR_H - bh;

    const DEPTH = 60;  // above hint bar (scene depth order)
    const btnBg = this.add.graphics().setDepth(DEPTH);
    this._endCycleBtnGfx = btnBg;

    const drawBg = (hov: boolean) => {
      btnBg.clear();
      const gc = hov ? 0xffe066 : 0xffaa33;  // glow colour

      // ── outer soft glow halos ──────────────────────────────────────────
      for (let gi = 7; gi >= 1; gi--) {
        const sp = gi * 4;
        btnBg.lineStyle(2.5, gc, (8 - gi) * (hov ? 0.038 : 0.020));
        btnBg.strokeRoundedRect(bx - sp, by - sp, bw + sp * 2, bh + sp * 2, 12 + sp);
      }

      // ── main fill ─────────────────────────────────────────────────────
      btnBg.fillStyle(hov ? 0x0e1a06 : 0x05090f, hov ? 0.98 : 0.95);
      btnBg.fillRoundedRect(bx, by, bw, bh, 10);

      // ── inner top highlight gradient strip ───────────────────────────
      btnBg.fillStyle(gc, hov ? 0.12 : 0.06);
      btnBg.fillRoundedRect(bx + 3, by + 3, bw - 6, bh * 0.35, { tl:8, tr:8, bl:0, br:0 } as unknown as number);

      // ── corner ornaments (small filled diamonds at each corner) ───────
      const diamonds = [
        { x: bx + 8,        y: by + bh / 2 },  // left mid
        { x: bx + bw - 8,   y: by + bh / 2 },  // right mid
      ];
      for (const d of diamonds) {
        const s = hov ? 5.5 : 4.5;
        btnBg.fillStyle(gc, hov ? 1.0 : 0.65);
        btnBg.fillTriangle(
          d.x, d.y - s,
          d.x + s, d.y,
          d.x, d.y + s,
        );
        btnBg.fillTriangle(
          d.x, d.y - s,
          d.x - s, d.y,
          d.x, d.y + s,
        );
      }

      // ── decorative rule lines ─────────────────────────────────────────
      const cx = bx + bw / 2;
      const ruleY = by + bh - 11;
      btnBg.lineStyle(1, gc, hov ? 0.50 : 0.22);
      btnBg.lineBetween(bx + 26, ruleY, cx - 24, ruleY);
      btnBg.lineBetween(cx + 24, ruleY, bx + bw - 26, ruleY);
      // small centre dot on rule
      btnBg.fillStyle(gc, hov ? 0.90 : 0.50);
      btnBg.fillCircle(cx, ruleY, hov ? 2.5 : 1.8);

      // ── primary border ────────────────────────────────────────────────
      btnBg.lineStyle(hov ? 2.5 : 1.8, gc, hov ? 1.0 : 0.75);
      btnBg.strokeRoundedRect(bx, by, bw, bh, 10);
    };
    drawBg(false);

    this.endCycleBtn = this.add.text(bx + bw / 2, by + bh / 2 - 4, 'END CYCLE', {
      fontSize: '22px', color: '#ffaa33', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 1).setInteractive({ useHandCursor: true });

    // small sub-label (tracked so dim/hide logic stays in sync)
    this._endCycleBtnSubLbl = this.add.text(bx + bw / 2, by + bh - 16, '▶  A D V A N C E  ▶', {
      fontSize: '10px', color: '#88663a', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(DEPTH + 1);

    this.endCycleBtn.on('pointerover', () => {
      this._overEndCycleBtn = true;
      this._onCorridorOut();
      this.endCycleBtn.setColor('#ffe066');
      this._endCycleBtnSubLbl?.setColor('#bb9955');
      drawBg(true);
      this._showEndCyclePreview();
    });
    this.endCycleBtn.on('pointerout', () => {
      this._overEndCycleBtn = false;
      this.endCycleBtn.setColor('#ffaa33');
      this._endCycleBtnSubLbl?.setColor('#88663a');
      drawBg(false);
      this._previewGfx?.clear();
    });
    this.endCycleBtn.on('pointerdown', () => this._onEndCycleTick());
  }

  private _openPartySelection(tile: HexTile): void {
    if (this.modalContainer) return;
    const W = this.scale.width;
    const H = this.scale.height;
    const modalW = 560; const modalH = 480;
    const mx = (W - modalW) / 2; const my = (H - modalH) / 2;

    this.modalContainer = this.add.container(0, 0).setDepth(100);
    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.60); dim.fillRect(0, 0, W, H);
    dim.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    this.modalContainer.add(dim);

    const panel = this.add.graphics();
    panel.fillStyle(0x1a1a2e, 0.95); panel.fillRoundedRect(mx, my, modalW, modalH, 10);
    panel.lineStyle(2, 0x4488cc, 1); panel.strokeRoundedRect(mx, my, modalW, modalH, 10);
    this.modalContainer.add(panel);

    const display = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
    this.modalContainer.add(this.add.text(mx + modalW / 2, my + 20,
      tile.siteType.toUpperCase() + ' -- ' + tile.id, {
        fontSize: '16px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));
    this.modalContainer.add(this.add.text(mx + 20, my + 45,
      'Danger: ' + tile.dangerLevel + '   State: ' + tile.siteState + '   Type: ' + display.label, {
        fontSize: '11px', color: '#aaaaaa', fontFamily: 'monospace',
      }));
    this.modalContainer.add(this.add.text(mx + 20, my + 70, 'Select Active Hero:', {
      fontSize: '12px', color: '#66ccff', fontFamily: 'monospace',
    }));

    const available       = this.heroSystem.getAvailable();
    let selectedActiveId:  string | null = null;
    let selectedSupportId: string | null = null;

    available.forEach((hero) => {
      const btnY = my + 118 + available.indexOf(hero) * 36;
      const btn  = this.add.text(mx + 36, btnY,
        hero.name + ' (' + hero.heroClass + ')  C:' + hero.stats.combat +
        ' E:' + hero.stats.exploration + ' D:' + hero.stats.diplomacy,
        { fontSize: '16px', color: '#cccccc', fontFamily: 'monospace' })
        .setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        if (selectedActiveId) return;
        selectedActiveId = hero.id;
        btn.setColor('#66ff66');
        btn.setText('> ' + hero.name + ' (ACTIVE)');
        this._addSupportPrompt(
          mx, my, modalW, available, selectedActiveId, selectedSupportId,
          (sid) => { selectedSupportId = sid; },
          () => this._confirmParty(tile, selectedActiveId!, selectedSupportId),
        );
      });
      this.modalContainer!.add(btn);
    });

    if (available.length === 0) {
      this.modalContainer.add(this.add.text(mx + 36, my + 118, 'No heroes available!', {
        fontSize: '17px', color: '#ff6666', fontFamily: 'monospace',
      }));
    }

    const cancelBtn = this.add.text(mx + modalW / 2, my + modalH - 28, '[ Cancel ]', {
      fontSize: '20px', color: '#ff6666', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerdown', () => this._closeModal());
    this.modalContainer.add(cancelBtn);
  }

  private _addSupportPrompt(
    mx: number, my: number, modalW: number,
    heroes: Hero[],
    activeId: string,
    _cur: string | null,
    onSelect: (id: string | null) => void,
    onConfirm: () => void,
  ): void {
    if (!this.modalContainer) return;
    const supportHeroes = heroes.filter(h => h.id !== activeId);
    const promptY = my + 280;

    this.modalContainer.add(this.add.text(mx + 24, promptY, 'Support hero (optional):', {
      fontSize: '18px', color: '#66ccff', fontFamily: 'monospace',
    }));

    supportHeroes.forEach((hero, i) => {
      const btn = this.add.text(mx + 36, promptY + 28 + i * 30,
        hero.name + ' (' + hero.heroClass + ')',
        { fontSize: '16px', color: '#cccccc', fontFamily: 'monospace' })
        .setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => {
        btn.setColor('#6699ff');
        btn.setText('>> ' + hero.name + ' (SUPPORT)');
        onSelect(hero.id);
      });
      this.modalContainer!.add(btn);
    });

    const goBtn = this.add.text(mx + modalW / 2, promptY + 110, '[ Launch Mission ]', {
      fontSize: '20px', color: '#66ff66', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    goBtn.on('pointerdown', () => onConfirm());
    this.modalContainer.add(goBtn);
  }

  private _confirmParty(tile: HexTile, activeId: string, supportId: string | null): void {
    const activeHero = this.heroSystem.getById(activeId);
    if (!activeHero) return;
    const supportHero = supportId ? this.heroSystem.getById(supportId) : null;
    this.heroSystem.assignToMission({ activeHeroId: activeId, supportHeroId: supportId });

    this.gsm.setMissionContext({
      missionId:       'mission_' + tile.id + '_c' + this.gsm.cycleCount,
      siteId:          tile.id,
      siteType:        tile.siteType,
      dangerLevel:     tile.dangerLevel,
      activeHeroId:    activeId,
      supportHeroId:   supportId,
      supportBonuses:  supportHero?.bonusArray ?? [],
      resourceSurface: tile.resourceSurface,
      objectives: [
        {
          id:          'obj_reach_exit',
          type:        'reach' as const,
          description: 'Reach the exit zone',
          isPrimary:   true,
        },
        {
          id:           'obj_collect',
          type:         'collect' as const,
          description:  'Gather resources',
          isPrimary:    false,
          targetAmount: tile.resourceSurface.reduce((s, r) => s + r.baseYield, 0),
        },
      ],
    });

    this._closeModal();
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { hide(): void }).hide();
    this.scene.start('MissionScene', this.services);
  }

  private _closeModal(): void {
    this.modalContainer?.destroy(true);
    this.modalContainer = null;
  }

  private _openCityView(): void {
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { hide(): void }).hide();
    this.scene.start('CityViewScene', this.services);
  }

  private _showMissionResult(): void {
    const result = this.gsm.missionResult!;
    const W = this.scale.width;
    const H = this.scale.height;
    this.resultOverlay = this.add.container(0, 0);

    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.50); dim.fillRect(0, 0, W, H);
    this.resultOverlay.add(dim);

    const panelW = 500; const panelH = 280;
    const px = (W - panelW) / 2; const py = (H - panelH) / 2;
    const panel = this.add.graphics();
    const oc = result.outcome === 'success' ? 0x33aa33
             : result.outcome === 'retreat'  ? 0xccaa33
             : 0xcc3333;
    panel.fillStyle(0x1a1a2e, 0.95); panel.fillRoundedRect(px, py, panelW, panelH, 12);
    panel.lineStyle(3, oc, 1);       panel.strokeRoundedRect(px, py, panelW, panelH, 12);
    this.resultOverlay.add(panel);

    this.resultOverlay.add(this.add.text(px + panelW / 2, py + 32,
      'Mission ' + result.outcome.toUpperCase(), {
        fontSize: '28px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5));

    const resLines = Object.entries(result.resourcesGathered)
      .filter(([, a]) => a > 0)
      .map(([id, a]) => '  ' + id + ': +' + a);
    this.resultOverlay.add(this.add.text(px + 28, py + 72,
      'Resources gathered:\n' + (resLines.length > 0 ? resLines.join('\n') : '  (none)'), {
        fontSize: '18px', color: '#aaccaa', fontFamily: 'monospace',
      }));

    for (const [id, amt] of Object.entries(result.resourcesGathered)) {
      if (amt > 0) this.resourceSystem.add(id, amt);
    }

    const dismissBtn = this.add.text(px + panelW / 2, py + panelH - 32, '[ Continue ]', {
      fontSize: '20px', color: '#66ccff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    dismissBtn.on('pointerdown', () => {
      this.resultOverlay?.destroy(true);
      this.resultOverlay = null;
      this.gsm.setMissionResult(null);
    });
    this.resultOverlay.add(dismissBtn);
    this.gsm.setMissionResult(null);
  }

  private _buildAccessibleSet(): Set<string> {
    // Pure geometric: all hexes within GAME_RADIUS of the city.
    const result = new Set<string>();
    for (const tile of this.gsm.hexMap) {
      if (hexDistance(tile.coord, this.gsm.cityHex) <= GAME_RADIUS) {
        result.add(tile.id);
      }
    }
    return result;
  }

  private _discoverReachableHexes(): void {
    // Pure geometric: discover all hexes within GAME_RADIUS of the city.
    for (const tile of this.gsm.hexMap) {
      if (
        hexDistance(tile.coord, this.gsm.cityHex) <= GAME_RADIUS &&
        tile.siteState === 'undiscovered'
      ) {
        this.gsm.updateHexTile(tile.id, { siteState: 'discovered' });
      }
    }
  }
}
