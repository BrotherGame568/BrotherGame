/**
 * CharacterSelectScene.ts
 * Full-screen cinematic character selection overlay launched before every mission.
 * Owner: Architecture domain
 *
 * === USAGE ===
 * Launched as a parallel overlay:
 *   this.scene.launch('CharacterSelectScene', { tile, ...this.services });
 *   this.scene.get('CharacterSelectScene').events.once('confirmed', ({ activeHeroId, supportHeroId }) => {...});
 *   this.scene.get('CharacterSelectScene').events.once('cancelled', () => {...});
 *
 * === EVENTS EMITTED ===
 *   'confirmed' → { activeHeroId: string, supportHeroId: string | null }
 *   'cancelled' → (no data)
 *
 * === EXTENSIBILITY ===
 * Cards are built from heroSystem.getRoster(). Adding a new hero with a
 * portraitId matching a ui/ asset automatically adds a card.
 * If no portrait asset exists, a class-tinted placeholder is shown.
 */

import Phaser from 'phaser';
import type { Hero } from '@data/Hero';
import type { HexTile } from '@data/HexTile';
import type { IHeroSystem } from '@systems/IHeroSystem';
import type { ServiceBundle } from '../../src/main';

// ── Layout ────────────────────────────────────────────────
const BAR_H       = 630;
const CARD_W      = 262;
const CARD_H      = 362;  // ~= CARD_W / 0.724 to match the card art aspect ratio
const CARD_GAP    = 32;
const MAX_VISIBLE = 6;

// ── Colors ────────────────────────────────────────────────
const COL_DIM        = 0x050508;
const COL_BAR_BG     = 0x0d0d1a;
const COL_BAR_BORDER = 0x252540;
const COL_CARD_BG    = 0x13132a;
const COL_CARD_IDLE  = 0x2a2a50;
const COL_HOVER      = 0x6699cc;
const COL_ACTIVE     = 0xffcc44;
const COL_SUPPORT    = 0x44aaff;

const CLASS_COLORS: Record<string, number> = {
  skirmisher: 0xcc4422,
  scout:      0x22aa55,
  envoy:      0x3355cc,
};

const STAT_COLORS = {
  combat:      0xff6655,
  exploration: 0x55ddaa,
  diplomacy:   0x5588ff,
};

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface CardEntry {
  heroId: string;
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Graphics;
  baseY: number;
}

// ─────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────

export class CharacterSelectScene extends Phaser.Scene {
  // Injected data
  private tile!: HexTile;
  private heroSystem!: IHeroSystem;
  private services!: ServiceBundle & { tile: HexTile };

  // Hero lists
  private roster: Hero[] = [];
  private available: Hero[] = [];

  // Selection state
  private phase: 'active' | 'support' = 'active';
  private activeHeroId: string | null = null;
  private supportHeroId: string | null = null;

  // Keyboard navigation
  private kbFocusIdx = 0;
  private pageOffset = 0;

  // UI objects
  private bar!: Phaser.GameObjects.Container;
  private cardsContainer!: Phaser.GameObjects.Container;
  private cardEntries: CardEntry[] = [];
  private phaseLabel!: Phaser.GameObjects.Text;
  private launchBtn!: Phaser.GameObjects.Text;
  private launchBtnBg!: Phaser.GameObjects.Graphics;
  private actionBtn!: Phaser.GameObjects.Text;
  private prevArrow!: Phaser.GameObjects.Text;
  private nextArrow!: Phaser.GameObjects.Text;
  private tooltip!: Phaser.GameObjects.Text;
  private kbRing!: Phaser.GameObjects.Graphics;

  constructor() {
    super({ key: 'CharacterSelectScene' });
  }

  // ── Lifecycle ─────────────────────────────────────────

  init(data: ServiceBundle & { tile: HexTile }): void {
    this.services     = data;
    this.tile         = data.tile;
    this.heroSystem   = data.heroSystem;
    this.phase        = 'active';
    this.activeHeroId = null;
    this.supportHeroId = null;
    this.kbFocusIdx   = 0;
    this.pageOffset   = 0;
  }

  preload(): void {
    // Load portrait images for all heroes; skip already-loaded textures.
    this.roster = this.heroSystem.getRoster ? this.heroSystem.getRoster() : [];
    for (const hero of this.roster) {
      const key = hero.portraitId;
      if (key && !this.textures.exists(key)) {
        this.load.image(key, `ui/${key}.webp`);
      }
    }
  }

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    this.available = this.heroSystem.getAvailable();

