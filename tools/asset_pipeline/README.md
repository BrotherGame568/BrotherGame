# Asset Manager

Standalone asset-processing and asset-library tool for BrotherGame.

## Purpose

This tool is used to:

- import new image, spritesheet, and video assets
- process and optimize assets into `game/assets/`
- maintain structured metadata in `game/assets/_meta/`
- regenerate `game/assets/manifest.catalog.json`
- regenerate `game/assets/MANIFEST.generated.md`
- browse, edit, archive, and delete previously saved assets

The UI is split into two main views:

1. **Library view** — thumbnail gallery of saved assets
2. **Editor view** — processing, preview, metadata, sizing, animation, and save tools

## Start the tool

From the repo root:

- `npm run asset-manager:start` — recommended, starts both together
- `npm run asset-manager:server` — starts only the local backend
- `npm run asset-manager:dev` — starts only the Vite frontend
- `npm run asset-manager:build` — production build validation

The backend listens on `http://127.0.0.1:4185`.

## Library workflow

The default entry screen is the asset library.

From the library you can:

- browse saved assets in a thumbnail gallery
- search by ID, name, category, or path
- select an asset to inspect it
- open the selected asset in the editor
- archive or restore assets
- delete assets
- create a brand new asset with **Add new asset**

## Editor workflow

The editor supports:

- image import
- spritesheet import
- video-to-spritesheet generation
- output sizing
- display sizing
- animation grid setup
- origin editing
- collision-box editing
- local matte-style background removal preview
- live grounded animation preview

## Saving behavior

### New assets

If the editor is opened with **Add new asset**, saving creates a new asset record and writes:

- processed output file to `game/assets/<category>/`
- metadata JSON to `game/assets/_meta/`
- updated catalog entry in `game/assets/manifest.catalog.json`
- regenerated markdown manifest in `game/assets/MANIFEST.generated.md`

### Existing assets

If an asset is opened from the library, saving is treated as an **update to that asset**, not a new asset.

That means:

- the existing catalog entry is replaced
- the metadata file is updated in place
- if the asset ID changes, the old entry is removed
- if the category or filename changes, the old output file is removed and the new one is written
- generated manifests are refreshed to point only at the updated asset

This prevents duplicates when editing existing assets.

### Metadata-only save

For existing assets, **Save metadata only** updates the saved asset record without reprocessing the file.

Use it when changing:

- name / asset ID
- notes
- category
- display sizing
- origin
- collision box
- animation metadata

Do **not** use metadata-only save when changing the actual processed output format or wanting a fresh re-render of the source.

## Video assets

Video imports are processed into spritesheets.

Important behavior:

- the generated spritesheet output is saved
- the original source video is not stored by the asset manager
- reopening an existing video-derived asset loads the generated sheet back into the editor as a spritesheet-style edit target

## Generated files

The tool maintains these files:

- `game/assets/manifest.catalog.json`
- `game/assets/MANIFEST.generated.md`
- `game/assets/_meta/*.asset.json`

Treat them as tool-managed outputs.

## Backend API summary

- `GET /api/health` — backend status
- `GET /api/catalog` — asset catalog
- `GET /api/asset-file?path=...` — serve saved output files
- `POST /api/process` — process a new or existing asset
- `POST /api/metadata` — metadata-only update for an existing asset
- `POST /api/asset-status` — archive / restore
- `DELETE /api/asset?assetId=...` — delete asset output + metadata + catalog entry

## Troubleshooting

### Library shows no assets

Usually this means the backend is not running or a stale backend process is serving an older route set.

Fix by:

1. stopping anything already bound to port `4185`
2. restarting `npm run asset-manager:start`
3. refreshing the UI

### Existing asset save created a duplicate

That should not happen after the current update path. If it does, confirm that:

- the asset was opened from the library
- the backend is the current version
- the save request included the current asset ID

## Source layout

- `src/` — React frontend
- `server/` — Express processing backend
- `dist/` — production frontend build output
