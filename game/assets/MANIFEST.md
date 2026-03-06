# Asset Manifest

> Owner: Art domain (`art/assets`)
> Purpose: Canonical registry of all assets. Architecture and Levels reference asset IDs defined here when loading assets in scenes.
> **Agents:** Never hardcode asset paths in code. Use the `id` column as the Phaser texture/atlas key.

## Spec Conventions

| Field | Description |
|---|---|
| `id` | Phaser texture key used in code (snake_case) |
| `path` | Relative path from `game/assets/` |
| `size` | Pixel dimensions (width × height) per frame |
| `format` | File format (`png`, `json`+`png` atlas, etc.) |
| `orientation` | For tilesets: `flat-top` or `pointy-top` |
| `stagger` | For hex tilesets: `x` or `y` stagger axis |
| `status` | `placeholder` / `wip` / `final` |

---

## World Map (2D Flat)

| ID | Description | Path | Size | Format | Status |
|---|---|---|---|---|---|
| `worldmap_bg` | Full world map background | `backgrounds/worldmap_bg.png` | TBD | png | placeholder |
| `city_icon` | Floating city map icon | `sprites/city_icon.png` | 64×64 | png | placeholder |
| `wind_arrow` | Wind corridor direction indicator | `ui/wind_arrow.png` | 32×32 | png | placeholder |
| `wind_route_highlight` | Hex highlight for wind route option | `ui/wind_route_highlight.png` | TBD | png | placeholder |

---

## Hex Zoom (Pseudo-Isometric Hex Tileset)

### Tileset Specification
- **Orientation:** Flat-top hexes
- **Stagger axis:** Y (rows offset)
- **Tile size (pre-squish):** TBD — decide at format-selection milestone
- **Render scaleY:** ~0.55 applied to camera/tilemap to achieve pseudo-isometric look
- **Atlas format:** Tiled-compatible or Phaser atlas JSON — locked at format-selection milestone

| ID | Description | Path | Size | Format | Orientation | Status |
|---|---|---|---|---|---|---|
| `hex_tileset` | Main hex terrain tileset atlas | `sprites/hex_tileset.png` + `sprites/hex_tileset.json` | TBD | atlas | flat-top | placeholder |
| `site_marker_town` | Town site overlay icon | `sprites/site_markers.png` | 32×32 | png | — | placeholder |
| `site_marker_village` | Village site overlay icon | `sprites/site_markers.png` | 32×32 | png | — | placeholder |
| `site_marker_ruin` | Ruin site overlay icon | `sprites/site_markers.png` | 32×32 | png | — | placeholder |
| `site_marker_deposit` | Resource deposit overlay icon | `sprites/site_markers.png` | 32×32 | png | — | placeholder |
| `site_marker_skydock` | Sky dock overlay icon | `sprites/site_markers.png` | 32×32 | png | — | placeholder |
| `hex_reach_ring` | Reach radius overlay ring | `ui/hex_reach_ring.png` | TBD | png | — | placeholder |
| `site_state_conquered` | State change indicator: conquered | `ui/site_states.png` | 24×24 | png | — | placeholder |
| `site_state_thriving` | State change indicator: thriving | `ui/site_states.png` | 24×24 | png | — | placeholder |
| `site_state_destroyed` | State change indicator: destroyed | `ui/site_states.png` | 24×24 | png | — | placeholder |
| `hex_out_of_reach_overlay` | Tint overlay for locked hexes | `ui/hex_locked.png` | TBD | png | — | placeholder |

---

## City View (HOMM-Style)

| ID | Description | Path | Size | Format | Status |
|---|---|---|---|---|---|
| `city_bg_base` | City background — sky layer | `backgrounds/city_bg_sky.png` | TBD | png | placeholder |
| `city_bg_city` | City background — city base layer | `backgrounds/city_bg_city.png` | TBD | png | placeholder |
| `building_slot_empty` | Empty building slot indicator | `ui/building_slot_empty.png` | TBD | png | placeholder |
| `building_slot_hover` | Building slot hover state | `ui/building_slot_hover.png` | TBD | png | placeholder |
| `building_barracks` | Barracks building sprite | `sprites/buildings/barracks.png` | TBD | png | placeholder |
| `building_scouting_post` | Scouting Post building sprite | `sprites/buildings/scouting_post.png` | TBD | png | placeholder |
| `building_diplomats_hall` | Diplomat's Hall building sprite | `sprites/buildings/diplomats_hall.png` | TBD | png | placeholder |
| `building_navigators_guild` | Navigator's Guild building sprite | `sprites/buildings/navigators_guild.png` | TBD | png | placeholder |
| `building_storage_annex` | Storage Annex building sprite | `sprites/buildings/storage_annex.png` | TBD | png | placeholder |
| `building_research_spire` | Research Spire building sprite | `sprites/buildings/research_spire.png` | TBD | png | placeholder |
| `building_observatory` | Long-Range Observatory sprite | `sprites/buildings/observatory.png` | TBD | png | placeholder |
| `building_constructing` | Under construction overlay | `sprites/buildings/constructing.png` | TBD | png | placeholder |

