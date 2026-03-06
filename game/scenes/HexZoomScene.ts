/**
 * HexZoomScene.ts
 * Pseudo-isometric hex grid with site selection and party selection modal.
 * Owner: Architecture domain
 *
 * === SCENE OWNERSHIP ===
 * Reads from GSM:  hexMap, cityHex, windCorridor, heroRoster, missionResult, resources
 * Writes to GSM:   missionContext, missionParty (via IHeroSystem.assignToMission)
 *
 * === TRANSITIONS ===
 * → MissionScene    after party confirmed for a surface site
 * → CityViewScene   when player clicks the city hex
 * → WorldMapScene   when player ends the cycle
 */

import Phaser from 'phaser';
import type { IGameStateManager } from '@systems/IGameStateManager';
import type { IReachSystem } from '@systems/IReachSystem';
import type { ISiteEvolutionSystem } from '@systems/ISiteEvolutionSystem';
import type { IHeroSystem } from '@systems/IHeroSystem';
import type { IResourceSystem } from '@systems/IResourceSystem';
import type { IAudioService } from '@services/IAudioService';
import type { HexTile, AxialCoord } from '@data/HexTile';
import { hexId, hexDistance } from '@data/HexTile';
import type { Hero } from '@data/Hero';
import type { ServiceBundle } from '../../src/main';

export const HEX_ZOOM_SCENE_KEY = 'HexZoomScene';

// ── Hex rendering constants ───────────────────────────────────
const HEX_RADIUS = 70;          // Outer radius (center → vertex) in pixels
const SCALE_Y = 0.55;           // Pseudo-isometric squish
const SQRT3 = Math.sqrt(3);
/** Only render tiles within this many rings of the current city. */
const DISPLAY_RADIUS = 4;

/** Site type → full label + colour. */
const SITE_DISPLAY: Record<string, { label: string; color: number }> = {
  town:    { label: 'Town',    color: 0x3388dd },
  village: { label: 'Village', color: 0x33aa66 },
  ruin:    { label: 'Ruin',    color: 0xaa6633 },
  deposit: { label: 'Deposit', color: 0xcccc33 },
  skydock: { label: 'Dock',    color: 0xcc33cc },
  empty:   { label: '·',       color: 0x555555 },
};

/** Site state → border + indicator colour. */
const STATE_COLORS: Record<string, number> = {
  undiscovered: 0x333333,
  discovered:   0x666666,
  visited:      0x88aa88,
  contested:    0xdd6633,
  conquered:    0xcc3333,
  destroyed:    0x444444,
  recovering:   0x5599aa,
  thriving:     0x33dd66,
  abandoned:    0x777777,
};

export class HexZoomScene extends Phaser.Scene {
  private gsm!: IGameStateManager;
  private reachSystem!: IReachSystem;
  private siteEvolutionSystem!: ISiteEvolutionSystem;
  private heroSystem!: IHeroSystem;
  private resourceSystem!: IResourceSystem;
  private audioService!: IAudioService;
  private services!: ServiceBundle;

  // Rendering state
  private hexContainer!: Phaser.GameObjects.Container;
  private modalContainer: Phaser.GameObjects.Container | null = null;
  private resultOverlay: Phaser.GameObjects.Container | null = null;

  constructor() {
    super({ key: HEX_ZOOM_SCENE_KEY });
  }

