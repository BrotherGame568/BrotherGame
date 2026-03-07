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
const metaRoot = path.join(assetsRoot, '_meta');
const catalogPath = path.join(assetsRoot, 'manifest.catalog.json');
const generatedManifestPath = path.join(assetsRoot, 'MANIFEST.generated.md');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 500 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

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
      error: error instanceof Error ? error.message : 'Asset processing failed.',
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

async function processRasterAsset(file, draft) {
  const effectiveFormat = getEffectiveFormat(draft.outputFormat, draft.removeBackground);
  const notes = [];
  if (effectiveFormat !== draft.outputFormat) {
    notes.push(`Output format changed to ${effectiveFormat} because background removal needs alpha support.`);
  }

  if (draft.mode === 'image') {
    let pipeline = sharp(file.buffer, { animated: false }).rotate();
    if (draft.removeBackground) {
      pipeline = await removeBackgroundFromPipeline(pipeline);
      notes.push('Local matte background removal applied using corner-color sampling.');
    }

    pipeline = pipeline.resize(Math.max(1, draft.exportWidth), Math.max(1, draft.exportHeight), {
      fit: toSharpFit(draft.resizeFit),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });

    const outputBuffer = await applyFormat(pipeline, effectiveFormat).toBuffer();
    return {
      outputBuffer,
      outputFormat: effectiveFormat,
      outputBytes: outputBuffer.byteLength,
      notes,
      frameCount: 1,
    };
  }

  const columns = Math.max(1, draft.columns);
  const rows = Math.max(1, draft.rows);
  const source = sharp(file.buffer, { animated: false }).rotate();
  const metadata = await source.metadata();
  const frameWidth = Math.floor((metadata.width ?? 1) / columns);
  const frameHeight = Math.floor((metadata.height ?? 1) / rows);
  const targetFrameWidth = Math.max(1, draft.exportWidth);
  const targetFrameHeight = Math.max(1, draft.exportHeight);
  const composites = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      let frame = sharp(file.buffer, { animated: false }).extract({
        left: col * frameWidth,
        top: row * frameHeight,
        width: frameWidth,
        height: frameHeight,
      });

      if (draft.removeBackground) {
        frame = await removeBackgroundFromPipeline(frame);
      }

      const frameBuffer = await applyFormat(
        frame.resize(targetFrameWidth, targetFrameHeight, {
          fit: toSharpFit(draft.resizeFit),
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        }),
        'png',
      ).toBuffer();

      composites.push({
        input: frameBuffer,
        left: col * targetFrameWidth,
        top: row * targetFrameHeight,
      });
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

  const composites = [];
  const notes = ['Video processed into spritesheet with local FFmpeg extraction.'];
  if (draft.videoSampling === 'spread') {
    notes.push('Frames were sampled evenly across the trimmed clip.');
  } else {
    notes.push('Frames were taken sequentially from the trimmed clip.');
  }
  for (let index = 0; index < targetFrameCount; index += 1) {
    const frameName = frameNames[Math.min(index, frameNames.length - 1)];
    let frame = sharp(path.join(framesDir, frameName));
    if (draft.removeBackground) {
      frame = await removeBackgroundFromPipeline(frame);
    }

    const frameBuffer = await frame.png().toBuffer();
    const col = index % columns;
    const row = Math.floor(index / columns);
    composites.push({
      input: frameBuffer,
      left: col * targetFrameWidth,
      top: row * targetFrameHeight,
    });
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
    generatedAt: new Date().toISOString(),
    assets: filtered,
  };
  await fs.writeFile(catalogPath, JSON.stringify(nextCatalog, null, 2));
  await fs.writeFile(generatedManifestPath, buildGeneratedManifest(nextCatalog.assets));
}

async function removeCatalogAsset(assetId) {
  const catalog = await readCatalog();
  const filtered = catalog.assets.filter((asset) => asset.id !== assetId);
  const nextCatalog = {
    generatedAt: new Date().toISOString(),
    assets: filtered,
  };
  await fs.writeFile(catalogPath, JSON.stringify(nextCatalog, null, 2));
  await fs.writeFile(generatedManifestPath, buildGeneratedManifest(nextCatalog.assets));
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
    return { generatedAt: new Date().toISOString(), assets: [] };
  }
}

function buildPersistedMetadata(draft, file, result, existingAsset) {
  const outputFolder = outputFolders[draft.category] ?? outputFolders.sprites;
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
      width: draft.exportWidth,
      height: draft.exportHeight,
    },
    displaySize: {
      width: draft.displayWidth,
      height: draft.displayHeight,
    },
    optimization: {
      enabled: draft.enableOptimization,
      backgroundRemovalRequested: draft.removeBackground,
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
    source: {
      kind: draft.mode === 'video' ? 'video' : 'image',
      name: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    },
    archivedAt: existingAsset?.status === 'archived' ? existingAsset.archivedAt : undefined,
    generatedAt: new Date().toISOString(),
    notes: draft.notes,
  };
}

function buildMetadataOnlyUpdate(existing, draft) {
  const outputFolder = outputFolders[draft.category] ?? outputFolders.sprites;
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
      width: draft.exportWidth,
      height: draft.exportHeight,
    },
    displaySize: {
      width: draft.displayWidth,
      height: draft.displayHeight,
    },
    optimization: {
      enabled: draft.enableOptimization,
      backgroundRemovalRequested: draft.removeBackground,
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
    notes: draft.notes,
    status: existing.status ?? 'active',
    archivedAt: existing.status === 'archived' ? existing.archivedAt ?? new Date().toISOString() : undefined,
    generatedAt: new Date().toISOString(),
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
    const description = asset.mode === 'video'
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
