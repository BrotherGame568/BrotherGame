# game/audio — Audio Domain

**Owner:** @AMarkMartin
**Branch:** `audio/music`

---

## What This Domain Is

The audio domain owns all sound and music:
- Music tracks (world map, mission, menus, stings)
- Sound effects (combat, UI, environment)
- Ambience (background atmosphere)
- The audio event registry

**You implement audio. You do not write game logic or trigger your own events — the game triggers events and you respond to them.**

---

## What You Are Allowed to Touch

```
game/audio/             ← everything in here
game/audio/EVENTS.md    ← keep this up to date
docs/GAME_DESIGN.md     ← Audio Direction section
```

## What You Must Not Touch

```
game/core/      ← architecture domain
game/levels/    ← levels domain
game/assets/    ← art domain
```

---

## Folder Structure

```
game/audio/
├── music/                   # Full music tracks (.opus recommended)
├── sfx/                     # Short sound effects (.wav for lossless)
├── ambience/                # Looping background atmosphere tracks
├── _meta/                   # Per-asset metadata JSON (managed by Audio Manager tool)
├── audio.catalog.json       # Master catalog (managed by Audio Manager tool)
└── MANIFEST.generated.md    # Human-readable summary (auto-generated, do not hand-edit)
```

---

## The Real Audio Service

The live Phaser implementation is `game/core/services/PhaserAudioService.ts`.
The stub (`AudioServiceStub` in `IAudioService.ts`) is still present for scenes that haven't been wired yet.

**Current status:** music fade in/out is fully working. SFX and ambience layers are Phase 1 stubs (no-ops).

### How scenes wire music

Every scene that needs music follows this pattern:

```typescript
// preload() — must come before load.image etc.
this.audioService.attachScene(this);

// end of create()
this.audioService.setAmbience('music_overworld_01', 2500); // 2.5 s cinematic fade-in
this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
  this.audioService.stopAll(1500); // 1.5 s smooth fade when leaving
});

// before this.scene.start(...) in any transition method
this.audioService.stopAll(1500);
```

### Adding a new track

1. Convert and save the audio file to `game/audio/music/` (use the **Audio Manager** tool at port 4174, or drop the file in manually).
2. In `PhaserAudioService.ts`, add a Vite `?url` import and a `TRACK_URLS` entry:
   ```typescript
   import myTrackUrl from '@audio/music/my_track.opus?url';
   // in TRACK_URLS:
   music_my_scene: myTrackUrl,
   ```
3. Add the track ID to the **Music Tracks** table in `game/audio/EVENTS.md` with status `active`.
4. Call `this.audioService.setAmbience('music_my_scene')` from the scene's `create()`.

> **Why `?url` imports?** Vite resolves them to content-hashed asset paths at build time, so the file is automatically copied into `dist/assets/` without needing to be in `/public/`.

### Fade duration conventions

| Situation | `ms` | Call |
|---|---|---|
| Scene starts / first loop | 2500 | `setAmbience(id, 2500)` or `setAmbience(id)` |
| Transitioning to another scene | 1500 | `stopAll(1500)` |
| Natural teardown (no successor) | 2500 | `stopAll()` |

---

## Audio Manager Tool

The asset pipeline (`tools/asset_pipeline/`) includes an **Audio** tab:
- Frontend: http://localhost:4174 → Audio tab
- Backend: http://localhost:4185 (start with `npm run asset-manager:server` from repo root)

Use it to:
- Convert source audio to Opus (music/ambience) or WAV (SFX)
- Set trim, normalise, loop metadata
- Browse the catalog and preview tracks in-browser

Output files land in `game/audio/{music,sfx,ambience}/`. Metadata JSON goes to `game/audio/_meta/`.

---

## How the Audio System Works

Audio is event-driven. You **do not** call audio functions yourself — you register handlers that fire when the game emits events.

```
# Your audio manager listens for events:
EventBus.on("mission_start",           self._play_mission_music)
EventBus.on("unit_death",              self._play_death_sfx)
EventBus.on("objective_complete",      self._play_objective_sting)
EventBus.on("map_turn_start",          self._play_turn_start_sound)
```

This means levels, core, and UI all trigger audio without knowing anything about audio implementation — and you can swap or update audio without touching any other domain.

Full event catalog: `game/audio/EVENTS.md` — keep it current.

---

## Adding a New Audio Event

If you need a new event that isn't in `EVENTS.md` yet:
1. Add it to `EVENTS.md` with status `proposed`
2. Open a `cross-domain` issue — the architecture owner adds the emit call to the right system
3. Once agreed, change status to `active`

Do not add emit calls to other domains' code yourself.

---

## File Naming Convention

```
[type]_[context]_[description].[ext]

Examples:
  music_world_map_main.ogg
  music_mission_tense.ogg
  sfx_unit_attack_sword.wav
  sfx_ui_button_click.wav
  ambience_mission_forest.ogg
```

---

## Export Standards

- **Music:** `.ogg` (preferred for size), 44.1kHz stereo
- **SFX:** `.wav` or `.ogg`, mono where appropriate
- **Ambience:** `.ogg`, loopable

Do not commit raw DAW project files unless the team agrees. Keep the repo lean.
