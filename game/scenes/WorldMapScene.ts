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
import type { WindCorridor, WindJunction } from '@data/WindNetwork';
import { fbm }                          from '@data/NoiseUtils';
import type { ServiceBundle }           from '../../src/main';

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
const TERRAIN_ATLAS_MANIFEST_KEY = 'terrain_atlas_manifest';
const TERRAIN_ATLAS_TEXTURE_PREFIX = 'terrain_atlas_';
const TERRAIN_TILE_FALLBACK_CORE_RADIUS = 1 / 3;
/** Minimum zoom at which terrain art sprites are created — below this only color fills show. */
const TERRAIN_ART_MIN_ZOOM = LABEL_ZOOM * 1.00; // = 3.5 — only kicks in once fully zoomed into the interactive layer

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
 * Returns a terrain biome bucket for world hex (q, r).
 *
 * Elevation = FBM + a continental-shelf boost that raises the centre of the
 * world above sea level, guaranteeing land near the city regardless of noise.
 * Moisture is an independent FBM channel controlling vegetation type.
 */
type TerrainBiome =
  | 'abyssal_trench'
  | 'deep_ocean'
  | 'open_ocean'
  | 'shallow_sea'
  | 'mangrove'
  | 'sand_beach'
  | 'snow_peaks'
  | 'bare_rock'
  | 'alpine'
  | 'dense_rainforest'
  | 'temperate_forest'
  | 'woodland'
  | 'plains'
  | 'savanna'
  | 'scrub_steppe'
  | 'desert_dunes';

interface TerrainAtlasCoreHex {
  centerX: number;
  centerY: number;
  radius: number;
  squashY: number;
  topOverflow: number;
}

interface TerrainAtlasManifestAsset {
  id: string;
  terrainType: TerrainBiome;
  variant: number;
  frameKey: string;
  coreHex?: TerrainAtlasCoreHex;
}

interface TerrainAtlasManifestEntry {
  group: string;
  imageRelativePath: string;
  dataRelativePath: string;
  tileCount: number;
  columns: number;
  rows: number;
  cellSize: { width: number; height: number };
  terrainTypes: TerrainBiome[];
  assets: TerrainAtlasManifestAsset[];
}

interface TerrainAtlasManifest {
  generatedAt: string;
  atlases: TerrainAtlasManifestEntry[];
}

interface TerrainAtlasVariant {
  textureKey: string;
  frameKey: string;
  terrainType: TerrainBiome;
  variant: number;
  coreHex: TerrainAtlasCoreHex;
  frameWidth: number;
  frameHeight: number;
}

function worldTileBiome(q: number, r: number): TerrainBiome {
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
  if (e < 0.08) return 'abyssal_trench';
  if (e < 0.18) return 'deep_ocean';
  if (e < 0.28) return 'open_ocean';
  if (e < 0.36) return 'shallow_sea';
  if (e < 0.42) return m > 0.52 ? 'mangrove' : 'sand_beach';

  // ── Alpine ───────────────────────────────────────────────
  if (e > 0.90) return 'snow_peaks';
  if (e > 0.78) return m < 0.38 ? 'bare_rock' : 'alpine';

  // ── Mainland (by moisture) ────────────────────────────────
  if (m > 0.74) return e > 0.64 ? 'dense_rainforest' : 'temperate_forest';
  if (m > 0.60) return e > 0.64 ? 'temperate_forest' : 'woodland';
  if (m > 0.48) return e > 0.63 ? 'woodland' : 'plains';
  if (m > 0.36) return e > 0.62 ? 'plains' : 'savanna';
  if (m > 0.24) return e > 0.60 ? 'savanna' : 'scrub_steppe';
  if (m > 0.14) return e > 0.58 ? 'scrub_steppe' : 'desert_dunes';
  return 'desert_dunes';
}

const TERRAIN_BIOME_COLORS: Record<TerrainBiome, number> = {
  abyssal_trench:   0x020c18,
  deep_ocean:       0x071828,
  open_ocean:       0x0d2e52,
  shallow_sea:      0x165c80,
  mangrove:         0x2a8060,
  sand_beach:       0xb8aa72,
  snow_peaks:       0xdce8f0,
  bare_rock:        0x7c6a50,
  alpine:           0x606858,
  dense_rainforest: 0x1e6828,
  temperate_forest: 0x347838,
  woodland:         0x4e9040,
  plains:           0x96c840,
  savanna:          0xb0b038,
  scrub_steppe:     0xc8a84a,
  desert_dunes:     0xe0b85a,
};

function worldTileColor(q: number, r: number): number {
  return TERRAIN_BIOME_COLORS[worldTileBiome(q, r)];
}

/** Lighten a packed 0xRRGGBB colour by adding `amount` to each channel. */
function lightenColor(col: number, amount: number): number {
  const r = Math.min(255, ((col >> 16) & 0xff) + amount);
  const g = Math.min(255, ((col >>  8) & 0xff) + amount);
  const b = Math.min(255, ( col        & 0xff) + amount);
  return (r << 16) | (g << 8) | b;
}

