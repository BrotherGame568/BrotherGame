import type { AssetCatalogDocument, AssetDraft, PersistedAssetRecord } from '../types';

export interface SavedAssetResult {
  outputRelativePath: string;
  metadataRelativePath: string;
  manifestRelativePath: string;
  sourceBytes: number;
  outputBytes: number;
  notes: string[];
  frameCount: number;
}

export interface HealthResponse {
  ok: boolean;
  ffmpegAvailable: boolean;
  repoRoot: string;
  assetsRoot: string;
}

export async function fetchBackendHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error('Asset backend is unavailable.');
  }
  return response.json() as Promise<HealthResponse>;
}

export async function fetchAssetCatalog(): Promise<AssetCatalogDocument> {
  const response = await fetch('/api/catalog');
  if (!response.ok) {
    throw new Error('Unable to load the asset catalog.');
  }
  return response.json() as Promise<AssetCatalogDocument>;
}

export async function fetchWorkspaceAssetFile(relativePath: string): Promise<Blob> {
  const response = await fetch(`/api/asset-file?path=${encodeURIComponent(relativePath)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Unable to load the asset file.' }));
    throw new Error(payload.error ?? 'Unable to load the asset file.');
  }
  return response.blob();
}

export async function updateAssetMetadataInWorkspace(draft: AssetDraft, currentAssetId: string): Promise<SavedAssetResult> {
  const response = await fetch('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft, currentAssetId }),
  });

  const payload = await response.json() as { error?: string; savedAsset?: SavedAssetResult };
  if (!response.ok || !payload.savedAsset) {
    throw new Error(payload.error ?? 'Metadata update failed.');
  }
  return payload.savedAsset;
}

export async function updateAssetArchiveStatus(assetId: string, archived: boolean): Promise<PersistedAssetRecord> {
  const response = await fetch('/api/asset-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId, archived }),
  });

  const payload = await response.json() as { error?: string; asset?: PersistedAssetRecord };
  if (!response.ok || !payload.asset) {
    throw new Error(payload.error ?? 'Asset archive update failed.');
  }
  return payload.asset;
}

export async function deleteWorkspaceAsset(assetId: string): Promise<void> {
  const response = await fetch(`/api/asset?assetId=${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Asset delete failed.' }));
    throw new Error(payload.error ?? 'Asset delete failed.');
  }
}

export async function processAssetInWorkspace(file: File, draft: AssetDraft, currentAssetId?: string | null): Promise<SavedAssetResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('draft', JSON.stringify(draft));
  if (currentAssetId) {
    formData.append('currentAssetId', currentAssetId);
  }

  const response = await fetch('/api/process', {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json() as { error?: string; savedAsset?: SavedAssetResult };
  if (!response.ok || !payload.savedAsset) {
    throw new Error(payload.error ?? 'Asset processing failed.');
  }

  return payload.savedAsset;
}