    // ── Dim overlay (click outside = cancel) ──────────────
    const dim = this.add.graphics();
    dim.fillStyle(COL_DIM, 0.82);
    dim.fillRect(0, 0, W, H);
    dim.setInteractive(
      new Phaser.Geom.Rectangle(0, 0, W, H),
      Phaser.Geom.Rectangle.Contains,
    );
    dim.on('pointerdown', () => this._cancel());

    // ── Horizontal bar (starts off-screen below, slides up) ─
    this.bar = this.add.container(0, H + BAR_H / 2);

    // Bar background with multi-step top/bottom fade for depth
    const barBg = this.add.graphics();
    barBg.fillStyle(COL_BAR_BG, 1);
    barBg.fillRect(0, -BAR_H / 2, W, BAR_H);
    // Bright accent border lines
    barBg.lineStyle(2, 0x3a3a6a);
    barBg.lineBetween(0, -BAR_H / 2, W, -BAR_H / 2);
    barBg.lineBetween(0,  BAR_H / 2, W,  BAR_H / 2);
    // Thin highlight inside the top border for a subtle rim-light
    barBg.lineStyle(1, 0x5a5a9a, 0.35);
    barBg.lineBetween(0, -BAR_H / 2 + 2, W, -BAR_H / 2 + 2);
    // Vignette: fade edges to black
    const vL = this.add.graphics();
    vL.fillStyle(0x000000, 0.35);
    vL.fillRect(0, -BAR_H / 2, 120, BAR_H);
    const vR = this.add.graphics();
    vR.fillStyle(0x000000, 0.35);
    vR.fillRect(W - 120, -BAR_H / 2, 120, BAR_H);
    // Absorb clicks on bar so they don't reach the dim overlay
    barBg.setInteractive(
      new Phaser.Geom.Rectangle(0, -BAR_H / 2, W, BAR_H),
      Phaser.Geom.Rectangle.Contains,
    );
    barBg.on('pointerdown', () => { /* absorb */ });
    this.bar.add([barBg, vL, vR]);

