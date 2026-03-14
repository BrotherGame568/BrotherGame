import cors from 'cors';
import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import multer from 'multer';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(toolRoot, '..', '..');
const assetsRoot = path.join(repoRoot, 'game', 'assets');
const outputFolders = {
  backgrounds: path.join(assetsRoot, 'backgrounds'),
  sprites: path.join(assetsRoot, 'sprites'),
  ui: path.join(assetsRoot, 'ui'),
  animations: path.join(assetsRoot, 'animations'),
};
const terrainTilesRoot = path.join(assetsRoot, 'terrain_tiles');
const terrainAtlasesRoot = path.join(terrainTilesRoot, 'atlases');
const terrainAtlasManifestPath = path.join(terrainTilesRoot, 'terrain_atlas_manifest.generated.json');
const TARGET_TERRAIN_HEX_SQUASH = 0.55;
const TARGET_TERRAIN_CORE_WIDTH = 256;
const TARGET_TERRAIN_OUTPUT_WIDTH = 384;
const TARGET_TERRAIN_OUTPUT_HEIGHT = 384;
const TARGET_TERRAIN_CENTER_X = 0.5;
const TARGET_TERRAIN_CENTER_Y = 0.55;
const TERRAIN_ATLAS_PADDING = 0;
const TERRAIN_ATLAS_IMAGE_EXTENSION = 'webp';
const metaRoot = path.join(assetsRoot, '_meta');
const catalogPath = path.join(assetsRoot, 'manifest.catalog.json');
const generatedManifestPath = path.join(assetsRoot, 'MANIFEST.generated.md');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 500 } });
const sharpInputOptions = { animated: false, limitInputPixels: false };

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

initializeGeneratedArtifacts().catch((error) => {
  console.error('Failed to initialize generated asset artifacts.', error);
});

app.get('/api/health', async (_req, res) => {
  const ffmpegAvailable = typeof ffmpegPath === 'string' && ffmpegPath.length > 0;
  res.json({ ok: true, ffmpegAvailable, repoRoot, assetsRoot });
});

app.get('/api/catalog', async (_req, res) => {
  const catalog = await readCatalog();
  res.json(catalog);
});

app.get('/api/asset-file', async (req, res) => {
  const relativePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!relativePath) {
    res.status(400).json({ error: 'Missing asset path.' });
    return;
  }

  const absolutePath = path.resolve(repoRoot, relativePath);
  if (!absolutePath.startsWith(repoRoot)) {
    res.status(400).json({ error: 'Invalid asset path.' });
    return;
  }

  try {
    await fs.access(absolutePath);
    res.sendFile(absolutePath);
  } catch {
    res.status(404).json({ error: 'Asset file not found.' });
  }
});

app.post('/api/process', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Missing file upload.' });
      return;
    }

    const draft = parseDraft(req.body.draft);
    const currentAssetId = typeof req.body.currentAssetId === 'string' ? req.body.currentAssetId : null;
    const existingAsset = currentAssetId ? await findCatalogAsset(currentAssetId) : null;
    if (currentAssetId && !existingAsset) {
      res.status(404).json({ error: 'The asset being edited no longer exists in the catalog. Reload it from the library and try again.' });
      return;
    }
    const result = draft.mode === 'video'
      ? await processVideoAsset(req.file, draft)
      : await processRasterAsset(req.file, draft);

    const metadata = buildPersistedMetadata(draft, req.file, result, existingAsset);
    await persistAssetArtifacts(metadata, result, existingAsset, currentAssetId);

    res.json({
      ok: true,
      savedAsset: buildSavedAssetResponse(metadata, req.file.size, result.outputBytes, result.notes, result.frameCount),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: formatProcessingError(error),
    });
  }
});

