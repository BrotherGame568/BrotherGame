export type AssetCategory = 'backgrounds' | 'sprites' | 'ui' | 'animations';
export type ImportMode = 'image' | 'spritesheet' | 'video';
export type OutputFormat = 'webp' | 'png' | 'jpg' | 'avif';
export type AnimationType = 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'hurt' | 'death' | 'custom';
export type ResizeFitMode = 'contain' | 'cover' | 'fill';
export type VideoSamplingMode = 'sequential' | 'spread';
export type TerrainType =
  | 'abyssal_trench'
  | 'deep_ocean'
  | 'open_ocean'
  | 'shallow_sea'
  | 'mangrove'
  | 'sand_beach'
  | 'snow_peaks'
  | 'bare_rock'
  | 'alpine'
  | 'dense_rainforest'
  | 'temperate_forest'
  | 'woodland'
  | 'plains'
  | 'savanna'
  | 'scrub_steppe'
  | 'desert_dunes';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OriginPoint {
  x: number;
  y: number;
}

export interface TerrainHexOverlay {
  centerX: number;
  centerY: number;
  radius: number;
  squashY: number;
  topOverflow: number;
}

export interface SourceInfo {
  kind: 'image' | 'video' | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds?: number;
}

export interface AssetDraft {
  assetId: string;
  displayName: string;
  category: AssetCategory;
  mode: ImportMode;
  outputFormat: OutputFormat;
  maintainAspectRatio: boolean;
  resizeFit: ResizeFitMode;
  exportWidth: number;
  exportHeight: number;
  displayWidth: number;
  displayHeight: number;
  removeBackground: boolean;
  cropToBoundingBox: boolean;
  enableOptimization: boolean;
  animationType: AnimationType;
  columns: number;
  rows: number;
  frameRate: number;
  origin: OriginPoint;
  collisionBox: Rect;
  notes: string;
  trimStartSeconds: number;
  trimEndSeconds: number;
  videoSampling: VideoSamplingMode;
  terrainType: TerrainType | '';
  terrainVariant: number;
  terrainAutoNaming: boolean;
  terrainAtlasGroup: string;
  terrainGenerateAtlas: boolean;
  terrainHexOverlay: TerrainHexOverlay;
}

export interface AssetMetadataDocument {
  id: string;
  name: string;
  category: AssetCategory;
  mode: ImportMode;
  outputFormat: OutputFormat;
  maintainAspectRatio: boolean;
  resizeFit: ResizeFitMode;
  exportSize: { width: number; height: number };
  displaySize: { width: number; height: number };
  optimization: {
    enabled: boolean;
    backgroundRemovalRequested: boolean;
    cropToBoundingBoxRequested?: boolean;
  };
  spritesheet?: {
    columns: number;
    rows: number;
    frameRate: number;
    animationType: AnimationType;
    origin: OriginPoint;
    collisionBox: Rect;
  };
  video?: {
    trimStartSeconds: number;
    trimEndSeconds: number;
    requestedFrameRate: number;
    sampling: VideoSamplingMode;
  };
  terrainTile?: {
    terrainType: TerrainType;
    variant: number;
    atlasGroup: string;
    generateAtlas: boolean;
    coreHex: TerrainHexOverlay;
  };
  source: SourceInfo | null;
  notes: string;
}

export interface PersistedAssetRecord extends AssetMetadataDocument {
  outputRelativePath: string;
  metadataRelativePath: string;
  outputAbsolutePath?: string;
  metadataAbsolutePath?: string;
  status?: 'active' | 'archived';
  archivedAt?: string;
  optimization: AssetMetadataDocument['optimization'] & {
    notes?: string[];
  };
  spritesheet?: NonNullable<AssetMetadataDocument['spritesheet']> & {
    frameCount?: number;
  };
}

export interface AssetCatalogDocument {
  assets: PersistedAssetRecord[];
}
