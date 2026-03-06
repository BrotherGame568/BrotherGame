/**
 * src/main.ts
 * ============================================================
 * Phaser Game entry point — Minimal playable version.
 *
 * This file:
 *   1. Instantiates all system implementations (real where available, stubs otherwise).
 *   2. Seeds initial game state via initializeGameState().
 *   3. Wires them into a BootScene that passes them to the first real scene.
 *   4. Registers all scenes so Phaser knows about them.
 *
 * Owner: Architecture (@arch)
 * ============================================================
 */

import Phaser from 'phaser';

// ── Real system implementations ───────────────────────────────
import { GameStateManagerStub }    from '@systems/IGameStateManager';
import { ResourceSystem }         from '@systems/ResourceSystem';
import { HeroSystem }             from '@systems/HeroSystem';
import { SiteEvolutionSystem }    from '@systems/SiteEvolutionSystem';
import { TradewindSystem }        from '@systems/TradewindSystem';
import { ReachSystem }            from '@systems/ReachSystem';

// ── Stubs for systems not yet implemented ─────────────────────
import { TechTreeSystemStub }      from '@systems/ITechTreeSystem';
import { AudioServiceStub }        from '@services/IAudioService';
import { SaveServiceStub }         from '@services/ISaveService';

// ── Game state seed ───────────────────────────────────────────
import { initializeGameState }     from '@data/InitialGameState';

// ── Scene imports ─────────────────────────────────────────────
import { WorldMapScene }  from '@scenes/WorldMapScene';
import { MissionScene }   from '@scenes/MissionScene';
import { CityViewScene }  from '@scenes/CityViewScene';
import { UIScene }        from '@scenes/UIScene';

// ── Type-only imports ─────────────────────────────────────────
import type { IGameStateManager }    from '@systems/IGameStateManager';
import type { IResourceSystem }      from '@systems/IResourceSystem';
import type { IHeroSystem }          from '@systems/IHeroSystem';
import type { ISiteEvolutionSystem } from '@systems/ISiteEvolutionSystem';
import type { ITradewindSystem }     from '@systems/ITradewindSystem';
import type { IReachSystem }         from '@systems/IReachSystem';
import type { ITechTreeSystem }      from '@systems/ITechTreeSystem';
import type { IAudioService }        from '@services/IAudioService';
import type { ISaveService }         from '@services/ISaveService';

// ─────────────────────────────────────────────────────────────
// Shared services bundle — passed into every scene via init()
// ─────────────────────────────────────────────────────────────
export interface ServiceBundle {
  gsm:               IGameStateManager;
  resourceSystem:    IResourceSystem;
  heroSystem:        IHeroSystem;
  siteEvolution:     ISiteEvolutionSystem;
  tradewindSystem:   ITradewindSystem;
  reachSystem:       IReachSystem;
  techTreeSystem:    ITechTreeSystem;
  audioService:      IAudioService;
  saveService:       ISaveService;
}

// ─────────────────────────────────────────────────────────────
// BootScene
// Instantiates all systems, seeds game state, starts WorldMapScene.
// ─────────────────────────────────────────────────────────────
class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    const gsm = new GameStateManagerStub();

    // Seed initial game state (hex map, heroes, resources, city)
    initializeGameState(gsm);

    const services: ServiceBundle = {
      gsm,
      resourceSystem:  new ResourceSystem(gsm),
      heroSystem:      new HeroSystem(gsm),
      siteEvolution:   new SiteEvolutionSystem(gsm),
      tradewindSystem: new TradewindSystem(gsm),
      reachSystem:     new ReachSystem(gsm),
      techTreeSystem:  new TechTreeSystemStub(gsm),
      audioService:    new AudioServiceStub(),
      saveService:     new SaveServiceStub(),
    };

    // Start the persistent UI overlay first so it's always on top.
    this.scene.launch('UIScene', services);

    // Then start the first gameplay scene.
    this.scene.start('WorldMapScene', services);
  }
}

// ─────────────────────────────────────────────────────────────
// Phaser Game configuration
// ─────────────────────────────────────────────────────────────
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,           // WebGL with Canvas fallback
  width: 1920,
  height: 1080,
  backgroundColor: '#1a1a2e',
  parent: 'game-container',
  scene: [
    BootScene,     // runs first, starts the others
    WorldMapScene,
    MissionScene,
    CityViewScene,
    UIScene,
  ],
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },  // MissionScene overrides with gravity: {y:600}
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

// ── Launch ────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const game = new Phaser.Game(config);
