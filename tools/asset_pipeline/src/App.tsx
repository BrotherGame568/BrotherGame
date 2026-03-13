import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Boxes,
  ChevronDown,
  Clapperboard,
  CircleCheckBig,
  Download,
  Film,
  FilePenLine,
  Hexagon,
  ImagePlus,
  Plus,
  RefreshCw,
  ScanLine,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import type { AssetCategory, AssetDraft, AnimationType, OutputFormat, PersistedAssetRecord, ResizeFitMode, SourceInfo, TerrainType, VideoSamplingMode } from './types';
import {
  buildAssetMetadata,
  buildDraftFromPersistedAsset,
  buildManifestRow,
  bytesToHuman,
  createDefaultDraft,
  downloadBlob,
  downloadTextFile,
  exportRasterBlob,
  getDraftOutputPath,
  inferCategoryFromMode,
  sanitizeAssetId,
} from './lib/assetTools';
import {
  deleteWorkspaceAsset,
  fetchAssetCatalog,
  fetchBackendHealth,
  fetchWorkspaceAssetFile,
  processAssetInWorkspace,
  updateAssetArchiveStatus,
  updateAssetMetadataInWorkspace,
  type SavedAssetResult,
} from './lib/apiClient';

const CATEGORY_OPTIONS: AssetCategory[] = ['backgrounds', 'sprites', 'ui', 'animations'];
const OUTPUT_FORMATS: OutputFormat[] = ['webp', 'png', 'jpg', 'avif'];
const ANIMATION_TYPES: AnimationType[] = ['idle', 'walk', 'run', 'jump', 'attack', 'hurt', 'death', 'custom'];
const RESIZE_FIT_OPTIONS: ResizeFitMode[] = ['contain', 'cover', 'fill'];
const VIDEO_SAMPLING_OPTIONS: VideoSamplingMode[] = ['spread', 'sequential'];
const TARGET_TERRAIN_HEX_SQUASH = 0.55;
const TARGET_TERRAIN_CORE_WIDTH = 256;
const TARGET_TERRAIN_OUTPUT_WIDTH = 384;
const TARGET_TERRAIN_OUTPUT_HEIGHT = 384;
const TARGET_TERRAIN_CENTER_X = 0.5;
const TARGET_TERRAIN_CENTER_Y = 0.55;
const TERRAIN_TYPE_OPTIONS: TerrainType[] = [
  'abyssal_trench',
  'deep_ocean',
  'open_ocean',
  'shallow_sea',
  'mangrove',
  'sand_beach',
  'snow_peaks',
  'bare_rock',
  'alpine',
  'dense_rainforest',
  'temperate_forest',
  'woodland',
  'plains',
  'savanna',
  'scrub_steppe',
  'desert_dunes',
];

