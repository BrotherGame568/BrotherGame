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
├── music/      # Full music tracks (.ogg, .mp3)
├── sfx/        # Short sound effects
└── ambience/   # Looping background atmosphere tracks
```

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