---

## Heroes

| ID | Description | Path | Size | Format | Status |
|---|---|---|---|---|---|
| `hero_portrait_skirmisher` | Skirmisher class portrait | `sprites/heroes/portrait_skirmisher.png` | 96×96 | png | placeholder |
| `hero_portrait_scout` | Scout class portrait | `sprites/heroes/portrait_scout.png` | 96×96 | png | placeholder |
| `hero_portrait_envoy` | Envoy class portrait | `sprites/heroes/portrait_envoy.png` | 96×96 | png | placeholder |
| `hero_spritesheet_skirmisher` | Skirmisher mission spritesheet | `sprites/heroes/skirmisher.png` + `.json` | 48×48/frame | atlas | placeholder |
| `hero_spritesheet_scout` | Scout mission spritesheet | `sprites/heroes/scout.png` + `.json` | 48×48/frame | atlas | placeholder |
| `hero_spritesheet_envoy` | Envoy mission spritesheet | `sprites/heroes/envoy.png` + `.json` | 48×48/frame | atlas | placeholder |

### Hero Spritesheet Animation Convention
Each hero atlas must include animation frame sets named: `idle`, `run`, `jump`, `attack`, `hurt`, `death`.

---

## Mission (Side-View)

| ID | Description | Path | Size | Format | Status |
|---|---|---|---|---|---|
| `mission_tileset_forest` | Forest biome tileset | `sprites/mission/tileset_forest.png` + `.json` | TBD | atlas | placeholder |
| `mission_tileset_ruins` | Ruins biome tileset | `sprites/mission/tileset_ruins.png` + `.json` | TBD | atlas | placeholder |
| `enemy_spritesheet_grunt` | Basic enemy spritesheet | `sprites/enemies/grunt.png` + `.json` | 48×48/frame | atlas | placeholder |
| `pickup_tier1` | Tier 1 resource pickup icon | `sprites/pickups/pickup_tier1.png` | 24×24 | png | placeholder |
| `pickup_tier2` | Tier 2 resource pickup icon | `sprites/pickups/pickup_tier2.png` | 24×24 | png | placeholder |
| `pickup_tier3` | Tier 3 resource pickup icon | `sprites/pickups/pickup_tier3.png` | 24×24 | png | placeholder |

---

## UI (Shared / HUD)

| ID | Description | Path | Size | Format | Status |
|---|---|---|---|---|---|
| `ui_resource_bar` | Resource bar background | `ui/resource_bar.png` | TBD | png | placeholder |
| `ui_resource_icon_tier1` | Tier 1 resource icon | `ui/icon_tier1.png` | 24×24 | png | placeholder |
| `ui_resource_icon_tier2` | Tier 2 resource icon | `ui/icon_tier2.png` | 24×24 | png | placeholder |
| `ui_resource_icon_tier3` | Tier 3 resource icon | `ui/icon_tier3.png` | 24×24 | png | placeholder |
| `ui_panel_bg` | Generic panel background | `ui/panel_bg.png` | TBD | png | placeholder |
| `ui_button_normal` | Button normal state | `ui/button.png` | TBD | png | placeholder |
| `ui_button_hover` | Button hover state | `ui/button_hover.png` | TBD | png | placeholder |
| `ui_hero_status_available` | Hero status: available | `ui/hero_status.png` | 16×16 | png | placeholder |
| `ui_hero_status_injured` | Hero status: injured | `ui/hero_status.png` | 16×16 | png | placeholder |
| `ui_hero_status_on_mission` | Hero status: on mission | `ui/hero_status.png` | 16×16 | png | placeholder |

