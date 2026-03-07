import type { AssetDraft } from '../types';

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

export async function processAssetInWorkspace(file: File, draft: AssetDraft): Promise<SavedAssetResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('draft', JSON.stringify(draft));

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
