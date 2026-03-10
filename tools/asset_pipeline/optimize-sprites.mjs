/**
 * tools/asset_pipeline/optimize-sprites.mjs
 *
 * Converts sprite assets to web-optimised WebP.
 * Run via:  npm run optimize-assets
 *
 * Add entries to SPRITES below to include additional assets.
 * Source files are read-only; output files are written alongside them as .webp.
 */

import sharp from 'sharp';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../');

// ── Sprite manifest ────────────────────────────────────────────────────────
// Add entries here as new large sprites are committed.
// path: relative to project root
// quality: 1-100 (lossy WebP). Use 85 for rendered sprites, 90+ for pixel art.
const SPRITES = [
  {
    path: 'game/assets/animations/RootWalker-Walk-cycle.png',
    quality: 85,
    alphaQuality: 90,
  },
];
// ──────────────────────────────────────────────────────────────────────────

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function optimise({ path: relPath, quality, alphaQuality }) {
  const src = resolve(ROOT, relPath);
  if (!existsSync(src)) {
    console.warn(`  ⚠  Skipping (not found): ${relPath}`);
    return;
  }

  const ext     = extname(relPath);
  const outPath = src.replace(new RegExp(`\\${ext}$`), '.webp');

  const srcSize = statSync(src).size;

  await sharp(src)
    .webp({ quality, alphaQuality, lossless: false, effort: 6 })
    .toFile(outPath);

  const outSize = statSync(outPath).size;
  const saving  = (((srcSize - outSize) / srcSize) * 100).toFixed(1);

  const name = basename(relPath);
  console.log(`  ✓  ${name}`);
  console.log(`     ${fmtKB(srcSize)}  →  ${fmtKB(outSize)}  (${saving}% smaller)`);
  console.log(`     Output: ${outPath}`);
}

console.log('\n🖼  BrotherGame — sprite optimiser\n');

for (const entry of SPRITES) {
  await optimise(entry);
}

console.log('\nDone.\n');