export default function App() {
  const [draft, setDraft] = useState<AssetDraft>(createDefaultDraft);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null);
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);
  const [videoPreviewSheet, setVideoPreviewSheet] = useState<HTMLCanvasElement | null>(null);
  const [videoPreviewInfo, setVideoPreviewInfo] = useState<SourceInfo | null>(null);
  const [isPreparingVideoPreview, setIsPreparingVideoPreview] = useState(false);
  const [status, setStatus] = useState<string>('Load an image or video to begin.');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [appView, setAppView] = useState<'library' | 'editor' | 'terrain'>('library');
  const [catalogAssets, setCatalogAssets] = useState<PersistedAssetRecord[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState('');
  const [showArchivedAssets, setShowArchivedAssets] = useState(false);
  const [librarySelectedAssetId, setLibrarySelectedAssetId] = useState<string | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
  const [savedAsset, setSavedAsset] = useState<SavedAssetResult | null>(null);
  const [currentAssetId, setCurrentAssetId] = useState<string | null>(null);
  const pendingLoadedDraftRef = useRef<AssetDraft | null>(null);
  const [openSections, setOpenSections] = useState({
    import: true,
    metadata: false,
    terrain: false,
    sizing: false,
    animation: false,
    video: false,
  });
  const isTerrainView = appView === 'terrain';
  const hasSelectedSource = selectedFile !== null;
  const canExportRaster = hasSelectedSource && draft.mode !== 'video';
  const canProcessToWorkspace = hasSelectedSource && (draft.mode !== 'video' || ffmpegAvailable);

  async function refreshCatalog(): Promise<void> {
    if (!backendReady) {
      setCatalogAssets([]);
      return;
    }

    setIsLoadingCatalog(true);
    try {
      const catalog = await fetchAssetCatalog();
      setCatalogAssets(catalog.assets);
      setCatalogError(null);
    } catch (error) {
      setCatalogAssets([]);
      setCatalogError(error instanceof Error ? error.message : 'Unable to load the asset catalog.');
    } finally {
      setIsLoadingCatalog(false);
    }
  }

  useEffect(() => {
    fetchBackendHealth()
      .then((health) => {
        setBackendReady(health.ok);
        setFfmpegAvailable(health.ffmpegAvailable);
      })
      .catch(() => {
        setBackendReady(false);
        setFfmpegAvailable(false);
      });
  }, []);

  useEffect(() => {
    if (saveState !== 'success') {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setSaveState('idle');
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [saveState]);

  useEffect(() => {
    void refreshCatalog();
  }, [backendReady]);

  useEffect(() => {
    if (!selectedFile) {
      setSourceInfo(null);
      setPreviewImage(null);
      setVideoPreviewSheet(null);
      setVideoPreviewInfo(null);
      setIsPreparingVideoPreview(false);
      return;
    }

    const url = URL.createObjectURL(selectedFile);

    let revoked = false;
    const baseName = selectedFile.name.replace(/\.[^.]+$/, '');

    const applySource = (info: SourceInfo): void => {
      if (revoked) return;
      setSourceInfo(info);
      const pendingLoadedDraft = pendingLoadedDraftRef.current;
      setDraft((current) => {
        if (pendingLoadedDraft) {
          pendingLoadedDraftRef.current = null;
          return pendingLoadedDraft;
        }

        const nextMode = isTerrainView ? 'image' : info.kind === 'video' ? 'video' : current.mode;
        const inferredCategory = isTerrainView ? 'sprites' : info.kind === 'video' ? 'animations' : inferCategoryFromMode(nextMode);
        const modeSizing = getSuggestedSizingForMode(nextMode, info, current.columns, current.rows);
        const displayWidth = current.displayWidth > 0 ? current.displayWidth : Math.min(modeSizing.exportWidth, 220);
        const aspect = modeSizing.exportWidth > 0 ? modeSizing.exportHeight / modeSizing.exportWidth : 1;
        const displayHeight = current.maintainAspectRatio || current.displayHeight <= 0
          ? Math.max(1, Math.round(displayWidth * aspect))
          : current.displayHeight;
        const collisionHeight = Math.max(24, Math.round(displayHeight * 0.72));
        const collisionWidth = Math.max(24, Math.round(displayWidth * 0.58));

        return {
          ...current,
          assetId: isTerrainView
            ? current.assetId
            : current.assetId === 'new_asset' || current.assetId === sanitizeAssetId(baseName)
            ? sanitizeAssetId(baseName)
            : current.assetId,
          displayName: isTerrainView
            ? current.displayName
            : current.displayName === 'New Asset' ? humanizeName(baseName) : current.displayName,
          mode: nextMode,
          category: isTerrainView
            ? 'sprites'
            : current.category === 'sprites' || current.category === 'animations' ? inferredCategory : current.category,
          exportWidth: modeSizing.exportWidth,
          exportHeight: modeSizing.exportHeight,
          displayWidth,
          displayHeight,
          frameRate: info.kind === 'video' ? Math.max(current.frameRate, 12) : current.frameRate,
          collisionBox: {
            x: Math.round((displayWidth - collisionWidth) / 2),
            y: Math.round(displayHeight - collisionHeight),
            width: collisionWidth,
            height: collisionHeight,
          },
        };
      });
      setStatus(
        pendingLoadedDraft
          ? pendingLoadedDraft.mode === 'spritesheet' && info.kind === 'image' && selectedFile.type.startsWith('image/')
            ? `${pendingLoadedDraft.displayName} loaded for editing.`
            : `${selectedFile.name} loaded.`
          : `${selectedFile.name} loaded.`,
      );
    };

    if (selectedFile.type.startsWith('image/')) {
      const image = new Image();
      image.onload = () => {
        if (revoked) return;
        setPreviewImage(image);
        applySource({
          kind: 'image',
          name: selectedFile.name,
          mimeType: selectedFile.type,
          sizeBytes: selectedFile.size,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      };
      image.src = url;
    } else if (selectedFile.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        if (revoked) return;
        applySource({
          kind: 'video',
          name: selectedFile.name,
          mimeType: selectedFile.type,
          sizeBytes: selectedFile.size,
          width: video.videoWidth,
          height: video.videoHeight,
          durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
        });
      };
      video.src = url;
    }

    return () => {
      revoked = true;
      URL.revokeObjectURL(url);
    };
  }, [isTerrainView, selectedFile]);

  useEffect(() => {
    let cancelled = false;

    async function buildVideoPreview(): Promise<void> {
      if (!selectedFile || !sourceInfo || sourceInfo.kind !== 'video' || draft.mode !== 'video') {
        setVideoPreviewSheet(null);
        setVideoPreviewInfo(null);
        setIsPreparingVideoPreview(false);
        return;
      }

      setIsPreparingVideoPreview(true);
      try {
        const sheet = await createSpritesheetPreviewFromVideo(selectedFile, draft, sourceInfo);
        if (cancelled) return;
        setVideoPreviewSheet(sheet);
        setVideoPreviewInfo({
          kind: 'image',
          name: `${selectedFile.name}-preview-sheet`,
          mimeType: 'image/png',
          sizeBytes: 0,
          width: sheet.width,
          height: sheet.height,
        });
      } catch {
        if (cancelled) return;
        setVideoPreviewSheet(null);
        setVideoPreviewInfo(null);
      } finally {
        if (!cancelled) {
          setIsPreparingVideoPreview(false);
        }
      }
    }

    void buildVideoPreview();
    return () => {
      cancelled = true;
    };
  }, [
    selectedFile,
    sourceInfo,
    draft.mode,
    draft.columns,
    draft.rows,
    draft.frameRate,
    draft.exportWidth,
    draft.exportHeight,
    draft.trimStartSeconds,
    draft.trimEndSeconds,
    draft.videoSampling,
    draft.resizeFit,
    draft.removeBackground,
    draft.cropToBoundingBox,
  ]);

  useEffect(() => {
    setOpenSections((current) => ({
      ...current,
      metadata: hasSelectedSource || current.metadata,
      sizing: hasSelectedSource || current.sizing,
      animation: (draft.mode === 'spritesheet' || draft.mode === 'video') || current.animation,
      video: draft.mode === 'video' || current.video,
    }));
  }, [hasSelectedSource, draft.mode]);

  const metadata = useMemo(() => buildAssetMetadata(draft, sourceInfo), [draft, sourceInfo]);
  const manifestRow = useMemo(() => buildManifestRow(draft), [draft]);
  const filteredCatalogAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    return catalogAssets.filter((asset) => {
      if (!showArchivedAssets && asset.status === 'archived') {
        return false;
      }

      if (!query) {
        return true;
      }

      return asset.id.toLowerCase().includes(query)
        || asset.name.toLowerCase().includes(query)
        || asset.category.toLowerCase().includes(query)
        || asset.outputRelativePath.toLowerCase().includes(query);
    });
  }, [catalogAssets, assetSearch, showArchivedAssets]);
  const selectedCatalogAsset = useMemo(
    () => catalogAssets.find((asset) => asset.id === currentAssetId) ?? null,
    [catalogAssets, currentAssetId],
  );
  const selectedLibraryAsset = useMemo(
    () => filteredCatalogAssets.find((asset) => asset.id === librarySelectedAssetId) ?? filteredCatalogAssets[0] ?? null,
    [filteredCatalogAssets, librarySelectedAssetId],
  );

  useEffect(() => {
    if (!isTerrainView || currentAssetId || !draft.terrainAutoNaming || !draft.terrainType) {
      return;
    }

    const nextVariant = getNextTerrainVariant(catalogAssets, draft.terrainType);
    const nextAssetId = buildTerrainAssetId(draft.terrainType, nextVariant);
    const nextDisplayName = `${humanizeTerrainType(draft.terrainType)} ${String(nextVariant).padStart(2, '0')}`;

    if (draft.assetId === nextAssetId && draft.displayName === nextDisplayName && draft.terrainVariant === nextVariant) {
      return;
    }

    setDraft((current) => ({
      ...current,
      assetId: nextAssetId,
      displayName: nextDisplayName,
      terrainVariant: nextVariant,
      category: 'sprites',
      mode: 'image',
    }));
  }, [catalogAssets, currentAssetId, draft.assetId, draft.displayName, draft.terrainAutoNaming, draft.terrainType, draft.terrainVariant, isTerrainView]);

  useEffect(() => {
    if (filteredCatalogAssets.length === 0) {
      setLibrarySelectedAssetId(null);
      return;
    }

    const firstAsset = filteredCatalogAssets[0];
    if (firstAsset && (!librarySelectedAssetId || !filteredCatalogAssets.some((asset) => asset.id === librarySelectedAssetId))) {
      setLibrarySelectedAssetId(firstAsset.id);
    }
  }, [filteredCatalogAssets, librarySelectedAssetId]);
  const outputPath = useMemo(
    () => `${getDraftOutputPath(draft)}/${draft.assetId}.${draft.outputFormat}`,
    [draft, draft.assetId, draft.outputFormat],
  );
  const currentAspectRatio = useMemo(() => getAssetAspectRatio(draft, sourceInfo), [draft, sourceInfo]);

  useEffect(() => {
    if (!isTerrainView) {
      return;
    }

    const nextExportWidth = TARGET_TERRAIN_OUTPUT_WIDTH;
    const nextExportHeight = TARGET_TERRAIN_OUTPUT_HEIGHT;
    const nextDisplayWidth = TARGET_TERRAIN_CORE_WIDTH;
    const nextDisplayHeight = getTerrainDisplayHeight(nextDisplayWidth);

    if (
      draft.exportWidth === nextExportWidth
      && draft.exportHeight === nextExportHeight
      && draft.displayWidth === nextDisplayWidth
      && draft.displayHeight === nextDisplayHeight
    ) {
      return;
    }

    setDraft((current) => ({
      ...current,
      exportWidth: nextExportWidth,
      exportHeight: nextExportHeight,
      displayWidth: nextDisplayWidth,
      displayHeight: nextDisplayHeight,
    }));
  }, [draft.displayHeight, draft.displayWidth, draft.exportHeight, draft.exportWidth, isTerrainView]);
  const workflowSteps = isTerrainView
    ? [
      { label: 'Import tile', description: hasSelectedSource ? selectedFile?.name ?? 'Loaded' : 'Choose a prerendered hex tile image.', complete: hasSelectedSource },
      { label: 'Assign terrain', description: draft.terrainType ? `${humanizeTerrainType(draft.terrainType)} • ${draft.assetId}` : 'Pick the terrain type and generate naming.', complete: hasSelectedSource && draft.terrainType.length > 0 },
      { label: 'Align core hex', description: 'Drag the outline to match the playable hex footprint.', complete: hasSelectedSource },
      { label: 'Save outputs', description: backendReady ? 'Write terrain metadata into the workspace.' : 'Start the backend to save directly into the repo.', complete: savedAsset !== null },
    ] as const
    : [
      { label: 'Import source', description: hasSelectedSource ? selectedFile?.name ?? 'Loaded' : 'Choose an image, spritesheet, or video.', complete: hasSelectedSource },
      { label: 'Set metadata', description: draft.assetId && draft.displayName ? `${draft.assetId} • ${draft.category}` : 'Name and classify the asset.', complete: hasSelectedSource && draft.assetId.length > 0 },
      { label: 'Tune preview', description: draft.mode === 'image' ? 'Check sizing and output format.' : 'Check grid, origin, and collision box.', complete: hasSelectedSource },
      { label: 'Save output', description: backendReady ? 'Process into the workspace or download files.' : 'Start the backend to save directly into the repo.', complete: savedAsset !== null },
    ] as const;

  function handleSizedValueChange(target: 'export' | 'display', dimension: 'width' | 'height', value: number): void {
    const nextValue = Math.max(1, Math.round(value));
    setDraft((current) => {
      const next = { ...current };
      const ratio = getAssetAspectRatio(current, sourceInfo);

      if (target === 'export') {
        if (dimension === 'width') {
          next.exportWidth = nextValue;
          if (current.maintainAspectRatio) {
            next.exportHeight = Math.max(1, Math.round(nextValue * ratio));
          }
        } else {
          next.exportHeight = nextValue;
          if (current.maintainAspectRatio) {
            next.exportWidth = Math.max(1, Math.round(nextValue / ratio));
          }
        }
      } else if (dimension === 'width') {
        next.displayWidth = nextValue;
        if (current.maintainAspectRatio) {
          next.displayHeight = Math.max(1, Math.round(nextValue * ratio));
        }
      } else {
        next.displayHeight = nextValue;
        if (current.maintainAspectRatio) {
          next.displayWidth = Math.max(1, Math.round(nextValue / ratio));
        }
      }

      return next;
    });
  }

  function handleGridChange(axis: 'columns' | 'rows', value: number): void {
    const nextValue = Math.max(1, Math.round(value));
    setDraft((current) => {
      const next = {
        ...current,
        [axis]: nextValue,
      } as AssetDraft;

      if (current.maintainAspectRatio) {
        const ratio = getAssetAspectRatio(next, sourceInfo);
        next.exportHeight = Math.max(1, Math.round(next.exportWidth * ratio));
        next.displayHeight = Math.max(1, Math.round(next.displayWidth * ratio));
      }

      return next;
    });
  }

  async function handleRasterExport(): Promise<void> {
    if (!selectedFile || selectedFile.type.startsWith('video/')) {
      setStatus('Raster export currently supports imported images and spritesheets.');
      return;
    }

    try {
      const blob = await exportRasterBlob(selectedFile, draft);
      downloadBlob(`${draft.assetId}.${draft.outputFormat}`, blob);
      setStatus(`Exported ${draft.assetId}.${draft.outputFormat}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Export failed.');
    }
  }

  async function handleSaveToWorkspace(): Promise<void> {
    if (!selectedFile) {
      setStatus('Select a source file first.');
      setSaveState('error');
      return;
    }

    if (!backendReady) {
      setStatus('Start the asset manager with `npm run asset-manager:start` from the repo root.');
      setSaveState('error');
      return;
    }

    try {
      setSaveState('saving');
      setStatus('Processing asset in workspace...');
      const result = await processAssetInWorkspace(selectedFile, draft, currentAssetId);
      setSavedAsset(result);
      setCurrentAssetId(draft.assetId);
      await refreshCatalog();
      setSaveState('success');
      setStatus(`Saved to ${result.outputRelativePath}`);
    } catch (error) {
      setSaveState('error');
      setStatus(error instanceof Error ? error.message : 'Workspace processing failed.');
    }
  }

  function handleMetadataDownload(): void {
    downloadTextFile(`${draft.assetId}.asset.json`, JSON.stringify(metadata, null, 2));
    setStatus('Metadata JSON downloaded.');
  }

  function handleManifestDownload(): void {
    downloadTextFile(`${draft.assetId}.manifest-row.md`, manifestRow);
    setStatus('Manifest row downloaded.');
  }

  function handleFileSelected(file: File | null): void {
    setSelectedFile(file);
    setSavedAsset(null);
    setSaveState('idle');
    setCurrentAssetId(null);
    if (!file) {
      setStatus('Selection cleared.');
      return;
    }

    if (isTerrainView) {
      setDraft((current) => ({
        ...current,
        mode: 'image',
        category: 'sprites',
      }));
      return;
    }

    if (file.type.startsWith('video/')) {
      setDraft((current) => ({
        ...current,
        mode: 'video',
        category: 'animations',
      }));
    }
  }

  async function handleLoadExistingAsset(asset: PersistedAssetRecord): Promise<void> {
    try {
      setStatus(`Loading ${asset.id} from the workspace...`);
      setSaveState('idle');
      setSavedAsset(null);
      const blob = await fetchWorkspaceAssetFile(asset.outputRelativePath);
      const fileName = asset.outputRelativePath.split('/').pop() ?? `${asset.id}.${asset.outputFormat}`;
      const file = new File([blob], fileName, { type: blob.type || inferMimeTypeFromFormat(asset.outputFormat) });
      pendingLoadedDraftRef.current = buildDraftFromPersistedAsset(asset);
      setCurrentAssetId(asset.id);
      setSelectedFile(file);
      setAppView(asset.terrainTile ? 'terrain' : 'editor');
      setStatus(
        asset.mode === 'video'
          ? `Loaded ${asset.id} from its generated spritesheet output. Original video clips are not stored.`
          : `Loaded ${asset.id} for editing.`,
      );
    } catch (error) {
      setSaveState('error');
      setStatus(error instanceof Error ? error.message : 'Unable to load the selected asset.');
    }
  }

  function handleStartNewAsset(): void {
    setAppView('editor');
    setDraft(createDefaultDraft());
    setSelectedFile(null);
    setSourceInfo(null);
    setPreviewImage(null);
    setVideoPreviewSheet(null);
    setVideoPreviewInfo(null);
    setSavedAsset(null);
    setCurrentAssetId(null);
    setSaveState('idle');
    setStatus('Ready to create a new asset.');
  }

  function handleStartNewTerrain(): void {
    setAppView('terrain');
    setDraft(createTerrainDraft());
    setSelectedFile(null);
    setSourceInfo(null);
    setPreviewImage(null);
    setVideoPreviewSheet(null);
    setVideoPreviewInfo(null);
    setSavedAsset(null);
    setCurrentAssetId(null);
    setSaveState('idle');
    setOpenSections({ import: true, metadata: true, terrain: true, sizing: true, animation: false, video: false });
    setStatus('Ready to import a prerendered terrain tile.');
  }

  function handleShowLibrary(): void {
    setAppView('library');
    void refreshCatalog();
  }

  async function handleMetadataOnlySave(): Promise<void> {
    if (!currentAssetId) {
      setSaveState('error');
      setStatus('Load an existing asset first to save metadata without reprocessing.');
      return;
    }

    try {
      setSaveState('saving');
      setStatus('Saving metadata only...');
      const result = await updateAssetMetadataInWorkspace(draft, currentAssetId);
      setSavedAsset(result);
      setCurrentAssetId(draft.assetId);
      await refreshCatalog();
      setSaveState('success');
      setStatus(`Metadata updated for ${draft.assetId}.`);
    } catch (error) {
      setSaveState('error');
      setStatus(error instanceof Error ? error.message : 'Metadata update failed.');
    }
  }

  async function handleArchiveToggle(asset: PersistedAssetRecord): Promise<void> {
    try {
      setStatus(`${asset.status === 'archived' ? 'Restoring' : 'Archiving'} ${asset.id}...`);
      await updateAssetArchiveStatus(asset.id, asset.status !== 'archived');
      await refreshCatalog();
      setStatus(`${asset.status === 'archived' ? 'Restored' : 'Archived'} ${asset.id}.`);
    } catch (error) {
      setSaveState('error');
      setStatus(error instanceof Error ? error.message : 'Unable to update asset status.');
    }
  }

  async function handleDeleteAsset(asset: PersistedAssetRecord): Promise<void> {
    const confirmed = window.confirm(`Delete ${asset.name} and remove it from the asset catalog?`);
    if (!confirmed) {
      return;
    }

    try {
      setStatus(`Deleting ${asset.id}...`);
      await deleteWorkspaceAsset(asset.id);
      if (currentAssetId === asset.id) {
        setCurrentAssetId(null);
        setSelectedFile(null);
      }
      await refreshCatalog();
      setStatus(`${asset.id} deleted.`);
    } catch (error) {
      setSaveState('error');
      setStatus(error instanceof Error ? error.message : 'Unable to delete asset.');
    }
  }

  return (
    <div className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">BrotherGame tooling</p>
          <h1>Asset Manager</h1>
          <p className="hero-copy">
            {isTerrainView
              ? 'Import prerendered hex terrain tiles, assign them to terrain types, and align a normalized core hex before saving.'
              : 'Import art, keep metadata organized, preview grounding and hitboxes, and save optimized assets directly into the game workspace.'}
          </p>
        </div>
        <div className="hero-actions">
          {appView === 'library' ? (
            <>
              {(hasSelectedSource || currentAssetId) ? (
                <button type="button" className="secondary-button" onClick={() => setAppView('editor')}>
                  <FilePenLine size={16} />
                  Return to editor
                </button>
              ) : null}
              <button type="button" className="primary-button" onClick={handleStartNewAsset}>
                <Plus size={16} />
                Add new asset
              </button>
              <button type="button" className="secondary-button" onClick={handleStartNewTerrain}>
                <Hexagon size={16} />
                Terrain tile import
              </button>
            </>
          ) : (
            <button type="button" className="secondary-button" onClick={handleShowLibrary}>
              <ArrowLeft size={16} />
              Back to library
            </button>
          )}
        </div>
      </header>

      {appView === 'library' ? (
        <main className="library-grid">
          <section className="panel stack">
            <PanelHeader icon={<Boxes size={18} />} title="Asset library" subtitle="Browse, search, edit, archive, and delete saved workspace assets." />

            <div className="asset-browser">
              <div className="asset-browser-header">
                <div>
                  <strong>Existing assets</strong>
                  <p>Load a previously saved asset back into the editor.</p>
                </div>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() => void refreshCatalog()}
                  disabled={!backendReady || isLoadingCatalog}
                >
                  <RefreshCw size={14} />
                  {isLoadingCatalog ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <label className="field full-span">
                <span>Search saved assets</span>
                <input value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder="Search by ID, name, category, or path" />
              </label>

              <ToggleField
                label="Show archived assets"
                checked={showArchivedAssets}
                onChange={setShowArchivedAssets}
                helper="Archived assets stay in the catalog until deleted."
              />

              {!backendReady ? (
                <p className="helper-text">Start the asset manager with `npm run asset-manager:start` from the repo root to browse saved assets.</p>
              ) : catalogError ? (
                <p className="helper-text">{catalogError} Try refreshing after restarting the asset backend.</p>
              ) : filteredCatalogAssets.length === 0 ? (
                <p className="helper-text">No saved assets match the current search.</p>
              ) : (
                <div className="asset-gallery-grid">
                  {filteredCatalogAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      className={`asset-gallery-card ${asset.status === 'archived' ? 'archived' : ''} ${selectedLibraryAsset?.id === asset.id ? 'selected' : ''}`}
                      onClick={() => setLibrarySelectedAssetId(asset.id)}
                    >
                      <img
                        className="asset-gallery-thumb"
                        src={`/api/asset-file?path=${encodeURIComponent(asset.outputRelativePath)}`}
                        alt={asset.name}
                        loading="lazy"
                      />
                      <div className="asset-gallery-copy">
                        <strong>{asset.name}</strong>
                        <span>{asset.category} • {asset.mode === 'video' ? 'video sheet' : asset.mode}</span>
                        <small>{asset.id}</small>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="panel stack">
            <PanelHeader icon={<Sparkles size={18} />} title="Selection" subtitle="Details and actions for the selected asset." />
            <div className="summary-grid library-summary-grid">
              <InfoTile label="Visible assets" value={`${filteredCatalogAssets.length}`} />
              <InfoTile label="All assets" value={`${catalogAssets.length}`} />
              <InfoTile label="Archived" value={`${catalogAssets.filter((asset) => asset.status === 'archived').length}`} />
              <InfoTile label="Backend" value={backendReady ? 'online' : 'offline'} />
            </div>
            {selectedLibraryAsset ? (
              <>
                <div className="library-selected-card">
                  <img
                    className="library-selected-thumb"
                    src={`/api/asset-file?path=${encodeURIComponent(selectedLibraryAsset.outputRelativePath)}`}
                    alt={selectedLibraryAsset.name}
                  />
                  <strong>{selectedLibraryAsset.name}</strong>
                  <span>{selectedLibraryAsset.id}</span>
                  <small>{selectedLibraryAsset.outputRelativePath}</small>
                </div>
                <div className="panel-tip compact-tip">
                  <strong>Selected asset</strong>
                  <p>
                    {selectedLibraryAsset.category} • {selectedLibraryAsset.mode === 'video' ? 'Reopens as spritesheet editor' : selectedLibraryAsset.mode}
                    {selectedLibraryAsset.status === 'archived' ? ' • Archived' : ''}
                  </p>
                </div>
                <div className="asset-browser-actions library-actions">
                  <button type="button" className="primary-button" onClick={() => void handleLoadExistingAsset(selectedLibraryAsset)}>
                    <FilePenLine size={16} />
                    Edit selected
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handleArchiveToggle(selectedLibraryAsset)}>
                    <Archive size={16} />
                    {selectedLibraryAsset.status === 'archived' ? 'Restore' : 'Archive'}
                  </button>
                  <button type="button" className="secondary-button destructive-button" onClick={() => void handleDeleteAsset(selectedLibraryAsset)}>
                    <Trash2 size={16} />
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <div className="panel-tip compact-tip">
                <strong>No asset selected</strong>
                <p>Select a thumbnail from the gallery to inspect it and open actions.</p>
              </div>
            )}
          </section>
        </main>
      ) : (
        <>
      <section className="workflow-strip">
        {workflowSteps.map((step, index) => (
          <div key={step.label} className={`workflow-step ${step.complete ? 'complete' : ''}`}>
            <div className="workflow-index">{index + 1}</div>
            <div>
              <strong>{step.label}</strong>
              <p>{step.description}</p>
            </div>
          </div>
        ))}
      </section>

      <main className="workspace-grid">
        <section className="panel stack">
          <CollapsibleSection
            icon={<ImagePlus size={18} />}
            title="1. Import"
            subtitle={isTerrainView ? 'Load a prerendered hex terrain image.' : 'Load a source image or video.'}
            open={openSections.import}
            onToggle={() => setOpenSections((current) => ({ ...current, import: !current.import }))}
          >
            <label className="file-dropzone">
              <input
                type="file"
                accept={isTerrainView ? 'image/*' : 'image/*,video/*'}
                onChange={(event) => handleFileSelected(event.target.files?.[0] ?? null)}
              />
              <span>{selectedFile ? selectedFile.name : isTerrainView ? 'Choose terrain tile image' : 'Choose image or video'}</span>
              <small>{isTerrainView ? 'PNG, JPG, WebP, AVIF' : 'PNG, JPG, WebP, AVIF, MP4, MOV, WebM'}</small>
            </label>

            <div className="panel-tip">
              <strong>Recommended flow</strong>
              <p>Import a source, confirm the output size and preview, then save into the workspace. Download buttons are optional.</p>
            </div>

            <div className="info-grid compact">
              <InfoTile label="Source kind" value={sourceInfo?.kind ?? '—'} />
              <InfoTile label="File size" value={sourceInfo ? bytesToHuman(sourceInfo.sizeBytes) : '—'} />
              <InfoTile label="Source size" value={sourceInfo ? `${sourceInfo.width} × ${sourceInfo.height}` : '—'} />
              <InfoTile label="Duration" value={sourceInfo?.durationSeconds ? `${sourceInfo.durationSeconds.toFixed(1)}s` : '—'} />
              <InfoTile label="Backend" value={backendReady ? 'online' : 'offline'} />
              <InfoTile label="FFmpeg" value={ffmpegAvailable ? 'available' : 'unavailable'} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            icon={<Boxes size={18} />}
            title={isTerrainView ? '2. Terrain metadata' : '2. Asset metadata'}
            subtitle={isTerrainView ? 'Name the tile output and choose common processing flags.' : 'Name and classify the asset.'}
            open={openSections.metadata}
            onToggle={() => setOpenSections((current) => ({ ...current, metadata: !current.metadata }))}
            disabled={!hasSelectedSource}
          >
            <div className="field-grid">
            {isTerrainView ? (
              <div className="panel-tip compact-tip full-span">
                <strong>Generated naming</strong>
                <p>{draft.assetId} • {draft.displayName}</p>
              </div>
            ) : (
              <>
                <TextField label="Asset ID" value={draft.assetId} onChange={(value) => updateDraft(setDraft, 'assetId', sanitizeAssetId(value))} helper="snake_case ID used by runtime loaders" />
                <TextField label="Display name" value={draft.displayName} onChange={(value) => updateDraft(setDraft, 'displayName', value)} />
              </>
            )}
            {!isTerrainView ? (
              <>
                <SelectField label="Category" value={draft.category} options={CATEGORY_OPTIONS} onChange={(value) => updateDraft(setDraft, 'category', value as AssetCategory)} />
                <SelectField
                  label="Import mode"
                  value={draft.mode}
                  options={['image', 'spritesheet', 'video']}
                  onChange={(value) => {
                    const mode = value as AssetDraft['mode'];
                    setDraft((current) => {
                      const sourceSizing = sourceInfo
                        ? getSuggestedSizingForMode(mode, sourceInfo, current.columns, current.rows)
                        : null;
                      const nextExportWidth = sourceSizing?.exportWidth ?? current.exportWidth;
                      const nextExportHeight = sourceSizing?.exportHeight ?? current.exportHeight;
                      const displayWidth = current.displayWidth > 0 ? current.displayWidth : Math.min(nextExportWidth, 220);
                      const aspect = nextExportWidth > 0 ? nextExportHeight / nextExportWidth : 1;
                      const displayHeight = current.maintainAspectRatio
                        ? Math.max(1, Math.round(displayWidth * aspect))
                        : current.displayHeight;

                      return {
                        ...current,
                        mode,
                        category: mode === 'image' && current.category === 'animations' ? 'sprites' : inferCategoryFromMode(mode),
                        exportWidth: nextExportWidth,
                        exportHeight: nextExportHeight,
                        displayHeight,
                      };
                    });
                  }}
                />
              </>
            ) : (
              <div className="panel-tip compact-tip full-span">
                <strong>Terrain workflow locks the basics</strong>
                <p>Terrain imports are stored as single-image sprite assets so the core hex can stay aligned independently from protruding art.</p>
              </div>
            )}
            <SelectField label="Output format" value={draft.outputFormat} options={OUTPUT_FORMATS} onChange={(value) => updateDraft(setDraft, 'outputFormat', value as OutputFormat)} />
            <ToggleField label="Optimize for web" checked={draft.enableOptimization} onChange={(checked) => updateDraft(setDraft, 'enableOptimization', checked)} />
            <ToggleField label="Background removal" checked={draft.removeBackground} onChange={(checked) => updateDraft(setDraft, 'removeBackground', checked)} helper="Uses local corner-matte removal when processed by the backend." />
            <ToggleField label="Crop to bounding box" checked={draft.cropToBoundingBox} onChange={(checked) => updateDraft(setDraft, 'cropToBoundingBox', checked)} helper="Reads frame 0 content bounds after background removal and sets the display size to match. Does not alter the exported pixels." />
            <TextAreaField label="Notes" value={draft.notes} onChange={(value) => updateDraft(setDraft, 'notes', value)} />
            </div>
          </CollapsibleSection>

          {isTerrainView ? (
            <CollapsibleSection
              icon={<Hexagon size={18} />}
              title="3. Terrain tile setup"
              subtitle="Assign the terrain bucket, auto naming, and core hex metadata."
              open={openSections.terrain}
              onToggle={() => setOpenSections((current) => ({ ...current, terrain: !current.terrain }))}
              disabled={!hasSelectedSource}
            >
              <div className="field-grid two-column">
                <SelectField
                  label="Terrain type"
                  value={draft.terrainType || TERRAIN_TYPE_OPTIONS[0] || 'temperate_forest'}
                  options={TERRAIN_TYPE_OPTIONS}
                  onChange={(value) => updateDraft(setDraft, 'terrainType', value as TerrainType)}
                  helper="Uses the same biome buckets as the current procedural world map."
                />
                <TextField label="Atlas group" value={draft.terrainAtlasGroup} onChange={(value) => updateDraft(setDraft, 'terrainAtlasGroup', sanitizeAssetId(value))} helper="Grouping key for the future packed tileset pass." />
                <ToggleField label="Auto-generate ID/name" checked={draft.terrainAutoNaming} onChange={(checked) => updateDraft(setDraft, 'terrainAutoNaming', checked)} helper="Generates terrain_forest_01 style IDs from the catalog." />
                <ToggleField label="Mark for atlas build" checked={draft.terrainGenerateAtlas} onChange={(checked) => updateDraft(setDraft, 'terrainGenerateAtlas', checked)} helper="Stores atlas intent in the saved terrain metadata." />
                <NumberField label="Overlay squash" value={draft.terrainHexOverlay.squashY} min={0.35} max={0.95} step={0.01} onChange={(value) => setDraft((current) => ({ ...current, terrainHexOverlay: { ...current.terrainHexOverlay, squashY: clamp(value, 0.35, 0.95) } }))} />
              </div>
              <div className="summary-grid">
                <InfoTile label="Variant" value={String(draft.terrainVariant).padStart(2, '0')} />
                <InfoTile label="Core hex center" value={`${Math.round(draft.terrainHexOverlay.centerX * 100)}%, ${Math.round(draft.terrainHexOverlay.centerY * 100)}%`} />
                <InfoTile label="Core hex radius" value={`${Math.round(draft.terrainHexOverlay.radius * 100)}%`} />
                <InfoTile label="Overlay squash" value={draft.terrainHexOverlay.squashY.toFixed(2)} />
                <InfoTile label="Top overflow" value={`${Math.round(draft.terrainHexOverlay.topOverflow * 100)}%`} />
                <InfoTile label="Runtime display" value={`${draft.displayWidth} × ${draft.displayHeight}`} />
              </div>
              <div className="terrain-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setDraft((current) => ({ ...current, terrainHexOverlay: createTerrainDraft().terrainHexOverlay }))}
                >
                  <RefreshCw size={16} />
                  Reset hex overlay
                </button>
              </div>
              <div className="panel-tip compact-tip">
                <strong>Alignment rule</strong>
                <p>Align the flat-top hex to the core footprint only. Tall art above the tile, like trees, is recorded as overflow rather than changing the footprint.</p>
              </div>
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection
            icon={<Sparkles size={18} />}
            title={isTerrainView ? '4. Sizing' : '3. Sizing'}
            subtitle="Define output pixels and in-game footprint."
            open={openSections.sizing}
            onToggle={() => setOpenSections((current) => ({ ...current, sizing: !current.sizing }))}
            disabled={!hasSelectedSource}
          >
            <ToggleField
            label="Maintain aspect ratio"
            checked={draft.maintainAspectRatio}
            onChange={(checked) => {
              setDraft((current) => {
                if (!checked) {
                  return { ...current, maintainAspectRatio: false };
                }

                const ratio = getAssetAspectRatio(current, sourceInfo);
                return {
                  ...current,
                  maintainAspectRatio: true,
                  exportHeight: Math.max(1, Math.round(current.exportWidth * ratio)),
                  displayHeight: Math.max(1, Math.round(current.displayWidth * ratio)),
                };
              });
            }}
            helper={`Default on for sprite imports. Current ratio: 1:${currentAspectRatio.toFixed(3)}`}
            />
            <div className="field-grid two-column">
              {!isTerrainView ? <NumberField label="Export width" value={draft.exportWidth} min={1} onChange={(value) => handleSizedValueChange('export', 'width', value)} /> : null}
              {!isTerrainView ? <NumberField label="Export height" value={draft.exportHeight} min={1} onChange={(value) => handleSizedValueChange('export', 'height', value)} /> : null}
              {!isTerrainView ? <NumberField label="Display width" value={draft.displayWidth} min={1} onChange={(value) => handleSizedValueChange('display', 'width', value)} /> : null}
              {!isTerrainView ? <NumberField label="Display height" value={draft.displayHeight} min={1} onChange={(value) => handleSizedValueChange('display', 'height', value)} /> : null}
              <SelectField
                label="Resize fit"
                value={draft.resizeFit}
                options={RESIZE_FIT_OPTIONS}
                onChange={(value) => updateDraft(setDraft, 'resizeFit', value as ResizeFitMode)}
                helper="Contain keeps the full frame, cover fills and crops, fill stretches to fit."
              />
            </div>
            {isTerrainView ? (
              <>
                <div className="summary-grid">
                  <InfoTile label="Saved tile size" value={`${TARGET_TERRAIN_OUTPUT_WIDTH} × ${TARGET_TERRAIN_OUTPUT_HEIGHT}`} />
                  <InfoTile label="Core hex width" value={`${TARGET_TERRAIN_CORE_WIDTH}px`} />
                  <InfoTile label="Runtime display" value={`${draft.displayWidth} × ${draft.displayHeight}`} />
                  <InfoTile label="Game squash" value={TARGET_TERRAIN_HEX_SQUASH.toFixed(2)} />
                </div>
                <p className="helper-text">{`Terrain exports are standardized to a fixed ${TARGET_TERRAIN_OUTPUT_WIDTH} × ${TARGET_TERRAIN_OUTPUT_HEIGHT} raster. The overlay is used to warp each source into the shared game hex shape.`}</p>
              </>
            ) : null}
          </CollapsibleSection>

          {(draft.mode === 'spritesheet' || draft.mode === 'video') && (
            <CollapsibleSection
              icon={<Film size={18} />}
              title="4. Animation setup"
              subtitle="Grid, origin, hitbox, and playback."
              open={openSections.animation}
              onToggle={() => setOpenSections((current) => ({ ...current, animation: !current.animation }))}
            >
              <div className="field-grid two-column">
                <NumberField label="Columns" value={draft.columns} min={1} onChange={(value) => handleGridChange('columns', value)} />
                <NumberField label="Rows" value={draft.rows} min={1} onChange={(value) => handleGridChange('rows', value)} />
                <NumberField label="Frame rate" value={draft.frameRate} min={1} onChange={(value) => updateDraft(setDraft, 'frameRate', value)} />
                <SelectField label="Animation type" value={draft.animationType} options={ANIMATION_TYPES} onChange={(value) => updateDraft(setDraft, 'animationType', value as AnimationType)} />
                <NumberField label="Origin X" value={draft.origin.x} min={0} max={1} step={0.05} onChange={(value) => setDraft((current) => ({ ...current, origin: { ...current.origin, x: value } }))} />
                <NumberField label="Origin Y" value={draft.origin.y} min={0} max={1} step={0.05} onChange={(value) => setDraft((current) => ({ ...current, origin: { ...current.origin, y: value } }))} />
              </div>
              <div className="field-grid two-column">
                <NumberField label="Hitbox X" value={draft.collisionBox.x} min={0} onChange={(value) => setDraft((current) => ({ ...current, collisionBox: { ...current.collisionBox, x: value } }))} />
                <NumberField label="Hitbox Y" value={draft.collisionBox.y} min={0} onChange={(value) => setDraft((current) => ({ ...current, collisionBox: { ...current.collisionBox, y: value } }))} />
                <NumberField label="Hitbox width" value={draft.collisionBox.width} min={1} onChange={(value) => setDraft((current) => ({ ...current, collisionBox: { ...current.collisionBox, width: value } }))} />
                <NumberField label="Hitbox height" value={draft.collisionBox.height} min={1} onChange={(value) => setDraft((current) => ({ ...current, collisionBox: { ...current.collisionBox, height: value } }))} />
              </div>
            </CollapsibleSection>
          )}

          {draft.mode === 'video' && (
            <CollapsibleSection
              icon={<Clapperboard size={18} />}
              title="5. Video extraction"
              subtitle="Define the future spritesheet job."
              open={openSections.video}
              onToggle={() => setOpenSections((current) => ({ ...current, video: !current.video }))}
            >
              <div className="field-grid two-column">
                <NumberField label="Trim start (s)" value={draft.trimStartSeconds} min={0} step={0.1} onChange={(value) => updateDraft(setDraft, 'trimStartSeconds', value)} />
                <NumberField label="Trim end (s)" value={draft.trimEndSeconds} min={0} step={0.1} onChange={(value) => updateDraft(setDraft, 'trimEndSeconds', value)} />
                <SelectField
                  label="Frame sampling"
                  value={draft.videoSampling}
                  options={VIDEO_SAMPLING_OPTIONS}
                  onChange={(value) => updateDraft(setDraft, 'videoSampling', value as VideoSamplingMode)}
                  helper="Spread samples across the clip. Sequential takes the earliest frames in order."
                />
                <SelectField
                  label="Frame fit"
                  value={draft.resizeFit}
                  options={RESIZE_FIT_OPTIONS}
                  onChange={(value) => updateDraft(setDraft, 'resizeFit', value as ResizeFitMode)}
                  helper="Choose whether each extracted frame should pad, crop, or stretch into the target cell."
                />
              </div>
              <p className="helper-text">
                The backend will extract {draft.columns * draft.rows} frames at up to {draft.frameRate} fps, then build a {draft.columns} × {draft.rows} spritesheet using {draft.videoSampling} sampling and {draft.resizeFit} fit.
              </p>
            </CollapsibleSection>
          )}
        </section>

        <section className="panel preview-panel">
          <PanelHeader icon={<ScanLine size={18} />} title={isTerrainView ? 'Terrain alignment preview' : 'Preview'} subtitle={isTerrainView ? 'Position the core hex over the prerendered terrain tile.' : 'Grounded animation, origin, and hitbox visualization.'} />
          <div className="panel-tip compact-tip">
            <strong>Interactive preview</strong>
            <p>{isTerrainView ? 'Drag inside the hex to move it, drag the right handle to resize it, drag the purple top vertex to squash the overlay perspective, and drag the red line handle to record art overflow above the core hex.' : 'Drag the green origin handle or move/resize the orange collision box directly in the preview.'}</p>
          </div>
          {isTerrainView ? (
            <TerrainPreviewCanvas
              draft={draft}
              previewImage={previewImage}
              previewSourceOverride={null}
              onDraftChange={setDraft}
            />
          ) : (
            <PreviewCanvas
              draft={draft}
              previewImage={previewImage}
              sourceInfo={draft.mode === 'video' ? videoPreviewInfo : sourceInfo}
              previewSourceOverride={draft.mode === 'video' ? videoPreviewSheet : null}
              isPreparingVideoPreview={draft.mode === 'video' && isPreparingVideoPreview}
              onDraftChange={setDraft}
            />
          )}
          {isTerrainView ? (
            <>
              <div className="panel-tip compact-tip">
                <strong>Normalized output preview</strong>
                <p>This shows the fixed-size saved tile after the overlay is corrected to the in-game hex shape.</p>
              </div>
              <TerrainNormalizedPreviewCanvas
                draft={draft}
                previewImage={previewImage}
                previewSourceOverride={null}
              />
            </>
          ) : null}
          <div className="preview-legend">
            {isTerrainView ? (
              <>
                <LegendSwatch color="rgba(255, 194, 92, 0.95)" label="Core hex outline" />
                <LegendSwatch color="rgba(100, 235, 195, 0.95)" label="Core anchor" />
                <LegendSwatch color="rgba(134, 146, 255, 0.95)" label="Perspective squash" />
                <LegendSwatch color="rgba(255, 126, 126, 0.95)" label="Overflow cap" />
              </>
            ) : (
              <>
                <LegendSwatch color="rgba(88, 228, 157, 0.9)" label="Origin point" />
                <LegendSwatch color="rgba(255, 127, 80, 0.9)" label="Collision box" />
                <LegendSwatch color="rgba(126, 198, 255, 0.9)" label="Frame bounds" />
              </>
            )}
          </div>
        </section>

        <section className="panel stack">
          <PanelHeader icon={<WandSparkles size={18} />} title="Save" subtitle="When the preview looks right, save the asset into the workspace." />
          <div className="summary-card">
            <span className="summary-label">Destination</span>
            <strong>{outputPath}</strong>
            <span className="summary-label">Manifest row preview</span>
            <code className="manifest-preview">{manifestRow}</code>
          </div>

          <div className="summary-grid">
            <InfoTile label="Output folder" value={getDraftOutputPath(draft)} />
            <InfoTile label="Runtime display" value={`${draft.displayWidth} × ${draft.displayHeight}`} />
            <InfoTile label="Export raster" value={`${draft.exportWidth} × ${draft.exportHeight}`} />
            <InfoTile label={isTerrainView ? 'Terrain type' : 'Animation'} value={isTerrainView ? (draft.terrainType ? humanizeTerrainType(draft.terrainType) : 'Unassigned') : draft.mode === 'image' ? 'N/A' : `${draft.animationType} @ ${draft.frameRate} fps`} />
          </div>

          {selectedCatalogAsset ? (
            <div className="panel-tip compact-tip">
              <strong>Editing existing asset</strong>
              <p>
                {selectedCatalogAsset.name} is loaded from {selectedCatalogAsset.outputRelativePath}. Use metadata-only save for metadata, naming, layout, and catalog changes without reprocessing the source.
              </p>
            </div>
          ) : null}

          {saveState !== 'idle' ? (
            <div className={`save-feedback save-feedback-${saveState}`}>
              {saveState === 'success' ? <CircleCheckBig size={18} /> : <WandSparkles size={18} />}
              <div>
                <strong>
                  {saveState === 'saving'
                    ? 'Saving asset…'
                    : saveState === 'success'
                      ? 'Asset saved'
                      : 'Save failed'}
                </strong>
                <p>
                  {saveState === 'saving'
                    ? 'Processing files and updating metadata in the workspace.'
                    : saveState === 'success'
                      ? savedAsset?.outputRelativePath ?? 'The asset and metadata were written to the workspace.'
                      : 'Check the status bar for the failure reason, then try again.'}
                </p>
              </div>
            </div>
          ) : null}

          <div className="export-actions">
            <button className="primary-button" onClick={handleSaveToWorkspace} disabled={!canProcessToWorkspace || !backendReady || saveState === 'saving'}>
              <WandSparkles size={16} />
              {saveState === 'saving'
                ? 'Saving…'
                : draft.mode === 'video'
                  ? 'Save spritesheet to workspace'
                  : 'Save to workspace'}
            </button>
            <button className="secondary-button" onClick={handleMetadataOnlySave} disabled={!selectedCatalogAsset || saveState === 'saving'}>
              <FilePenLine size={16} />
              Save metadata only
            </button>
          </div>

          <div className="panel-tip compact-tip">
            <strong>Next action</strong>
            <p>
              {!hasSelectedSource
                ? 'Import a source file to unlock processing and downloads.'
                : !backendReady
                  ? 'Start the asset manager with npm run asset-manager:start, then save directly into the repo.'
                  : isTerrainView && !draft.terrainType
                    ? 'Assign a terrain type so the generated filename and terrain metadata are ready.'
                  : draft.mode === 'video' && !ffmpegAvailable
                    ? 'FFmpeg is unavailable, so video processing is disabled.'
                    : 'Preview looks good — use Save to workspace.'}
            </p>
          </div>

          <details className="advanced-actions">
            <summary>Advanced export options</summary>
            <div className="advanced-actions-body">
              <button className="secondary-button" onClick={handleRasterExport} disabled={!canExportRaster}>
                <Download size={16} />
                Download processed raster
              </button>
              <button className="secondary-button" onClick={handleMetadataDownload} disabled={!hasSelectedSource}>
                <Download size={16} />
                Download metadata JSON
              </button>
              <button className="secondary-button" onClick={handleManifestDownload} disabled={!hasSelectedSource}>
                <Download size={16} />
                Download manifest preview
              </button>
            </div>
          </details>

          {savedAsset ? (
            <div className="summary-card">
              <span className="summary-label">Saved asset</span>
              <strong>{savedAsset.outputRelativePath}</strong>
              <span className="summary-label">Metadata</span>
              <div>{savedAsset.metadataRelativePath}</div>
              <span className="summary-label">Generated manifest</span>
              <div>{savedAsset.manifestRelativePath}</div>
              <span className="summary-label">Processing notes</span>
              <ul className="notes-list">
                {savedAsset.notes.length > 0 ? savedAsset.notes.map((note) => <li key={note}>{note}</li>) : <li>No extra notes.</li>}
              </ul>
            </div>
          ) : null}
        </section>
      </main>
      </>
      )}

      <footer className="status-bar">
        <span>{status}</span>
        <span>
          {backendReady ? 'Backend online.' : 'Backend offline.'}
          {draft.removeBackground ? ' Background removal requested.' : ' Background removal disabled.'}
          {isTerrainView && draft.terrainType ? ` Terrain type: ${humanizeTerrainType(draft.terrainType)}.` : ''}
        </span>
      </footer>
    </div>
  );
}

function TerrainPreviewCanvas({
  draft,
  previewImage,
  previewSourceOverride,
  onDraftChange,
}: {
  draft: AssetDraft;
  previewImage: HTMLImageElement | null;
  previewSourceOverride: HTMLCanvasElement | null;
  onDraftChange: Dispatch<SetStateAction<AssetDraft>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewSource, setPreviewSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  const sceneRef = useRef({ drawX: 0, drawY: 0, drawWidth: 1, drawHeight: 1 });
  const interactionRef = useRef<{
    mode: 'move' | 'resize' | 'squash' | 'overflow' | null;
    pointerOffsetX: number;
    pointerOffsetY: number;
  }>({ mode: null, pointerOffsetX: 0, pointerOffsetY: 0 });

  useEffect(() => {
    let cancelled = false;

    async function preparePreview(): Promise<void> {
      if (previewSourceOverride) {
        setPreviewSource(previewSourceOverride);
        return;
      }

      if (!previewImage) {
        setPreviewSource(null);
        return;
      }

      if (!draft.removeBackground) {
        setPreviewSource(previewImage);
        return;
      }

      const processed = await createBackgroundRemovedCanvas(previewImage);
      if (!cancelled) {
        setPreviewSource(processed);
      }
    }

    void preparePreview();
    return () => {
      cancelled = true;
    };
  }, [draft.removeBackground, previewImage, previewSourceOverride]);

  useEffect(() => {
    let frameId = 0;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const render = (): void => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#09101d';
      ctx.fillRect(0, 0, width, height);

      const padding = 28 * dpr;
      let drawX = padding;
      let drawY = padding;
      let drawWidth = width - padding * 2;
      let drawHeight = height - padding * 2;

      if (previewSource) {
        const sourceWidth = previewSource instanceof HTMLCanvasElement ? previewSource.width : previewSource.naturalWidth;
        const sourceHeight = previewSource instanceof HTMLCanvasElement ? previewSource.height : previewSource.naturalHeight;
        const scale = Math.min((width - padding * 2) / Math.max(1, sourceWidth), (height - padding * 2) / Math.max(1, sourceHeight));
        drawWidth = Math.max(1, sourceWidth * scale);
        drawHeight = Math.max(1, sourceHeight * scale);
        drawX = (width - drawWidth) / 2;
        drawY = (height - drawHeight) / 2;

        ctx.drawImage(previewSource, drawX, drawY, drawWidth, drawHeight);
        sceneRef.current = { drawX, drawY, drawWidth, drawHeight };

        const centerX = drawX + draft.terrainHexOverlay.centerX * drawWidth;
        const centerY = drawY + draft.terrainHexOverlay.centerY * drawHeight;
        const radius = Math.max(12 * dpr, draft.terrainHexOverlay.radius * drawWidth);
        const squashY = draft.terrainHexOverlay.squashY;
        const topOverflow = Math.max(0, draft.terrainHexOverlay.topOverflow * drawHeight);
        const hexPoints = getFlatTopHexPoints(centerX, centerY, radius, squashY);
        const hexHalfHeight = Math.sin(Math.PI / 3) * radius * squashY;
        const overflowY = centerY - hexHalfHeight - topOverflow;
        const squashHandleY = centerY - hexHalfHeight;

        ctx.fillStyle = 'rgba(255, 194, 92, 0.14)';
        ctx.beginPath();
        ctx.moveTo(hexPoints[0]!.x, hexPoints[0]!.y);
        for (const point of hexPoints.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.closePath();
        ctx.fill();

        ctx.setLineDash([10 * dpr, 8 * dpr]);
        ctx.strokeStyle = 'rgba(255, 194, 92, 0.96)';
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgba(255, 126, 126, 0.95)';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(centerX - radius * 0.85, overflowY);
        ctx.lineTo(centerX + radius * 0.85, overflowY);
        ctx.stroke();

        ctx.fillStyle = 'rgba(100, 235, 195, 0.98)';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 194, 92, 0.98)';
        ctx.beginPath();
        ctx.arc(centerX + radius, centerY, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 126, 126, 0.98)';
        ctx.beginPath();
        ctx.arc(centerX, overflowY, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(134, 146, 255, 0.98)';
        ctx.beginPath();
        ctx.arc(centerX, squashHandleY, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(210, 221, 255, 0.72)';
        ctx.font = `${16 * dpr}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Import a terrain image to align the core hex.', width / 2, height / 2);
      }

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, [draft.terrainHexOverlay, previewSource]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const pointerToCanvas = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / Math.max(1, rect.width);
      const scaleY = canvas.height / Math.max(1, rect.height);
      return {
        x: (event.clientX - rect.left) * scaleX,
        y: (event.clientY - rect.top) * scaleY,
      };
    };

    const onPointerDown = (event: PointerEvent): void => {
      const { drawX, drawY, drawWidth, drawHeight } = sceneRef.current;
      if (drawWidth <= 1 || drawHeight <= 1) return;

      const point = pointerToCanvas(event);
      const centerX = drawX + draft.terrainHexOverlay.centerX * drawWidth;
      const centerY = drawY + draft.terrainHexOverlay.centerY * drawHeight;
      const radius = Math.max(1, draft.terrainHexOverlay.radius * drawWidth);
      const squashY = draft.terrainHexOverlay.squashY;
      const hexHalfHeight = Math.sin(Math.PI / 3) * radius * squashY;
      const overflowY = centerY - hexHalfHeight - draft.terrainHexOverlay.topOverflow * drawHeight;
      const squashHandleY = centerY - hexHalfHeight;
      const movePoints = getFlatTopHexPoints(centerX, centerY, radius, squashY);
      const hitRadius = 14 * (window.devicePixelRatio || 1);

      if (distance(point.x, point.y, centerX + radius, centerY) <= hitRadius) {
        interactionRef.current = { mode: 'resize', pointerOffsetX: 0, pointerOffsetY: 0 };
      } else if (distance(point.x, point.y, centerX, squashHandleY) <= hitRadius) {
        interactionRef.current = { mode: 'squash', pointerOffsetX: 0, pointerOffsetY: 0 };
      } else if (distance(point.x, point.y, centerX, overflowY) <= hitRadius) {
        interactionRef.current = { mode: 'overflow', pointerOffsetX: 0, pointerOffsetY: 0 };
      } else if (isPointInsidePolygon(point, movePoints)) {
        interactionRef.current = { mode: 'move', pointerOffsetX: point.x - centerX, pointerOffsetY: point.y - centerY };
      } else {
        interactionRef.current = { mode: null, pointerOffsetX: 0, pointerOffsetY: 0 };
        return;
      }

      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      const { mode, pointerOffsetX, pointerOffsetY } = interactionRef.current;
      if (!mode) return;

      const { drawX, drawY, drawWidth, drawHeight } = sceneRef.current;
      const point = pointerToCanvas(event);

      onDraftChange((current) => {
        const nextOverlay = { ...current.terrainHexOverlay };
        const centerX = drawX + current.terrainHexOverlay.centerX * drawWidth;
        const centerY = drawY + current.terrainHexOverlay.centerY * drawHeight;
        const radius = Math.max(1, current.terrainHexOverlay.radius * drawWidth);

        if (mode === 'move') {
          nextOverlay.centerX = clamp((point.x - pointerOffsetX - drawX) / Math.max(1, drawWidth), 0.05, 0.95);
          nextOverlay.centerY = clamp((point.y - pointerOffsetY - drawY) / Math.max(1, drawHeight), 0.05, 0.95);
        } else if (mode === 'resize') {
          nextOverlay.radius = clamp((point.x - centerX) / Math.max(1, drawWidth), 0.08, 0.48);
        } else if (mode === 'squash') {
          nextOverlay.squashY = clamp((centerY - point.y) / Math.max(1, Math.sin(Math.PI / 3) * radius), 0.35, 0.95);
        } else if (mode === 'overflow') {
          const coreTopY = centerY - Math.sin(Math.PI / 3) * radius * current.terrainHexOverlay.squashY;
          nextOverlay.topOverflow = clamp((coreTopY - point.y) / Math.max(1, drawHeight), 0, 0.5);
        }

        return { ...current, terrainHexOverlay: nextOverlay };
      });
    };

    const endInteraction = (event?: PointerEvent): void => {
      if (event && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      interactionRef.current = { mode: null, pointerOffsetX: 0, pointerOffsetY: 0 };
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endInteraction);
    canvas.addEventListener('pointerleave', endInteraction);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endInteraction);
      canvas.removeEventListener('pointerleave', endInteraction);
    };
  }, [draft.terrainHexOverlay, onDraftChange]);

  return <canvas ref={canvasRef} className="preview-canvas terrain-preview-canvas" />;
}

