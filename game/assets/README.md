# game/assets — Art & Assets Domain

**Owner:** @abe-mart
**Branch:** `art/assets`

---

## What This Domain Is

The art domain owns all visual assets and the style guide:
- Character and object sprites
- UI elements and icons
- Background art
- Animations
- The asset manifest (the registry other domains use to reference assets)

**You provide assets. You do not write game logic.**

---

## What You Are Allowed to Touch

```
game/assets/            ← everything in here
game/assets/MANIFEST.md ← keep this up to date whenever assets are added/changed
docs/GAME_DESIGN.md     ← Art Direction section
```

## What You Must Not Touch

```
game/core/      ← architecture domain
game/levels/    ← levels domain
game/audio/     ← audio domain
```

---

## Folder Structure

```
game/assets/
├── sprites/        # Character, enemy, object, and item sprites
├── ui/             # HUD elements, buttons, panels, icons
├── backgrounds/    # World map and mission background art
└── animations/     # Animation sheets or frames
```

---

## Asset Naming Convention

```
[domain]_[subject]_[variant].[ext]

Examples:
  player_idle_01.png
  enemy_soldier_walk.png
  ui_button_primary.png
  bg_world_map_forest.png
  player_attack_anim.png
```

---

## The Manifest Is Required

**Every asset added to this folder must be registered in `MANIFEST.md`.**

Other domains reference assets by manifest ID, not file path. If an asset isn't in the manifest, other domains cannot safely use it. If you rename or move a file, update the manifest ID — do not break existing references without coordinating first.

---

## Export Standards

- **Sprites:** PNG, power-of-two dimensions where possible
- **UI:** PNG with transparency
- **Backgrounds:** PNG or compressed format (TBD once engine is chosen)
- **Animations:** sprite sheets preferred over individual frames

Do not commit raw project files (`.psd`, `.ai`, `.xcf`) unless the team agrees to. Keep the repo lean.

---

## Coordinating with Architecture

The architecture owner needs to know:
- Sprite sizes for collision/hitbox setup
- UI layout dimensions for scene composition
- Animation frame counts and timing

Open a `cross-domain` issue when these specs are ready or when they change.