  init(data: ServiceBundle): void {
    this.services = data;
    this.gsm = data.gsm;
    this.reachSystem = data.reachSystem;
    this.siteEvolutionSystem = data.siteEvolution;
    this.heroSystem = data.heroSystem;
    this.resourceSystem = data.resourceSystem;
    this.audioService = data.audioService;
  }

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    // Show UIScene
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { show(): void }).show();

    // Background
    this.add.graphics().fillStyle(0x111122, 1).fillRect(0, 0, W, H);

    // Mark reachable hexes as 'discovered'
    this._discoverReachableHexes();

    // ── Hex grid container (centered, squished) ────────
    this.hexContainer = this.add.container(W / 2, H / 2 - 20);
    this.hexContainer.setScale(1, SCALE_Y);

    const accessibleSet = this._buildAccessibleSet();

    for (const tile of this.gsm.hexMap) {
      // Only show tiles close to the city (zoomed-in neighbourhood view)
      if (hexDistance(tile.coord, this.gsm.cityHex) > DISPLAY_RADIUS) continue;
      this._renderHexTile(tile, accessibleSet.has(tile.id));
    }

    // ── End Cycle button ──────────────────────────────────
    this._renderEndCycleButton(W, H);

    // ── Title ─────────────────────────────────────────────
    this.add.text(W / 2, 22, `Hex Map — Cycle ${this.gsm.cycleCount}`, {
      fontSize: '26px', color: '#ffffff', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // ── Check for pending mission result ──────────────────
    if (this.gsm.missionResult) {
      this._showMissionResult();
    }
  }

  // ── Hex rendering ──────────────────────────────────────

  private _renderHexTile(tile: HexTile, accessible: boolean): void {
    const pos = this._hexToPixel(tile.coord);
    const isCity = hexId(tile.coord) === hexId(this.gsm.cityHex);
    const display = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
    const stateColor = STATE_COLORS[tile.siteState] ?? 0x333333;

    const gfx = this.add.graphics();

    // Hex polygon (flat-top)
    const points = this._hexPoints(pos.x, pos.y, HEX_RADIUS);

    if (isCity) {
      gfx.fillStyle(0xffcc00, 0.6);
    } else if (accessible) {
      gfx.fillStyle(display.color, 0.4);
    } else {
      gfx.fillStyle(0x222222, 0.3);
    }
    gfx.fillPoints(points, true);

    // Border — city gets a multi-pass glow; others get a single stroke
    if (isCity) {
      gfx.lineStyle(10, 0xffee88, 0.20);
      gfx.strokePoints(points, true);
      gfx.lineStyle(6,  0xffdd66, 0.40);
      gfx.strokePoints(points, true);
      gfx.lineStyle(3,  0xffcc00, 1.00);
      gfx.strokePoints(points, true);
    } else {
      gfx.lineStyle(2, stateColor, accessible ? 1 : 0.3);
      gfx.strokePoints(points, true);
    }

    this.hexContainer.add(gfx);

    // ── Labels / icon: drawn on the SCENE (not the container) so they aren't squished ──
    const screenX = this.hexContainer.x + pos.x;
    const screenY = this.hexContainer.y + pos.y * SCALE_Y;

    if (isCity) {
      // ── City building icon ──────────────────────────────
      const ig = this.add.graphics();
      const bx = screenX;
      const by = screenY;
      // Ground / base line
      ig.fillStyle(0xffaa22, 1);
      ig.fillRect(bx - 28, by + 12, 56, 4);
      // Left building
      ig.fillStyle(0xccaa33, 1);
      ig.fillRect(bx - 26, by - 6, 16, 18);
      // Windows on left building
      ig.fillStyle(0x88ccff, 0.85);
      ig.fillRect(bx - 23, by - 3, 4, 4);
      ig.fillRect(bx - 15, by - 3, 4, 4);
      // Centre tower (tallest)
      ig.fillStyle(0xffcc44, 1);
      ig.fillRect(bx - 8, by - 22, 16, 34);
      // Windows on centre tower
      ig.fillStyle(0x88ccff, 0.85);
      ig.fillRect(bx - 5, by - 18, 4, 4);
      ig.fillRect(bx + 3, by - 18, 4, 4);
      ig.fillRect(bx - 5, by - 10, 4, 4);
      ig.fillRect(bx + 3, by - 10, 4, 4);
      // Spire on centre tower
      ig.fillStyle(0xffee88, 1);
      ig.fillTriangle(bx - 5, by - 22, bx + 5, by - 22, bx, by - 32);
      // Right building
      ig.fillStyle(0xccaa33, 1);
      ig.fillRect(bx + 10, by - 2, 14, 14);
      ig.fillStyle(0x88ccff, 0.85);
      ig.fillRect(bx + 13, by + 1, 4, 4);
    } else {
      // Regular site type label
      const labelColor = accessible ? '#ffffff' : '#666666';
      this.add.text(screenX, screenY - 8, display.label, {
        fontSize: '20px',
        color: labelColor,
        fontFamily: 'monospace',
        fontStyle: 'bold',
      }).setOrigin(0.5);
    }

    // Interaction zone (only for accessible non-city hexes, OR the city hex)
    if (accessible || isCity) {
      // Create an interactive zone within the container's coordinate space
      const zone = this.add.zone(pos.x, pos.y, HEX_RADIUS * 1.6, HEX_RADIUS * 1.4)
        .setInteractive({ useHandCursor: true });
      this.hexContainer.add(zone);

      zone.on('pointerover', () => {
        gfx.clear();
        gfx.fillStyle(isCity ? 0xffee55 : display.color, 0.7);
        gfx.fillPoints(points, true);
        gfx.lineStyle(3, 0xffffff, 1);
        gfx.strokePoints(points, true);
      });

      zone.on('pointerout', () => {
        gfx.clear();
        if (isCity) {
          gfx.fillStyle(0xffcc00, 0.6);
        } else if (accessible) {
          gfx.fillStyle(display.color, 0.4);
        } else {
          gfx.fillStyle(0x222222, 0.3);
        }
        gfx.fillPoints(points, true);
        gfx.lineStyle(2, isCity ? 0xffcc00 : stateColor, accessible ? 1 : 0.3);
        gfx.strokePoints(points, true);
      });

      zone.on('pointerdown', () => {
        if (isCity) {
          this._openCityView();
        } else {
          this._openPartySelection(tile);
        }
      });
    }
  }

  // ── Coordinate conversion ──────────────────────────────

  /** Axial → pixel (flat-top hex). */
  private _hexToPixel(coord: AxialCoord): { x: number; y: number } {
    const x = HEX_RADIUS * (3 / 2 * coord.q);
    const y = HEX_RADIUS * (SQRT3 / 2 * coord.q + SQRT3 * coord.r);
    return { x, y };
  }

  /** Generate the 6 vertices of a flat-top hex. */
  private _hexPoints(cx: number, cy: number, r: number): Phaser.Geom.Point[] {
    const points: Phaser.Geom.Point[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i);
      points.push(new Phaser.Geom.Point(
        cx + r * Math.cos(angle),
        cy + r * Math.sin(angle),
      ));
    }
    return points;
  }

  // ── Accessibility helpers ──────────────────────────────

  private _buildAccessibleSet(): Set<string> {
    const radius = this.reachSystem.getCurrentRadius();
    const accessible = this.reachSystem.getAccessibleHexes(this.gsm.cityHex, radius);
    return new Set(accessible.map(t => t.id));
  }

  private _discoverReachableHexes(): void {
    const radius = this.reachSystem.getCurrentRadius();
    const accessible = this.reachSystem.getAccessibleHexes(this.gsm.cityHex, radius);
    for (const tile of accessible) {
      if (tile.siteState === 'undiscovered') {
        this.gsm.updateHexTile(tile.id, { siteState: 'discovered' });
      }
    }
  }

  // ── Party selection modal ──────────────────────────────

  private _openPartySelection(tile: HexTile): void {
    if (this.modalContainer) return; // Already open

    const W = this.scale.width;
    const H = this.scale.height;
    const modalW = 560;
    const modalH = 480;
    const mx = (W - modalW) / 2;
    const my = (H - modalH) / 2;

    this.modalContainer = this.add.container(0, 0);

    // Dim background
    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.6);
    dim.fillRect(0, 0, W, H);
    dim.setInteractive(new Phaser.Geom.Rectangle(0, 0, W, H), Phaser.Geom.Rectangle.Contains);
    this.modalContainer.add(dim);

    // Modal panel
    const panel = this.add.graphics();
    panel.fillStyle(0x1a1a2e, 0.95);
    panel.fillRoundedRect(mx, my, modalW, modalH, 10);
    panel.lineStyle(2, 0x4488cc, 1);
    panel.strokeRoundedRect(mx, my, modalW, modalH, 10);
    this.modalContainer.add(panel);

    // Title
    const siteDisplay = SITE_DISPLAY[tile.siteType] ?? SITE_DISPLAY['empty']!;
    const title = this.add.text(mx + modalW / 2, my + 20, `${tile.siteType.toUpperCase()} — ${tile.id}`, {
      fontSize: '16px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.modalContainer.add(title);

    // Danger and state info
    const info = this.add.text(mx + 20, my + 45, `Danger: ${tile.dangerLevel}  |  State: ${tile.siteState}`, {
      fontSize: '11px', color: '#aaaaaa', fontFamily: 'monospace',
    });
    this.modalContainer.add(info);

    // Available heroes
    const available = this.heroSystem.getAvailable();
    this.add.text(mx + 20, my + 70, 'Select Active Hero:', {
      fontSize: '12px', color: '#66ccff', fontFamily: 'monospace',
    }).setOrigin(0);
    this.modalContainer.add(this.children.list[this.children.list.length - 1]!);

    let selectedActiveId: string | null = null;
    let selectedSupportId: string | null = null;
    const heroButtons: Phaser.GameObjects.Text[] = [];

    available.forEach((hero, i) => {
      const btnY = my + 118 + i * 36;
      const btn = this.add.text(mx + 36, btnY,
        `${hero.name} (${hero.heroClass})  C:${hero.stats.combat} E:${hero.stats.exploration} D:${hero.stats.diplomacy}`,
        { fontSize: '16px', color: '#cccccc', fontFamily: 'monospace' },
      ).setInteractive({ useHandCursor: true });

      btn.on('pointerdown', () => {
        if (!selectedActiveId) {
          selectedActiveId = hero.id;
          btn.setColor('#66ff66');
          btn.setText(`▶ ${hero.name} (ACTIVE)`);
          // Now show "select support or go" prompt
          this._addSupportPrompt(mx, my, modalW, available, selectedActiveId, selectedSupportId,
            (supportId) => {
              selectedSupportId = supportId;
            },
            () => this._confirmParty(tile, selectedActiveId!, selectedSupportId),
          );
        }
      });

      heroButtons.push(btn);
      this.modalContainer!.add(btn);
    });

    if (available.length === 0) {
      const noHero = this.add.text(mx + 36, my + 118, 'No heroes available!', {
        fontSize: '17px', color: '#ff6666', fontFamily: 'monospace',
      });
      this.modalContainer.add(noHero);
    }

    // Cancel button
    const cancelBtn = this.add.text(mx + modalW / 2, my + modalH - 28, '[ Cancel ]', {
      fontSize: '20px', color: '#ff6666', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    cancelBtn.on('pointerdown', () => this._closeModal());
    this.modalContainer.add(cancelBtn);
  }

  private _addSupportPrompt(
    mx: number, my: number, modalW: number,
    heroes: Hero[], activeId: string, _currentSupportId: string | null,
    onSelect: (id: string | null) => void,
    onConfirm: () => void,
  ): void {
    if (!this.modalContainer) return;

    const supportHeroes = heroes.filter(h => h.id !== activeId);
    const promptY = my + 280;

    const label = this.add.text(mx + 24, promptY, 'Support hero (optional):', {
      fontSize: '18px', color: '#66ccff', fontFamily: 'monospace',
    });
    this.modalContainer.add(label);

    supportHeroes.forEach((hero, i) => {
      const btn = this.add.text(mx + 36, promptY + 28 + i * 30,
        `${hero.name} (${hero.heroClass})`,
        { fontSize: '16px', color: '#cccccc', fontFamily: 'monospace' },
      ).setInteractive({ useHandCursor: true });

      btn.on('pointerdown', () => {
        btn.setColor('#6699ff');
        btn.setText(`▷ ${hero.name} (SUPPORT)`);
        onSelect(hero.id);
      });
      this.modalContainer!.add(btn);
    });

    // Go button
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

    // Assign party
    this.heroSystem.assignToMission({ activeHeroId: activeId, supportHeroId: supportId });

    // Build MissionContext
    const context = {
      missionId: `mission_${tile.id}_c${this.gsm.cycleCount}`,
      siteId: tile.id,
      siteType: tile.siteType,
      dangerLevel: tile.dangerLevel,
      activeHeroId: activeId,
      supportHeroId: supportId,
      supportBonuses: supportHero?.bonusArray ?? [],
      resourceSurface: tile.resourceSurface,
      objectives: [
        {
          id: 'obj_reach_exit',
          type: 'reach' as const,
          description: 'Reach the exit zone',
          isPrimary: true,
        },
        {
          id: 'obj_collect',
          type: 'collect' as const,
          description: 'Gather resources',
          isPrimary: false,
          targetAmount: tile.resourceSurface.reduce((s, r) => s + r.baseYield, 0),
        },
      ],
    };

    this.gsm.setMissionContext(context);
    this._closeModal();

    // Hide UI and launch mission
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { hide(): void }).hide();

    this.scene.start('MissionScene', this.services);
  }

  private _closeModal(): void {
    if (this.modalContainer) {
      this.modalContainer.destroy(true);
      this.modalContainer = null;
    }
  }

  // ── Mission result overlay ─────────────────────────────

  private _showMissionResult(): void {
    const result = this.gsm.missionResult!;
    const W = this.scale.width;
    const H = this.scale.height;

    this.resultOverlay = this.add.container(0, 0);

    const dim = this.add.graphics();
    dim.fillStyle(0x000000, 0.5);
    dim.fillRect(0, 0, W, H);
    this.resultOverlay.add(dim);

    const panelW = 500;
    const panelH = 280;
    const px = (W - panelW) / 2;
    const py = (H - panelH) / 2;

    const panel = this.add.graphics();
    const outcomeColor = result.outcome === 'success' ? 0x33aa33
      : result.outcome === 'retreat' ? 0xccaa33 : 0xcc3333;
    panel.fillStyle(0x1a1a2e, 0.95);
    panel.fillRoundedRect(px, py, panelW, panelH, 12);
    panel.lineStyle(3, outcomeColor, 1);
    panel.strokeRoundedRect(px, py, panelW, panelH, 12);
    this.resultOverlay.add(panel);

    const outcomeLabel = result.outcome.toUpperCase();
    this.resultOverlay.add(this.add.text(px + panelW / 2, py + 32, `Mission ${outcomeLabel}`, {
      fontSize: '28px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5));

    // Resources gathered
    const resLines = Object.entries(result.resourcesGathered)
      .filter(([, amt]) => amt > 0)
      .map(([id, amt]) => `  ${id}: +${amt}`);
    const resText = resLines.length > 0 ? resLines.join('\n') : '  (none)';

    this.resultOverlay.add(this.add.text(px + 28, py + 72, `Resources gathered:\n${resText}`, {
      fontSize: '18px', color: '#aaccaa', fontFamily: 'monospace',
    }));

    // Apply resources
    for (const [id, amt] of Object.entries(result.resourcesGathered)) {
      if (amt > 0) {
        this.resourceSystem.add(id, amt);
      }
    }

    // Dismiss button
    const dismissBtn = this.add.text(px + panelW / 2, py + panelH - 32, '[ Continue ]', {
      fontSize: '20px', color: '#66ccff', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    dismissBtn.on('pointerdown', () => {
      this.resultOverlay?.destroy(true);
      this.resultOverlay = null;
    });
    this.resultOverlay.add(dismissBtn);

    // Clear the result from GSM
    this.gsm.setMissionResult(null);
  }

  // ── City view transition ───────────────────────────────

  private _openCityView(): void {
    const uiScene = this.scene.get('UIScene');
    if (uiScene) (uiScene as unknown as { hide(): void }).hide();
    this.scene.start('CityViewScene', this.services);
  }

  // ── End cycle ──────────────────────────────────────────

  private _renderEndCycleButton(W: number, H: number): void {
    const btn = this.add.text(W - 28, H - 80, '[ End Cycle ]', {
      fontSize: '22px', color: '#ffaa33', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(1, 0.5).setInteractive({ useHandCursor: true });

    btn.on('pointerover', () => btn.setColor('#ffcc66'));
    btn.on('pointerout', () => btn.setColor('#ffaa33'));
    btn.on('pointerdown', () => {
      this.siteEvolutionSystem.runEvolutionPass(this.gsm.cycleCount);
      this.scene.start('WorldMapScene', this.services);
    });
  }
}
