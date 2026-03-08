export type AssetCategory = 'backgrounds' | 'sprites' | 'ui' | 'animations';
export type ImportMode = 'image' | 'spritesheet' | 'video';
export type OutputFormat = 'webp' | 'png' | 'jpg' | 'avif';
export type AnimationType = 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'hurt' | 'death' | 'custom';
export type ResizeFitMode = 'contain' | 'cover' | 'fill';
export type VideoSamplingMode = 'sequential' | 'spread';

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
  source: SourceInfo | null;
  generatedAt: string;
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
  generatedAt: string;
  assets: PersistedAssetRecord[];
}

// ─── Audio types ────────────────────────────────────────────────────────────

export type AudioCategory = 'music' | 'sfx' | 'ambience';
export type AudioOutputFormat = 'wav' | 'opus' | 'ogg';

export interface AudioDraft {
  assetId: string;
  displayName: string;
  category: AudioCategory;
  outputFormat: AudioOutputFormat;
  trimStartSeconds: number;
  trimEndSeconds: number;
  normalize: boolean;
  loopable: boolean;
  notes: string;
}

export interface PersistedAudioRecord {
  id: string;
  name: string;
  status: 'active' | 'archived';
  category: AudioCategory;
  outputFormat: AudioOutputFormat;
  outputRelativePath: string;
  outputAbsolutePath?: string;
  metadataRelativePath: string;
  metadataAbsolutePath?: string;
  duration: number;
  loopable: boolean;
  normalize: boolean;
  trim: { startSeconds: number; endSeconds: number };
  source: { name: string; mimeType: string; sizeBytes: number };
  generatedAt: string;
  archivedAt?: string;
  notes: string;
}

export interface AudioCatalogDocument {
  generatedAt: string;
  assets: PersistedAudioRecord[];
}