app.post('/api/metadata', async (req, res) => {
  try {
    const draft = req.body?.draft;
    const currentAssetId = req.body?.currentAssetId;
    if (!draft || !currentAssetId) {
      res.status(400).json({ error: 'Missing metadata update payload.' });
      return;
    }

    const catalog = await readCatalog();
    const existing = catalog.assets.find((asset) => asset.id === currentAssetId);
    if (!existing) {
      res.status(404).json({ error: 'Saved asset not found.' });
      return;
    }

    if (draft.outputFormat !== existing.outputFormat) {
      res.status(400).json({ error: 'Metadata-only save cannot change the output format. Reprocess the asset instead.' });
      return;
    }

    const updated = buildMetadataOnlyUpdate(existing, draft);
    await relocateAssetFiles(existing, updated);
    await fs.mkdir(path.dirname(updated.metadataAbsolutePath), { recursive: true });
    await fs.writeFile(updated.metadataAbsolutePath, JSON.stringify(updated, null, 2));
    await updateCatalogAsset(currentAssetId, updated);

    res.json({
      ok: true,
      savedAsset: buildSavedAssetResponse(updated, existing.source?.sizeBytes ?? 0, 0, updated.optimization?.notes ?? [], updated.spritesheet?.frameCount ?? 1),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Metadata update failed.' });
  }
});

app.post('/api/asset-status', async (req, res) => {
  try {
    const assetId = req.body?.assetId;
    const shouldArchive = !!req.body?.archived;
    if (!assetId) {
      res.status(400).json({ error: 'Missing asset identifier.' });
      return;
    }

    const catalog = await readCatalog();
    const existing = catalog.assets.find((asset) => asset.id === assetId);
    if (!existing) {
      res.status(404).json({ error: 'Saved asset not found.' });
      return;
    }

    const updated = {
      ...existing,
      status: shouldArchive ? 'archived' : 'active',
      archivedAt: shouldArchive ? new Date().toISOString() : undefined,
    };
    await updateCatalogAsset(assetId, updated);
    res.json({ ok: true, asset: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Asset status update failed.' });
  }
});

app.delete('/api/asset', async (req, res) => {
  try {
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : '';
    if (!assetId) {
      res.status(400).json({ error: 'Missing asset identifier.' });
      return;
    }

    const catalog = await readCatalog();
    const existing = catalog.assets.find((asset) => asset.id === assetId);
    if (!existing) {
      res.status(404).json({ error: 'Saved asset not found.' });
      return;
    }

    await Promise.allSettled([
      fs.rm(existing.outputAbsolutePath, { force: true }),
      fs.rm(existing.metadataAbsolutePath, { force: true }),
    ]);
    await removeCatalogAsset(assetId);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Asset delete failed.' });
  }
});

const port = 4185;
app.listen(port, () => {
  console.log(`Asset manager backend listening on http://127.0.0.1:${port}`);
});

function parseDraft(raw) {
  if (!raw) throw new Error('Missing draft payload.');
  return JSON.parse(raw);
}

function getOutputFolderForDraft(draft) {
  if (draft?.terrainType) {
    return terrainTilesRoot;
  }
  return outputFolders[draft.category] ?? outputFolders.sprites;
}

async function processRasterAsset(file, draft) {
  const effectiveFormat = getEffectiveFormat(draft.outputFormat, draft.removeBackground);
  const notes = [];
  if (effectiveFormat !== draft.outputFormat) {
    notes.push(`Output format changed to ${effectiveFormat} because background removal needs alpha support.`);
  }

  if (draft.mode === 'image') {
    let pipeline = sharp(file.buffer, sharpInputOptions).rotate();
    if (draft.removeBackground) {
      pipeline = await removeBackgroundFromPipeline(pipeline);
      notes.push('Local matte background removal applied using corner-color sampling.');
    }

    if (draft.terrainType && draft.terrainHexOverlay) {
      const normalized = await normalizeTerrainTile(pipeline, draft);
      notes.push(...normalized.notes);
      const formattedOutputBuffer = await applyFormat(sharp(normalized.outputBuffer, sharpInputOptions), effectiveFormat).toBuffer();

      return {
        outputBuffer: formattedOutputBuffer,
        outputFormat: effectiveFormat,
        outputBytes: formattedOutputBuffer.byteLength,
        notes,
        frameCount: 1,
        suggestedDisplayWidth: normalized.suggestedDisplayWidth,
        suggestedDisplayHeight: normalized.suggestedDisplayHeight,
        exportWidth: normalized.exportWidth,
        exportHeight: normalized.exportHeight,
        normalizedHexOverlay: normalized.normalizedHexOverlay,
      };
    }

    pipeline = pipeline.resize(Math.max(1, draft.exportWidth), Math.max(1, draft.exportHeight), {
      fit: toSharpFit(draft.resizeFit),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });

    let suggestedDisplayWidth;
    let suggestedDisplayHeight;
    if (draft.cropToBoundingBox) {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const bbox = findOpaqueBoundingBox(data, info.width, info.height);
      if (bbox) {
        suggestedDisplayWidth = bbox.maxX - bbox.minX + 1;
        suggestedDisplayHeight = bbox.maxY - bbox.minY + 1;
        notes.push(`Display size inferred from content bounding box (${suggestedDisplayWidth}\u00d7${suggestedDisplayHeight}).`);
      }
      pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    }

    const outputBuffer = await applyFormat(pipeline, effectiveFormat).toBuffer();
    return {
      outputBuffer,
      outputFormat: effectiveFormat,
      outputBytes: outputBuffer.byteLength,
      notes,
      frameCount: 1,
      suggestedDisplayWidth,
      suggestedDisplayHeight,
      exportWidth: draft.exportWidth,
      exportHeight: draft.exportHeight,
    };
  }

  const columns = Math.max(1, draft.columns);
  const rows = Math.max(1, draft.rows);
  const source = sharp(file.buffer, sharpInputOptions).rotate();
  const metadata = await source.metadata();
  const frameWidth = Math.floor((metadata.width ?? 1) / columns);
  const frameHeight = Math.floor((metadata.height ?? 1) / rows);
  const targetFrameWidth = Math.max(1, draft.exportWidth);
  const targetFrameHeight = Math.max(1, draft.exportHeight);

  // Single-pass: process all frames; sample frame 0 bbox for suggested display size
  const composites = [];
  let suggestedDisplayWidth;
  let suggestedDisplayHeight;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const frameIndex = row * columns + col;
      let frame = sharp(file.buffer, sharpInputOptions).extract({
        left: col * frameWidth,
        top: row * frameHeight,
        width: frameWidth,
        height: frameHeight,
      });

      if (draft.removeBackground) {
        frame = await removeBackgroundFromPipeline(frame);
      }

      const resized = frame.resize(targetFrameWidth, targetFrameHeight, {
        fit: toSharpFit(draft.resizeFit),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });

      if (draft.cropToBoundingBox && frameIndex === 0) {
        const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const bbox = findOpaqueBoundingBox(data, info.width, info.height);
        if (bbox) {
          suggestedDisplayWidth = bbox.maxX - bbox.minX + 1;
          suggestedDisplayHeight = bbox.maxY - bbox.minY + 1;
          notes.push(`Display size inferred from frame 0 content bounding box (${suggestedDisplayWidth}\u00d7${suggestedDisplayHeight}).`);
        }
        const frameBuffer = await applyFormat(
          sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }),
          'png',
        ).toBuffer();
        composites.push({ input: frameBuffer, left: col * targetFrameWidth, top: row * targetFrameHeight });
      } else {
        const frameBuffer = await applyFormat(resized, 'png').toBuffer();
        composites.push({ input: frameBuffer, left: col * targetFrameWidth, top: row * targetFrameHeight });
      }
    }
  }

  if (draft.removeBackground) {
    notes.push('Local matte background removal applied per frame.');
  }

  const sheet = sharp({
    create: {
      width: targetFrameWidth * columns,
      height: targetFrameHeight * rows,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites);

  const outputBuffer = await applyFormat(sheet, effectiveFormat).toBuffer();
  return {
    outputBuffer,
    outputFormat: effectiveFormat,
    outputBytes: outputBuffer.byteLength,
    notes,
    frameCount: columns * rows,
    suggestedDisplayWidth,
    suggestedDisplayHeight,
    exportWidth: columns * targetFrameWidth,
    exportHeight: rows * targetFrameHeight,
  };
}

async function normalizeTerrainTile(pipeline, draft) {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sourceWidth = Math.max(1, info.width);
  const sourceHeight = Math.max(1, info.height);
  const overlay = draft.terrainHexOverlay ?? {
    centerX: 0.5,
    centerY: 0.62,
    radius: 0.28,
    squashY: 0.72,
    topOverflow: 0.22,
  };
  const sourceRadius = Math.max(1, overlay.radius * sourceWidth);
  const sourceSquashY = Math.max(0.35, Math.min(0.95, overlay.squashY ?? 0.72));
  const sourceHexHalfHeight = sourceRadius * Math.sin(Math.PI / 3) * sourceSquashY;
  const sourceCenterX = overlay.centerX * sourceWidth;
  const sourceCenterY = overlay.centerY * sourceHeight;
  const sourceHexLeft = sourceCenterX - sourceRadius;
  const sourceHexRight = sourceCenterX + sourceRadius;
  const sourceHexTop = sourceCenterY - sourceHexHalfHeight;
  const sourceHexBottom = sourceCenterY + sourceHexHalfHeight;
  const opaqueBounds = findOpaqueBoundingBox(data, sourceWidth, sourceHeight) ?? {
    minX: 0,
    minY: 0,
    maxX: sourceWidth - 1,
    maxY: sourceHeight - 1,
  };

  const leftOverflow = Math.max(0, sourceHexLeft - opaqueBounds.minX);
  const rightOverflow = Math.max(0, opaqueBounds.maxX - sourceHexRight);
  const topOverflow = Math.max(0, sourceHexTop - opaqueBounds.minY);
  const bottomOverflow = Math.max(0, opaqueBounds.maxY - sourceHexBottom);

  const targetCoreWidth = TARGET_TERRAIN_CORE_WIDTH;
  const targetRadius = targetCoreWidth / 2;
  const scale = targetRadius / sourceRadius;
  const targetHexHalfHeight = targetRadius * Math.sin(Math.PI / 3) * TARGET_TERRAIN_HEX_SQUASH;
  const targetLeftOverflow = Math.max(0, Math.ceil(leftOverflow * scale));
  const targetRightOverflow = Math.max(0, Math.ceil(rightOverflow * scale));
  const targetTopOverflow = Math.max(0, Math.ceil(topOverflow * scale));
  const targetBottomOverflow = Math.max(0, Math.ceil(bottomOverflow * scale));
  const outputWidth = TARGET_TERRAIN_OUTPUT_WIDTH;
  const outputHeight = TARGET_TERRAIN_OUTPUT_HEIGHT;
  const scaledWidth = Math.max(1, Math.round(sourceWidth * scale));
  const scaledHeight = Math.max(1, Math.round(sourceHeight * scale));
  const targetCenterX = outputWidth * TARGET_TERRAIN_CENTER_X;
  const targetCenterY = outputHeight * TARGET_TERRAIN_CENTER_Y;
  const compositeLeft = Math.round(targetCenterX - sourceCenterX * scale);
  const compositeTop = Math.round(targetCenterY - sourceCenterY * scale);
  const scaledInput = await sharp(data, {
    raw: { width: sourceWidth, height: sourceHeight, channels: info.channels },
  }).resize(scaledWidth, scaledHeight, {
    fit: 'fill',
    kernel: sharp.kernel.lanczos3,
  }).png().toBuffer();

  const sourceClipLeft = Math.max(0, -compositeLeft);
  const sourceClipTop = Math.max(0, -compositeTop);
  const visibleWidth = Math.max(0, Math.min(scaledWidth - sourceClipLeft, outputWidth - Math.max(0, compositeLeft)));
  const visibleHeight = Math.max(0, Math.min(scaledHeight - sourceClipTop, outputHeight - Math.max(0, compositeTop)));

  let compositeInput = scaledInput;
  let compositeX = Math.max(0, compositeLeft);
  let compositeY = Math.max(0, compositeTop);

  if (visibleWidth <= 0 || visibleHeight <= 0) {
    throw new Error('Terrain normalization produced an empty output. Adjust the overlay and try again.');
  }

  if (sourceClipLeft > 0 || sourceClipTop > 0 || visibleWidth < scaledWidth || visibleHeight < scaledHeight) {
    compositeInput = await sharp(scaledInput, sharpInputOptions).extract({
      left: sourceClipLeft,
      top: sourceClipTop,
      width: visibleWidth,
      height: visibleHeight,
    }).png().toBuffer();
  }

  const outputBuffer = await sharp({
    create: {
      width: outputWidth,
      height: outputHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([{ input: compositeInput, left: compositeX, top: compositeY }]).png().toBuffer();

  const clippedLeft = sourceClipLeft > 0;
  const clippedTop = sourceClipTop > 0;
  const clippedRight = sourceClipLeft + visibleWidth < scaledWidth;
  const clippedBottom = sourceClipTop + visibleHeight < scaledHeight;
  const clippingNotes = [];
  if (clippedLeft || clippedTop || clippedRight || clippedBottom) {
    clippingNotes.push(`Overflow clipped to fit ${outputWidth}×${outputHeight} canvas — left ${clippedLeft ? 'yes' : 'no'}, top ${clippedTop ? 'yes' : 'no'}, right ${clippedRight ? 'yes' : 'no'}, bottom ${clippedBottom ? 'yes' : 'no'}.`);
  }

  return {
    outputBuffer,
    exportWidth: outputWidth,
    exportHeight: outputHeight,
    suggestedDisplayWidth: targetCoreWidth,
    suggestedDisplayHeight: Math.round(targetHexHalfHeight * 2),
    normalizedHexOverlay: {
      centerX: targetCenterX / outputWidth,
      centerY: targetCenterY / outputHeight,
      radius: targetRadius / outputWidth,
      squashY: TARGET_TERRAIN_HEX_SQUASH,
      topOverflow: targetTopOverflow / outputHeight,
    },
    notes: [
      `Terrain tile normalized to a ${targetCoreWidth}px core hex footprint.`,
      `Scaled overflow budget — left ${targetLeftOverflow}px, right ${targetRightOverflow}px, top ${targetTopOverflow}px, bottom ${targetBottomOverflow}px.`,
      ...clippingNotes,
    ],
  };
}

async function processVideoAsset(file, draft) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is unavailable. Reinstall dependencies to enable video processing.');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'brothergame-video-'));
  const inputPath = path.join(workDir, `source${path.extname(file.originalname) || '.mp4'}`);
  const framesDir = path.join(workDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  await fs.writeFile(inputPath, file.buffer);

  const columns = Math.max(1, draft.columns);
  const rows = Math.max(1, draft.rows);
  const targetFrameCount = columns * rows;
  const targetFrameWidth = Math.max(1, draft.exportWidth);
  const targetFrameHeight = Math.max(1, draft.exportHeight);
  const fps = Math.max(1, draft.frameRate);
  const extractionFilter = buildVideoExtractionFilter(targetFrameWidth, targetFrameHeight, fps, draft.resizeFit);

  const args = [
    '-y',
    '-ss',
    `${Math.max(0, draft.trimStartSeconds ?? 0)}`,
    '-i',
    inputPath,
  ];

  if ((draft.trimEndSeconds ?? 0) > (draft.trimStartSeconds ?? 0)) {
    args.push('-to', `${draft.trimEndSeconds}`);
  }

  args.push(
    '-vf',
    extractionFilter,
    path.join(framesDir, 'frame-%04d.png'),
  );

  await runCommand(ffmpegPath, args, workDir);
  const extractedFrameNames = (await fs.readdir(framesDir)).filter((name) => name.endsWith('.png')).sort();

  if (extractedFrameNames.length === 0) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw new Error('No frames were extracted from the video.');
  }

  const frameNames = sampleFrameNames(extractedFrameNames, targetFrameCount, draft.videoSampling);

  const notes = ['Video processed into spritesheet with local FFmpeg extraction.'];
  if (draft.videoSampling === 'spread') {
    notes.push('Frames were sampled evenly across the trimmed clip.');
  } else {
    notes.push('Frames were taken sequentially from the trimmed clip.');
  }

  // Single-pass: composite all frames; sample frame 0 bbox for suggested display size
  const composites = [];
  let suggestedDisplayWidth;
  let suggestedDisplayHeight;

  for (let index = 0; index < targetFrameCount; index += 1) {
    const frameName = frameNames[Math.min(index, frameNames.length - 1)];
    let frame = sharp(path.join(framesDir, frameName), { limitInputPixels: false });
    if (draft.removeBackground) {
      frame = await removeBackgroundFromPipeline(frame);
    }

    const col = index % columns;
    const row = Math.floor(index / columns);

    if (draft.cropToBoundingBox && index === 0) {
      const { data, info } = await frame.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const bbox = findOpaqueBoundingBox(data, info.width, info.height);
      if (bbox) {
        suggestedDisplayWidth = bbox.maxX - bbox.minX + 1;
        suggestedDisplayHeight = bbox.maxY - bbox.minY + 1;
        notes.push(`Display size inferred from frame 0 content bounding box (${suggestedDisplayWidth}\u00d7${suggestedDisplayHeight}).`);
      }
      const frameBuffer = await applyFormat(
        sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }), 'png',
      ).toBuffer();
      composites.push({ input: frameBuffer, left: col * targetFrameWidth, top: row * targetFrameHeight });
    } else {
      const frameBuffer = await frame.png().toBuffer();
      composites.push({ input: frameBuffer, left: col * targetFrameWidth, top: row * targetFrameHeight });
    }
  }

  if (draft.removeBackground) {
    notes.push('Local matte background removal applied to extracted frames.');
  }

  const effectiveFormat = getEffectiveFormat(draft.outputFormat, draft.removeBackground);
  if (effectiveFormat !== draft.outputFormat) {
    notes.push(`Output format changed to ${effectiveFormat} because background removal needs alpha support.`);
  }

  const sheet = sharp({
    create: {
      width: columns * targetFrameWidth,
      height: rows * targetFrameHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites);

  const outputBuffer = await applyFormat(sheet, effectiveFormat).toBuffer();
  await fs.rm(workDir, { recursive: true, force: true });

  return {
    outputBuffer,
    outputFormat: effectiveFormat,
    outputBytes: outputBuffer.byteLength,
    notes,
    frameCount: targetFrameCount,
    suggestedDisplayWidth,
    suggestedDisplayHeight,
  };
}

async function removeBackgroundFromPipeline(pipeline) {
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = sampleCornerColor(data, info.width, info.height, info.channels);
  const tolerance = 48;
  const feather = 52;

  for (let index = 0; index < data.length; index += info.channels) {
    const distance = colorDistance(data[index], data[index + 1], data[index + 2], bg.r, bg.g, bg.b);
    if (distance <= tolerance) {
      data[index + 3] = 0;
    } else if (distance <= tolerance + feather) {
      const alphaFactor = (distance - tolerance) / feather;
      data[index + 3] = Math.round(data[index + 3] * alphaFactor);
    }
  }

  return sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  });
}

function findOpaqueBoundingBox(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

function sampleCornerColor(buffer, width, height, channels) {
  const sampleSize = Math.max(4, Math.min(20, Math.floor(Math.min(width, height) / 10)));
  const coords = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let samples = 0;

  for (const [startX, startY] of coords) {
    for (let y = startY; y < Math.min(height, startY + sampleSize); y += 1) {
      for (let x = startX; x < Math.min(width, startX + sampleSize); x += 1) {
        const index = (y * width + x) * channels;
        totalR += buffer[index];
        totalG += buffer[index + 1];
        totalB += buffer[index + 2];
        samples += 1;
      }
    }
  }

  return {
    r: Math.round(totalR / Math.max(1, samples)),
    g: Math.round(totalG / Math.max(1, samples)),
    b: Math.round(totalB / Math.max(1, samples)),
  };
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function applyFormat(pipeline, format) {
  switch (format) {
    case 'png':
      return pipeline.png({ compressionLevel: 9 });
    case 'jpg':
      return pipeline.jpeg({ quality: 88, mozjpeg: true });
    case 'avif':
      return pipeline.avif({ quality: 58 });
    case 'webp':
    default:
      return pipeline.webp({ quality: 86, alphaQuality: 92, effort: 6 });
  }
}

function getEffectiveFormat(format, removeBackground) {
  if (removeBackground && format === 'jpg') {
    return 'png';
  }
  return format;
}

function formatProcessingError(error) {
  if (!(error instanceof Error)) {
    return 'Asset processing failed.';
  }

  if (error.message.toLowerCase().includes('pixel limit')) {
    return 'The generated asset is too large for Sharp\'s default safety limit. The server now allows larger source images, but if this still happens reduce the export frame size or grid size before saving.';
  }

  return error.message;
}

async function persistAssetArtifacts(metadata, result, existingAsset, previousAssetId) {
  await Promise.all([
    fs.mkdir(path.dirname(metadata.outputAbsolutePath), { recursive: true }),
    fs.mkdir(path.dirname(metadata.metadataAbsolutePath), { recursive: true }),
  ]);

  await fs.writeFile(metadata.outputAbsolutePath, result.outputBuffer);
  await fs.writeFile(metadata.metadataAbsolutePath, JSON.stringify(metadata, null, 2));

  if (existingAsset) {
    await cleanupReplacedAssetFiles(existingAsset, metadata);
  }

  await updateCatalogAsset(previousAssetId ?? metadata.id, metadata);
}

async function cleanupReplacedAssetFiles(existingAsset, metadata) {
  if (existingAsset.outputAbsolutePath && existingAsset.outputAbsolutePath !== metadata.outputAbsolutePath) {
    await fs.rm(existingAsset.outputAbsolutePath, { force: true }).catch(() => {});
  }

  if (existingAsset.metadataAbsolutePath && existingAsset.metadataAbsolutePath !== metadata.metadataAbsolutePath) {
    await fs.rm(existingAsset.metadataAbsolutePath, { force: true }).catch(() => {});
  }
}

async function updateCatalogAsset(previousAssetId, metadata) {
  if (previousAssetId && previousAssetId !== metadata.id) {
    const oldMetadataPath = path.join(metaRoot, `${previousAssetId}.asset.json`);
    if (oldMetadataPath !== metadata.metadataAbsolutePath) {
      await fs.rm(oldMetadataPath, { force: true }).catch(() => {});
    }
  }

  const catalog = await readCatalog();
  const filtered = catalog.assets.filter((asset) => asset.id !== previousAssetId && asset.id !== metadata.id);
  filtered.push(metadata);
  filtered.sort((a, b) => a.id.localeCompare(b.id));
  const nextCatalog = {
    assets: filtered,
  };
  await writeCatalogArtifacts(nextCatalog);
}

async function removeCatalogAsset(assetId) {
  const catalog = await readCatalog();
  const filtered = catalog.assets.filter((asset) => asset.id !== assetId);
  const nextCatalog = {
    assets: filtered,
  };
  await writeCatalogArtifacts(nextCatalog);
}

async function findCatalogAsset(assetId) {
  const catalog = await readCatalog();
  return catalog.assets.find((asset) => asset.id === assetId) ?? null;
}

async function readCatalog() {
  try {
    const raw = await fs.readFile(catalogPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { assets: [] };
  }
}

async function initializeGeneratedArtifacts() {
  const catalog = await readCatalog();
  await writeCatalogArtifacts(catalog);
}

async function writeCatalogArtifacts(catalog) {
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  await fs.writeFile(generatedManifestPath, buildGeneratedManifest(catalog.assets));
  await rebuildTerrainAtlases(catalog.assets);
}

async function rebuildTerrainAtlases(assets) {
  const terrainAssets = assets
    .filter((asset) => asset.status !== 'archived')
    .filter((asset) => asset.terrainTile?.generateAtlas)
    .filter((asset) => typeof asset.outputAbsolutePath === 'string' && asset.outputAbsolutePath.length > 0);

  const groups = new Map();
  for (const asset of terrainAssets) {
    const atlasGroup = sanitizeAtlasGroup(asset.terrainTile?.atlasGroup);
    const existingGroup = groups.get(atlasGroup) ?? [];
    existingGroup.push(asset);
    groups.set(atlasGroup, existingGroup);
  }

  await fs.mkdir(terrainAtlasesRoot, { recursive: true });

  const manifest = {
    atlases: [],
  };
  const expectedFiles = new Set();

  for (const [group, groupAssets] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const atlas = await buildTerrainAtlasGroup(group, groupAssets);
    const imageAbsolutePath = path.join(terrainAtlasesRoot, `${group}.${TERRAIN_ATLAS_IMAGE_EXTENSION}`);
    const dataAbsolutePath = path.join(terrainAtlasesRoot, `${group}.atlas.json`);
    const imageRelativePath = path.relative(repoRoot, imageAbsolutePath).replace(/\\/g, '/');
    const dataRelativePath = path.relative(repoRoot, dataAbsolutePath).replace(/\\/g, '/');

    await Promise.all([
      fs.writeFile(imageAbsolutePath, atlas.imageBuffer),
      fs.writeFile(dataAbsolutePath, JSON.stringify(atlas.atlasData, null, 2)),
    ]);

    expectedFiles.add(path.basename(imageAbsolutePath));
    expectedFiles.add(path.basename(dataAbsolutePath));

    manifest.atlases.push({
      group,
      imageRelativePath,
      dataRelativePath,
      tileCount: atlas.tileCount,
      columns: atlas.columns,
      rows: atlas.rows,
      cellSize: atlas.cellSize,
      terrainTypes: atlas.terrainTypes,
      assets: atlas.assets,
    });
  }

  await cleanupStaleTerrainAtlasFiles(expectedFiles);
  await fs.writeFile(terrainAtlasManifestPath, JSON.stringify(manifest, null, 2));
}

async function buildTerrainAtlasGroup(group, assets) {
  const sortedAssets = [...assets].sort(compareTerrainAtlasAssets);
  const assetImages = await Promise.all(sortedAssets.map(async (asset) => {
    const metadata = await sharp(asset.outputAbsolutePath, sharpInputOptions).metadata();
    const width = Math.max(1, metadata.width ?? asset.exportSize?.width ?? TARGET_TERRAIN_OUTPUT_WIDTH);
    const height = Math.max(1, metadata.height ?? asset.exportSize?.height ?? TARGET_TERRAIN_OUTPUT_HEIGHT);
    return {
      asset,
      width,
      height,
    };
  }));

  const cellWidth = Math.max(...assetImages.map((entry) => entry.width), TARGET_TERRAIN_OUTPUT_WIDTH);
  const cellHeight = Math.max(...assetImages.map((entry) => entry.height), TARGET_TERRAIN_OUTPUT_HEIGHT);
  const tileCount = assetImages.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(tileCount)));
  const rows = Math.max(1, Math.ceil(tileCount / columns));
  const atlasWidth = columns * cellWidth + Math.max(0, columns - 1) * TERRAIN_ATLAS_PADDING;
  const atlasHeight = rows * cellHeight + Math.max(0, rows - 1) * TERRAIN_ATLAS_PADDING;
  const composites = [];
  const frames = {};
  const terrainTypeIndex = {};
  const manifestAssets = [];

  for (let index = 0; index < assetImages.length; index += 1) {
    const { asset, width, height } = assetImages[index];
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * (cellWidth + TERRAIN_ATLAS_PADDING);
    const y = row * (cellHeight + TERRAIN_ATLAS_PADDING);

    composites.push({
      input: asset.outputAbsolutePath,
      left: x,
      top: y,
    });

    const terrainType = asset.terrainTile?.terrainType ?? 'unknown';
    const variant = asset.terrainTile?.variant ?? 1;
    const coreHex = asset.terrainTile?.coreHex ?? {
      centerX: TARGET_TERRAIN_CENTER_X,
      centerY: TARGET_TERRAIN_CENTER_Y,
      radius: TARGET_TERRAIN_CORE_WIDTH / TARGET_TERRAIN_OUTPUT_WIDTH / 2,
      squashY: TARGET_TERRAIN_HEX_SQUASH,
      topOverflow: 0,
    };

    frames[asset.id] = {
      frame: { x, y, w: width, h: height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: width, h: height },
      sourceSize: { w: width, h: height },
      pivot: { x: coreHex.centerX ?? TARGET_TERRAIN_CENTER_X, y: coreHex.centerY ?? TARGET_TERRAIN_CENTER_Y },
      terrain: {
        terrainType,
        variant,
        atlasGroup: group,
        sourceAssetId: asset.id,
        coreHex,
        displaySize: asset.displaySize,
        outputRelativePath: asset.outputRelativePath,
      },
    };

    terrainTypeIndex[terrainType] ??= [];
    terrainTypeIndex[terrainType].push(asset.id);
    manifestAssets.push({
      id: asset.id,
      terrainType,
      variant,
      frameKey: asset.id,
      coreHex,
    });
  }

  const imageBuffer = await sharp({
    create: {
      width: atlasWidth,
      height: atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toBuffer();

  return {
    imageBuffer,
    atlasData: {
      frames,
      meta: {
        app: 'BrotherGame Asset Manager',
        version: '1.0',
        image: `${group}.${TERRAIN_ATLAS_IMAGE_EXTENSION}`,
        format: 'RGBA8888',
        size: { w: atlasWidth, h: atlasHeight },
        scale: '1',
        terrainAtlas: {
          group,
          tileCount,
          columns,
          rows,
          cellSize: { width: cellWidth, height: cellHeight },
          terrainTypes: Object.keys(terrainTypeIndex).sort(),
          terrainTypeIndex,
        },
      },
    },
    tileCount,
    columns,
    rows,
    cellSize: { width: cellWidth, height: cellHeight },
    terrainTypes: Object.keys(terrainTypeIndex).sort(),
    assets: manifestAssets,
  };
}

function compareTerrainAtlasAssets(left, right) {
  const leftType = left.terrainTile?.terrainType ?? '';
  const rightType = right.terrainTile?.terrainType ?? '';
  if (leftType !== rightType) {
    return leftType.localeCompare(rightType);
  }

  const leftVariant = Number.isFinite(left.terrainTile?.variant) ? left.terrainTile.variant : 1;
  const rightVariant = Number.isFinite(right.terrainTile?.variant) ? right.terrainTile.variant : 1;
  if (leftVariant !== rightVariant) {
    return leftVariant - rightVariant;
  }

  return left.id.localeCompare(right.id);
}

async function cleanupStaleTerrainAtlasFiles(expectedFiles) {
  const existingEntries = await fs.readdir(terrainAtlasesRoot, { withFileTypes: true }).catch(() => []);
  const staleFiles = existingEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !expectedFiles.has(name));

  await Promise.all(staleFiles.map((name) => fs.rm(path.join(terrainAtlasesRoot, name), { force: true }).catch(() => {})));
}

function sanitizeAtlasGroup(value) {
  const sanitized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized || 'hex_tileset';
}

function buildPersistedMetadata(draft, file, result, existingAsset) {
  const outputFolder = getOutputFolderForDraft(draft);
  const outputFilename = `${draft.assetId}.${result.outputFormat}`;
  const outputAbsolutePath = path.join(outputFolder, outputFilename);
  const outputRelativePath = path.relative(repoRoot, outputAbsolutePath).replace(/\\/g, '/');
  const metadataAbsolutePath = path.join(metaRoot, `${draft.assetId}.asset.json`);
  const metadataRelativePath = path.relative(repoRoot, metadataAbsolutePath).replace(/\\/g, '/');

  return {
    id: draft.assetId,
    name: draft.displayName,
    status: existingAsset?.status ?? 'active',
    category: draft.category,
    mode: draft.mode,
    outputFormat: result.outputFormat,
    maintainAspectRatio: !!draft.maintainAspectRatio,
    resizeFit: draft.resizeFit,
    outputRelativePath,
    outputAbsolutePath,
    metadataAbsolutePath,
    metadataRelativePath,
    exportSize: {
      width: result.exportWidth ?? draft.exportWidth,
      height: result.exportHeight ?? draft.exportHeight,
    },
    displaySize: {
      width: result.suggestedDisplayWidth ?? draft.displayWidth,
      height: result.suggestedDisplayHeight ?? draft.displayHeight,
    },
    optimization: {
      enabled: draft.enableOptimization,
      backgroundRemovalRequested: draft.removeBackground,
      cropToBoundingBoxRequested: draft.cropToBoundingBox ?? false,
      notes: result.notes,
    },
    spritesheet: draft.mode === 'image' ? undefined : {
      columns: draft.columns,
      rows: draft.rows,
      frameRate: draft.frameRate,
      animationType: draft.animationType,
      origin: draft.origin,
      collisionBox: draft.collisionBox,
      frameCount: result.frameCount,
    },
    video: draft.mode !== 'video' ? undefined : {
      trimStartSeconds: draft.trimStartSeconds,
      trimEndSeconds: draft.trimEndSeconds,
      requestedFrameRate: draft.frameRate,
      sampling: draft.videoSampling,
    },
    terrainTile: draft.terrainType ? {
      terrainType: draft.terrainType,
      variant: Number.isFinite(draft.terrainVariant) ? draft.terrainVariant : 1,
      atlasGroup: sanitizeAtlasGroup(draft.terrainAtlasGroup),
      generateAtlas: !!draft.terrainGenerateAtlas,
      coreHex: result.normalizedHexOverlay ?? draft.terrainHexOverlay ?? {
        centerX: 0.5,
        centerY: 0.62,
        radius: 0.28,
        squashY: 0.72,
        topOverflow: 0.22,
      },
    } : undefined,
    source: {
      kind: draft.mode === 'video' ? 'video' : 'image',
      name: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    },
    archivedAt: existingAsset?.status === 'archived' ? existingAsset.archivedAt : undefined,
    notes: draft.notes,
  };
}

function buildMetadataOnlyUpdate(existing, draft) {
  const outputFolder = getOutputFolderForDraft(draft);
  const outputFilename = `${draft.assetId}.${existing.outputFormat}`;
  const outputAbsolutePath = path.join(outputFolder, outputFilename);
  const outputRelativePath = path.relative(repoRoot, outputAbsolutePath).replace(/\\/g, '/');
  const metadataAbsolutePath = path.join(metaRoot, `${draft.assetId}.asset.json`);
  const metadataRelativePath = path.relative(repoRoot, metadataAbsolutePath).replace(/\\/g, '/');

  return {
    ...existing,
    id: draft.assetId,
    name: draft.displayName,
    category: draft.category,
    mode: draft.mode,
    maintainAspectRatio: !!draft.maintainAspectRatio,
    resizeFit: draft.resizeFit,
    outputRelativePath,
    outputAbsolutePath,
    metadataAbsolutePath,
    metadataRelativePath,
    exportSize: {
      width: existing.exportSize?.width ?? draft.exportWidth,
      height: existing.exportSize?.height ?? draft.exportHeight,
    },
    displaySize: {
      width: draft.displayWidth,
      height: draft.displayHeight,
    },
    optimization: {
      enabled: draft.enableOptimization,
      backgroundRemovalRequested: draft.removeBackground,
      cropToBoundingBoxRequested: draft.cropToBoundingBox ?? false,
      notes: existing.optimization?.notes ?? [],
    },
    spritesheet: draft.mode === 'image' ? undefined : {
      columns: draft.columns,
      rows: draft.rows,
      frameRate: draft.frameRate,
      animationType: draft.animationType,
      origin: draft.origin,
      collisionBox: draft.collisionBox,
      frameCount: existing.spritesheet?.frameCount ?? Math.max(1, draft.columns * draft.rows),
    },
    video: draft.mode !== 'video' ? undefined : {
      trimStartSeconds: draft.trimStartSeconds,
      trimEndSeconds: draft.trimEndSeconds,
      requestedFrameRate: draft.frameRate,
      sampling: draft.videoSampling,
    },
    terrainTile: draft.terrainType ? {
      terrainType: draft.terrainType,
      variant: Number.isFinite(draft.terrainVariant) ? draft.terrainVariant : existing.terrainTile?.variant ?? 1,
      atlasGroup: sanitizeAtlasGroup(draft.terrainAtlasGroup || existing.terrainTile?.atlasGroup || 'hex_tileset'),
      generateAtlas: !!draft.terrainGenerateAtlas,
      coreHex: draft.terrainHexOverlay ?? existing.terrainTile?.coreHex ?? {
        centerX: 0.5,
        centerY: 0.62,
        radius: 0.28,
        squashY: 0.72,
        topOverflow: 0.22,
      },
    } : undefined,
    notes: draft.notes,
    status: existing.status ?? 'active',
    archivedAt: existing.status === 'archived' ? existing.archivedAt ?? new Date().toISOString() : undefined,
  };
}

async function relocateAssetFiles(existing, updated) {
  if (existing.outputAbsolutePath !== updated.outputAbsolutePath) {
    await fs.mkdir(path.dirname(updated.outputAbsolutePath), { recursive: true });
    await fs.rename(existing.outputAbsolutePath, updated.outputAbsolutePath);
  }

  if (existing.metadataAbsolutePath && existing.metadataAbsolutePath !== updated.metadataAbsolutePath) {
    await fs.rm(existing.metadataAbsolutePath, { force: true }).catch(() => {});
  }
}

function buildGeneratedManifest(assets) {
  const rows = assets.map((asset) => {
    const size = asset.mode === 'image'
      ? `${asset.exportSize.width}×${asset.exportSize.height}`
      : `${asset.spritesheet.columns}×${asset.spritesheet.rows} cells, ${asset.displaySize.width}×${asset.displaySize.height} display`;
    const format = asset.mode === 'image' ? asset.outputFormat : `${asset.outputFormat} spritesheet`;
    const description = asset.terrainTile
      ? `${asset.terrainTile.terrainType.replace(/_/g, ' ')} terrain tile v${String(asset.terrainTile.variant ?? 1).padStart(2, '0')}`
      : asset.mode === 'video'
      ? `Generated from video (${asset.spritesheet.animationType})`
      : asset.mode === 'spritesheet'
        ? `${asset.spritesheet.animationType} animation sheet`
        : `${asset.category} asset`;
    const status = asset.status === 'archived' ? 'archived' : 'generated';
    return `| \`${asset.id}\` | ${description} | \`${asset.outputRelativePath.replace('game/assets/', '')}\` | ${size} | ${format} | ${status} |`;
  });

  return [
    '# Generated Asset Manifest',
    '',
    '> This file is generated by the standalone asset manager. Edit metadata through the tool, not by hand.',
    '',
    '| ID | Description | Path | Size | Format | Status |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function buildSavedAssetResponse(metadata, sourceBytes, outputBytes, notes, frameCount) {
  return {
    outputRelativePath: metadata.outputRelativePath,
    metadataRelativePath: metadata.metadataRelativePath,
    manifestRelativePath: path.relative(repoRoot, generatedManifestPath).replace(/\\/g, '/'),
    sourceBytes,
    outputBytes,
    notes,
    frameCount,
  };
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `Command failed with exit code ${code}`));
    });
  });
}

function toSharpFit(mode) {
  switch (mode) {
    case 'cover':
      return 'cover';
    case 'fill':
      return 'fill';
    case 'contain':
    default:
      return 'contain';
  }
}

function buildVideoExtractionFilter(width, height, fps, resizeFit) {
  const safeFps = Math.max(1, Math.round(fps));
  if (resizeFit === 'fill') {
    return `fps=${safeFps},scale=${width}:${height}:flags=lanczos`;
  }

  if (resizeFit === 'cover') {
    return `fps=${safeFps},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  }

  return `fps=${safeFps},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
}

function sampleFrameNames(frameNames, targetFrameCount, mode) {
  if (frameNames.length <= targetFrameCount || mode !== 'spread') {
    return frameNames;
  }

  const sampled = [];
  for (let index = 0; index < targetFrameCount; index += 1) {
    const ratio = targetFrameCount === 1 ? 0 : index / (targetFrameCount - 1);
    const sourceIndex = Math.min(frameNames.length - 1, Math.round(ratio * (frameNames.length - 1)));
    sampled.push(frameNames[sourceIndex]);
  }
  return sampled;
}
