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

export const WORLD_MAP_SCENE_KEY = 'WorldMapScene';

// ── Constants
const SQRT3        = Math.sqrt(3);
const WORLD_RADIUS = 60;   // large world — feel vast when panning
const TILE_R       = 12;
const TILE_SY      = 0.55;
const GAME_RADIUS  = 4;
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
    this.cityDot         = null;
    this.routeOverlay    = null;
    this.modalContainer  = null;
    this.resultOverlay   = null;
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

    const TITLE_H  = 50;
    const HINT_H   = 28;
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

    this._renderTitleBar(W);
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

  private _buildGameTiles(): void {
    this.gameTileContainer.removeAll(true);
    for (const lbl of this.screenLabels) lbl.text.destroy();
    this.screenLabels = [];
    this.labelObjects = [];

    const accessibleSet = this._buildAccessibleSet();
    const cityId        = hexId(this.gsm.cityHex);

    for (const tile of this.gsm.hexMap) {
      if (hexDistance(tile.coord, this.gsm.cityHex) > GAME_RADIUS) continue;

      const isCity     = tile.id === cityId;
      const accessible = accessibleSet.has(tile.id);
      const display    = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
      const stateColor = STATE_COLORS[tile.siteState] ?? 0x333333;
      const { x, y }   = tilePx(tile.coord.q, tile.coord.r);
      const pts         = tilePts(x, y);

      const tileGfx = this.add.graphics();
      this.gameTileContainer.add(tileGfx);

      // Terrain-matched fill; site-type color as outline ring.
      const terrColor = worldTileColor(tile.coord.q, tile.coord.r);
      const drawTile = (hovered: boolean) => {
        tileGfx.clear();
        if (isCity) {
          tileGfx.fillStyle(hovered ? 0xddbb22 : 0x887722, 0.85);
          tileGfx.fillPoints(pts, true);
          tileGfx.lineStyle(hovered ? 3 : 2, 0xf7c948, hovered ? 1 : 0.9);
          tileGfx.strokePoints(pts, true);
        } else if (accessible) {
          // Base fill: underlying terrain color at moderate alpha
          tileGfx.fillStyle(terrColor, hovered ? 0.82 : 0.60);
          tileGfx.fillPoints(pts, true);
          // Site-type tint overlay (thin; just adds site color on hover or always subtle)
          if (hovered) {
            tileGfx.fillStyle(display.color, 0.25);
            tileGfx.fillPoints(pts, true);
          }
          // Site-type as outline stroke
          tileGfx.lineStyle(hovered ? 2.5 : 1.5, display.color, hovered ? 1 : 0.70);
          tileGfx.strokePoints(pts, true);
        } else {
          tileGfx.fillStyle(terrColor, 0.22);
          tileGfx.fillPoints(pts, true);
          tileGfx.lineStyle(1, 0x666666, 0.18);
          tileGfx.strokePoints(pts, true);
        }
      };
      drawTile(false);

      if (isCity) {
        const icon = this._makeCityIcon(x, y);
        this.gameTileContainer.add(icon);
        this.labelObjects.push(icon);
      } else {
        const isNearby = hexDistance(tile.coord, this.gsm.cityHex) <= 2;
        const shouldLabel = isNearby && tile.siteType !== 'empty';
        if (shouldLabel) {
          const lbl = this.add.text(0, 0, display.label, {
            fontSize: '8px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
          }).setOrigin(0.5).setAlpha(0).setDepth(20);
          this.screenLabels.push({ coord: tile.coord, text: lbl });
        }
      }

      if (accessible || isCity) {
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
    }

    const { x: cx, y: cy } = tilePx(this.gsm.cityHex.q, this.gsm.cityHex.r);

    // ── Reachable-area boundary ring ────────────────────────────────────────
    // Draw only the hex edges that face the outside (no neighbour within GAME_RADIUS).
    const ringGfx = this.add.graphics();
    this.gameTileContainer.add(ringGfx);
    this._reachOutlineGfx = ringGfx;
    ringGfx.lineStyle(2.0, 0xaabb88, 0.55);
    const HEX_DIR_OFFSETS = [
      { dq:  1, dr:  0 }, { dq:  1, dr: -1 }, { dq:  0, dr: -1 },
      { dq: -1, dr:  0 }, { dq: -1, dr:  1 }, { dq:  0, dr:  1 },
    ];
    // Vertex offsets for each flat-top hex edge (edge i = between vertex i and i+1).
    for (const tile of this.gsm.hexMap) {
      if (hexDistance(tile.coord, this.gsm.cityHex) !== GAME_RADIUS) continue;
      const { x: tx, y: ty } = tilePx(tile.coord.q, tile.coord.r);
      const tpts = tilePts(tx, ty);
      for (let ei = 0; ei < 6; ei++) {
        const nb = HEX_DIR_OFFSETS[ei]!;
        const nq = tile.coord.q + nb.dq;
        const nr = tile.coord.r + nb.dr;
        if (hexDistance({ q: nq, r: nr }, this.gsm.cityHex) <= GAME_RADIUS) continue;
        // This edge faces outside — draw it.
        const vA = tpts[ei]!;
        const vB = tpts[(ei + 1) % 6]!;
        ringGfx.beginPath();
        ringGfx.moveTo(vA.x, vA.y);
        ringGfx.lineTo(vB.x, vB.y);
        ringGfx.strokePath();
      }
    }

    const dotGfx = this.add.graphics();
    dotGfx.fillStyle(0xf7c948, 0.22); dotGfx.fillCircle(cx, cy, TILE_R * 1.05);
    dotGfx.fillStyle(0xf7c948, 0.62); dotGfx.fillCircle(cx, cy, TILE_R * 0.45);
    this.gameTileContainer.add(dotGfx);
    this.cityDot = dotGfx;
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
    const show = this.currentZoom >= LABEL_ZOOM;
    for (const obj of this.labelObjects) {
      const go = obj as { setAlpha?: (v: number) => void };
      if (go.setAlpha) go.setAlpha(show ? 1 : 0);
    }
    if (this.zoomHintText) {
      const zStr = this.currentZoom.toFixed(1);
      this.zoomHintText.setText(
        show
          ? 'Click a hex to interact   |   Scroll to zoom   |   Drag to pan'
          : 'Scroll in to reveal the local map   (zoom: ' + zStr + 'x)',
      );
    }
    if (this.cityDot) {
      this.cityDot.setAlpha(show ? 0 : 1);
    }
    for (const lbl of this.screenLabels) {
      lbl.text.setAlpha(show ? 1 : 0);
    }
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
      for (let si = 0; si < pts.length - 1; si++) {
        const frac = si / (pts.length - 1);   // 0 = near tail, 1 = near head
        const segA = Math.min(1, drawAlpha * pBoost * (frac * frac));
        const w    = Math.min(2.0, (0.5 + frac * 1.0) * Math.min(pBoost, 1.6));
        if (segA < 0.012) continue;
        gfx.lineStyle(w, p.color, segA);
        gfx.lineBetween(pts[si]!.x, pts[si]!.y, pts[si + 1]!.x, pts[si + 1]!.y);
      }
    }
  }

  // ── Cycle advance + junction logic ────────────────────────────────────────

  /** Called when the player clicks "End Cycle". Advances city and checks for junction. */
  private _onEndCycleTick(): void {
    this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
    this.heroSystem.advanceCycleStatuses();
    this.tradewindSystem.advanceCityAlongCorridor();
    this._buildFogOverlay();       // recentre fog around new city position
    this._discoverReachableHexes();
    this._buildGameTiles();
    this._updateLabelVisibility();
    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Hex Map');

    // Junction check happens AFTER movement — the choice is presented when
    // the city has already arrived at the junction hex, not a turn before.
    if (this.tradewindSystem.isAtJunction()) {
      this._showJunctionModal();
    }
  }

  /**
   * Show a bottom panel listing corridors available at the upcoming junction.
   * The player can switch to a different current or stay on the current one.
   */
  private _showJunctionModal(): void {
    if (this.routeOverlay) return;

    const result = this.tradewindSystem.getUpcomingJunction();
    if (!result) return;

    const { junction, options } = result;
    const W = this.scale.width;
    const H = this.scale.height;

    this.routeOverlay = this.add.container(0, 0).setDepth(50);
    const PANEL_H = Math.floor(H * 0.30);
    const panelY  = H - PANEL_H;

    // ── Backdrop ──────────────────────────────────────────────────────
    const backdrop = this.add.graphics();
    backdrop.fillStyle(0x020c1c, 0.94);
    backdrop.fillRect(0, panelY, W, PANEL_H);
    backdrop.lineStyle(1.5, 0x1a3a5a, 1.0);
    backdrop.lineBetween(0, panelY, W, panelY);
    this.routeOverlay.add(backdrop);

    // ── Header ───────────────────────────────────────────────────────
    this.routeOverlay.add(
      this.add.text(W / 2, panelY + 10,
        '◈  J U N C T I O N  —  choose your wind current  ◈', {
          fontSize: '11px', color: '#3a5570', fontFamily: 'monospace',
        }).setOrigin(0.5, 0),
    );

    // ── Build card list ────────────────────────────────────────────────
    const activeCorrId  = this.gsm.currentCorridorId;
    const activeCorridor = this.gsm.windNetwork.corridors.find(c => c.id === activeCorrId);
    const allCards: Array<{ name: string; speed: number; color: number; corridorId: string | null }> = [];
    if (activeCorridor) {
      allCards.push({ name: activeCorridor.name, speed: activeCorridor.speed, color: 0xf7c948, corridorId: null });
    }
    for (const opt of options) {
      allCards.push({ name: opt.corridor.name, speed: opt.corridor.speed, color: opt.corridor.color, corridorId: opt.corridor.id });
    }

    const cardW  = 220;
    const cardH  = Math.floor(PANEL_H * 0.80);
    const gap    = 14;
    const totalW = allCards.length * (cardW + gap) - gap;
    const startX = Math.max(16, (W - totalW) / 2);
    const startY = panelY + 30;

    for (let ci = 0; ci < allCards.length; ci++) {
      const card   = allCards[ci]!;
      const x      = startX + ci * (cardW + gap);
      const isStay = card.corridorId === null;
      const col    = card.color;

      // Pre-lookup corridor object for hover highlight
      const corrObj = isStay
        ? activeCorridor
        : this.gsm.windNetwork.corridors.find(c => c.id === card.corridorId);

      const gcard = this.add.graphics();
      const drawCard = (hov: boolean) => {
        gcard.clear();
        // Body fill
        gcard.fillStyle(0x040c1c, hov ? 0.97 : 0.82);
        gcard.fillRoundedRect(x, startY, cardW, cardH, 6);
        // Colored left-edge stripe (4 px)
        gcard.fillStyle(col, hov ? 1.0 : 0.65);
        gcard.fillRoundedRect(x, startY, 4, cardH,
          { tl: 6, tr: 0, br: 0, bl: 6 } as unknown as number);
        // Border
        gcard.lineStyle(hov ? 2 : 1.5, hov ? 0xffffff : col, hov ? 0.90 : 0.40);
        gcard.strokeRoundedRect(x, startY, cardW, cardH, 6);
        // "Stay" accent top bar
        if (isStay && !hov) {
          gcard.lineStyle(2, 0xf7c948, 0.60);
          gcard.lineBetween(x + 4, startY + 1, x + cardW, startY + 1);
        }
      };
      drawCard(false);
      this.routeOverlay!.add(gcard);

      // ── Card text labels ─────────────────────────────────────────────────
      const tx = x + 14;  // left-pad past stripe

      const badge = isStay ? 'STAY  ▼' : 'SWITCH  ▶';
      const badgeCol = isStay ? '#776040' : '#336688';
      const nameLabel = this.add.text(tx, startY + 12, card.name, {
        fontSize: '14px', color: '#dde8f4', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0, 0);
      const sub = this.add.text(tx, startY + 30, badge, {
        fontSize: '10px', color: badgeCol, fontFamily: 'monospace',
      }).setOrigin(0, 0);

      // Speed pips: ◆ = filled, ◇ = empty
      const pips = ('◆'.repeat(card.speed) + '◇'.repeat(Math.max(0, 3 - card.speed)));
      const speedWord = card.speed === 1 ? 'slow' : card.speed === 2 ? 'steady' : 'swift';
      const colHex = '#' + col.toString(16).padStart(6, '0');
      const speedLabel = this.add.text(tx, startY + 46, pips + '  ' + speedWord, {
        fontSize: '11px', color: colHex, fontFamily: 'monospace',
      }).setOrigin(0, 0);

      for (const t of [nameLabel, sub, speedLabel]) this.routeOverlay!.add(t);

      // ── Hit zone ────────────────────────────────────────────────────────
      const hit = this.add.zone(x + cardW / 2, startY + cardH / 2, cardW, cardH)
        .setInteractive({ useHandCursor: true });
      this.routeOverlay!.add(hit);

      hit.on('pointerover', () => {
        drawCard(true);
        if (corrObj) this._onCorridorHover(corrObj);
      });
      hit.on('pointerout', () => {
        drawCard(false);
        this._onCorridorOut();
      });
      hit.on('pointerdown', () => {
        if (card.corridorId) {
          this._applyCorridorSwitch(card.corridorId);
        } else {
          // Stay on current — close panel and restore UI
          this.routeOverlay?.destroy(true);
          this.routeOverlay = null;
          this.endCycleBtn?.setVisible(true);
          this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Hex Map');
        }
      });
    }

    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Junction');
    this.endCycleBtn?.setVisible(false);
  }

  /** Switch the city to a different wind corridor at the current junction. */
  private _applyCorridorSwitch(corridorId: string): void {
    this.tradewindSystem.switchCorridor(corridorId);

    this.routeOverlay?.destroy(true);
    this.routeOverlay = null;

    // Rebuild network graphics to reflect new active corridor
    this._renderWindNetwork();
    // Rebuild particles — active corridor now different
    this._buildParticles();
    // Fog doesn't change (city position unchanged at switch)

    this._discoverReachableHexes();
    this._buildGameTiles();
    this._updateLabelVisibility();
    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  —  Hex Map');
    this.endCycleBtn?.setVisible(true);
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

  private _renderTitleBar(W: number): void {
    const bar = this.add.graphics();
    bar.fillStyle(0x020810, 0.92);
    bar.fillRect(0, 0, W, 50);
    // Thin bottom accent line
    bar.lineStyle(1, 0x1a3850, 1.0);
    bar.lineBetween(0, 49, W, 49);
    this.titleText = this.add.text(W / 2, 25,
      'Cycle ' + this.gsm.cycleCount + '  —  Hex Map', {
        fontSize: '19px', color: '#c0d0e0', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
  }

  private _renderHintLine(W: number, H: number, hintH: number): void {
    this.add.graphics().fillStyle(0x000000, 0.35).fillRect(0, H - hintH, W, hintH);
    const zStr = this.currentZoom.toFixed(1);
    this.zoomHintText = this.add.text(W / 2, H - hintH / 2,
      'Scroll in to reveal the local map   (zoom: ' + zStr + 'x)', {
        fontSize: '12px', color: '#445566', fontFamily: 'monospace',
      }).setOrigin(0.5);
  }

  private _renderEndCycleButton(W: number, H: number): void {
    const bw = 148, bh = 32;
    const bx = W - bw - 14;
    const by = H - bh - 14;
    const btnBg = this.add.graphics();
    const drawBg = (hov: boolean) => {
      btnBg.clear();
      btnBg.fillStyle(hov ? 0x1a2800 : 0x080e1a, hov ? 0.95 : 0.85);
      btnBg.fillRoundedRect(bx, by, bw, bh, 5);
      btnBg.lineStyle(hov ? 2 : 1.5, hov ? 0xffdd55 : 0xffaa33, hov ? 1.0 : 0.70);
      btnBg.strokeRoundedRect(bx, by, bw, bh, 5);
    };
    drawBg(false);
    this.endCycleBtn = this.add.text(bx + bw / 2, by + bh / 2, 'End Cycle  ▶', {
      fontSize: '15px', color: '#ffaa33', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.endCycleBtn.on('pointerover', () => { this.endCycleBtn.setColor('#ffdd66'); drawBg(true); });
    this.endCycleBtn.on('pointerout',  () => { this.endCycleBtn.setColor('#ffaa33'); drawBg(false); });
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
    const radius     = this.reachSystem.getCurrentRadius();
    const accessible = this.reachSystem.getAccessibleHexes(this.gsm.cityHex, radius);
    return new Set(accessible.map(t => t.id));
  }

  private _discoverReachableHexes(): void {
    const radius     = this.reachSystem.getCurrentRadius();
    const accessible = this.reachSystem.getAccessibleHexes(this.gsm.cityHex, radius);
    for (const tile of accessible) {
      if (tile.siteState === 'undiscovered') {
        this.gsm.updateHexTile(tile.id, { siteState: 'discovered' });
      }
    }
  }
}