    // ── Mission info header ─────────────────────────────────
    // Site type name — prominent, no coordinates
    const siteLabel = this.tile.siteType.toUpperCase();
    const siteText = this.add.text(W / 2, -BAR_H / 2 + 26, siteLabel, {
      fontSize: '28px', color: '#ccd8e8', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.bar.add(siteText);

    // Danger level — centered on its own line
    const pips = this._buildDangerPips(W / 2, -BAR_H / 2 + 58);
    this.bar.add(pips);

    // Phase label — large, centered
    this.phaseLabel = this.add.text(W / 2, -BAR_H / 2 + 96, 'SELECT YOUR HERO', {
      fontSize: '32px', color: '#88ccff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.bar.add(this.phaseLabel);

    // ── Keyboard focus ring (must exist before _layoutCards calls _drawKbRing) ─
    this.kbRing = this.add.graphics();
    this.bar.add(this.kbRing);

    // ── Cards ───────────────────────────────────────────────
    this.cardsContainer = this.add.container(0, 0);
    this.bar.add(this.cardsContainer);
    this._buildCards();
    this._layoutCards();

    // ── Pagination arrows ───────────────────────────────────
    this.prevArrow = this.add.text(56, 30, '◀', {
      fontSize: '36px', color: '#3a4a5a', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.prevArrow.on('pointerover', () => this.prevArrow.setColor('#7799bb'));
    this.prevArrow.on('pointerout',  () => this.prevArrow.setColor('#3a4a5a'));
    this.prevArrow.on('pointerdown', () => this._scrollPage(-1));

    this.nextArrow = this.add.text(W - 56, 30, '▶', {
      fontSize: '36px', color: '#3a4a5a', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.nextArrow.on('pointerover', () => this.nextArrow.setColor('#7799bb'));
    this.nextArrow.on('pointerout',  () => this.nextArrow.setColor('#3a4a5a'));
    this.nextArrow.on('pointerdown', () => this._scrollPage(1));
    this.bar.add([this.prevArrow, this.nextArrow]);
    this._updateArrows();

    // ── Tooltip (support bonus preview on hover) ────────────
    this.tooltip = this.add.text(W / 2, BAR_H / 2 - 96, '', {
      fontSize: '15px', color: '#77ccaa', fontFamily: 'monospace',
    }).setOrigin(0.5).setAlpha(0);
    this.bar.add(this.tooltip);

    // ── Launch Mission button ───────────────────────────────
    // Button geometry — redrawn on state changes
    const BW = 380; const BH = 50; const BR = 10;
    const bx = W / 2 - BW / 2;
    const by = BAR_H / 2 - 74;

    this.launchBtnBg = this.add.graphics();
    this._redrawLaunchBtn(false, false);
    this.bar.add(this.launchBtnBg);

    this.launchBtn = this.add.text(W / 2, by + BH / 2, 'LAUNCH MISSION', {
      fontSize: '22px', color: '#2a3a28', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });

    this.launchBtn.on('pointerdown', () => {
      if (!this.activeHeroId) return;
      this._redrawLaunchBtn(true, false);
      this.launchBtn.setColor('#ffffff');
      this.time.delayedCall(120, () => this._confirm());
    });
    this.launchBtn.on('pointerover', () => {
      if (!this.activeHeroId) return;
      this._redrawLaunchBtn(true, true);
      this.launchBtn.setColor('#ccffcc');
    });
    this.launchBtn.on('pointerout', () => {
      const active = !!this.activeHeroId;
      this._redrawLaunchBtn(active, false);
      this.launchBtn.setColor(active ? '#88ee88' : '#2a3a28');
    });
    this.bar.add(this.launchBtn);

    // ── Secondary action button (Cancel / Skip Support) ─────
    // Placed well above the Launch button
    this.actionBtn = this.add.text(W / 2, BAR_H / 2 - 14, '[ Cancel ]', {
      fontSize: '16px', color: '#885555', fontFamily: 'monospace',
    }).setOrigin(0.5).setInteractive({ useHandCursor: true });
    this.actionBtn.on('pointerover', () => this.actionBtn.setColor('#ff9999'));
    this.actionBtn.on('pointerout',  () => this.actionBtn.setColor(this.activeHeroId ? '#666677' : '#885555'));
    this.actionBtn.on('pointerdown', () => {
      if (this.activeHeroId) {
        this._confirm(); // skip support and launch
      } else {
        this._cancel();
      }
    });
    this.bar.add(this.actionBtn);

    // ── Keyboard bindings ───────────────────────────────────
    this.input.keyboard!.on('keydown-LEFT',  () => this._kbNav(-1));
    this.input.keyboard!.on('keydown-RIGHT', () => this._kbNav(1));
    this.input.keyboard!.on('keydown-ENTER', () => this._kbConfirm());
    this.input.keyboard!.on('keydown-ESC',   () => {
      if (this.activeHeroId) this._resetToPhase1();
      else this._cancel();
    });

    // ── No heroes edge case ─────────────────────────────────
    if (this.available.length === 0) {
      this.phaseLabel.setText('NO HEROES AVAILABLE').setColor('#ff8888');
    }

    // ── Slide up ────────────────────────────────────────────
    this.tweens.add({
      targets: this.bar,
      y: H / 2,
      duration: 340,
      ease: 'Back.Out',
    });
  }

  shutdown(): void {
    this.input.keyboard?.removeAllListeners();
  }

  // ── Card construction ─────────────────────────────────

  private _buildCards(): void {
    this.cardEntries = [];
    this.cardsContainer.removeAll(true);

    for (const hero of this.roster) {
      const isAvailable = this.available.some(h => h.id === hero.id);
      const entry = this._makeCard(hero, isAvailable);
      this.cardEntries.push({ heroId: hero.id, container: entry.container, border: entry.border, baseY: 0 });
      this.cardsContainer.add(entry.container);
    }
  }

  private _makeCard(
    hero: Hero,
    isAvailable: boolean,
  ): { container: Phaser.GameObjects.Container; border: Phaser.GameObjects.Graphics } {
    const cont = this.add.container(0, 0);

    // ── Dark card background ────────────────────────────
    const bg = this.add.graphics();
    bg.fillStyle(0x080810, 1);
    bg.fillRoundedRect(0, 0, CARD_W, CARD_H, 10);
    cont.add(bg);

    // ── Portrait — fills full card, scaled to width ─────
    const portraitKey = hero.portraitId;
    const textureOk = portraitKey &&
      this.textures.exists(portraitKey) &&
      this.textures.get(portraitKey).key !== '__MISSING';

    if (textureOk) {
      const img = this.add.image(CARD_W / 2, 0, portraitKey).setOrigin(0.5, 0);
      img.setScale(CARD_W / img.width);
      cont.add(img);
    } else {
      // Fallback: class-colored placeholder
      const classHex = CLASS_COLORS[hero.heroClass] ?? 0x334455;
      const fb = this.add.graphics();
      fb.fillStyle(classHex, 0.45);
      fb.fillRoundedRect(0, 0, CARD_W, CARD_H, 10);
      const initial = this.add.text(CARD_W / 2, CARD_H / 2, hero.name[0] ?? '?', {
        fontSize: '110px', color: '#ffffff', fontFamily: 'monospace',
      }).setOrigin(0.5).setAlpha(0.25);
      cont.add(fb);
      cont.add(initial);
    }

    // ── Border (redrawn on state changes) ──────────────
    const border = this.add.graphics();
    border.lineStyle(2, isAvailable ? COL_CARD_IDLE : 0x18182a);
    border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
    cont.add(border);

    // ── Unavailable overlay + status label ─────────────
    if (!isAvailable) {
      const dimOverlay = this.add.graphics();
      dimOverlay.fillStyle(0x000000, 0.62);
      dimOverlay.fillRoundedRect(0, 0, CARD_W, CARD_H, 10);
      cont.add(dimOverlay);

      const statusBg = this.add.graphics();
      statusBg.fillStyle(0x111122, 0.85);
      statusBg.fillRoundedRect(CARD_W / 2 - 44, CARD_H / 2 - 14, 88, 28, 6);
      cont.add(statusBg);

      const statusTxt = this.add.text(CARD_W / 2, CARD_H / 2, hero.status.toUpperCase(), {
        fontSize: '13px', color: '#555577', fontFamily: 'monospace',
      }).setOrigin(0.5);
      cont.add(statusTxt);
    } else {
      bg.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, CARD_W, CARD_H),
        Phaser.Geom.Rectangle.Contains,
      );
      bg.input!.cursor = 'pointer';
      bg.on('pointerover', () => this._onHover(hero, cont, border, true));
      bg.on('pointerout',  () => this._onHover(hero, cont, border, false));
      bg.on('pointerdown', () => this._onCardClick(hero));
    }

    return { container: cont, border };
  }

  // ── Card layout ───────────────────────────────────────

  private _layoutCards(): void {
    const W = this.scale.width;
    const page = this.roster.slice(this.pageOffset, this.pageOffset + MAX_VISIBLE);
    const count = page.length;
    const totalW = count * CARD_W + (count - 1) * CARD_GAP;
    const startX = (W - totalW) / 2;
    // Cards: top edge starts below the header (~120px from bar top), centred vertically
    const cardY = -BAR_H / 2 + 120;

    // Hide all, then position and show only this page
    for (const entry of this.cardEntries) {
      entry.container.setVisible(false);
    }

    for (let i = 0; i < page.length; i++) {
      const hero  = page[i]!;
      const entry = this.cardEntries.find(e => e.heroId === hero.id);
      if (!entry) continue;
      entry.container.setPosition(startX + i * (CARD_W + CARD_GAP), cardY);
      entry.container.setVisible(true);
      entry.baseY = cardY;
    }

    this._drawKbRing();
  }

  // ── Interaction ───────────────────────────────────────

  private _onHover(
    hero: Hero,
    cont: Phaser.GameObjects.Container,
    border: Phaser.GameObjects.Graphics,
    isOver: boolean,
  ): void {
    // Don't animate already-selected cards
    if (hero.id === this.activeHeroId || hero.id === this.supportHeroId) return;

    const entry = this.cardEntries.find(e => e.heroId === hero.id);
    if (!entry) return;

    this.tweens.killTweensOf(cont);
    this.tweens.add({
      targets: cont,
      scaleX: isOver ? 1.06 : 1,
      scaleY: isOver ? 1.06 : 1,
      y: isOver ? entry.baseY - 10 : entry.baseY,
      duration: 130,
      ease: 'Sine.Out',
    });

    border.clear();
    border.lineStyle(isOver ? 2 : 1, isOver ? COL_HOVER : COL_CARD_IDLE);
    border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);

    // Support bonus tooltip in phase 2
    if (this.phase === 'support' && isOver && hero.bonusArray.length > 0) {
      const bonusStr = hero.bonusArray
        .map(b => `+${b.modifier} ${b.stat}`)
        .join('   ');
      this.tooltip.setText(`Support bonus: ${bonusStr}`).setAlpha(1);
    } else if (!isOver) {
      this.tooltip.setAlpha(0);
    }
  }

  private _onCardClick(hero: Hero): void {
    if (this.phase === 'active') {
      this._selectActive(hero.id);
    } else {
      this._selectSupport(hero.id);
    }
  }

  private _selectActive(heroId: string): void {
    this.activeHeroId = heroId;
    this.phase = 'support';

    for (const entry of this.cardEntries) {
      if (entry.heroId === heroId) {
        entry.border.clear();
        entry.border.lineStyle(3, COL_ACTIVE);
        entry.border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
        // Snap back to base (was hovering)
        this.tweens.killTweensOf(entry.container);
        entry.container.setScale(1).setY(entry.baseY);
      } else if (this.available.some(h => h.id === entry.heroId)) {
        entry.container.setAlpha(0.45);
      }
    }

    this.phaseLabel.setText('CHOOSE SUPPORT HERO  (OPTIONAL)').setColor('#66bbff');
    this._redrawLaunchBtn(true, false);
    this.launchBtn.setColor('#88ee88');
    this.actionBtn.setText('[ Skip Support & Launch ]').setColor('#666677');
    this.kbFocusIdx = 0;
    this._drawKbRing();
  }

  private _selectSupport(heroId: string): void {
    if (heroId === this.activeHeroId) return;

    // Toggle off if already selected
    if (this.supportHeroId === heroId) {
      this.supportHeroId = null;
      const entry = this.cardEntries.find(e => e.heroId === heroId);
      if (entry) {
        entry.border.clear();
        entry.border.lineStyle(1, COL_CARD_IDLE);
        entry.border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
        entry.container.setAlpha(0.45);
      }
      return;
    }

    this.supportHeroId = heroId;

    for (const entry of this.cardEntries) {
      if (!this.available.some(h => h.id === entry.heroId)) continue;
      if (entry.heroId === this.activeHeroId) continue;

      this.tweens.killTweensOf(entry.container);
      entry.container.setScale(1).setY(entry.baseY);

      if (entry.heroId === heroId) {
        entry.container.setAlpha(1);
        entry.border.clear();
        entry.border.lineStyle(3, COL_SUPPORT);
        entry.border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
      } else {
        entry.container.setAlpha(0.35);
        entry.border.clear();
        entry.border.lineStyle(1, 0x1a1a35);
        entry.border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
      }
    }
  }

  private _resetToPhase1(): void {
    this.activeHeroId  = null;
    this.supportHeroId = null;
    this.phase         = 'active';
    this.tooltip.setAlpha(0);

    for (const entry of this.cardEntries) {
      this.tweens.killTweensOf(entry.container);
      entry.container.setAlpha(1).setScale(1).setY(entry.baseY);
      const isAvail = this.available.some(h => h.id === entry.heroId);
      entry.border.clear();
      entry.border.lineStyle(2, isAvail ? COL_CARD_IDLE : 0x1a1a30);
      entry.border.strokeRoundedRect(0, 0, CARD_W, CARD_H, 10);
    }

    this.phaseLabel.setText('SELECT YOUR HERO').setColor('#88ccff');
    this._redrawLaunchBtn(false, false);
    this.launchBtn.setColor('#2a3a28');
    this.actionBtn.setText('[ Cancel ]').setColor('#885555');
    this.kbFocusIdx = 0;
    this._drawKbRing();
  }

  // ── Pagination ────────────────────────────────────────

  private _scrollPage(dir: number): void {
    const maxOffset = Math.max(0, this.roster.length - MAX_VISIBLE);
    this.pageOffset = Phaser.Math.Clamp(this.pageOffset + dir * MAX_VISIBLE, 0, maxOffset);
    this._layoutCards();
    this._updateArrows();
  }

  private _updateArrows(): void {
    const hasMore = this.roster.length > MAX_VISIBLE;
    this.prevArrow.setAlpha(hasMore && this.pageOffset > 0 ? 0.85 : 0.15);
    this.nextArrow.setAlpha(hasMore && this.pageOffset + MAX_VISIBLE < this.roster.length ? 0.85 : 0.15);
  }

  // ── Keyboard nav ──────────────────────────────────────

  private _kbNav(dir: number): void {
    const pool = this._getNavPool();
    if (pool.length === 0) return;
    this.kbFocusIdx = (this.kbFocusIdx + dir + pool.length) % pool.length;
    this._drawKbRing();
  }

  private _kbConfirm(): void {
    const pool = this._getNavPool();
    if (pool.length === 0) {
      if (this.activeHeroId) this._confirm();
      return;
    }
    const hero = pool[this.kbFocusIdx];
    if (hero) this._onCardClick(hero);
  }

  private _getNavPool(): Hero[] {
    return this.phase === 'active'
      ? this.available
      : this.available.filter(h => h.id !== this.activeHeroId);
  }

  private _drawKbRing(): void {
    this.kbRing.clear();
    const pool = this._getNavPool();
    if (pool.length === 0) return;

    const hero  = pool[this.kbFocusIdx % pool.length];
    if (!hero) return;
    const entry = this.cardEntries.find(e => e.heroId === hero.id);
    if (!entry || !entry.container.visible) return;

    const { x, y } = entry.container;
    this.kbRing.lineStyle(2, 0xffffff, 0.35);
    this.kbRing.strokeRoundedRect(x - 4, y - 4, CARD_W + 8, CARD_H + 8, 12);
  }

  // ── Danger pips ───────────────────────────────────────

  private _buildDangerPips(x: number, y: number): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);

    const label = this.add.text(0, 0, 'DANGER LEVEL', {
      fontSize: '13px', color: '#667788', fontFamily: 'monospace',
    }).setOrigin(0.5, 0.5);
    c.add(label);

    // 5 pips centered after label
    const pipSpacing = 20;
    const totalPipW  = 5 * pipSpacing - 4;
    const pipStartX  = -totalPipW / 2 + 8;
    const labelOffset = label.width / 2 + 12;

    for (let i = 0; i < 5; i++) {
      const g = this.add.graphics();
      const filled = i < this.tile.dangerLevel;
      g.fillStyle(filled ? 0xff4422 : 0x1e2035);
      g.fillCircle(labelOffset + pipStartX + i * pipSpacing, 0, filled ? 7 : 6);
      if (filled) {
        g.lineStyle(1, 0xff6644, 0.5);
        g.strokeCircle(labelOffset + pipStartX + i * pipSpacing, 0, 7);
      }
      c.add(g);
    }
    return c;
  }

  // ── Confirm / cancel ──────────────────────────────────

  private _confirm(): void {
    if (!this.activeHeroId) return;
    const activeHeroId  = this.activeHeroId;
    const supportHeroId = this.supportHeroId;
    this._slideOut(() => {
      this.events.emit('confirmed', { activeHeroId, supportHeroId });
      this.scene.stop();
    });
  }

  private _cancel(): void {
    this._slideOut(() => {
      this.events.emit('cancelled');
      this.scene.stop();
    });
  }

  private _redrawLaunchBtn(active: boolean, hovered: boolean): void {
    const W  = this.scale.width;
    const BW = 380; const BH = 50; const BR = 10;
    const bx = W / 2 - BW / 2;
    const by = BAR_H / 2 - 74;
    this.launchBtnBg.clear();
    if (active) {
      this.launchBtnBg.fillStyle(hovered ? 0x1e5c1e : 0x163c14, 1);
      this.launchBtnBg.fillRoundedRect(bx, by, BW, BH, BR);
      this.launchBtnBg.lineStyle(2, hovered ? 0x66dd66 : 0x337733);
      this.launchBtnBg.strokeRoundedRect(bx, by, BW, BH, BR);
      this.launchBtnBg.lineStyle(1, 0x55aa55, 0.4);
      this.launchBtnBg.lineBetween(bx + BR, by + 1, bx + BW - BR, by + 1);
    } else {
      this.launchBtnBg.fillStyle(0x111118, 1);
      this.launchBtnBg.fillRoundedRect(bx, by, BW, BH, BR);
      this.launchBtnBg.lineStyle(1, 0x222233);
      this.launchBtnBg.strokeRoundedRect(bx, by, BW, BH, BR);
    }
  }

  private _slideOut(onComplete: () => void): void {
    const H = this.scale.height;
    this.tweens.add({
      targets: this.bar,
      y: H + BAR_H / 2,
      duration: 280,
      ease: 'Back.In',
      onComplete,
    });
  }
}
