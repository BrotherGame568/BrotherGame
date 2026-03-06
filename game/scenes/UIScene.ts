/**
 * UIScene.ts
 * Persistent HUD overlay: resource counts and cycle counter.
 * Owner: Architecture domain
 *
 * === SCENE OWNERSHIP ===
 * Reads from GSM:  resources, cycleCount   [READ-ONLY — never writes to GSM]
 * Writes to GSM:   nothing
 *
 * === LIFECYCLE ===
 * - Launched once at game start; never stopped.
 * - Hidden during MissionScene and CityViewScene.
 */

import Phaser from 'phaser';
import type { IGameStateManager } from '@systems/IGameStateManager';
import { RESOURCE_DEFS } from '@data/ResourceDefinitions';

export const UI_SCENE_KEY = 'UIScene';

/** Tier → display colour for the HUD labels. */
const TIER_COLORS: Record<number, string> = {
  1: '#66ff66',
  2: '#6699ff',
  3: '#cc66ff',
};

export class UIScene extends Phaser.Scene {
  private gsm!: IGameStateManager;

  // Display objects
  private cycleText!: Phaser.GameObjects.Text;
  private resourceTexts: Map<string, Phaser.GameObjects.Text> = new Map();
  private barBg!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: UI_SCENE_KEY });
  }

  init(data: { gsm: IGameStateManager }): void {
    this.gsm = data.gsm;
  }

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const BAR_H = 56;

    // Semi-transparent bottom bar
    this.barBg = this.add.graphics();
    this.barBg.fillStyle(0x000000, 0.7);
    this.barBg.fillRect(0, H - BAR_H, W, BAR_H);

    // Cycle counter (left)
    this.cycleText = this.add.text(16, H - BAR_H + 14, '', {
      fontSize: '22px',
      color: '#ffffff',
      fontFamily: 'monospace',
    });

    // Resource labels (spread across center)
    const defs = Object.values(RESOURCE_DEFS);
    const startX = 280;
    const spacing = 260;

    defs.forEach((def, i) => {
      const color = TIER_COLORS[def.tier] ?? '#ffffff';
      const label = this.add.text(startX + i * spacing, H - BAR_H + 14, '', {
        fontSize: '20px',
        color,
        fontFamily: 'monospace',
      });
      this.resourceTexts.set(def.id, label);
    });

    this._refresh();
  }

  update(): void {
    this._refresh();
  }

  /** Called by other scenes to hide the persistent HUD. */
  hide(): void {
    this.scene.setVisible(false);
    this.scene.setActive(false);
  }

  /** Called when returning to WorldMapScene or HexZoomScene. */
  show(): void {
    this.scene.setActive(true);
    this.scene.setVisible(true);
  }

  // ── Private ──────────────────────────────────────────────

  private _refresh(): void {
    if (!this.gsm) return;
    this.cycleText.setText(`Cycle: ${this.gsm.cycleCount}`);

    const store = this.gsm.resources;
    for (const [id, def] of Object.entries(RESOURCE_DEFS)) {
      const text = this.resourceTexts.get(id);
      if (!text) continue;
      const tierMap = def.tier === 1 ? store.tier1 : def.tier === 2 ? store.tier2 : store.tier3;
      const amount = tierMap[id] ?? 0;
      text.setText(`${def.displayName}: ${amount}`);
    }
  }
}