/** Darken a packed 0xRRGGBB colour by subtracting `amount` from each channel. */
function darkenColor(col: number, amount: number): number {
  const r = Math.max(0, ((col >> 16) & 0xff) - amount);
  const g = Math.max(0, ((col >>  8) & 0xff) - amount);
  const b = Math.max(0, ( col        & 0xff) - amount);
  return (r << 16) | (g << 8) | b;
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

function stableHexHash(q: number, r: number): number {
  // Cantor pairing → single integer, then MurmurHash3 finalizer for full avalanche mixing.
  // The final >>> 0 is required: bitwise XOR returns a signed 32-bit int, which would make
  // hash % n negative, producing invalid array indices and missing tile sprites.
  const k = (q >= 0 ? 2 * q : -2 * q - 1) * 0x10000 + (r >= 0 ? 2 * r : -2 * r - 1);
  let h = k >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function toPublicAssetPath(relativePath: string): string {
  return relativePath.replace(/^game\/assets\//, '');
}

function defaultTerrainCoreHex(): TerrainAtlasCoreHex {
  return {
    centerX: 0.5,
    centerY: 0.55,
    radius: TERRAIN_TILE_FALLBACK_CORE_RADIUS,
    squashY: TILE_SY,
    topOverflow: 0,
  };
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
  /** Hex grid stroke layer — separate from fills so it can fade at far zoom. */
  private _terrainLineGfx:   Phaser.GameObjects.Graphics | null = null;
  /** Bevel shading layer — highlight/shadow tints reveal 3-D form at close zoom. */
  private _terrainDetailGfx: Phaser.GameObjects.Graphics | null = null;
  /** Cloud puff container inside mapContainer — drifts across the world. */
  private _cloudContainer:   Phaser.GameObjects.Container | null = null;
  /** Per-cloud drift data for update(). */
  private _cloudData: Array<{
    gfx: Phaser.GameObjects.Graphics;
    vx: number; vy: number; wrapHalfW: number; wrapHalfH: number;
  }> = [];
  /** Full-screen aerial haze overlay at scene level (not in mapContainer). */
  private _hazeGfx:     Phaser.GameObjects.Graphics | null = null;
  /** Full-screen lens vignette at scene level. */
  private _vignetteGfx: Phaser.GameObjects.Graphics | null = null;
  /** Screen-space top/edge horizon haze — sky-blue gradient fading inward. */
  private _horizonHazeGfx: Phaser.GameObjects.Graphics | null = null;
  /** Thin horizontal wind wisps drifting across the screen. */
  private _windStreakGfx: Phaser.GameObjects.Graphics | null = null;
  private _windStreaks: Array<{ x: number; y: number; len: number; alpha: number; speed: number }> = [];
  /** Soft cast-shadow ellipse beneath the floating city, drawn on terrain. */
  private _shadowGfx:   Phaser.GameObjects.Graphics | null = null;
  /** Floating info card shown when a corridor is clicked. */
  private _corridorInfoCard:  Phaser.GameObjects.Container | null = null;
  /** ID of the corridor the pointer was over at pointerdown (to detect clean clicks). */
  private _clickedCorridorId: string | null = null;
  /** Permanent outline ring drawn at the edge of the reachable hex area. */
  private _reachOutlineGfx: Phaser.GameObjects.Graphics | null = null;
  /** Terrain fill graphics for each game tile — hidden when zoomed far out. */
  private _gameTileGfxList: Phaser.GameObjects.Graphics[] = [];
  /** Close-up terrain art sprites generated from atlas variants. */
  private _terrainTileSprites: Phaser.GameObjects.Image[] = [];
  /** Container in mapContainer that holds all world terrain art sprites (above fills, below grid lines). */
  private _terrainSpriteContainer: Phaser.GameObjects.Container | null = null;
  /** Viewport-culled terrain art sprites keyed by hexId — added/removed as camera pans/zooms. */
  private _worldTerrainSprites: Map<string, Phaser.GameObjects.Image> = new Map();
  /** Camera state at the last terrain sprite sync, to throttle redundant pan-syncs. */
  private _lastTerrainSyncCtrX = 0;
  private _lastTerrainSyncCtrY = 0;
  private _lastTerrainSyncZoom = -1;
  /** Runtime atlas manifest describing available terrain variants. */
  private _terrainAtlasManifest: TerrainAtlasManifest | null = null;
  /** Variant lookup by biome bucket for deterministic tile art selection. */
  private _terrainVariantsByType: Map<TerrainBiome, TerrainAtlasVariant[]> = new Map();
  /** True while dynamic atlas loading is in flight. */
  private _terrainAtlasesLoading = false;
  /** Set when the variant index is rebuilt but sync couldn't run (zoom too low). */
  private _pendingTerrainSync = false;

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
  /** Zoomed-in city sprite (cityzoom.webp), bobbing gently. Hidden when zoomed out. */
  private _citySprite:   Phaser.GameObjects.Image | null = null;
  private _cityBobBaseX: number = 0;
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
  private _parallaxX  = 0;
  private _parallaxY  = 0;
  private mapCtrY     = 0;

  private routeOverlay:   Phaser.GameObjects.Container | null = null;
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
    this._terrainLineGfx      = null;
    this._terrainDetailGfx    = null;
    this._cloudContainer      = null;
    this._cloudData            = [];
    this._hazeGfx              = null;
    this._vignetteGfx          = null;
    this._reachOutlineGfx      = null;
    this._terrainSpriteContainer = null;
    this._worldTerrainSprites    = new Map();
    this._lastTerrainSyncZoom    = -1;
    this._terrainTileSprites     = [];
    this._terrainAtlasManifest = null;
    this._terrainVariantsByType = new Map();
    this._terrainAtlasesLoading = false;
    this._pendingTerrainSync = false;
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
    this.resultOverlay   = null;
  }

  preload(): void {
    if (!this.textures.exists('city_zoom')) {
      this.load.image('city_zoom', 'sprites/cityzoom.webp');
    }
    this.load.json(TERRAIN_ATLAS_MANIFEST_KEY, 'terrain_tiles/terrain_atlas_manifest.generated.json');
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
    this._buildClouds();             // animated cloud layer (above corridors, below city)

    this.gameTileContainer = this.add.container(0, 0);
    this.mapContainer.add(this.gameTileContainer);
    this._prepareTerrainAtlases();
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

    this._buildHaze(W, H);           // scene-level aerial haze + vignette

    // ── Horizon haze: top-biased sky-blue gradient, always-on ───────────────
    const horizGfx = this.add.graphics().setDepth(4);
    this._horizonHazeGfx = horizGfx;
    const HZ_N = 28;
    for (let i = 0; i < HZ_N; i++) {
      const t = i / HZ_N;
      const bandH = H * 0.35 / HZ_N;
      horizGfx.fillStyle(0xb8d8ee, Math.pow(1 - t, 2.2) * 0.18);
      horizGfx.fillRect(0, i * bandH, W, bandH + 1);
    }
    for (let i = 0; i < HZ_N; i++) {
      const bandW = W * 0.15 / HZ_N;
      const a = Math.pow(1 - i / HZ_N, 2.2) * 0.08;
      horizGfx.fillStyle(0xb8d8ee, a);
      horizGfx.fillRect(i * bandW, 0, bandW + 1, H);
      horizGfx.fillRect(W - (i + 1) * bandW, 0, bandW + 1, H);
    }

    // ── Wind streaks: thin horizontal wisps drifting across the screen ───────
    this._windStreakGfx = this.add.graphics().setDepth(4);
    for (let i = 0; i < 12; i++) {
      this._windStreaks.push({
        x:     Math.random() * W,
        y:     Math.random() * H * 0.85,
        len:   80 + Math.random() * 220,
        alpha: 0.04 + Math.random() * 0.08,
        speed: 6  + Math.random() * 14,
      });
    }

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
      this._clickedCorridorId = this._hoveredCorridorId;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.mapPointerDown) return;
      const moved = Math.hypot(p.x - this.dragStartX, p.y - this.dragStartY);
      if (moved < 6 && !this.isDragging) return;
      this.isDragging = true;
      const dx = p.x - this.dragStartX;
      const dy = p.y - this.dragStartY;
      this.mapContainer.x = this.ctnrStartX + dx;
      this.mapContainer.y = this.ctnrStartY + dy;
      // City sprite lags behind camera — floats free of the ground plane.
      this._parallaxX = -0.04 * dx / this.currentZoom;
      this._parallaxY = -0.04 * dy / this.currentZoom;
      this._updateScreenLabelTransforms();
      // Sync terrain sprites when the camera has panned by at least half a tile.
      const movePx = Math.hypot(
        this.mapContainer.x - this._lastTerrainSyncCtrX,
        this.mapContainer.y - this._lastTerrainSyncCtrY,
      );
      if (movePx > TILE_R * this.currentZoom * 0.5) this._syncWorldTerrainSprites();
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      this.mapPointerDown = false;
      const wasDragging = this.isDragging;
      this.isDragging = false;
      // Let city parallax ease back naturally — no snap needed.
      if (!wasDragging) {
        if (this._clickedCorridorId && this.currentZoom < LABEL_ZOOM) {
          // Clean click on a corridor — open info card.
          const corr = this.gsm.windNetwork.corridors.find(c => c.id === this._clickedCorridorId);
          if (corr) this._openCorridorInfoCard(corr, p.x, p.y);
        } else if (this._corridorInfoCard) {
          // Clicked empty space — dismiss open card.
          this._dismissCorridorInfoCard();
        }
      }
      this._clickedCorridorId = null;
    });

    if (this.gsm.missionResult) this._showMissionResult();
  }

  private _buildWorldBackground(): void {
    // Three separate Graphics for independent alpha control:
    //   fillGfx — terrain colour fills     (always visible, fades with zoom)
    //   bevlGfx — per-hex bevel shading    (fades in at close zoom)
    //   lineGfx — hex grid strokes         (fades out at far zoom)
    const fillGfx = this.add.graphics();
    const bevlGfx = this.add.graphics();
    const lineGfx = this.add.graphics();
    this._terrainGfx       = fillGfx;
    this._terrainDetailGfx = bevlGfx;
    this._terrainLineGfx   = lineGfx;
    // Insertion order: fill → terrain-art-sprites → bevel → shadow → grid-lines
    // Fog is inserted on top by _buildFogOverlay; grid lines & bevel stay separate for alpha control.
    this._terrainSpriteContainer = this.add.container(0, 0);
    this.mapContainer.add(fillGfx);
    this.mapContainer.add(this._terrainSpriteContainer);
    this.mapContainer.add(bevlGfx);

    // Ground shadow — soft dark oval cast by the floating city onto terrain below.
    const shadowGfx = this.add.graphics();
    this._shadowGfx = shadowGfx;
    const { x: scx, y: scy } = tilePx(this.gsm.cityHex.q, this.gsm.cityHex.r);
    const R = TILE_R, SY = TILE_SY;
    shadowGfx.fillStyle(0x000000, 0.03); shadowGfx.fillEllipse(scx, scy, R * 12, R * 12 * SY);
    shadowGfx.fillStyle(0x000000, 0.04); shadowGfx.fillEllipse(scx, scy, R *  9, R *  9 * SY);
    shadowGfx.fillStyle(0x000000, 0.05); shadowGfx.fillEllipse(scx, scy, R *  6, R *  6 * SY);
    shadowGfx.fillStyle(0x000000, 0.06); shadowGfx.fillEllipse(scx, scy, R *  4, R *  4 * SY);
    shadowGfx.fillStyle(0x000000, 0.05); shadowGfx.fillEllipse(scx, scy, R *  2, R *  2 * SY);
    this.mapContainer.add(shadowGfx);

    this.mapContainer.add(lineGfx);

    for (let q = -WORLD_RADIUS; q <= WORLD_RADIUS; q++) {
      for (let r = -WORLD_RADIUS; r <= WORLD_RADIUS; r++) {
        if (Math.abs(-q - r) > WORLD_RADIUS) continue;
        const { x, y } = tilePx(q, r);
        const pts       = tilePts(x, y);
        const col       = worldTileColor(q, r);

        // ── Terrain fill ────────────────────────────────────────────────
        fillGfx.fillStyle(col, 0.80);
        fillGfx.fillPoints(pts, true);

        // ── Bevel: highlight upper-left faces, shadow lower-right faces ──
        // Flat-top hex vertex angles: v0=0°, v1=60°, v2=120°, v3=180°, v4=240°, v5=300°
        // Upper-left highlight → triangles: centre–v4–v5, centre–v5–v0
        // Lower-right shadow   → triangles: centre–v1–v2, centre–v2–v3
        bevlGfx.fillStyle(lightenColor(col, 45), 0.22);
        bevlGfx.fillTriangle(x, y, pts[4]!.x, pts[4]!.y, pts[5]!.x, pts[5]!.y);
        bevlGfx.fillTriangle(x, y, pts[5]!.x, pts[5]!.y, pts[0]!.x, pts[0]!.y);
        bevlGfx.fillStyle(darkenColor(col, 55), 0.22);
        bevlGfx.fillTriangle(x, y, pts[1]!.x, pts[1]!.y, pts[2]!.x, pts[2]!.y);
        bevlGfx.fillTriangle(x, y, pts[2]!.x, pts[2]!.y, pts[3]!.x, pts[3]!.y);

        // ── Grid stroke ─────────────────────────────────────────────────
        lineGfx.lineStyle(1, 0x000000, 0.30);
        lineGfx.strokePoints(pts, true);
      }
    }
    // Start invisible; update() drives them based on zoom level
    bevlGfx.setAlpha(0);
    lineGfx.setAlpha(0);
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
    gfx.lineStyle(3, 0x4af0ff, 0.12);
    for (const [ax, ay, bx, by] of outerEdges) {
      gfx.beginPath(); gfx.moveTo(ax, ay); gfx.lineTo(bx, by); gfx.strokePath();
    }
    // Tight bright core pass
    gfx.lineStyle(1, 0x4af0ff, 0.75);
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
    this._terrainTileSprites = [];

    const cityId = hexId(this.gsm.cityHex);
    const localTiles = this.gsm.hexMap
      .filter((tile) => hexDistance(tile.coord, this.gsm.cityHex) <= GAME_RADIUS)
      .map((tile) => {
        const isCity = tile.id === cityId;
        const display = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
        const { x, y } = tilePx(tile.coord.q, tile.coord.r);
        const pts = tilePts(x, y);
        const terrColor = worldTileColor(tile.coord.q, tile.coord.r);
        const terrainVariant = this._resolveTerrainVariant(tile.coord.q, tile.coord.r);
        return { tile, isCity, display, x, y, pts, terrColor, terrainVariant };
      });

    for (const { tile, isCity, display, x, y, pts, terrColor, terrainVariant } of localTiles) {
      const hasTerrainArt = terrainVariant !== null;

      const tileGfx = this.add.graphics();
      this.gameTileContainer.add(tileGfx);
      this._gameTileGfxList.push(tileGfx);

      const drawTile = (hovered: boolean) => {
        tileGfx.clear();
        if (hasTerrainArt) {
          // At rest the art is the boundary — no outline needed.
          // On hover: subtle fill tint + thin bright edge.
          if (hovered) {
            tileGfx.fillStyle(isCity ? 0xf7c948 : display.color, 0.15);
            tileGfx.fillPoints(pts, true);
            tileGfx.lineStyle(1, 0xffffff, 0.70);
            tileGfx.strokePoints(pts, true);
          }
        } else if (isCity) {
          // City hex: normal terrain fill with amber outline (orb drawn separately).
          tileGfx.fillStyle(terrColor, hovered ? 0.90 : 0.75);
          tileGfx.fillPoints(pts, true);
          tileGfx.lineStyle(hovered ? 1.5 : 1, 0xf7c948, hovered ? 0.90 : 0.50);
          tileGfx.strokePoints(pts, true);
        } else {
          tileGfx.fillStyle(terrColor, hovered ? 0.82 : 0.60);
          tileGfx.fillPoints(pts, true);
          if (hovered) {
            tileGfx.fillStyle(display.color, 0.25);
            tileGfx.fillPoints(pts, true);
          }
          tileGfx.lineStyle(hovered ? 1.5 : 1, display.color, hovered ? 0.90 : 0.50);
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
    this._cityBobBaseX = cx;
    this._cityBobBaseY = cy - 3;
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
    // _terrainSpriteContainer alpha is driven every frame by update() — skip individual sprites here.
    for (const lbl of this.screenLabels) {
      lbl.text.setAlpha(t);
    }
    for (const spr of this._terrainTileSprites) {
      spr.setAlpha(t);
    }
    // Terrain fills fade in; ring fades out as you zoom in.
    for (const gfx of this._gameTileGfxList) {
      gfx.setAlpha(t);
    }
    // Ring fades out after tiles are fully interactive — starts at LABEL_ZOOM, gone by zoom ~6.
    if (this._reachOutlineGfx) {
      const ringFade = Phaser.Math.Clamp((this.currentZoom - LABEL_ZOOM) / (LABEL_ZOOM * 0.75), 0, 1);
      this._reachOutlineGfx.setAlpha(1 - ringFade);
    }
    // Clear corridor hover highlight once we're mostly zoomed in.
    if (show) this._onCorridorOut();
    // Sync viewport-culled terrain sprites on every zoom change.
    this._syncWorldTerrainSprites();
    // Terrain / line / bevel / cloud / haze alphas are all driven in update() each frame.
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
    // Dismiss card if hovering a different corridor than the one shown.
    if (this._corridorInfoCard && this._hoveredCorridorId !== corr.id) {
      this._dismissCorridorInfoCard();
    }
    this._hoveredCorridorId = corr.id;
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
    this._hoveredCorridorId = null;
    this._hoverGfx?.clear();
    this._corridorNameLabel?.setVisible(false);
  }

  // ── Corridor Info Card ───────────────────────────────────────────────────

  /** Deterministic hash of a corridor id → non-negative integer. */
  private _corridorHash(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /**
   * Open a themed info card near the given screen position showing
   * corridor name, derived altitude, wind speed, route length, and lore.
   */
  private _openCorridorInfoCard(corr: WindCorridor, screenX: number, screenY: number): void {
    this._dismissCorridorInfoCard();

    const hash   = this._corridorHash(corr.id);
    const alt    = 3800 + (hash % 28) * 200;
    const windKt = corr.speed === 1 ? 8  + (hash >> 3) % 12
                 : corr.speed === 2 ? 22 + (hash >> 5) % 24
                                    : 50 + (hash >> 7) % 40;
    const LORE = [
      'First charted by Skalder navigators during the Drift Epoch.',
      'Known to carry trace minerals from volcanic ridges far below.',
      'Skyborn merchants use this current for the eastern grain runs.',
      'Unusual layering makes this corridor treacherous in cold season.',
      'Calm enough that birds have been sighted riding it for days.',
      'This current has shifted north three times since the Founding.',
      'Guild markers here date back to the Second Migration.',
      'Reliable by pilot reckoning — deceptively slow by cartographic measure.',
      'Sudden gusts at junction points test even seasoned crews.',
      'Carries the faint smell of salt despite distance from any ocean biome.',
      'Traditionally used as a boundary marker between highland territories.',
      'Some navigators report compass drift near its edges — cause unknown.',
    ];
    const lore = LORE[(hash >> 2) % LORE.length];

    const CARD_W  = 420;
    const CARD_H  = 310;
    const RADIUS  = 12;
    const PAD     = 18;
    const W       = this.scale.width;
    const H       = this.scale.height;

    // Clamp card position so it stays inside viewport with 16px margin.
    const cx = Phaser.Math.Clamp(screenX + 20, 16, W - CARD_W - 16);
    const cy = Phaser.Math.Clamp(screenY - 20, 16, H - CARD_H - 16);

    const ct = this.add.container(cx, cy).setDepth(75);

    // ── Background ────────────────────────────────────────────────────────
    const bg = this.add.graphics();
    // Outer glow
    bg.lineStyle(8, corr.color, 0.12);
    bg.strokeRoundedRect(0, 0, CARD_W, CARD_H, RADIUS);
    // Fill
    bg.fillStyle(0x050e1e, 0.95);
    bg.fillRoundedRect(0, 0, CARD_W, CARD_H, RADIUS);
    // Border
    bg.lineStyle(1.5, corr.color, 0.50);
    bg.strokeRoundedRect(0, 0, CARD_W, CARD_H, RADIUS);
    ct.add(bg);

    // ── Top color strip ───────────────────────────────────────────────────
    const strip = this.add.graphics();
    strip.fillStyle(corr.color, 0.22);
    strip.fillRoundedRect(0, 0, CARD_W, 46, { tl: RADIUS, tr: RADIUS, bl: 0, br: 0 });
    ct.add(strip);

    // ── Left accent bar ───────────────────────────────────────────────────
    const accent = this.add.graphics();
    accent.fillStyle(corr.color, 0.80);
    accent.fillRect(0, RADIUS, 4, CARD_H - RADIUS * 2);
    ct.add(accent);

    // ── Name ─────────────────────────────────────────────────────────────
    const colorHex = '#' + corr.color.toString(16).padStart(6, '0');
    const nameText = this.add.text(PAD + 4, 12, corr.name.toUpperCase(), {
      fontSize: '18px', fontFamily: 'monospace', fontStyle: 'bold', color: colorHex,
    });
    ct.add(nameText);

    // ── Close button ──────────────────────────────────────────────────────
    const closeBtn = this.add.text(CARD_W - PAD, 12, '×', {
      fontSize: '22px', fontFamily: 'monospace', color: '#6090a0',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover',  () => closeBtn.setColor('#a0d0e0'));
    closeBtn.on('pointerout',   () => closeBtn.setColor('#6090a0'));
    closeBtn.on('pointerdown',  () => this._dismissCorridorInfoCard());
    ct.add(closeBtn);

    // ── Divider 1 ─────────────────────────────────────────────────────────
    const div1 = this.add.graphics();
    div1.lineStyle(1, corr.color, 0.20);
    div1.lineBetween(PAD, 52, CARD_W - PAD, 52);
    ct.add(div1);

    // ── Stats ─────────────────────────────────────────────────────────────
    const flowLabel = corr.speed === 1 ? 'Light Breeze' : corr.speed === 2 ? 'Steady Wind' : 'Gale Current';
    const pips = '◆'.repeat(corr.speed) + '◇'.repeat(3 - corr.speed);
    const stats: Array<[string, string]> = [
      ['ALTITUDE',     alt.toLocaleString() + ' m'],
      ['WIND SPEED',   windKt + ' kt'],
      ['ROUTE LENGTH', corr.spine.length + ' segments'],
      ['FLOW',         flowLabel + '  ' + pips],
    ];
    let sy = 64;
    for (const [label, value] of stats) {
      ct.add(this.add.text(PAD + 6, sy, '◈  ' + label, {
        fontSize: '14px', fontFamily: 'monospace', color: '#4a8aaa',
      }));
      ct.add(this.add.text(CARD_W - PAD, sy, value, {
        fontSize: '15px', fontFamily: 'monospace', color: '#c8dce8',
      }).setOrigin(1, 0));
      sy += 28;
    }

    // ── Divider 2 ─────────────────────────────────────────────────────────
    const div2 = this.add.graphics();
    div2.lineStyle(1, corr.color, 0.20);
    div2.lineBetween(PAD, sy + 2, CARD_W - PAD, sy + 2);
    ct.add(div2);

    // ── Lore ──────────────────────────────────────────────────────────────
    ct.add(this.add.text(PAD + 4, sy + 12, '"' + lore + '"', {
      fontSize: '13px', fontFamily: 'monospace', fontStyle: 'italic',
      color: '#5a7a8a', wordWrap: { width: CARD_W - PAD * 2 - 8 },
    }));

    // ── Fade in ───────────────────────────────────────────────────────────
    ct.setAlpha(0);
    this.tweens.add({ targets: ct, alpha: 1, duration: 150, ease: 'Linear' });

    this._corridorInfoCard = ct;
  }

  /** Fade out and destroy the corridor info card. */
  private _dismissCorridorInfoCard(): void {
    if (!this._corridorInfoCard) return;
    const card = this._corridorInfoCard;
    this._corridorInfoCard = null;
    this.tweens.add({
      targets: card, alpha: 0, duration: 100, ease: 'Linear',
      onComplete: () => card.destroy(),
    });
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

    // ── Deferred terrain sync: atlas loaded but zoom was too low at that time ────
    if (this._pendingTerrainSync && this.currentZoom >= TERRAIN_ART_MIN_ZOOM && this._terrainVariantsByType.size > 0) {
      this._pendingTerrainSync = false;
      this._lastTerrainSyncZoom = -1;
      this._syncWorldTerrainSprites();
    }

    // ── Gently bob the city sprite (suppressed during movement tween) ───────────────
    // Ease city parallax back toward zero — gentle float-back when pan ends.
    this._parallaxX *= 0.98;
    this._parallaxY *= 0.98;
    if (this._citySprite && this._citySprite.alpha > 0 && !this._cityMoving) {
      this._citySprite.x = this._cityBobBaseX + this._parallaxX;
      this._citySprite.y = this._cityBobBaseY + Math.sin(time * 0.0005) * TILE_R * 0.12 + this._parallaxY;
    }

    // ── Zoom-driven visual effect alphas ─────────────────────────────────────
    // zoomFar:  1 at MIN_ZOOM → 0 at INITIAL_ZOOM  ("strategic / world view")
    // zoomNear: 0 at INITIAL_ZOOM → 1 at MAX_ZOOM  ("close / aerial view")
    const zoomFar  = Phaser.Math.Clamp((this.currentZoom - MIN_ZOOM)     / (INITIAL_ZOOM - MIN_ZOOM),  0, 1);
    const zoomNear = Phaser.Math.Clamp((this.currentZoom - INITIAL_ZOOM) / (MAX_ZOOM - INITIAL_ZOOM),  0, 1);
    /** Smoothstep: smooth S-curve 0→1 as t moves from lo to hi. */
    const ss = (t: number, lo: number, hi: number): number => {
      const x = Phaser.Math.Clamp((t - lo) / (hi - lo), 0, 1);
      return x * x * (3 - 2 * x);
    };

    // Terrain fills — present at all zoom levels, brighten toward INITIAL_ZOOM
    if (this._terrainGfx)       this._terrainGfx.setAlpha(0.20 + zoomFar * 0.60);
    // Terrain art sprites — fade in as zoom passes TERRAIN_ART_MIN_ZOOM, finish ~1.5× LABEL_ZOOM
    const artFadeEnd   = LABEL_ZOOM * 1.50;   // fully opaque by zoom ~5.25
    const artFadeT = Phaser.Math.Clamp(
      (this.currentZoom - TERRAIN_ART_MIN_ZOOM) / (artFadeEnd - TERRAIN_ART_MIN_ZOOM), 0, 1,
    );
    const artAlpha = artFadeT * artFadeT * (3 - 2 * artFadeT); // smoothstep
    if (this._terrainSpriteContainer) this._terrainSpriteContainer.setAlpha(artAlpha);
    // Grid lines — fade OUT as we zoom far away AND as terrain art fades in (art takes over)
    const gridFadeOut = 1 - ss(artFadeT, 0.40, 1.0); // disappears as art fills in
    if (this._terrainLineGfx)   this._terrainLineGfx.setAlpha(ss(zoomFar, 0.30, 0.85) * gridFadeOut);
    // Bevel shading — fade IN as we zoom close, but fade OUT again as terrain art covers it
    const bevelBase = ss(zoomNear, 0.08, 0.45);
    const bevelArt  = 1 - artAlpha; // fully gone once art is opaque
    if (this._terrainDetailGfx) this._terrainDetailGfx.setAlpha(bevelBase * bevelArt);
    // Clouds — only appear close up where individual tiles are large enough to warrant it
    // zoomNear: 0 at INITIAL_ZOOM(2.0), 1 at MAX_ZOOM(14.0).  0.08 ≈ zoom 3, 0.30 ≈ zoom 5.6
    if (this._cloudContainer)   this._cloudContainer.setAlpha(ss(zoomNear, 0.08, 0.30));
    // Drift each cloud puff across the map (mapContainer-local px per ms)
    for (const cd of this._cloudData) {
      cd.gfx.x += cd.vx * delta;
      cd.gfx.y += cd.vy * delta;
      if (cd.gfx.x >  cd.wrapHalfW) cd.gfx.x -= cd.wrapHalfW * 2;
      if (cd.gfx.x < -cd.wrapHalfW) cd.gfx.x += cd.wrapHalfW * 2;
      if (cd.gfx.y >  cd.wrapHalfH) cd.gfx.y -= cd.wrapHalfH * 2;
      if (cd.gfx.y < -cd.wrapHalfH) cd.gfx.y += cd.wrapHalfH * 2;
    }
    // Aerial haze (pale blue tint) and vignette: deepen at close zoom
    if (this._hazeGfx)     this._hazeGfx.setAlpha(ss(zoomNear, 0.10, 0.55) * 0.10);
    if (this._vignetteGfx) this._vignetteGfx.setAlpha(ss(zoomNear, 0.04, 0.38) * 0.85);
    // Wind streaks: drift rightward, wrap at screen edge
    if (this._windStreakGfx) {
      const W = this.scale.width;
      this._windStreakGfx.clear();
      for (const s of this._windStreaks) {
        s.x += s.speed * dt;
        if (s.x > W + s.len) s.x = -s.len;
        this._windStreakGfx.lineStyle(1, 0xdcecf8, s.alpha);
        this._windStreakGfx.lineBetween(s.x, s.y, s.x + s.len, s.y);
      }
    }
    // City sprite: grows from the orb as it fades in, then continues to scale with close zoom.
    if (this._citySprite) {
      const FADE_START = LABEL_ZOOM * 0.50;
      const fadeT = Phaser.Math.Clamp((this.currentZoom - FADE_START) / (LABEL_ZOOM - FADE_START), 0, 1);
      const emergeT = fadeT < 0.5
        ? 16 * fadeT * fadeT * fadeT * fadeT * fadeT
        : 1 - Math.pow(-2 * fadeT + 2, 5) / 32;
      const baseSize = TILE_R * 1.2;
      // Emerges from 0.4× (dot-sized) to 1.0× while fading in; then grows further at close zoom.
      const sz = baseSize * (0.4 + 0.6 * emergeT) * (1.0 + 1.2 * zoomNear);
      this._citySprite.setDisplaySize(sz, sz);
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

  private _prepareTerrainAtlases(): void {
    this._terrainAtlasManifest = this.cache.json.get(TERRAIN_ATLAS_MANIFEST_KEY) as TerrainAtlasManifest | null;
    if (!this._terrainAtlasManifest?.atlases?.length) {
      this._terrainVariantsByType.clear();
      this._lastTerrainSyncZoom = -1;
      this._syncWorldTerrainSprites();
      return;
    }

    const atlasesToLoad = this._terrainAtlasManifest.atlases.filter(
      (atlas) => !this.textures.exists(this._terrainAtlasTextureKey(atlas.group)),
    );

    if (atlasesToLoad.length === 0) {
      this._rebuildTerrainVariantIndex();
      this._lastTerrainSyncZoom = -1;
      this._syncWorldTerrainSprites();
      return;
    }

    if (this._terrainAtlasesLoading) return;
    this._terrainAtlasesLoading = true;
    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      this._terrainAtlasesLoading = false;
      this._rebuildTerrainVariantIndex();
      this._lastTerrainSyncZoom = -1;
      // If zoom is already high enough, sync immediately; otherwise defer to update().
      if (this.currentZoom >= TERRAIN_ART_MIN_ZOOM) {
        this._syncWorldTerrainSprites();
      } else {
        this._pendingTerrainSync = true;
      }
      if (this.gameTileContainer) {
        this._buildGameTiles();
        this._updateLabelVisibility();
      }
    });

    for (const atlas of atlasesToLoad) {
      this.load.atlas(
        this._terrainAtlasTextureKey(atlas.group),
        toPublicAssetPath(atlas.imageRelativePath),
        toPublicAssetPath(atlas.dataRelativePath),
      );
    }
    this.load.start();
  }

  private _rebuildTerrainVariantIndex(): void {
    this._terrainVariantsByType.clear();
    if (!this._terrainAtlasManifest?.atlases?.length) return;

    for (const atlas of this._terrainAtlasManifest.atlases) {
      const textureKey = this._terrainAtlasTextureKey(atlas.group);
      if (!this.textures.exists(textureKey)) continue;

      for (const asset of atlas.assets ?? []) {
        const frame = this.textures.getFrame(textureKey, asset.frameKey);
        if (!frame) continue;

        const nextVariant: TerrainAtlasVariant = {
          textureKey,
          frameKey: asset.frameKey,
          terrainType: asset.terrainType,
          variant: asset.variant,
          coreHex: asset.coreHex ?? defaultTerrainCoreHex(),
          frameWidth: frame.width,
          frameHeight: frame.height,
        };
        const existing = this._terrainVariantsByType.get(asset.terrainType) ?? [];
        existing.push(nextVariant);
        existing.sort((a, b) => (a.variant - b.variant) || a.frameKey.localeCompare(b.frameKey));
        this._terrainVariantsByType.set(asset.terrainType, existing);
      }
    }

  }

  private _resolveTerrainVariant(q: number, r: number): TerrainAtlasVariant | null {
    // Bail fast when the index hasn't been built yet.
    if (this._terrainVariantsByType.size === 0) return null;

    const biome = worldTileBiome(q, r);

    // Water biomes fall back to shallow_sea art until dedicated ocean tiles exist.
    const isWaterBiome = biome === 'abyssal_trench' || biome === 'deep_ocean' || biome === 'open_ocean';
    if (isWaterBiome) {
      const hash = stableHexHash(q, r);
      const seaVariants = this._terrainVariantsByType.get('shallow_sea');
      if (seaVariants?.length) return seaVariants[hash % seaVariants.length]!;
      return null;
    }

    // Biomes that have no dedicated art fall back to the nearest visual equivalent.
    const BIOME_FALLBACK: Partial<Record<TerrainBiome, TerrainBiome>> = {
      dense_rainforest: 'temperate_forest',
      plains:           'woodland',
      scrub_steppe:     'savanna',
      sand_beach:       'savanna',
    };

    const hash = stableHexHash(q, r);

    // Primary: look up the biome directly.
    const directVariants = this._terrainVariantsByType.get(biome);
    if (directVariants?.length) {
      return directVariants[hash % directVariants.length]!;
    }

    // Fallback 1: mapped biome alias.
    const fallbackBiome = BIOME_FALLBACK[biome];
    if (fallbackBiome) {
      const fbVariants = this._terrainVariantsByType.get(fallbackBiome);
      if (fbVariants?.length) {
        return fbVariants[hash % fbVariants.length]!;
      }
    }

    // Fallback 2: any available variant (prevents visual gaps).
    for (const variants of this._terrainVariantsByType.values()) {
      if (variants?.length) return variants[hash % variants.length]!;
    }

    return null;
  }

  private _terrainAtlasTextureKey(group: string): string {
    return `${TERRAIN_ATLAS_TEXTURE_PREFIX}${group}`;
  }

  /**
   * Returns the range of hex axial coordinates that are currently visible in the camera viewport,
   * with a 2-hex margin so tiles never pop in at the edge.
   */
  private _visibleHexBounds(): { qMin: number; qMax: number; rMin: number; rMax: number } {
    const W = this.scale.width, H = this.scale.height;
    const corners = [
      { sx: 0, sy: 0 }, { sx: W, sy: 0 }, { sx: 0, sy: H }, { sx: W, sy: H },
    ].map(({ sx, sy }) => ({
      mx: (sx - this.mapContainer.x) / this.currentZoom,
      my: (sy - this.mapContainer.y) / this.currentZoom,
    }));
    let qMin = Infinity, qMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const { mx, my } of corners) {
      const q = mx / (TILE_R * 1.5);
      const r = my / (TILE_R * SQRT3 * TILE_SY) - q * 0.5;
      qMin = Math.min(qMin, Math.floor(q) - 2);
      qMax = Math.max(qMax, Math.ceil(q) + 2);
      rMin = Math.min(rMin, Math.floor(r) - 2);
      rMax = Math.max(rMax, Math.ceil(r) + 2);
    }
    return {
      qMin: Math.max(-WORLD_RADIUS, qMin),
      qMax: Math.min(WORLD_RADIUS, qMax),
      rMin: Math.max(-WORLD_RADIUS, rMin),
      rMax: Math.min(WORLD_RADIUS, rMax),
    };
  }

  /**
   * Adds terrain art sprites for hexes newly in-view and destroys those that have scrolled out.
   * Sprites are placed directly in _terrainSpriteContainer (map-space coords) and share atlas
   * textures so Phaser WebGL batches them into a single draw call per atlas.
   * Called on every zoom change and when the camera pans by ≥ half a tile.
   */
  private _syncWorldTerrainSprites(): void {
    if (!this._terrainSpriteContainer) return;

    // Below the art threshold destroy everything — color fills are sufficient.
    if (this.currentZoom < TERRAIN_ART_MIN_ZOOM || this._terrainVariantsByType.size === 0) {
      for (const spr of this._worldTerrainSprites.values()) spr.destroy();
      this._worldTerrainSprites.clear();
      this._lastTerrainSyncZoom = this.currentZoom;
      this._lastTerrainSyncCtrX = this.mapContainer.x;
      this._lastTerrainSyncCtrY = this.mapContainer.y;
      return;
    }

    const { qMin, qMax, rMin, rMax } = this._visibleHexBounds();
    const activeIds = new Set<string>();

    for (let q = qMin; q <= qMax; q++) {
      for (let r = rMin; r <= rMax; r++) {
        if (Math.abs(-q - r) > WORLD_RADIUS) continue;
        const terrainVariant = this._resolveTerrainVariant(q, r);
        if (!terrainVariant) continue;

        const id = hexId({ q, r });
        activeIds.add(id);

        if (!this._worldTerrainSprites.has(id)) {
          const { x, y } = tilePx(q, r);
          const coreRadiusPx = Math.max(1, terrainVariant.frameWidth * terrainVariant.coreHex.radius);
          const baseScale = TILE_R / coreRadiusPx;
          // Per-hex stable pseudo-random decorations to break visual repetition.
          // Using different bit-windows of the same hash keeps everything deterministic.
          const hash = stableHexHash(q, r);
          // Horizontal flip: ~50% of tiles mirrored — doubles apparent variety for free.
          const flipX = Boolean((hash >>> 8) & 1);
          // Scale jitter ±5%: breaks up the mechanical hex-grid regularity.
          const scaleJitter = 1 + (((hash >>> 12) & 0xf) - 7) / 140; // range ≈ [0.95 … 1.05]
          const scale = baseScale * scaleJitter;
          // Container render order = insertion order, so we sort after all adds (below).
          const spr = this.add.image(x, y, terrainVariant.textureKey, terrainVariant.frameKey)
            .setOrigin(terrainVariant.coreHex.centerX, terrainVariant.coreHex.centerY)
            .setScale(scale)
            .setFlipX(flipX);
          this._terrainSpriteContainer.add(spr);
          this._worldTerrainSprites.set(id, spr);
        }
      }
    }

    // Destroy sprites that scrolled out of view.
    for (const [id, spr] of this._worldTerrainSprites.entries()) {
      if (!activeIds.has(id)) {
        spr.destroy();
        this._worldTerrainSprites.delete(id);
      }
    }

    this._lastTerrainSyncZoom = this.currentZoom;
    this._lastTerrainSyncCtrX = this.mapContainer.x;
    this._lastTerrainSyncCtrY = this.mapContainer.y;
    // Re-sort by Y so lower tiles (higher screen Y) render on top of tiles behind them.
    this._terrainSpriteContainer.sort('y');
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
      this._cityBobBaseX  = fromPx.x;
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
          this._cityBobBaseX  = pos.x;
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
            if (this._citySprite) { this._citySprite.x = toPx.x; this._cityBobBaseX = toPx.x; this._cityBobBaseY = toPx.y; }
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
        if (d <= 10) continue;                                      // inner ring stays clear
        const alpha = Math.min(0.22, (d - 10) / 28 * 0.22);       // ramp to 22% sky-blue at dist 38+
        const { x, y } = tilePx(q, r);
        gfx.fillStyle(0x87b8d4, alpha);
        gfx.fillPoints(tilePts(x, y), true);
      }
    }

    // Insert fog right after the terrain lines layer (fill/bevel/lines trio),
    // so draw order is: fill → bevel → lines → fog → network+
    const fogIdx = this._terrainLineGfx
      ? this.mapContainer.getIndex(this._terrainLineGfx) + 1
      : 3;
    this.mapContainer.addAt(gfx, fogIdx);
    this._fogGfx = gfx;
  }

  /**
   * Build the animated cloud layer.
   *
   * Creates ~26 procedural cloud puffs (overlapping soft white circles) across
   * the world disk, split into two parallax layers — near (bigger, faster) and
   * far (smaller, slower).  Each puff drifts slowly in a near-horizontal wind
   * direction and wraps around the world bounds.
   *
   * The container sits in mapContainer between the corridor network and the
   * gameTileContainer, so clouds appear below the floating city.
   * Alpha is driven every frame in update() by zoomNear.
   */
  private _buildClouds(): void {
    this._cloudContainer?.destroy();
    this._cloudContainer = null;
    this._cloudData = [];

    const container = this.add.container(0, 0);
    container.setAlpha(0);   // update() drives this
    this.mapContainer.add(container);
    this._cloudContainer = container;

    /** Half-extent of the world in mapContainer px for wrap-around logic. */
    const WORLD_PX = WORLD_RADIUS * TILE_R * 1.5;

    // Near layer: larger, faster-drifting puffs (lower altitude)
    // Far  layer: smaller, slower puffs (higher altitude / distant)
    const layers = [
      { count: 18, baseW: 80, baseH: 22, speedScale: 1.0,  baseAlpha: 0.62 },
      { count: 16, baseW: 44, baseH: 12, speedScale: 0.42, baseAlpha: 0.44 },
    ];

    for (const layer of layers) {
      for (let i = 0; i < layer.count; i++) {
        // Scatter puff randomly inside the world disk
        const ang  = Math.random() * Math.PI * 2;
        const dist = Math.random() * WORLD_PX * 0.88;
        const bx   = Math.cos(ang) * dist;
        const by   = Math.sin(ang) * dist;

        // Per-puff width/height variation
        const wScale = 0.7 + Math.random() * 0.8;
        const pw     = layer.baseW * wScale;
        const ph     = layer.baseH * (0.8 + Math.random() * 0.5);

        const puffGfx = this.add.graphics();
        puffGfx.x = bx;
        puffGfx.y = by;

        // ── flat shadow underbelly ─────────────────────────────────────────
        puffGfx.fillStyle(0xd0e4f0, 0.08 * layer.baseAlpha);
        puffGfx.fillEllipse(0, ph * 0.25, pw * 2.2, ph * 0.8);

        // ── wide flat body ───────────────────────────────────────────────
        puffGfx.fillStyle(0xffffff, 0.13 * layer.baseAlpha);
        puffGfx.fillEllipse(0, 0, pw * 2.0, ph * 1.0);

        // ── billowy dome bumps along horizontal spine ────────────────────
        const numBumps = 3 + Math.floor(Math.random() * 3);
        for (let b = 0; b < numBumps; b++) {
          const bx2  = (b / (numBumps - 1) - 0.5) * pw * 1.3;
          const bw   = pw * (0.30 + Math.random() * 0.35);
          // Height capped to 55% of the bump width so bumps stay horizontally flat
          const bh   = Math.min(ph * (0.8 + Math.random() * 0.6), bw * 0.55);
          const ba   = (0.10 + Math.random() * 0.14) * layer.baseAlpha;
          puffGfx.fillStyle(0xffffff, ba);
          puffGfx.fillEllipse(bx2, -ph * 0.2, bw * 2, bh * 2);
        }

        // ── bright core highlight ──────────────────────────────────────────
        puffGfx.fillStyle(0xffffff, 0.16 * layer.baseAlpha);
        puffGfx.fillEllipse(0, -ph * 0.1, pw * 0.9, ph * 0.7);

        container.add(puffGfx);

        // Slow wind drift, mostly horizontal with a small vertical component
        const windAng = -0.18 + Math.random() * 0.36;
        const speed   = (0.55 + Math.random() * 0.75) * layer.speedScale; // px/s world-space
        this._cloudData.push({
          gfx: puffGfx,
          vx:  Math.cos(windAng) * speed / 1000,  // px/ms
          vy:  Math.sin(windAng) * speed / 1000,
          wrapHalfW: WORLD_PX * 0.97,
          wrapHalfH: WORLD_PX * 0.97,
        });
      }
    }
  }

  /**
   * Build the scene-level aerial haze and vignette overlays.
   *
   * These are NOT inside mapContainer, so they scale with the viewport (not the map).
   * - hazeGfx:     pale blue-white fill that tints the scene at close zoom,
   *                conveying thick atmosphere when looking straight down.
   * - vignetteGfx: dark edge-banding that creates a lens/porthole depth effect.
   *
   * Both start at alpha 0 and are driven in update() by zoomNear.
   */
  private _buildHaze(W: number, H: number): void {
    // ── Haze (pale blue-white atmosphere tint) ───────────────────────────────
    const hazeGfx = this.add.graphics();
    hazeGfx.fillStyle(0xb0cce0, 1.0);
    hazeGfx.fillRect(0, 0, W, H);
    hazeGfx.setAlpha(0);
    hazeGfx.setDepth(3);
    this._hazeGfx = hazeGfx;

    // ── Vignette (atmospheric edge darkening) ────────────────────────────────
    // Simulate looking through a vast column of air out to the world below.
    // Horizontal and vertical gradient bands accumulate at the four edges.
    const vigGfx = this.add.graphics();
    const N      = 24;
    // Horizontal bands (top/bottom darkening)
    for (let i = 0; i < N; i++) {
      const tFrac = i / N;
      const edgeT = Math.abs(tFrac - 0.5) * 2;           // 0 at centre, 1 at top/bottom
      const a     = Math.pow(edgeT, 2.5) * 0.22 / N * 4;
      vigGfx.fillStyle(0x000814, a);
      vigGfx.fillRect(0, tFrac * H, W, H / N + 1);
    }
    // Vertical bands (left/right darkening, slightly weaker)
    for (let i = 0; i < N; i++) {
      const tFrac = i / N;
      const edgeT = Math.abs(tFrac - 0.5) * 2;
      const a     = Math.pow(edgeT, 2.5) * 0.14 / N * 4;
      vigGfx.fillStyle(0x000814, a);
      vigGfx.fillRect(tFrac * W, 0, W / N + 1, H);
    }
    vigGfx.setAlpha(0);
    vigGfx.setDepth(3);
    this._vignetteGfx = vigGfx;
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
    this.scene.launch('CharacterSelectScene', { tile, ...this.services });
    const sel = this.scene.get('CharacterSelectScene');
    sel.events.once('confirmed', ({ activeHeroId, supportHeroId }: { activeHeroId: string; supportHeroId: string | null }) => {
      this._launchMission(tile, activeHeroId, supportHeroId);
    });
  }

  private _launchMission(tile: HexTile, activeId: string, supportId: string | null): void {
    const activeHero  = this.heroSystem.getById(activeId);
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

    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { hide(): void }).hide();
    this.scene.start('MissionScene', this.services);
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
