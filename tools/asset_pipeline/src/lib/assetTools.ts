import type { AssetCategory, AssetDraft, AssetMetadataDocument, OutputFormat, PersistedAssetRecord, SourceInfo } from '../types';

const CATEGORY_PATHS: Record<AssetCategory, string> = {
  backgrounds: 'game/assets/backgrounds',
  sprites: 'game/assets/sprites',
  ui: 'game/assets/ui',
  animations: 'game/assets/animations',
};

const TERRAIN_OUTPUT_PATH = 'game/assets/terrain_tiles';

export function createDefaultDraft(): AssetDraft {
  return {
    assetId: 'new_asset',
    displayName: 'New Asset',
    category: 'sprites',
    mode: 'image',
    outputFormat: 'webp',
    maintainAspectRatio: true,
    resizeFit: 'contain',
    exportWidth: 1024,
    exportHeight: 1024,
    displayWidth: 160,
    displayHeight: 160,
    removeBackground: false,
    cropToBoundingBox: false,
    enableOptimization: true,
    animationType: 'walk',
    columns: 6,
    rows: 6,
    frameRate: 12,
    origin: { x: 0.5, y: 1 },
    collisionBox: { x: 30, y: 45, width: 96, height: 110 },
    notes: '',
    trimStartSeconds: 0,
    trimEndSeconds: 0,
    videoSampling: 'spread',
    terrainType: '',
    terrainVariant: 1,
    terrainAutoNaming: false,
    terrainAtlasGroup: 'hex_tileset',
    terrainGenerateAtlas: false,
    terrainHexOverlay: {
      centerX: 0.5,
      centerY: 0.62,
      radius: 0.28,
      squashY: 0.72,
      topOverflow: 0.22,
    },
  };
}

export function sanitizeAssetId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'new_asset';
}

export function inferCategoryFromMode(mode: AssetDraft['mode']): AssetCategory {
  if (mode === 'video' || mode === 'spritesheet') return 'animations';
  return 'sprites';
}

export function getCategoryOutputPath(category: AssetCategory): string {
  return CATEGORY_PATHS[category];
}

export function getDraftOutputPath(draft: Pick<AssetDraft, 'category' | 'terrainType'>): string {
  return draft.terrainType ? TERRAIN_OUTPUT_PATH : getCategoryOutputPath(draft.category);
}

export function buildAssetMetadata(draft: AssetDraft, source: SourceInfo | null): AssetMetadataDocument {
  return {
    id: draft.assetId,
    name: draft.displayName,
    category: draft.category,
    mode: draft.mode,
    outputFormat: draft.outputFormat,
    maintainAspectRatio: draft.maintainAspectRatio,
    resizeFit: draft.resizeFit,
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
      cropToBoundingBoxRequested: draft.cropToBoundingBox,
    },
    spritesheet: draft.mode === 'image' ? undefined : {
      columns: draft.columns,
      rows: draft.rows,
      frameRate: draft.frameRate,
      animationType: draft.animationType,
      origin: draft.origin,
      collisionBox: draft.collisionBox,
    },
    video: draft.mode !== 'video' ? undefined : {
      trimStartSeconds: draft.trimStartSeconds,
      trimEndSeconds: draft.trimEndSeconds,
      requestedFrameRate: draft.frameRate,
      sampling: draft.videoSampling,
    },
    terrainTile: draft.terrainType ? {
      terrainType: draft.terrainType,
      variant: draft.terrainVariant,
      atlasGroup: draft.terrainAtlasGroup,
      generateAtlas: draft.terrainGenerateAtlas,
      coreHex: draft.terrainHexOverlay,
    } : undefined,
    source,
    notes: draft.notes,
  };
}

export function buildManifestRow(draft: AssetDraft): string {
  const formatLabel = draft.mode === 'spritesheet' ? `${draft.outputFormat} spritesheet` : draft.outputFormat;
  const sizeLabel = draft.mode === 'image'
    ? `${draft.exportWidth}×${draft.exportHeight}`
    : `${draft.columns}×${draft.rows} cells, ${draft.displayWidth}×${draft.displayHeight} display`;
  const description = draft.terrainType
    ? `${draft.terrainType.replace(/_/g, ' ')} terrain tile v${String(draft.terrainVariant).padStart(2, '0')}`
    : draft.mode === 'video'
    ? `Generated from video (${draft.animationType})`
    : draft.mode === 'spritesheet'
      ? `${draft.animationType} animation sheet`
      : `${draft.category} asset`;

  return `| \`${draft.assetId}\` | ${description} | \`${getDraftOutputPath(draft).replace('game/assets/', '')}/${draft.assetId}.${draft.outputFormat}\` | ${sizeLabel} | ${formatLabel} | wip |`;
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

export async function exportRasterBlob(file: File, draft: AssetDraft): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(draft.exportWidth || bitmap.width));
  canvas.height = Math.max(1, Math.round(draft.exportHeight || bitmap.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable.');
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const mimeType = toMimeType(draft.outputFormat);
  const quality = draft.outputFormat === 'png' ? undefined : 0.9;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  bitmap.close();

  if (!blob) {
    throw new Error('Export failed.');
  }
  return blob;
}

function toMimeType(format: OutputFormat): string {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpg':
      return 'image/jpeg';
    case 'avif':
      return 'image/avif';
    case 'webp':
    default:
      return 'image/webp';
  }
}

export function bytesToHuman(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function buildDraftFromPersistedAsset(asset: PersistedAssetRecord): AssetDraft {
  const reopenedMode = asset.mode === 'video' ? 'spritesheet' : asset.mode;
  const defaultDraft = createDefaultDraft();

  return {
    assetId: asset.id,
    displayName: asset.name,
    category: asset.category,
    mode: reopenedMode,
    outputFormat: asset.outputFormat,
    maintainAspectRatio: asset.maintainAspectRatio,
    resizeFit: asset.resizeFit ?? 'contain',
    exportWidth: asset.exportSize.width,
    exportHeight: asset.exportSize.height,
    displayWidth: asset.displaySize.width,
    displayHeight: asset.displaySize.height,
    removeBackground: false,
    cropToBoundingBox: asset.optimization.cropToBoundingBoxRequested ?? false,
    enableOptimization: asset.optimization.enabled,
    animationType: asset.spritesheet?.animationType ?? defaultDraft.animationType,
    columns: asset.spritesheet?.columns ?? 1,
    rows: asset.spritesheet?.rows ?? 1,
    frameRate: asset.spritesheet?.frameRate ?? asset.video?.requestedFrameRate ?? defaultDraft.frameRate,
    origin: asset.spritesheet?.origin ?? defaultDraft.origin,
    collisionBox: asset.spritesheet?.collisionBox ?? defaultDraft.collisionBox,
    notes: asset.notes,
    trimStartSeconds: asset.video?.trimStartSeconds ?? 0,
    trimEndSeconds: asset.video?.trimEndSeconds ?? 0,
    videoSampling: asset.video?.sampling ?? 'spread',
    terrainType: asset.terrainTile?.terrainType ?? '',
    terrainVariant: asset.terrainTile?.variant ?? defaultDraft.terrainVariant,
    terrainAutoNaming: false,
    terrainAtlasGroup: asset.terrainTile?.atlasGroup ?? defaultDraft.terrainAtlasGroup,
    terrainGenerateAtlas: asset.terrainTile?.generateAtlas ?? defaultDraft.terrainGenerateAtlas,
    terrainHexOverlay: asset.terrainTile?.coreHex ?? defaultDraft.terrainHexOverlay,
  };
}
