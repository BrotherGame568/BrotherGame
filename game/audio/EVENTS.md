# Audio Event Registry

> Owner: Audio domain (`audio/music`)
> Purpose: Canonical list of all audio event names. Architecture triggers these via `IAudioService.play(eventName)`. Audio implements the sound behind each name.
> **Agents:** Never hardcode audio file paths in code. Call `this.audioService.play('event_name')` using the names in this file only.

## Convention

- Event names: `snake_case` strings
- Format: `scene_action` or `scene_state`
- All names are string literals — the TypeScript `AudioEventName` union type in `IAudioService.ts` is generated from this list.

---

## Cycle / World Map Events

| Event Name | Scene | When It Fires | Status |
|---|---|---|---|
| `cycle_start` | WorldMapScene | New cycle begins; wind options presented | planned |
| `wind_option_hover` | WorldMapScene | Player hovers over a wind route option | planned |
| `wind_option_select` | WorldMapScene | Player confirms wind route choice | planned |
| `city_move` | WorldMapScene | City icon moves to new hex position | planned |

---

## Hex Zoom Events

| Event Name | Scene | When It Fires | Status |
|---|---|---|---|
| `hexzoom_enter` | HexZoomScene | Scene becomes active | planned |
| `hex_hover` | HexZoomScene | Player hovers an accessible hex | planned |
| `hex_select` | HexZoomScene | Player selects a site hex | planned |
| `hex_locked` | HexZoomScene | Player clicks an out-of-reach hex | planned |
| `site_state_changed` | HexZoomScene | A site shows a state-change indicator | planned |
| `party_select_open` | HexZoomScene | Party selection modal opens | planned |
| `party_select_confirm` | HexZoomScene | Player confirms mission party | planned |

---

## Mission Events

| Event Name | Scene | When It Fires | Status |
|---|---|---|---|
| `mission_start` | MissionScene | Mission scene launches | planned |
| `mission_complete_success` | MissionScene | All primary objectives complete | planned |
| `mission_complete_retreat` | MissionScene | Player reaches escape zone | planned |
| `mission_complete_failure` | MissionScene | Active hero HP reaches 0 | planned |
| `hero_attack` | MissionScene | Active hero attacks | planned |
| `hero_hurt` | MissionScene | Active hero takes damage | planned |
| `hero_death` | MissionScene | Active hero is defeated | planned |
| `enemy_hurt` | MissionScene | Enemy takes damage | planned |
| `enemy_death` | MissionScene | Enemy is defeated | planned |
| `pickup_tier1` | MissionScene | Player picks up a Tier 1 resource | planned |
| `pickup_tier2` | MissionScene | Player picks up a Tier 2 resource | planned |
| `pickup_tier3` | MissionScene | Player picks up a Tier 3 resource | planned |
| `objective_complete` | MissionScene | A mission objective is completed | planned |

---

## City View Events

| Event Name | Scene | When It Fires | Status |
|---|---|---|---|
| `city_enter` | CityViewScene | City view scene becomes active | planned |
| `building_slot_hover` | CityViewScene | Player hovers a building slot | planned |
| `building_slot_select` | CityViewScene | Player clicks a building slot | planned |
| `building_construct_start` | CityViewScene | Player starts constructing a building | planned |
| `building_construct_complete` | CityViewScene | Construction finishes (cycle passes) | planned |
| `hero_recruit` | CityViewScene | New hero recruited | planned |
| `resource_insufficient` | CityViewScene | Player tries to build with insufficient resources | planned |

---

## UI / Global Events

| Event Name | Scene | When It Fires | Status |
|---|---|---|---|
| `ui_button_click` | Any | Any button pressed | planned |
| `ui_menu_open` | Any | Any menu or panel opens | planned |
| `ui_menu_close` | Any | Any menu or panel closes | planned |
| `ui_error` | Any | Invalid action attempted | planned |

---

## Music Tracks

Music tracks are longer looping compositions. `IAudioService.setAmbience(trackId)` crossfades to the given track.

| Track ID | Context | Loop | Status |
|---|---|---|---|
| `music_world_map` | WorldMapScene — sailing the skies, calm exploration | Yes | planned |
| `music_hex_zoom` | HexZoomScene — nearby surface, anticipation | Yes | planned |
| `music_mission_explore` | MissionScene — exploration tone | Yes | planned |
| `music_mission_combat` | MissionScene — combat engaged | Yes | planned |
| `music_city` | CityViewScene — city management, warm | Yes | planned |
| `music_mission_success` | Mission success sting | No | planned |
| `music_mission_retreat` | Mission retreat sting | No | planned |
| `music_mission_failure` | Mission failure sting | No | planned |
| `music_cycle_advance` | End of cycle, new route starting | No | planned |

---

## Ambience Layers

Ambience layers run beneath music at lower volume. Multiple may be active simultaneously.

| Ambience ID | Context | Status |
|---|---|---|
| `ambience_wind` | Any overworld scene — constant wind | planned |
| `ambience_clouds` | WorldMapScene — cloud layer passing | planned |
| `ambience_city_bustle` | CityViewScene — city life | planned |
| `ambience_forest` | MissionScene forest biome | planned |
| `ambience_ruins` | MissionScene ruins biome | planned |

