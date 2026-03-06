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
import type { TradewindOption }         from '@data/TradewindOption';
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

const ROUTE_COLORS   = [0x3399ff, 0x33cc77, 0xff9933] as const;
const ROUTE_TEXT_HEX = ['#5599ff', '#44dd88', '#ffaa44'] as const;

// ── Biome noise ─────────────────────────────────────────────
// Correct 32-bit hash using Math.imul to avoid JavaScript float-XOR overflow.
// Two FBM channels → elevation + moisture → biome colour lookup.

function _h32(n: number): number {
  n = (Math.imul((n ^ (n >>> 16)) >>> 0, 0x45d9f3b)) >>> 0;
  n = (Math.imul((n ^ (n >>> 16)) >>> 0, 0x45d9f3b)) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

function _noise2(ix: number, iy: number): number {
  const code = (Math.imul(ix & 0xFFFF, 73856093) ^ Math.imul(iy & 0xFFFF, 19349663)) >>> 0;
  return _h32(code);
}

function _smoothNoise(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (
    _noise2(x0,   y0  ) * (1 - ux) * (1 - uy) +
    _noise2(x0+1, y0  ) * ux       * (1 - uy) +
    _noise2(x0,   y0+1) * (1 - ux) * uy       +
    _noise2(x0+1, y0+1) * ux       * uy
  );
}

function _fbm(px: number, py: number, octs: number): number {
  let v = 0, amp = 1, freq = 1, tot = 0;
  for (let i = 0; i < octs; i++) {
    v += _smoothNoise(px * freq, py * freq) * amp;
    tot += amp; amp *= 0.5; freq *= 2.1;
  }
  return v / tot;
}

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

  const rawE = _fbm((nx + 31.5) * sc, (ny + 17.3) * sc, 4);
  const rawM = _fbm((nx - 53.1) * sc, (ny + 44.7) * sc, 3);

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
  private corridorGraphics: Phaser.GameObjects.Graphics[] = [];
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
    this.corridorGraphics = [];
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

    this.gameTileContainer = this.add.container(0, 0);
    this.mapContainer.add(this.gameTileContainer);
    this._buildGameTiles();
    this._updateLabelVisibility();

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

      const drawTile = (hovered: boolean) => {
        tileGfx.clear();
        if (isCity) {
          tileGfx.fillStyle(hovered ? 0xddbb22 : 0x887722, 0.80);
        } else if (accessible) {
          tileGfx.fillStyle(display.color, hovered ? 0.80 : 0.55);
        } else {
          tileGfx.fillStyle(0x222222, 0.42);
        }
        tileGfx.fillPoints(pts, true);
        if (isCity) {
          tileGfx.lineStyle(hovered ? 3 : 2, 0xf7c948, hovered ? 1 : 0.9);
          tileGfx.strokePoints(pts, true);
        } else {
          tileGfx.lineStyle(hovered ? 3 : 2, stateColor, accessible ? (hovered ? 1 : 0.9) : 0.25);
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

  private _showRouteSelectionOverlay(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const options = this.tradewindSystem.generateOptions(this.gsm.cityHex, this.gsm.cycleCount);
    if (options.length === 0) return;

    options.forEach((opt, i) => {
      const color  = ROUTE_COLORS[i % ROUTE_COLORS.length]!;
      const hexSet = new Set(opt.windCorridor.map(c => 'q' + c.q + '_r' + c.r));
      const gfx    = this.add.graphics();
      for (let q = -WORLD_RADIUS; q <= WORLD_RADIUS; q++) {
        for (let r = -WORLD_RADIUS; r <= WORLD_RADIUS; r++) {
          if (Math.abs(-q - r) > WORLD_RADIUS) continue;
          if (!hexSet.has('q' + q + '_r' + r)) continue;
          const { x, y } = tilePx(q, r);
          const pts = tilePts(x, y);
          gfx.fillStyle(color, 0.32); gfx.fillPoints(pts, true);
          gfx.lineStyle(1, color, 0.60); gfx.strokePoints(pts, true);
        }
      }
      this.mapContainer.add(gfx);
      this.corridorGraphics.push(gfx);
    });

    this.routeOverlay = this.add.container(0, 0);
    const PANEL_H  = Math.floor(H * 0.26);
    const backdrop = this.add.graphics();
    backdrop.fillStyle(0x000000, 0.70);
    backdrop.fillRect(0, H - PANEL_H - 8, W, PANEL_H + 8);
    this.routeOverlay.add(backdrop);

    const cardW  = 300;
    const cardH  = 140;
    const gap    = 24;
    const totalW = options.length * (cardW + gap) - gap;
    const startX = (W - totalW) / 2;
    const startY = H - PANEL_H + 10;

    options.forEach((option, i) => {
      const x     = startX + i * (cardW + gap);
      const y     = startY;
      const color = ROUTE_COLORS[i % ROUTE_COLORS.length]!;
      const tCol  = ROUTE_TEXT_HEX[i % ROUTE_TEXT_HEX.length]!;

      const card = this.add.graphics();
      const drawCard = (hov: boolean) => {
        card.clear();
        card.fillStyle(color, hov ? 0.45 : 0.20);
        card.fillRoundedRect(x, y, cardW, cardH, 10);
        card.lineStyle(hov ? 3 : 2, hov ? 0xffffff : color, hov ? 1 : 0.75);
        card.strokeRoundedRect(x, y, cardW, cardH, 10);
        card.fillStyle(color, hov ? 1 : 0.7);
        card.fillRect(x, y + 10, 4, cardH - 20);
      };
      drawCard(false);
      this.routeOverlay!.add(card);

      const lbl1 = this.add.text(x + cardW / 2, y + 20, option.label, {
        fontSize: '18px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      const lbl2 = this.add.text(x + cardW / 2, y + 50, option.description, {
        fontSize: '12px', color: '#cccccc', fontFamily: 'monospace', wordWrap: { width: cardW - 30 },
      }).setOrigin(0.5, 0);
      const lbl3 = this.add.text(x + cardW / 2, y + 102, '-> ' + hexId(option.resultingCityHex), {
        fontSize: '13px', color: tCol, fontFamily: 'monospace', fontStyle: 'bold',
      }).setOrigin(0.5);
      const lbl4 = this.add.text(x + cardW / 2, y + 122,
        option.windCorridor.length + ' hexes in corridor', {
          fontSize: '11px', color: '#666666', fontFamily: 'monospace',
        }).setOrigin(0.5);
      for (const t of [lbl1, lbl2, lbl3, lbl4]) this.routeOverlay!.add(t);

      const hit = this.add.zone(x + cardW / 2, y + cardH / 2, cardW, cardH)
        .setInteractive({ useHandCursor: true });
      this.routeOverlay!.add(hit);
      hit.on('pointerover', () => drawCard(true));
      hit.on('pointerout',  () => drawCard(false));
      hit.on('pointerdown', () => this._applyWindRoute(option));
    });

    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  --  Choose a Wind Route');
    this.endCycleBtn?.setVisible(false);
  }

  private _applyWindRoute(option: TradewindOption): void {
    this.tradewindSystem.applyChoice(option);
    for (const g of this.corridorGraphics) g.destroy();
    this.corridorGraphics = [];
    this.routeOverlay?.destroy(true);
    this.routeOverlay = null;
    this._discoverReachableHexes();
    this._buildGameTiles();
    this._updateLabelVisibility();
    this.titleText?.setText('Cycle ' + this.gsm.cycleCount + '  --  Hex Map');
    this.endCycleBtn?.setVisible(true);
  }

  private _renderTitleBar(W: number): void {
    this.add.graphics().fillStyle(0x000000, 0.45).fillRect(0, 0, W, 50);
    this.titleText = this.add.text(W / 2, 25,
      'Cycle ' + this.gsm.cycleCount + '  --  Hex Map', {
        fontSize: '22px', color: '#ffffff', fontFamily: 'monospace',
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
    this.endCycleBtn = this.add.text(W - 28, H - 58, '[ End Cycle ]', {
      fontSize: '22px', color: '#ffaa33', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });
    this.endCycleBtn.on('pointerover', () => this.endCycleBtn.setColor('#ffcc66'));
    this.endCycleBtn.on('pointerout',  () => this.endCycleBtn.setColor('#ffaa33'));
    this.endCycleBtn.on('pointerdown', () => {
      this.siteEvolution.runEvolutionPass(this.gsm.cycleCount);
      this.heroSystem.advanceCycleStatuses();
      this._showRouteSelectionOverlay();
    });
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
