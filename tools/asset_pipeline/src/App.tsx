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
  ImagePlus,
  Plus,
  RefreshCw,
  ScanLine,
  Sparkles,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import type { AssetCategory, AssetDraft, AnimationType, OutputFormat, PersistedAssetRecord, ResizeFitMode, SourceInfo, VideoSamplingMode } from './types';
import {
  buildAssetMetadata,
  buildDraftFromPersistedAsset,
  buildManifestRow,
  bytesToHuman,
  createDefaultDraft,
  downloadBlob,
  downloadTextFile,
  exportRasterBlob,
  getCategoryOutputPath,
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
  const [appView, setAppView] = useState<'library' | 'editor'>('library');
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
    sizing: false,
    animation: false,
    video: false,
  });
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

        const nextMode = info.kind === 'video' ? 'video' : current.mode;
        const inferredCategory = info.kind === 'video' ? 'animations' : inferCategoryFromMode(nextMode);
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
          assetId: current.assetId === 'new_asset' || current.assetId === sanitizeAssetId(baseName)
            ? sanitizeAssetId(baseName)
            : current.assetId,
          displayName: current.displayName === 'New Asset' ? humanizeName(baseName) : current.displayName,
          mode: nextMode,
          category: current.category === 'sprites' || current.category === 'animations' ? inferredCategory : current.category,
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
  }, [selectedFile]);

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
    () => `${getCategoryOutputPath(draft.category)}/${draft.assetId}.${draft.outputFormat}`,
    [draft.category, draft.assetId, draft.outputFormat],
  );
  const currentAspectRatio = useMemo(() => getAssetAspectRatio(draft, sourceInfo), [draft, sourceInfo]);
  const workflowSteps = [
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
      setAppView('editor');
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
            Import art, keep metadata organized, preview grounding and hitboxes, and save optimized assets directly
            into the game workspace.
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
            subtitle="Load a source image or video."
            open={openSections.import}
            onToggle={() => setOpenSections((current) => ({ ...current, import: !current.import }))}
          >
            <label className="file-dropzone">
              <input
                type="file"
                accept="image/*,video/*"
                onChange={(event) => handleFileSelected(event.target.files?.[0] ?? null)}
              />
              <span>{selectedFile ? selectedFile.name : 'Choose image or video'}</span>
              <small>PNG, JPG, WebP, AVIF, MP4, MOV, WebM</small>
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
            title="2. Asset metadata"
            subtitle="Name and classify the asset."
            open={openSections.metadata}
            onToggle={() => setOpenSections((current) => ({ ...current, metadata: !current.metadata }))}
            disabled={!hasSelectedSource}
          >
            <div className="field-grid">
            <TextField label="Asset ID" value={draft.assetId} onChange={(value) => updateDraft(setDraft, 'assetId', sanitizeAssetId(value))} helper="snake_case ID used by runtime loaders" />
            <TextField label="Display name" value={draft.displayName} onChange={(value) => updateDraft(setDraft, 'displayName', value)} />
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
            <SelectField label="Output format" value={draft.outputFormat} options={OUTPUT_FORMATS} onChange={(value) => updateDraft(setDraft, 'outputFormat', value as OutputFormat)} />
            <ToggleField label="Optimize for web" checked={draft.enableOptimization} onChange={(checked) => updateDraft(setDraft, 'enableOptimization', checked)} />
            <ToggleField label="Background removal" checked={draft.removeBackground} onChange={(checked) => updateDraft(setDraft, 'removeBackground', checked)} helper="Uses local corner-matte removal when processed by the backend." />
            <TextAreaField label="Notes" value={draft.notes} onChange={(value) => updateDraft(setDraft, 'notes', value)} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            icon={<Sparkles size={18} />}
            title="3. Sizing"
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
              <NumberField label="Export width" value={draft.exportWidth} min={1} onChange={(value) => handleSizedValueChange('export', 'width', value)} />
              <NumberField label="Export height" value={draft.exportHeight} min={1} onChange={(value) => handleSizedValueChange('export', 'height', value)} />
              <NumberField label="Display width" value={draft.displayWidth} min={1} onChange={(value) => handleSizedValueChange('display', 'width', value)} />
              <NumberField label="Display height" value={draft.displayHeight} min={1} onChange={(value) => handleSizedValueChange('display', 'height', value)} />
              <SelectField
                label="Resize fit"
                value={draft.resizeFit}
                options={RESIZE_FIT_OPTIONS}
                onChange={(value) => updateDraft(setDraft, 'resizeFit', value as ResizeFitMode)}
                helper="Contain keeps the full frame, cover fills and crops, fill stretches to fit."
              />
            </div>
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
          <PanelHeader icon={<ScanLine size={18} />} title="Preview" subtitle="Grounded animation, origin, and hitbox visualization." />
          <div className="panel-tip compact-tip">
            <strong>Interactive preview</strong>
            <p>Drag the green origin handle or move/resize the orange collision box directly in the preview.</p>
          </div>
          <PreviewCanvas
            draft={draft}
            previewImage={previewImage}
            sourceInfo={draft.mode === 'video' ? videoPreviewInfo : sourceInfo}
            previewSourceOverride={draft.mode === 'video' ? videoPreviewSheet : null}
            isPreparingVideoPreview={draft.mode === 'video' && isPreparingVideoPreview}
            onDraftChange={setDraft}
          />
          <div className="preview-legend">
            <LegendSwatch color="rgba(88, 228, 157, 0.9)" label="Origin point" />
            <LegendSwatch color="rgba(255, 127, 80, 0.9)" label="Collision box" />
            <LegendSwatch color="rgba(126, 198, 255, 0.9)" label="Frame bounds" />
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
            <InfoTile label="Category folder" value={getCategoryOutputPath(draft.category)} />
            <InfoTile label="Runtime display" value={`${draft.displayWidth} × ${draft.displayHeight}`} />
            <InfoTile label="Export raster" value={`${draft.exportWidth} × ${draft.exportHeight}`} />
            <InfoTile label="Animation" value={draft.mode === 'image' ? 'N/A' : `${draft.animationType} @ ${draft.frameRate} fps`} />
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
        </span>
      </footer>
    </div>
  );
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
  }, [previewImage, previewSourceOverride, draft.removeBackground]);

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