function TerrainNormalizedPreviewCanvas({
  draft,
  previewImage,
  previewSourceOverride,
}: {
  draft: AssetDraft;
  previewImage: HTMLImageElement | null;
  previewSourceOverride: HTMLCanvasElement | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewSource, setPreviewSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function preparePreview(): Promise<void> {
      if (previewSourceOverride) {
        setPreviewSource(previewSourceOverride);
        return;
      }

      if (!previewImage) {
        setPreviewSource(null);
        return;
      }

      if (!draft.removeBackground) {
        setPreviewSource(previewImage);
        return;
      }

      const processed = await createBackgroundRemovedCanvas(previewImage);
      if (!cancelled) {
        setPreviewSource(processed);
      }
    }

    void preparePreview();
    return () => {
      cancelled = true;
    };
  }, [draft.removeBackground, previewImage, previewSourceOverride]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#09101d';
    ctx.fillRect(0, 0, width, height);

    if (!previewSource) {
      ctx.fillStyle = 'rgba(210, 221, 255, 0.72)';
      ctx.font = `${16 * dpr}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Normalized saved tile preview will appear here.', width / 2, height / 2);
      return;
    }

    const offscreen = createNormalizedTerrainPreviewCanvas(previewSource, draft);
    const padding = 28 * dpr;
    const scale = Math.min((width - padding * 2) / offscreen.width, (height - padding * 2) / offscreen.height);
    const drawWidth = offscreen.width * scale;
    const drawHeight = offscreen.height * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;

    ctx.drawImage(offscreen, drawX, drawY, drawWidth, drawHeight);

    const overlay = getNormalizedTerrainOverlay(draft);
    const centerX = drawX + overlay.centerX * drawWidth;
    const centerY = drawY + overlay.centerY * drawHeight;
    const radius = overlay.radius * drawWidth;
    const points = getFlatTopHexPoints(centerX, centerY, radius, overlay.squashY);
    ctx.setLineDash([10 * dpr, 8 * dpr]);
    ctx.strokeStyle = 'rgba(88, 228, 157, 0.95)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }, [draft, previewSource]);

  return <canvas ref={canvasRef} className="preview-canvas terrain-normalized-preview-canvas" />;
}

function PreviewCanvas({
  draft,
  previewImage,
  sourceInfo,
  previewSourceOverride,
  isPreparingVideoPreview,
  onDraftChange,
}: {
  draft: AssetDraft;
  previewImage: HTMLImageElement | null;
  sourceInfo: SourceInfo | null;
  previewSourceOverride: HTMLCanvasElement | null;
  isPreparingVideoPreview: boolean;
  onDraftChange: Dispatch<SetStateAction<AssetDraft>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionRef = useRef<{
    mode: 'origin' | 'collision-move' | 'collision-resize' | null;
    pointerOffsetX: number;
    pointerOffsetY: number;
    pendingOrigin: { x: number; y: number } | null;
  }>({ mode: null, pointerOffsetX: 0, pointerOffsetY: 0, pendingOrigin: null });
  const sceneRef = useRef({
    drawX: 0,
    drawY: 0,
    displayWidth: 1,
    displayHeight: 1,
    groundY: 0,
    originX: 0,
    originY: 0,
    collisionX: 0,
    collisionY: 0,
    collisionWidth: 0,
    collisionHeight: 0,
    resizeHandleX: 0,
    resizeHandleY: 0,
  });
  const [previewSource, setPreviewSource] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function preparePreview(): Promise<void> {
      if (previewSourceOverride) {
        if (draft.cropToBoundingBox) {
          const frameW = Math.floor(previewSourceOverride.width / Math.max(1, draft.columns));
          const frameH = Math.floor(previewSourceOverride.height / Math.max(1, draft.rows));
          const frame = document.createElement('canvas');
          frame.width = frameW;
          frame.height = frameH;
          const fc = frame.getContext('2d');
          if (fc) fc.drawImage(previewSourceOverride, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
          const tight = cropCanvasToBoundingBox(frame);
          if (tight.width > 0 && tight.height > 0 && !cancelled) {
            onDraftChange((current) => ({ ...current, displayWidth: tight.width, displayHeight: tight.height }));
          }
        }
        setPreviewSource(previewSourceOverride);
        return;
      }

      if (!previewImage) {
        setPreviewSource(null);
        return;
      }

      if (!draft.removeBackground && !draft.cropToBoundingBox) {
        setPreviewSource(previewImage);
        return;
      }

      let processed: HTMLCanvasElement;
      if (draft.removeBackground) {
        processed = await createBackgroundRemovedCanvas(previewImage);
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = previewImage.naturalWidth;
        canvas.height = previewImage.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.drawImage(previewImage, 0, 0);
        processed = canvas;
      }

      if (draft.cropToBoundingBox) {
        const cols = draft.mode === 'image' ? 1 : Math.max(1, draft.columns);
        const rowCount = draft.mode === 'image' ? 1 : Math.max(1, draft.rows);
        const frameW = Math.floor(processed.width / cols);
        const frameH = Math.floor(processed.height / rowCount);
        const frame = document.createElement('canvas');
        frame.width = frameW;
        frame.height = frameH;
        const fc = frame.getContext('2d');
        if (fc) fc.drawImage(processed, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
        const tight = cropCanvasToBoundingBox(frame);
        if (tight.width > 0 && tight.height > 0 && !cancelled) {
          onDraftChange((current) => ({ ...current, displayWidth: tight.width, displayHeight: tight.height }));
        }
      }

      if (!cancelled) {
        setPreviewSource(processed);
      }
    }

    void preparePreview();
    return () => {
      cancelled = true;
    };
  }, [previewImage, previewSourceOverride, draft.removeBackground, draft.cropToBoundingBox, draft.mode, draft.columns, draft.rows]);

  useEffect(() => {
    let frameId = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const draw = (timestamp: number) => {
      const width = canvas.width;
      const height = canvas.height;
      const groundY = height - 88;
      context.clearRect(0, 0, width, height);

      const skyGradient = context.createLinearGradient(0, 0, 0, height);
      skyGradient.addColorStop(0, '#1d2742');
      skyGradient.addColorStop(1, '#0d1324');
      context.fillStyle = skyGradient;
      context.fillRect(0, 0, width, height);

      context.fillStyle = '#1f3f2f';
      context.fillRect(0, groundY, width, height - groundY);
      context.strokeStyle = 'rgba(118, 242, 151, 0.55)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(0, groundY);
      context.lineTo(width, groundY);
      context.stroke();

      context.fillStyle = 'rgba(255,255,255,0.68)';
      context.font = '13px Inter, sans-serif';
      context.fillText('Ground plane', 20, groundY - 10);

      if (!previewSource || !sourceInfo || sourceInfo.kind !== 'image') {
        context.fillStyle = 'rgba(255,255,255,0.86)';
        context.font = '16px Inter, sans-serif';
        context.fillText(
          isPreparingVideoPreview ? 'Generating spritesheet preview from video…' : 'Load an image or spritesheet to preview grounding.',
          22,
          34,
        );
        frameId = requestAnimationFrame(draw);
        return;
      }

      const activeOrigin = interactionRef.current.mode === 'origin' && interactionRef.current.pendingOrigin
        ? interactionRef.current.pendingOrigin
        : draft.origin;
      const centerX = width * 0.5;
      const displayWidth = Math.max(1, draft.displayWidth);
      const displayHeight = Math.max(1, draft.displayHeight);
      const drawX = centerX - displayWidth * draft.origin.x;
      const drawY = groundY - displayHeight * draft.origin.y;
      const previewOriginX = drawX + displayWidth * activeOrigin.x;
      const previewOriginY = drawY + displayHeight * activeOrigin.y;

      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = sourceInfo.width;
      let sourceHeight = sourceInfo.height;
      let frameIndex = 0;

      if (draft.mode !== 'image') {
        const columns = Math.max(1, draft.columns);
        const rows = Math.max(1, draft.rows);
        const totalFrames = Math.max(1, columns * rows);
        frameIndex = Math.floor((timestamp / 1000) * Math.max(1, draft.frameRate)) % totalFrames;
        sourceWidth = sourceInfo.width / columns;
        sourceHeight = sourceInfo.height / rows;
        sourceX = (frameIndex % columns) * sourceWidth;
        sourceY = Math.floor(frameIndex / columns) * sourceHeight;
      }

      context.save();
      context.drawImage(previewSource, sourceX, sourceY, sourceWidth, sourceHeight, drawX, drawY, displayWidth, displayHeight);

      context.setLineDash([8, 6]);
      context.strokeStyle = 'rgba(126, 198, 255, 0.9)';
      context.strokeRect(drawX, drawY, displayWidth, displayHeight);
      context.setLineDash([]);

      const collisionX = drawX + draft.collisionBox.x;
      const collisionY = drawY + draft.collisionBox.y;
      context.strokeStyle = 'rgba(255, 127, 80, 0.9)';
      context.lineWidth = 2;
      context.strokeRect(collisionX, collisionY, draft.collisionBox.width, draft.collisionBox.height);
      context.fillStyle = 'rgba(255, 127, 80, 0.95)';
      context.fillRect(
        collisionX + draft.collisionBox.width - 6,
        collisionY + draft.collisionBox.height - 6,
        12,
        12,
      );

      context.fillStyle = 'rgba(88, 228, 157, 0.95)';
      context.beginPath();
      context.arc(previewOriginX, previewOriginY, 5, 0, Math.PI * 2);
      context.fill();

      context.strokeStyle = 'rgba(88, 228, 157, 0.95)';
      context.beginPath();
      context.moveTo(previewOriginX, previewOriginY - 16);
      context.lineTo(previewOriginX, previewOriginY + 16);
      context.moveTo(previewOriginX - 16, previewOriginY);
      context.lineTo(previewOriginX + 16, previewOriginY);
      context.stroke();

      context.fillStyle = 'rgba(255,255,255,0.88)';
      context.font = '13px Inter, sans-serif';
      context.fillText(`Origin (${activeOrigin.x.toFixed(2)}, ${activeOrigin.y.toFixed(2)})`, 20, 34);
      context.fillText(`Display ${displayWidth}×${displayHeight}`, 20, 56);
      context.fillText(`Collision ${draft.collisionBox.width}×${draft.collisionBox.height}`, 20, 78);
      if (draft.mode !== 'image') {
        context.fillText(`Frame ${frameIndex + 1}/${Math.max(1, draft.columns * draft.rows)} • ${draft.frameRate} fps`, 20, 100);
      }

      sceneRef.current = {
        drawX,
        drawY,
        displayWidth,
        displayHeight,
        groundY,
        originX: previewOriginX,
        originY: previewOriginY,
        collisionX,
        collisionY,
        collisionWidth: draft.collisionBox.width,
        collisionHeight: draft.collisionBox.height,
        resizeHandleX: collisionX + draft.collisionBox.width,
        resizeHandleY: collisionY + draft.collisionBox.height,
      };

      context.restore();
      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [draft, previewSource, sourceInfo, isPreparingVideoPreview]);

  function getCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = event.currentTarget.width / rect.width;
    const scaleY = event.currentTarget.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    const point = getCanvasPoint(event);
    const scene = sceneRef.current;
    const resizeDistance = Math.hypot(point.x - scene.resizeHandleX, point.y - scene.resizeHandleY);
    const originDistance = Math.hypot(point.x - scene.originX, point.y - scene.originY);

    if (resizeDistance <= 18) {
      interactionRef.current = { mode: 'collision-resize', pointerOffsetX: 0, pointerOffsetY: 0, pendingOrigin: null };
    } else if (originDistance <= 24) {
      // Origin interaction gets priority over hitbox dragging so it remains
      // reachable even when the marker sits inside the collision box.
      interactionRef.current = { mode: 'origin', pointerOffsetX: 0, pointerOffsetY: 0, pendingOrigin: { ...draft.origin } };
    } else if (
      point.x >= scene.collisionX && point.x <= scene.collisionX + scene.collisionWidth
      && point.y >= scene.collisionY && point.y <= scene.collisionY + scene.collisionHeight
    ) {
      interactionRef.current = {
        mode: 'collision-move',
        pointerOffsetX: point.x - scene.collisionX,
        pointerOffsetY: point.y - scene.collisionY,
        pendingOrigin: null,
      };
    } else {
      interactionRef.current = { mode: null, pointerOffsetX: 0, pointerOffsetY: 0, pendingOrigin: null };
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const interaction = interactionRef.current;
    if (!interaction.mode) return;

    const point = getCanvasPoint(event);
    const scene = sceneRef.current;

    if (interaction.mode === 'origin') {
      const nextOriginX = clamp((point.x - scene.drawX) / scene.displayWidth, 0, 1);
      const nextOriginY = clamp((point.y - scene.drawY) / scene.displayHeight, 0, 1);
      interactionRef.current = {
        ...interactionRef.current,
        pendingOrigin: { x: round2(nextOriginX), y: round2(nextOriginY) },
      };
      return;
    }

    if (interaction.mode === 'collision-move') {
      const nextX = clamp(point.x - scene.drawX - interaction.pointerOffsetX, 0, Math.max(0, scene.displayWidth - draft.collisionBox.width));
      const nextY = clamp(point.y - scene.drawY - interaction.pointerOffsetY, 0, Math.max(0, scene.displayHeight - draft.collisionBox.height));
      onDraftChange((current) => ({
        ...current,
        collisionBox: {
          ...current.collisionBox,
          x: Math.round(nextX),
          y: Math.round(nextY),
        },
      }));
      return;
    }

    const nextWidth = clamp(point.x - scene.collisionX, 8, scene.displayWidth - draft.collisionBox.x);
    const nextHeight = clamp(point.y - scene.collisionY, 8, scene.displayHeight - draft.collisionBox.y);
    onDraftChange((current) => ({
      ...current,
      collisionBox: {
        ...current.collisionBox,
        width: Math.round(nextWidth),
        height: Math.round(nextHeight),
      },
    }));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const interaction = interactionRef.current;
    if (interaction.mode === 'origin' && interaction.pendingOrigin) {
      const committedOrigin = interaction.pendingOrigin;
      onDraftChange((current) => ({
        ...current,
        origin: committedOrigin,
      }));
    }
    interactionRef.current = { mode: null, pointerOffsetX: 0, pointerOffsetY: 0, pendingOrigin: null };
  }

  return (
    <canvas
      ref={canvasRef}
      className="preview-canvas"
      width={760}
      height={440}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    />
  );
}

function PanelHeader({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="panel-header">
      <div className="panel-icon">{icon}</div>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function CollapsibleSection({
  icon,
  title,
  subtitle,
  open,
  onToggle,
  disabled,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`collapsible-section ${disabled ? 'disabled' : ''}`}>
      <button type="button" className="collapsible-trigger" onClick={onToggle} disabled={disabled}>
        <div className="collapsible-heading">
          <PanelHeader icon={icon} title={title} subtitle={subtitle} />
          {disabled ? <span className="section-lock-note">Import a source to unlock</span> : null}
        </div>
        <ChevronDown size={18} className={`collapsible-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && !disabled ? <div className="collapsible-body">{children}</div> : null}
    </section>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TextField({ label, value, onChange, helper }: { label: string; value: string; onChange: (value: string) => void; helper?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

function TextAreaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field full-span">
      <span>{label}</span>
      <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  helper,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  helper?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {helper ? <small>{helper}</small> : null}
    </label>
  );
}

function ToggleField({ label, checked, onChange, helper }: { label: string; checked: boolean; onChange: (value: boolean) => void; helper?: string }) {
  return (
    <label className="toggle-field">
      <div className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {helper ? <small className="toggle-helper">{helper}</small> : null}
      </div>
      <button type="button" className={`toggle ${checked ? 'on' : 'off'}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="legend-item">
      <span className="legend-swatch" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function updateDraft<K extends keyof AssetDraft>(
  setDraft: Dispatch<SetStateAction<AssetDraft>>,
  key: K,
  value: AssetDraft[K],
): void {
  setDraft((current) => ({ ...current, [key]: value }));
}

function createTerrainDraft(): AssetDraft {
  const draft = createDefaultDraft();
  const displayWidth = 256;
  return {
    ...draft,
    category: 'sprites',
    mode: 'image',
    removeBackground: true,
    cropToBoundingBox: false,
    exportWidth: displayWidth,
    displayWidth,
    displayHeight: getTerrainDisplayHeight(displayWidth),
    terrainType: 'temperate_forest',
    terrainVariant: 1,
    terrainAutoNaming: true,
    terrainAtlasGroup: 'hex_tileset',
    terrainGenerateAtlas: true,
    terrainHexOverlay: {
      centerX: 0.5,
      centerY: 0.62,
      radius: 0.28,
      squashY: 0.72,
      topOverflow: 0.22,
    },
  };
}

function getTerrainDisplayHeight(coreWidth: number): number {
  return Math.max(1, Math.round(coreWidth * (Math.sqrt(3) / 2) * TARGET_TERRAIN_HEX_SQUASH));
}

function getNormalizedTerrainOverlay(draft: AssetDraft): AssetDraft['terrainHexOverlay'] {
  return {
    centerX: TARGET_TERRAIN_CENTER_X,
    centerY: TARGET_TERRAIN_CENTER_Y,
    radius: (TARGET_TERRAIN_CORE_WIDTH / 2) / TARGET_TERRAIN_OUTPUT_WIDTH,
    squashY: TARGET_TERRAIN_HEX_SQUASH,
    topOverflow: draft.terrainHexOverlay.topOverflow,
  };
}

function getNormalizedTerrainPlacement(
  sourceWidth: number,
  sourceHeight: number,
  overlay: AssetDraft['terrainHexOverlay'],
): {
  sourceClipX: number;
  sourceClipY: number;
  sourceClipWidth: number;
  sourceClipHeight: number;
  destX: number;
  destY: number;
  destWidth: number;
  destHeight: number;
} {
  const sourceRadius = Math.max(1, overlay.radius * sourceWidth);
  const sourceCenterX = overlay.centerX * sourceWidth;
  const sourceCenterY = overlay.centerY * sourceHeight;
  const targetCenterX = TARGET_TERRAIN_OUTPUT_WIDTH * TARGET_TERRAIN_CENTER_X;
  const targetCenterY = TARGET_TERRAIN_OUTPUT_HEIGHT * TARGET_TERRAIN_CENTER_Y;
  const targetRadius = TARGET_TERRAIN_CORE_WIDTH / 2;
  const scale = targetRadius / sourceRadius;
  const scaledWidth = Math.max(1, Math.round(sourceWidth * scale));
  const scaledHeight = Math.max(1, Math.round(sourceHeight * scale));
  const compositeLeft = Math.round(targetCenterX - sourceCenterX * scale);
  const compositeTop = Math.round(targetCenterY - sourceCenterY * scale);

  const sourceClipX = Math.max(0, -compositeLeft);
  const sourceClipY = Math.max(0, -compositeTop);
  const destX = Math.max(0, compositeLeft);
  const destY = Math.max(0, compositeTop);
  const sourceClipWidth = Math.max(0, Math.min(scaledWidth - sourceClipX, TARGET_TERRAIN_OUTPUT_WIDTH - destX));
  const sourceClipHeight = Math.max(0, Math.min(scaledHeight - sourceClipY, TARGET_TERRAIN_OUTPUT_HEIGHT - destY));

  return {
    sourceClipX,
    sourceClipY,
    sourceClipWidth,
    sourceClipHeight,
    destX,
    destY,
    destWidth: sourceClipWidth,
    destHeight: sourceClipHeight,
  };
}

function createNormalizedTerrainPreviewCanvas(source: HTMLImageElement | HTMLCanvasElement, draft: AssetDraft): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_TERRAIN_OUTPUT_WIDTH;
  canvas.height = TARGET_TERRAIN_OUTPUT_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return canvas;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sourceWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const sourceHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
  const placement = getNormalizedTerrainPlacement(sourceWidth, sourceHeight, draft.terrainHexOverlay);

  if (placement.sourceClipWidth > 0 && placement.sourceClipHeight > 0) {
    ctx.drawImage(
      source,
      placement.sourceClipX,
      placement.sourceClipY,
      placement.sourceClipWidth,
      placement.sourceClipHeight,
      placement.destX,
      placement.destY,
      placement.destWidth,
      placement.destHeight,
    );
  }

  return canvas;
}

function humanizeTerrainType(value: TerrainType | ''): string {
  if (!value) return 'Unassigned';
  return humanizeName(value);
}

function buildTerrainAssetId(terrainType: TerrainType, variant: number): string {
  return sanitizeAssetId(`terrain_${terrainType}_${String(variant).padStart(2, '0')}`);
}

function getNextTerrainVariant(assets: PersistedAssetRecord[], terrainType: TerrainType): number {
  let maxVariant = 0;
  const fallbackPattern = new RegExp(`^terrain_${terrainType}_(\\d+)$`);

  for (const asset of assets) {
    if (asset.terrainTile?.terrainType === terrainType) {
      maxVariant = Math.max(maxVariant, asset.terrainTile.variant ?? 0);
      continue;
    }

    const match = asset.id.match(fallbackPattern);
    if (match?.[1]) {
      maxVariant = Math.max(maxVariant, Number.parseInt(match[1], 10) || 0);
    }
  }

  return maxVariant + 1;
}

function getFlatTopHexPoints(centerX: number, centerY: number, radius: number, squashY = 1): Array<{ x: number; y: number }> {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index);
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius * squashY,
    };
  });
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function isPointInsidePolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]!.x;
    const yi = polygon[i]!.y;
    const xj = polygon[j]!.x;
    const yj = polygon[j]!.y;

    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / Math.max(0.00001, (yj - yi)) + xi);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function getAssetAspectRatio(draft: AssetDraft, sourceInfo: SourceInfo | null): number {
  if (!sourceInfo || sourceInfo.width <= 0 || sourceInfo.height <= 0) {
    return safeAspectRatio(draft.exportWidth, draft.exportHeight);
  }

  if (draft.mode === 'image') {
    return safeAspectRatio(sourceInfo.width, sourceInfo.height);
  }

  const perFrameWidth = sourceInfo.width / Math.max(1, draft.columns);
  const perFrameHeight = sourceInfo.height / Math.max(1, draft.rows);
  return safeAspectRatio(perFrameWidth, perFrameHeight);
}

function getSuggestedSizingForMode(
  mode: AssetDraft['mode'],
  sourceInfo: SourceInfo,
  columns: number,
  rows: number,
): { exportWidth: number; exportHeight: number } {
  if (mode === 'image') {
    return {
      exportWidth: Math.max(1, Math.round(sourceInfo.width)),
      exportHeight: Math.max(1, Math.round(sourceInfo.height)),
    };
  }

  return {
    exportWidth: Math.max(1, Math.round(sourceInfo.width / Math.max(1, columns))),
    exportHeight: Math.max(1, Math.round(sourceInfo.height / Math.max(1, rows))),
  };
}

function safeAspectRatio(width: number, height: number): number {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  return safeHeight / safeWidth;
}

function inferMimeTypeFromFormat(format: OutputFormat): string {
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

async function createSpritesheetPreviewFromVideo(
  file: File,
  draft: AssetDraft,
  sourceInfo: SourceInfo,
): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  try {
    await loadVideoElement(video, url);

    const columns = Math.max(1, draft.columns);
    const rows = Math.max(1, draft.rows);
    const frameCount = Math.max(1, columns * rows);
    const frameWidth = Math.max(1, Math.round(draft.exportWidth));
    const frameHeight = Math.max(1, Math.round(draft.exportHeight));
    const canvas = document.createElement('canvas');
    canvas.width = frameWidth * columns;
    canvas.height = frameHeight * rows;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2D context is unavailable.');
    }

    const clipStart = Math.max(0, draft.trimStartSeconds ?? 0);
    const videoDuration = Number.isFinite(sourceInfo.durationSeconds) ? sourceInfo.durationSeconds ?? 0 : Number.isFinite(video.duration) ? video.duration : 0;
    const explicitEnd = (draft.trimEndSeconds ?? 0) > clipStart ? draft.trimEndSeconds : videoDuration;
    const clipEnd = explicitEnd > clipStart ? Math.min(explicitEnd, videoDuration || explicitEnd) : videoDuration;
    const safeClipEnd = clipEnd > clipStart ? clipEnd : clipStart;
    const maxSeekTime = Math.max(clipStart, safeClipEnd - 0.001);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const targetTime = getPreviewFrameTime(frameIndex, frameCount, clipStart, maxSeekTime, draft.frameRate, draft.videoSampling);
      await seekVideoElement(video, targetTime);

      const col = frameIndex % columns;
      const row = Math.floor(frameIndex / columns);
      drawMediaWithFit(
        context,
        video,
        col * frameWidth,
        row * frameHeight,
        frameWidth,
        frameHeight,
        draft.resizeFit,
      );
    }

    if (draft.removeBackground) {
      return removeBackgroundFromCanvas(canvas);
    }

    return canvas;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function getPreviewFrameTime(
  frameIndex: number,
  frameCount: number,
  clipStart: number,
  clipEnd: number,
  frameRate: number,
  samplingMode: VideoSamplingMode,
): number {
  if (samplingMode === 'sequential') {
    return Math.min(clipEnd, clipStart + frameIndex / Math.max(1, frameRate));
  }

  if (frameCount <= 1) {
    return clipStart;
  }

  const ratio = frameIndex / Math.max(1, frameCount - 1);
  return clipStart + (clipEnd - clipStart) * ratio;
}

function drawMediaWithFit(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  fit: ResizeFitMode,
): void {
  const sourceWidth = getCanvasImageSourceWidth(source);
  const sourceHeight = getCanvasImageSourceHeight(source);
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  context.clearRect(dx, dy, dw, dh);

  if (fit === 'fill') {
    context.drawImage(source, dx, dy, dw, dh);
    return;
  }

  const scale = fit === 'cover'
    ? Math.max(dw / sourceWidth, dh / sourceHeight)
    : Math.min(dw / sourceWidth, dh / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = dx + (dw - drawWidth) / 2;
  const offsetY = dy + (dh - drawHeight) / 2;
  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
}

function getCanvasImageSourceWidth(source: CanvasImageSource): number {
  if (source instanceof HTMLVideoElement) return source.videoWidth;
  if (source instanceof HTMLImageElement) return source.naturalWidth;
  if (source instanceof HTMLCanvasElement) return source.width;
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return source.width;
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return source.width;
  return 0;
}

function getCanvasImageSourceHeight(source: CanvasImageSource): number {
  if (source instanceof HTMLVideoElement) return source.videoHeight;
  if (source instanceof HTMLImageElement) return source.naturalHeight;
  if (source instanceof HTMLCanvasElement) return source.height;
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return source.height;
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return source.height;
  return 0;
}

function loadVideoElement(video: HTMLVideoElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.onloadeddata = null;
      video.onerror = null;
    };

    video.onloadeddata = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Unable to load video for preview generation.'));
    };
    video.src = url;
  });
}

function seekVideoElement(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.onseeked = null;
      video.onerror = null;
    };

    video.onseeked = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Video seeking failed during preview generation.'));
    };
    video.currentTime = Math.max(0, time);
  });
}

async function createBackgroundRemovedCanvas(image: HTMLImageElement): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);

  return removeBackgroundFromCanvas(canvas);
}

function cropCanvasToBoundingBox(source: HTMLCanvasElement): HTMLCanvasElement {
  const context = source.getContext('2d');
  if (!context) return source;

  const imageData = context.getImageData(0, 0, source.width, source.height);
  const { data, width, height } = imageData;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return source; // fully transparent — nothing to crop
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const canvas = document.createElement('canvas');
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;

  ctx.drawImage(source, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
  return canvas;
}

function removeBackgroundFromCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return source;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const background = sampleCornerColor(imageData.data, canvas.width, canvas.height);
  const tolerance = 48;
  const feather = 52;

  for (let index = 0; index < imageData.data.length; index += 4) {
    const distance = colorDistance(
      imageData.data[index] ?? 0,
      imageData.data[index + 1] ?? 0,
      imageData.data[index + 2] ?? 0,
      background.r,
      background.g,
      background.b,
    );

    if (distance <= tolerance) {
      imageData.data[index + 3] = 0;
    } else if (distance <= tolerance + feather) {
      const alphaFactor = (distance - tolerance) / feather;
      imageData.data[index + 3] = Math.round((imageData.data[index + 3] ?? 0) * alphaFactor);
    }
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function sampleCornerColor(data: Uint8ClampedArray, width: number, height: number): { r: number; g: number; b: number } {
  const sampleSize = Math.max(4, Math.min(20, Math.floor(Math.min(width, height) / 10)));
  const corners: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let samples = 0;

  for (const [startX, startY] of corners) {
    for (let y = startY; y < Math.min(height, startY + sampleSize); y += 1) {
      for (let x = startX; x < Math.min(width, startX + sampleSize); x += 1) {
        const index = (y * width + x) * 4;
        totalR += data[index] ?? 0;
        totalG += data[index + 1] ?? 0;
        totalB += data[index + 2] ?? 0;
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

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function humanizeName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
