import React, { useState, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  FileVideo,
  CheckCircle2,
  Loader2,
  Sparkles,
  ArrowRight,
  Building,
  Layers,
  AlertCircle,
  Clock,
  Radio,
  RefreshCw,
  Play,
  Eye,
  ChevronDown,
  ChevronRight,
  FileJson,
  ShieldCheck,
  Package,
  Link2,
  ExternalLink,
  MapPin,
  Copy,
  Check,
  X,
  Sliders,
  Cpu,
  Terminal,
} from 'lucide-react';
import {
  type VideoAnalysisDoc,
  type VideoRecord,
  type VideoPasses,
  type PassStatus,
  type ExecutionAudit,
  DEFAULT_VIDEO_PASSES,
} from '@sail/shared';
import {
  TenantConfig,
  DEFAULT_GCS_BUCKET,
  apiService,
  UploadVideoResponse,
  type InventoryRecord,
} from '../services/api.service';

export interface VideoManagerViewProps {
  tenant: TenantConfig;
  activeStreamId?: string;
  onSelectActiveStream?: (video: VideoRecord, analysis?: VideoAnalysisDoc) => void;
  onSelectVideoForReview: (
    videoId: string,
    workflowType: 'inventory' | 'archive' | 'hitl',
    analysis?: VideoAnalysisDoc
  ) => void;
  onNavigateToInventory?: (inventoryId?: string, videoId?: string) => void;
  onSeekVideo?: (seconds: number) => void;
  currentTime?: number;
}

export type VideoManagerProps = VideoManagerViewProps;

type UploadStep = 'IDLE' | 'UPLOADING' | 'TRANSCODING' | 'SAVED' | 'ERROR';

function parseTimeStringToSeconds(timeStr?: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) {
    return '--:--';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTimestamp(ts: any): string {
  if (!ts) return 'Just now';
  if (typeof ts === 'string') {
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
    return ts;
  }
  if (typeof ts === 'object') {
    if (typeof ts.toDate === 'function') {
      return ts.toDate().toLocaleString();
    }
    if (typeof ts._seconds === 'number') {
      return new Date(ts._seconds * 1000).toLocaleString();
    }
    if (typeof ts.seconds === 'number') {
      return new Date(ts.seconds * 1000).toLocaleString();
    }
  }
  return 'Recorded';
}

function ensurePasses(passes?: VideoPasses): VideoPasses {
  return {
    pass0: passes?.pass0 || { status: 'PENDING' },
    pass1: passes?.pass1 || { status: 'PENDING' },
    pass2: passes?.pass2 || { status: 'PENDING' },
    pass3: passes?.pass3 || { status: 'PENDING' },
    hitl: passes?.hitl || { status: 'PENDING' },
  };
}

export const VideoManager: React.FC<VideoManagerViewProps> = ({
  tenant,
  activeStreamId,
  onSelectActiveStream,
  onSelectVideoForReview,
  onNavigateToInventory,
  onSeekVideo,
  currentTime,
}) => {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const isLoadingRegistry = loading;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [probedDuration, setProbedDuration] = useState<number | undefined>(undefined);

  // Inventories for automatic/manual association
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [assigningInventoryMap, setAssigningInventoryMap] = useState<Record<string, string>>({});
  const [isAssigningMap, setIsAssigningMap] = useState<Record<string, boolean>>({});

  // Selected video for the Pass Stepper & Execution UI
  const [activeStream, setActiveStreamState] = useState<string | null>(
    activeStreamId && !activeStreamId.startsWith('vid_cryo_demo') && !activeStreamId.startsWith('vid_archive_demo')
      ? activeStreamId
      : null
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(activeStream);

  // Decoupled Upload & Transcoding State
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [uploadStep, setUploadStep] = useState<UploadStep>('IDLE');
  const [latestUploadedVideo, setLatestUploadedVideo] = useState<VideoRecord | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [transcodingVideoId, setTranscodingVideoId] = useState<string | null>(null);
  const [pollingStoppedForActive, setPollingStoppedForActive] = useState<boolean>(false);

  // Per-video & per-pass AI Analysis State
  const [analyzingIds, setAnalyzingIds] = useState<Record<string, boolean>>({});
  const [runningPassMap, setRunningPassMap] = useState<Record<string, Record<string, boolean>>>({});
  const [passesByVideo, setPassesByVideo] = useState<Record<string, VideoPasses>>({});
  const [analysisCache, setAnalysisCache] = useState<Record<string, VideoAnalysisDoc>>({});
  const [openJsonDrawers, setOpenJsonDrawers] = useState<Record<string, boolean>>({});
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [showRawJsonMap, setShowRawJsonMap] = useState<Record<string, boolean>>({});
  const [activeSeekedActionId, setActiveSeekedActionId] = useState<string | null>(null);
  const [seekFeedback, setSeekFeedback] = useState<string | null>(null);
  const [inspectionModal, setInspectionModal] = useState<{
    audit: ExecutionAudit;
    title: string;
  } | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);

  // Model & Thinking Level Selectors (Default: Pass 0 -> gemini-3.8-flash, Passes 1-3 -> gemini-1.5-pro, Passes 1-3 Thinking -> MEDIUM)
  const [pass0Model, setPass0Model] = useState<string>('gemini-3.8-flash');
  const [pass1Model, setPass1Model] = useState<string>('gemini-1.5-pro');
  const [pass1Thinking, setPass1Thinking] = useState<string>('MEDIUM');
  const [pass2Model, setPass2Model] = useState<string>('gemini-1.5-pro');
  const [pass2Thinking, setPass2Thinking] = useState<string>('MEDIUM');
  const [pass3Model, setPass3Model] = useState<string>('gemini-1.5-pro');
  const [pass3Thinking, setPass3Thinking] = useState<string>('MEDIUM');

  const handleSeekToInterval = (seconds: number, actionId?: string, label?: string) => {
    if (actionId) {
      setActiveSeekedActionId(actionId);
    }
    const displayLabel = label || formatDuration(seconds);
    setSeekFeedback(`Seeked to ${displayLabel} (${seconds.toFixed(1)}s)`);
    setTimeout(() => setSeekFeedback(null), 3500);

    onSeekVideo?.(seconds);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('sail:seek-video', {
          detail: { seconds, actionId, videoId: selectedVideoId },
        })
      );
    }
  };

  /**
   * Selects a video as the current active stream and updates parent state.
   */
  const setActiveStream = useCallback(
    (videoId: string, videoRecord?: VideoRecord) => {
      setActiveStreamState(videoId);
      setSelectedVideoId(videoId);
      const targetVideo = videoRecord || videos.find((v) => v.videoId === videoId);
      if (targetVideo) {
        onSelectActiveStream?.(targetVideo, analysisCache[videoId]);
      }
    },
    [videos, analysisCache, onSelectActiveStream]
  );

  /**
   * Fetch persistent video registry from GET /api/videos on mount, refresh button click,
   * and after video upload completion or background polling ticks.
   */
  const fetchVideos = useCallback(async (showLoadingSpinner: boolean = true): Promise<VideoRecord[]> => {
    try {
      if (showLoadingSpinner) {
        setLoading(true);
      }
      const res = await fetch('/api/videos');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: VideoRecord[] = Array.isArray(json) ? json : (json.videos || []);
      console.log('[VideoManager] Loaded videos:', list.length);
      setVideos((prev) => {
        const mergedMap = new Map<string, VideoRecord>();
        for (const v of list) {
          if (v?.videoId) {
            mergedMap.set(v.videoId, v);
          }
        }
        for (const v of prev) {
          if (v?.videoId && !mergedMap.has(v.videoId)) {
            mergedMap.set(v.videoId, v);
          }
        }
        const merged = Array.from(mergedMap.values());
        merged.sort(
          (a, b) =>
            new Date(String(b.uploadedAt || 0)).getTime() -
            new Date(String(a.uploadedAt || 0)).getTime()
        );
        return merged;
      });

      const initialPassesMap: Record<string, VideoPasses> = {};
      for (const v of list) {
        initialPassesMap[v.videoId] = ensurePasses(v.passes);
      }
      setPassesByVideo((prev) => ({ ...prev, ...initialPassesMap }));

      if (list.length > 0) {
        setSelectedVideoId((prevId) => {
          if (prevId) {
            return prevId;
          }
          return list[0].videoId;
        });
      }
      return list;
    } catch (err) {
      console.error('[VideoManager] Error fetching videos:', err);
      return [];
    } finally {
      if (showLoadingSpinner) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const loadInventories = useCallback(async () => {
    try {
      const data = await apiService.fetchInventories({
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      setInventories(data);
    } catch (err) {
      console.error('[VideoManager] Failed to load inventories:', err);
    }
  }, [tenant.customerId, tenant.databaseId]);

  useEffect(() => {
    loadInventories();
  }, [loadInventories]);

  const handleAssignInventory = async (videoId: string, inventoryIdToAssign?: string) => {
    const invId = inventoryIdToAssign || assigningInventoryMap[videoId];
    if (!invId) return;

    setIsAssigningMap((prev) => ({ ...prev, [videoId]: true }));
    try {
      const result = await apiService.associateVideoInventory(videoId, invId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      if (result.success && result.video) {
        setVideos((prev) =>
          prev.map((v) => (v.videoId === videoId ? { ...v, ...result.video } : v))
        );
        setStatusBanner(
          `Successfully assigned ${videoId} to inventory "${result.inventoryName || invId}".`
        );
      }
    } catch (err: any) {
      console.error(`[VideoManager] Failed to associate inventory for ${videoId}:`, err);
      setStatusBanner(`Failed to associate inventory: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsAssigningMap((prev) => ({ ...prev, [videoId]: false }));
    }
  };

  /**
   * Poll GET /api/videos every 3-5 seconds while any video has status === 'TRANSCODING'.
   * When the active video status becomes 'READY_FOR_ANALYSIS':
   * - Stop polling.
   * - Refresh the registry table so Pass 0 through Pass 3 can be executed.
   */
  useEffect(() => {
    const hasTranscodingVideos = videos.some((v) => v.status === 'TRANSCODING');
    if (!hasTranscodingVideos || pollingStoppedForActive) {
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const list = await fetchVideos(false);
        const currentActiveId = selectedVideoId || activeStreamId || transcodingVideoId;
        const activeVid = list.find((v) => v.videoId === currentActiveId);

        if (activeVid && activeVid.status === 'READY_FOR_ANALYSIS') {
          console.log(
            `[VideoManager] Active video ${currentActiveId} is now READY_FOR_ANALYSIS. Stopping polling.`
          );
          setPollingStoppedForActive(true);
          setTranscodingVideoId(null);
          setUploadStep('SAVED');
          setUploading(false);
          setUploadProgress('');
          setLatestUploadedVideo(activeVid);
          setStatusBanner(
            `Video "${activeVid.originalName}" is ready for analysis (${activeVid.totalChunks ?? activeVid.chunks?.length ?? 1} chunk(s)). Pass 0 through Pass 3 can now be executed.`
          );
          // Refresh registry table so Pass 0 through Pass 3 can be executed
          await fetchVideos(false);
          if (onSelectActiveStream) {
            onSelectActiveStream(activeVid, analysisCache[activeVid.videoId]);
          }
        } else if (activeVid && (activeVid.status === 'ERROR' || activeVid.status === 'FAILED')) {
          console.error(
            `[VideoManager] Active video ${currentActiveId} failed with status:`,
            activeVid.status
          );
          setPollingStoppedForActive(true);
          setTranscodingVideoId(null);
          setUploadStep('ERROR');
          setUploading(false);
          setUploadProgress('');
          setUploadError((activeVid as any).errorMessage || 'Video background transcoding failed');
          setStatusBanner(null);
          await fetchVideos(false);
        }
      } catch (pollErr) {
        console.warn('[VideoManager] Polling /api/videos failed:', pollErr);
      }
    }, 4000);

    return () => clearInterval(intervalId);
  }, [
    videos,
    selectedVideoId,
    activeStreamId,
    transcodingVideoId,
    pollingStoppedForActive,
    fetchVideos,
    onSelectActiveStream,
    analysisCache,
  ]);

  /**
   * Whenever selectedVideoId changes, sync its passes from GET /api/pipeline/passes/:videoId.
   */
  useEffect(() => {
    if (!selectedVideoId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.fetchVideoPasses(selectedVideoId, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        if (!cancelled && res?.passes) {
          setPassesByVideo((prev) => ({
            ...prev,
            [selectedVideoId]: ensurePasses(res.passes),
          }));
          setVideos((prev) =>
            prev.map((v) =>
              v.videoId === selectedVideoId
                ? {
                    ...v,
                    status: res.status || v.status,
                    geminiFileUri: res.geminiFileUri || v.geminiFileUri,
                    passes: ensurePasses(res.passes),
                  }
                : v
            )
          );
        }
      } catch {
        // Ignore pass fetch errors if video is brand new
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVideoId, tenant.customerId, tenant.databaseId]);

  const handleSelectVideo = (video: VideoRecord) => {
    setActiveStream(video.videoId, video);
    if (video.status === 'TRANSCODING') {
      setPollingStoppedForActive(false);
      setTranscodingVideoId(video.videoId);
      setUploadStep('TRANSCODING');
      setUploadProgress('Transcoding & segmenting video in background...');
      setStatusBanner('Transcoding & segmenting video in background...');
    }
  };

  const toggleJsonDrawer = (drawerKey: string) => {
    setOpenJsonDrawers((prev) => ({
      ...prev,
      [drawerKey]: !prev[drawerKey],
    }));
  };

  const probeVideoDuration = (file: File) => {
    try {
      const videoEl = document.createElement('video');
      videoEl.preload = 'metadata';
      const objectUrl = URL.createObjectURL(file);
      videoEl.onloadedmetadata = () => {
        URL.revokeObjectURL(objectUrl);
        if (videoEl.duration && Number.isFinite(videoEl.duration)) {
          setProbedDuration(Math.round(videoEl.duration));
        }
      };
      videoEl.onerror = () => {
        URL.revokeObjectURL(objectUrl);
      };
      videoEl.src = objectUrl;
    } catch {
      setProbedDuration(undefined);
    }
  };

  /**
   * Direct-to-GCS V4 Signed URL Upload & Chunked FFmpeg Normalization Flow:
   * 1. Request signed URL: POST /api/videos/request-upload-url with file metadata.
   * 2. Upload raw file directly to GCS via PUT to signedUrl.
   * 3. Notify server to process 10-minute normalized chunks: POST /api/videos/finalize-upload.
   * 4. Refresh video registry on success.
   */
  const uploadVideoFile = async (file: File) => {
    try {
      setUploading(true);
      const contentType = file.type || 'video/mp4';
      setUploadProgress('Requesting signed GCS upload URL...');
      console.log('[VideoManager] Starting direct-to-GCS upload for:', file.name, file.size);

      setSelectedFile(file);
      probeVideoDuration(file);
      setUploadError(null);
      setLatestUploadedVideo(null);
      setUploadStep('UPLOADING');
      setStatusBanner('Step 1/3: Requesting V4 Signed URL and uploading raw video directly to Cloud Storage...');

      // 1. Request signed URL: POST /api/videos/request-upload-url
      const urlRes = await fetch('/api/videos/request-upload-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: file.name,
          contentType,
        }),
      });

      if (!urlRes.ok) {
        const errJson = await urlRes.json().catch(() => ({}));
        throw new Error(
          errJson.error || `Failed to request upload URL (HTTP ${urlRes.status})`
        );
      }

      const { videoId, signedUrl, rawGcsUri } = await urlRes.json();

      // 2. Upload raw file directly to GCS via PUT to V4 Signed URL
      setUploadProgress('Uploading raw video directly to Google Cloud Storage...');
      const putRes = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': contentType,
        },
      });

      if (!putRes.ok) {
        throw new Error(`Direct GCS upload failed with HTTP status ${putRes.status}`);
      }

      // 3. Notify server to process chunks asynchronously: POST /api/videos/finalize-upload
      setUploadStep('TRANSCODING');
      setUploadProgress('Transcoding & segmenting video in background...');
      setStatusBanner('Transcoding & segmenting video in background...');

      const finalizeRes = await fetch('/api/videos/finalize-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoId,
          rawGcsUri,
          originalName: file.name,
        }),
      });

      // Handle HTTP 202 (or 200) from /api/videos/finalize-upload as successful initiation
      if (!finalizeRes.ok && finalizeRes.status !== 202) {
        const errJson = await finalizeRes.json().catch(() => ({}));
        throw new Error(
          errJson.error || `Finalize upload failed with HTTP status ${finalizeRes.status}`
        );
      }

      const result = await finalizeRes.json();
      console.log('[VideoManager] Async transcoding initiated (202 Accepted):', result);

      const initiatedVideoId = result.videoId || videoId;
      setTranscodingVideoId(initiatedVideoId);
      setPollingStoppedForActive(false);

      // Refresh registry so the initial TRANSCODING record is reflected immediately
      await fetchVideos(false);

      // Set active stream to the newly registered video ID returned by the backend
      setActiveStream(initiatedVideoId);
      setSelectedVideoId(initiatedVideoId);
    } catch (err: any) {
      console.error('[VideoManager] Upload failed:', err);
      setUploadStep('ERROR');
      setUploadError(err?.message || 'Upload failed');
      setStatusBanner(null);
      setUploadProgress('');
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = uploadVideoFile;

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      uploadVideoFile(file);
    }
  };

  const handleUploadVideo = async () => {
    if (selectedFile) {
      await uploadVideoFile(selectedFile);
    }
  };

  const uploadVideoHandler = handleUploadVideo;

  /**
   * Executes a single pass (`0 | 1 | 2 | 3`) via `POST /api/pipeline/analyze-pass`.
   * Does not mark COMPLETED until the backend request finishes.
   */
  const handleRunSinglePass = async (video: VideoRecord, passNum: 0 | 1 | 2 | 3) => {
    const { videoId } = video;
    const normalizedGcsUri = video.normalizedGcsUri || video.chunks?.[0]?.gcsUri;
    const passKey = `pass${passNum}` as keyof VideoPasses;

    setSelectedVideoId(videoId);
    setRunningPassMap((prev) => ({
      ...prev,
      [videoId]: { ...(prev[videoId] || {}), [passKey]: true },
    }));
    setPassesByVideo((prev) => {
      const current = ensurePasses(prev[videoId] || video.passes);
      return {
        ...prev,
        [videoId]: {
          ...current,
          [passKey]: {
            ...current[passKey],
            status: 'RUNNING',
            error: null,
          },
        },
      };
    });

    const passLabels: Record<number, string> = {
      0: 'Pass 0: Workflow Classification (Flash @ 1 fps)',
      1: 'Pass 1: Action Detection (Pro @ 1 fps)',
      2: 'Pass 2: Event Detection (Temporal 4 fps)',
      3: 'Pass 3: Analysis Refinement (Full Res Crop)',
    };
    setStatusBanner(`Executing ${passLabels[passNum]} for ${video.originalName} (${videoId})...`);

    let selectedModel: string | undefined;
    let selectedThinking: string | undefined;

    if (passNum === 0) {
      selectedModel = pass0Model;
    } else if (passNum === 1) {
      selectedModel = pass1Model;
      selectedThinking = pass1Thinking;
    } else if (passNum === 2) {
      selectedModel = pass2Model;
      selectedThinking = pass2Thinking;
    } else if (passNum === 3) {
      selectedModel = pass3Model;
      selectedThinking = pass3Thinking;
    }

    try {
      const res = await apiService.runPipelinePass(videoId, passNum, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
        videoGcsUri: normalizedGcsUri,
        model: selectedModel,
        thinkingLevel: selectedThinking,
      });

      const updatedPasses = ensurePasses(res.passes);
      if (updatedPasses[passKey]?.status === 'COMPLETED') {
        updatedPasses[passKey].error = null;
      }

      setPassesByVideo((prev) => ({
        ...prev,
        [videoId]: updatedPasses,
      }));

      // Auto-expand the JSON inspector for the completed pass
      setOpenJsonDrawers((prev) => ({
        ...prev,
        [`${videoId}_${passKey}`]: true,
      }));

      const updatedVideo: VideoRecord = {
        ...video,
        status: res.status || (passNum === 3 ? 'ANALYSIS_COMPLETE' : video.status),
        geminiFileUri: res.geminiFileUri || video.geminiFileUri,
        passes: updatedPasses,
      };

      setVideos((prev) => prev.map((v) => (v.videoId === videoId ? updatedVideo : v)));
      if (latestUploadedVideo?.videoId === videoId) {
        setLatestUploadedVideo(updatedVideo);
      }

      if (res.analysis) {
        setAnalysisCache((prev) => ({ ...prev, [videoId]: res.analysis! }));
        onSelectActiveStream?.(updatedVideo, res.analysis);
      } else if (passNum >= 2) {
        const fetchedAnalysis = await apiService.fetchVideoAnalysis(videoId, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        setAnalysisCache((prev) => ({ ...prev, [videoId]: fetchedAnalysis }));
        onSelectActiveStream?.(updatedVideo, fetchedAnalysis);
      } else {
        onSelectActiveStream?.(updatedVideo, analysisCache[videoId]);
      }

      // If Pass 0 completed, refresh video list from Firestore to pull automatic inventory association
      if (passNum === 0) {
        await fetchVideos(false);
      }

      setStatusBanner(
        `${passLabels[passNum]} completed for ${video.originalName} (${videoId}).`
      );
      return res;
    } catch (err: any) {
      const errMsg = err?.message || `Pass ${passNum} failed`;
      setPassesByVideo((prev) => {
        const current = ensurePasses(prev[videoId] || video.passes);
        return {
          ...prev,
          [videoId]: {
            ...current,
            [passKey]: {
              ...current[passKey],
              status: 'ERROR',
              error: errMsg,
            },
          },
        };
      });
      setVideos((prev) =>
        prev.map((v) => (v.videoId === videoId ? { ...v, status: 'FAILED' } : v))
      );
      setStatusBanner(`Error in ${passLabels[passNum]} (${videoId}): ${errMsg}`);
      throw err;
    } finally {
      setRunningPassMap((prev) => ({
        ...prev,
        [videoId]: { ...(prev[videoId] || {}), [passKey]: false },
      }));
    }
  };

  /**
   * Master "Run All Passes" handler: executes Pass 0 -> Pass 1 -> Pass 2 -> Pass 3 sequentially
   * so each pass card shows real-time spinners and updates its JSON output as it completes.
   */
  const handleRunAllPasses = async (video: VideoRecord) => {
    const { videoId } = video;
    setSelectedVideoId(videoId);
    setAnalyzingIds((prev) => ({ ...prev, [videoId]: true }));

    setVideos((prev) =>
      prev.map((v) => (v.videoId === videoId ? { ...v, status: 'ANALYZING' } : v))
    );
    if (latestUploadedVideo?.videoId === videoId) {
      setLatestUploadedVideo((prev) => (prev ? { ...prev, status: 'ANALYZING' } : prev));
    }

    try {
      await handleRunSinglePass(video, 0);
      await handleRunSinglePass(video, 1);
      await handleRunSinglePass(video, 2);
      const res3 = await handleRunSinglePass(video, 3);

      setStatusBanner(
        `All 4 AI Passes (Pass 0 – Pass 3) completed for ${video.originalName} (${videoId}) and persisted to Firestore video_analyses/${videoId}.`
      );

      if (res3?.analysis) {
        onSelectActiveStream?.(
          {
            ...video,
            status: 'ANALYSIS_COMPLETE',
            passes: ensurePasses(res3.passes),
          },
          res3.analysis
        );
      }
    } catch {
      // Individual pass error already handled and displayed in banner
    } finally {
      setAnalyzingIds((prev) => ({ ...prev, [videoId]: false }));
    }
  };

  /**
   * Inspect Results / Review in Sign-Off Tab handler.
   */
  const handleInspectResults = (video: VideoRecord, forceHitlTab: boolean = false) => {
    const cachedAnalysis = analysisCache[video.videoId];
    onSelectActiveStream?.(video, cachedAnalysis);

    if (forceHitlTab) {
      onSelectVideoForReview(video.videoId, 'hitl', cachedAnalysis);
      return;
    }

    const passes = passesByVideo[video.videoId] || video.passes;
    const detectedWorkflow =
      cachedAnalysis?.workflowClassification?.workflowType ||
      cachedAnalysis?.workloadClassification?.workflowType ||
      passes?.pass0?.data?.workflowType;
    const targetTab: 'inventory' | 'archive' =
      detectedWorkflow === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      video.originalName.toLowerCase().includes('archive') ||
      video.videoId.toLowerCase().includes('archive')
        ? 'archive'
        : 'inventory';

    onSelectVideoForReview(video.videoId, targetTab, cachedAnalysis);
  };

  const renderPassStatusBadge = (status: PassStatus, isRunning: boolean) => {
    if (isRunning || status === 'RUNNING') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold bg-blue-950/90 text-blue-300 border border-blue-500/60">
          <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
          <span>RUNNING</span>
        </span>
      );
    }
    if (status === 'COMPLETED') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold bg-emerald-950/90 text-emerald-300 border border-emerald-500/60">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          <span>COMPLETED</span>
        </span>
      );
    }
    if (status === 'ERROR') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold bg-rose-950/90 text-rose-300 border border-rose-500/60">
          <AlertCircle className="w-3 h-3 text-rose-400" />
          <span>ERROR</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold bg-slate-800 text-slate-400 border border-slate-700">
        <Clock className="w-3 h-3 text-slate-500" />
        <span>PENDING</span>
      </span>
    );
  };

  const renderIngestionBadge = (video: VideoRecord) => {
    if (video.status === 'UPLOADING') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-700/60">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Uploading</span>
        </span>
      );
    }
    if (video.status === 'TRANSCODING') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-yellow-950/80 text-yellow-300 border border-yellow-700/60">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Transcoding</span>
        </span>
      );
    }
    if (video.status === 'FAILED' && !video.normalizedGcsUri) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/80 text-rose-300 border border-rose-700/60">
          <AlertCircle className="w-3 h-3" />
          <span>Ingestion Failed</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-700/60">
        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
        <span>Ready for Analysis</span>
      </span>
    );
  };

  const renderAnalysisBadge = (video: VideoRecord) => {
    const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
    const anyPassRunning =
      Boolean(analyzingIds[video.videoId]) ||
      Object.values(runningPassMap[video.videoId] || {}).some(Boolean) ||
      video.status === 'ANALYZING';

    if (anyPassRunning) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-950/80 text-blue-300 border border-blue-600/60">
          <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
          <span>Running Pass...</span>
        </span>
      );
    }
    if (video.status === 'ANALYSIS_COMPLETE' || vPasses.pass3.status === 'COMPLETED') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/60">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          <span>Analysis Complete</span>
        </span>
      );
    }
    if (video.status === 'FAILED') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/80 text-rose-300 border border-rose-600/60">
          <AlertCircle className="w-3 h-3 text-rose-400" />
          <span>Error</span>
        </span>
      );
    }

    const completedCount = [vPasses.pass0, vPasses.pass1, vPasses.pass2, vPasses.pass3].filter(
      (p) => p.status === 'COMPLETED'
    ).length;
    if (completedCount > 0) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-cyan-950/80 text-cyan-300 border border-cyan-700/60">
          <span>{completedCount}/4 Passes Complete</span>
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-800/90 text-slate-400 border border-slate-700">
        <span>READY_FOR_ANALYSIS</span>
      </span>
    );
  };

  const renderInventoryBadge = (video: VideoRecord) => {
    const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
    const pass0Data = vPasses.pass0.data;
    const isInventoryWorkflow =
      pass0Data?.workflowType === 'INVENTORY_UPDATE_WORKFLOW';

    // 1. Matched / Associated inventory
    if (video.inventoryId) {
      const matchTypeLabel =
        video.inventoryAssociationType === 'MANUAL' ? 'Manual' : 'Auto-Matched';
      return (
        <div
          className="flex items-center gap-1.5 flex-wrap mt-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/60 font-mono">
            <Package className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>
              Linked to: {video.inventoryName || video.inventoryId} ({matchTypeLabel})
            </span>
          </span>
          {onNavigateToInventory && (
            <button
              type="button"
              onClick={() => onNavigateToInventory(video.inventoryId ?? undefined, video.videoId)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 transition-colors"
              title="View in Cryo-Inventory"
            >
              <span>View in Cryo-Inventory</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      );
    }

    // 2. Unmatched inventory workflow
    if (
      video.inventoryAssociationType === 'UNMATCHED' ||
      (isInventoryWorkflow && !video.inventoryId)
    ) {
      const unmatchedName =
        video.unmatchedInventoryName || pass0Data?.inventoryName || 'Unspecified';
      const isAssigning = Boolean(isAssigningMap[video.videoId]);
      const selectedInv = assigningInventoryMap[video.videoId] || (inventories[0]?.id ?? '');

      return (
        <div
          className="flex items-center gap-1.5 flex-wrap mt-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-600/60 font-mono">
            <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />
            <span>Unmatched inventory: &ldquo;{unmatchedName}&rdquo;</span>
          </span>

          <div className="flex items-center gap-1">
            <select
              value={selectedInv}
              onChange={(e) =>
                setAssigningInventoryMap((prev) => ({
                  ...prev,
                  [video.videoId]: e.target.value,
                }))
              }
              className="bg-slate-950 border border-slate-700 text-slate-200 text-[11px] rounded px-2 py-0.5 font-mono focus:border-cyan-500 focus:outline-none"
            >
              <option value="" disabled>
                Select inventory...
              </option>
              {inventories.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.name} ({inv.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedInv || isAssigning}
              onClick={() => handleAssignInventory(video.videoId, selectedInv)}
              className="px-2.5 py-0.5 rounded text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1"
            >
              {isAssigning && <Loader2 className="w-3 h-3 animate-spin" />}
              <span>Assign</span>
            </button>
          </div>
        </div>
      );
    }

    return null;
  };

  const isUploadingOrTranscoding =
    uploading || uploadStep === 'UPLOADING' || uploadStep === 'TRANSCODING';

  const selectedVideo =
    videos.find((v) => v.videoId === selectedVideoId) ||
    (videos.length > 0 ? videos[0] : null);

  const selectedPasses = selectedVideo
    ? ensurePasses(passesByVideo[selectedVideo.videoId] || selectedVideo.passes)
    : ensurePasses();

  const pass1Audit = selectedPasses.pass1?.executionAudit || selectedPasses.pass1?.data?.executionAudit;

  const passStepsConfig: Array<{
    passNumber: 0 | 1 | 2 | 3;
    passKey: 'pass0' | 'pass1' | 'pass2' | 'pass3';
    title: string;
    subtitle: string;
    buttonLabel: string;
    artifactFilename: string;
  }> = [
    {
      passNumber: 0,
      passKey: 'pass0',
      title: 'Pass 0: Workflow Classification (Flash @ 1 fps)',
      subtitle: 'Global workflow classification & audio transcription via Gemini Flash',
      buttonLabel: 'Run Pass 0',
      artifactFilename: 'workloadClassification.json',
    },
    {
      passNumber: 1,
      passKey: 'pass1',
      title: 'Pass 1: Action & Label Event Detection (Pro @ 1 fps)',
      subtitle:
        'Coarse temporal action span detection + box/vial label presentation events & action associations at 1 fps',
      buttonLabel: 'Run Pass 1',
      artifactFilename: 'action_detection_pass.json',
    },
    {
      passNumber: 2,
      passKey: 'pass2',
      title: 'Pass 2: Best Frames & Boundary Refinement (Temporal 4 fps)',
      subtitle:
        'Targeted 4 fps dual best-frame selection (highest contrast & minimal blur) & [start-1s, end+1s] action boundary refinement',
      buttonLabel: 'Run Pass 2',
      artifactFilename: 'event_detection_pass.json',
    },
    {
      passNumber: 3,
      passKey: 'pass3',
      title: 'Pass 3: Analysis Refinement (Full Res Crop)',
      subtitle: 'Multi-frame OCR conflation, spatial grid differencing & aggregation into video_analyses',
      buttonLabel: 'Run Pass 3',
      artifactFilename: 'analysis_refinement_pass.json',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Decoupled Video Ingestion & FFmpeg Transcoding Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-950 border border-indigo-800 text-indigo-400">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">
                Egocentric Video Ingestion & FFmpeg Normalization
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Decoupled Upload & Containerized FFmpeg Transcoding (H.264 CRF 17, 1080p, +faststart)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono text-cyan-300 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
            <Building className="w-3.5 h-3.5 text-cyan-400" />
            <span>gs://{tenant.bucketName || DEFAULT_GCS_BUCKET}/</span>
          </div>
        </div>

        {/* Drag & drop upload area */}
        <label
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="border-2 border-dashed border-slate-700 hover:border-cyan-500 rounded-2xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors bg-slate-950/60 hover:bg-slate-950 group"
        >
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadVideoFile(file);
            }}
            disabled={isUploadingOrTranscoding}
          />
          <div className="w-14 h-14 rounded-full bg-slate-800 group-hover:bg-cyan-950 text-slate-400 group-hover:text-cyan-400 flex items-center justify-center transition-colors mb-3">
            <FileVideo className="w-7 h-7" />
          </div>
          <span className="text-sm font-semibold text-slate-200">
            {selectedFile ? selectedFile.name : 'Choose raw wet-lab video (.mp4, .mov, .mkv)'}
          </span>
          <span className="text-xs text-slate-500 mt-1">
            {selectedFile
              ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB${
                  probedDuration ? ` • Duration: ${formatDuration(probedDuration)}` : ''
                }`
              : 'Egocentric video recorded with head-mounted or benchtop camera (click or drag & drop)'}
          </span>
        </label>

        {/* Action Button for Upload & Transcoding */}
        {selectedFile && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-400 font-mono">
              Target Bucket:{' '}
              <strong className="text-cyan-300">
                gs://{tenant.bucketName || DEFAULT_GCS_BUCKET}/
              </strong>
            </span>
            <button
              type="button"
              disabled={isUploadingOrTranscoding}
              onClick={uploadVideoHandler}
              className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 text-white font-semibold text-xs px-5 py-2.5 rounded-xl shadow-lg shadow-cyan-500/25 active:scale-95 transition-all"
            >
              {isUploadingOrTranscoding ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>
                    {uploadStep === 'UPLOADING'
                      ? 'Uploading Raw Video...'
                      : 'Transcoding & segmenting video in background...'}
                  </span>
                </>
              ) : (
                <>
                  <UploadCloud className="w-4 h-4" />
                  <span>Upload & Normalize Video (FFmpeg)</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Multi-Step Upload & Transcoding Progress Bar */}
        {uploadStep !== 'IDLE' && (
          <div className="mt-5 p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
              <div
                className={`flex items-center gap-2.5 p-2.5 rounded-lg border ${
                  uploadStep === 'UPLOADING'
                    ? 'bg-cyan-950/60 border-cyan-500/60 text-cyan-200'
                    : uploadStep === 'TRANSCODING' || uploadStep === 'SAVED'
                    ? 'bg-emerald-950/40 border-emerald-600/40 text-emerald-300'
                    : 'bg-rose-950/40 border-rose-600/40 text-rose-300'
                }`}
              >
                {uploadStep === 'UPLOADING' ? (
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
                <span>1. Uploading Raw Video</span>
              </div>

              <div
                className={`flex items-center gap-2.5 p-2.5 rounded-lg border ${
                  uploadStep === 'TRANSCODING'
                    ? 'bg-amber-950/60 border-amber-500/60 text-amber-200'
                    : uploadStep === 'SAVED'
                    ? 'bg-emerald-950/40 border-emerald-600/40 text-emerald-300'
                    : 'bg-slate-900 border-slate-800 text-slate-500'
                }`}
              >
                {uploadStep === 'TRANSCODING' ? (
                  <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                ) : uploadStep === 'SAVED' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-slate-600 shrink-0" />
                )}
                <span>2. Transcoding & segmenting video in background...</span>
              </div>

              <div
                className={`flex items-center gap-2.5 p-2.5 rounded-lg border ${
                  uploadStep === 'SAVED'
                    ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200'
                    : 'bg-slate-900 border-slate-800 text-slate-500'
                }`}
              >
                {uploadStep === 'SAVED' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-slate-600 shrink-0" />
                )}
                <span>3. Saved to Firestore `videos`</span>
              </div>
            </div>

            {uploadError && (
              <div className="flex items-center gap-2 text-xs font-mono text-rose-300">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* Status Banner */}
        {statusBanner && (
          <div className="mt-4 p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-cyan-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{statusBanner}</span>
            </div>
          </div>
        )}
      </div>

      {/* Persistent Video Streams Registry */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>Persistent Video Registry (Firestore `(default)` / `videos`)</span>
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Select a video below to set the global activeStream context and control individual AI pipeline passes
            </p>
          </div>

          <button
            type="button"
            onClick={() => { void fetchVideos(); }}
            disabled={isLoadingRegistry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRegistry ? 'animate-spin' : ''}`} />
            <span>Refresh Registry</span>
          </button>
        </div>

        {isLoadingRegistry && videos.length === 0 ? (
          <div className="p-10 flex flex-col items-center justify-center text-slate-400 space-y-2">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
            <span className="text-xs font-mono">Loading Video Streams Registry from Firestore...</span>
          </div>
        ) : videos.length === 0 ? (
          <div className="p-10 rounded-xl bg-slate-950/70 border border-slate-800 text-center space-y-2">
            <FileVideo className="w-8 h-8 text-slate-500 mx-auto" />
            <div className="text-sm font-semibold text-slate-300">
              No Uploaded Video Streams in Registry Yet
            </div>
            <p className="text-xs text-slate-500 font-mono">
              Upload a wet-lab video above to normalize it with FFmpeg and register it in Firestore `(default)`.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-mono uppercase text-slate-400 bg-slate-900/80">
                  <th className="py-3 px-4">Video Filename & Stream ID</th>
                  <th className="py-3 px-4">Upload Timestamp & Duration</th>
                  <th className="py-3 px-4">Transcoding / Ingestion</th>
                  <th className="py-3 px-4">Pipeline Status</th>
                  <th className="py-3 px-4 text-right">Action Controls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-xs">
                {videos.map((video) => {
                  const isActive =
                    activeStreamId === video.videoId || selectedVideo?.videoId === video.videoId;
                  const isVideoAnalyzing =
                    Boolean(analyzingIds[video.videoId]) ||
                    Object.values(runningPassMap[video.videoId] || {}).some(Boolean) ||
                    video.status === 'ANALYZING';
                  const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
                  const isAnalysisComplete =
                    video.status === 'ANALYSIS_COMPLETE' || vPasses.pass3.status === 'COMPLETED';

                  return (
                    <tr
                      key={video.videoId}
                      onClick={() => handleSelectVideo(video)}
                      className={`cursor-pointer transition-colors ${
                        isActive ? 'bg-cyan-950/25' : 'hover:bg-slate-900/60'
                      }`}
                    >
                      <td className="py-3.5 px-4">
                        <div className="flex items-start gap-2.5">
                          <FileVideo className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                          <div>
                            <div className="font-semibold text-slate-100 flex items-center gap-2">
                              <span>{video.originalName}</span>
                              {activeStreamId === video.videoId && (
                                <span className="text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-1.5 py-0.5 rounded">
                                  ACTIVE STREAM
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                              ID: <span className="text-slate-300">{video.videoId}</span>
                            </div>
                            {renderInventoryBadge(video)}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono">
                        <div className="text-slate-200">{formatTimestamp(video.uploadedAt)}</div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span>Duration: {formatDuration(video.durationSeconds)}</span>
                          {video.fileSizeBytes ? (
                            <span>• {(video.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB</span>
                          ) : null}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">{renderIngestionBadge(video)}</td>

                      <td className="py-3.5 px-4">{renderAnalysisBadge(video)}</td>

                      <td className="py-3.5 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          <button
                            type="button"
                            disabled={
                              isVideoAnalyzing ||
                              video.status === 'UPLOADING' ||
                              video.status === 'TRANSCODING'
                            }
                            onClick={() => handleRunAllPasses(video)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {isVideoAnalyzing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            <span>Run All Passes</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleSelectVideo(video)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                              activeStreamId === video.videoId
                                ? 'bg-cyan-600/30 text-cyan-200 border-cyan-400/60'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                            }`}
                          >
                            <Radio className="w-3.5 h-3.5 text-cyan-400" />
                            <span>Select as Active Stream</span>
                          </button>

                          <button
                            type="button"
                            disabled={!isAnalysisComplete && vPasses.pass2.status !== 'COMPLETED'}
                            onClick={() => handleInspectResults(video)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Inspect Results</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Hierarchical AI Pipeline Pass Stepper & Execution Inspector */}
      {selectedVideo && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
            <div>
              <div className="flex items-center gap-2.5">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-slate-100">
                  Hierarchical Pipeline Pass Stepper & Artifact Inspector
                </h3>
                <span className="text-xs font-mono px-2.5 py-0.5 rounded-md bg-slate-950 text-cyan-300 border border-slate-800">
                  {selectedVideo.originalName} ({selectedVideo.videoId})
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-1">
                Execute individual passes (Pass 0 → Pass 3) or all passes sequentially and inspect each JSON artifact
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={
                  Boolean(analyzingIds[selectedVideo.videoId]) ||
                  Object.values(runningPassMap[selectedVideo.videoId] || {}).some(Boolean)
                }
                onClick={() => handleRunAllPasses(selectedVideo)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {analyzingIds[selectedVideo.videoId] ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Running All Passes...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    <span>Run All Passes</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 4 AI Pass Cards + HITL Verification Card */}
          <div className="space-y-3">
            {passStepsConfig.map((step) => {
              const passState = selectedPasses[step.passKey] || { status: 'PENDING' };
              const isPassRunning =
                Boolean(runningPassMap[selectedVideo.videoId]?.[step.passKey]) ||
                passState.status === 'RUNNING';
              const drawerKey = `${selectedVideo.videoId}_${step.passKey}`;
              const isDrawerOpen = Boolean(openJsonDrawers[drawerKey]);
              const hasJsonData = passState.data !== undefined && passState.data !== null;
              const pass0Data = selectedPasses.pass0?.data;
              const pass1Data = selectedPasses.pass1?.data;

              return (
                <div
                  key={step.passKey}
                  className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-sm font-bold text-slate-100 flex items-center gap-2.5">
                        <span>{step.title}</span>
                        {renderPassStatusBadge(passState.status, isPassRunning)}
                        {step.passKey === 'pass0' && (
                          <select
                            value={pass0Model}
                            onChange={(e) => setPass0Model(e.target.value)}
                            disabled={isPassRunning}
                            className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-purple-300 border border-purple-700/50 focus:outline-none focus:border-purple-500 cursor-pointer disabled:opacity-50"
                          >
                            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                            <option value="gemini-1.5-pro-002">Gemini 1.5 Pro (002)</option>
                            <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                          </select>
                        )}
                        {step.passKey === 'pass1' && (
                          <>
                            <select
                              value={pass1Model}
                              onChange={(e) => setPass1Model(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-purple-300 border border-purple-700/50 focus:outline-none focus:border-purple-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                              <option value="gemini-1.5-pro-002">Gemini 1.5 Pro (002)</option>
                              <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            </select>
                            <select
                              value={pass1Thinking}
                              onChange={(e) => setPass1Thinking(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-indigo-300 border border-indigo-700/50 focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="MEDIUM">Thinking: Medium</option>
                              <option value="HIGH">Thinking: High</option>
                              <option value="LOW">Thinking: Low</option>
                              <option value="OFF">Thinking: Off</option>
                            </select>
                          </>
                        )}
                        {step.passKey === 'pass2' && (
                          <>
                            <select
                              value={pass2Model}
                              onChange={(e) => setPass2Model(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-purple-300 border border-purple-700/50 focus:outline-none focus:border-purple-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                              <option value="gemini-1.5-pro-002">Gemini 1.5 Pro (002)</option>
                              <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            </select>
                            <select
                              value={pass2Thinking}
                              onChange={(e) => setPass2Thinking(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-indigo-300 border border-indigo-700/50 focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="MEDIUM">Thinking: Medium</option>
                              <option value="HIGH">Thinking: High</option>
                              <option value="LOW">Thinking: Low</option>
                              <option value="OFF">Thinking: Off</option>
                            </select>
                          </>
                        )}
                        {step.passKey === 'pass3' && (
                          <>
                            <select
                              value={pass3Model}
                              onChange={(e) => setPass3Model(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-purple-300 border border-purple-700/50 focus:outline-none focus:border-purple-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                              <option value="gemini-1.5-pro-002">Gemini 1.5 Pro (002)</option>
                              <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                            </select>
                            <select
                              value={pass3Thinking}
                              onChange={(e) => setPass3Thinking(e.target.value)}
                              disabled={isPassRunning}
                              className="px-2 py-0.5 text-xs font-mono rounded bg-slate-900 text-indigo-300 border border-indigo-700/50 focus:outline-none focus:border-indigo-500 cursor-pointer disabled:opacity-50"
                            >
                              <option value="MEDIUM">Thinking: Medium</option>
                              <option value="HIGH">Thinking: High</option>
                              <option value="LOW">Thinking: Low</option>
                              <option value="OFF">Thinking: Off</option>
                            </select>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 font-mono">{step.subtitle}</p>
                      {Boolean(
                        (passState.status === 'ERROR' ||
                          (passState.error && passState.status !== 'COMPLETED')) &&
                          passState.error
                      ) && (
                        <p className="text-xs text-rose-400 font-mono mt-1">
                          Error: {passState.error}
                        </p>
                      )}
                      {step.passKey === 'pass0' && renderInventoryBadge(selectedVideo)}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleJsonDrawer(drawerKey)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 transition-colors"
                      >
                        {isDrawerOpen ? (
                          <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-cyan-400" />
                        )}
                        <FileJson className="w-3.5 h-3.5 text-cyan-400" />
                        <span>View {step.artifactFilename}</span>
                      </button>

                      {/* Prompt & Parameters Inspection Button */}
                      {(step.passKey === 'pass1' || step.passKey === 'pass0' || step.passKey === 'pass2' || step.passKey === 'pass3') && (hasJsonData || Boolean(passState.executionAudit)) && (
                        <button
                          type="button"
                          className="px-2.5 py-1 text-xs rounded border border-cyan-800 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors flex items-center gap-1.5"
                          onClick={() => {
                            const rawAudit: ExecutionAudit | undefined =
                              passState.executionAudit ||
                              passState.data?.executionAudit;
                            const fallbackModel =
                              step.passKey === 'pass0'
                                ? 'gemini-3.8-flash'
                                : step.passKey === 'pass1'
                                ? pass1Model || 'gemini-1.5-pro'
                                : step.passKey === 'pass2'
                                ? pass2Model || 'gemini-1.5-pro'
                                : pass3Model || 'gemini-1.5-pro';
                            const fallbackThinking =
                              step.passKey === 'pass0'
                                ? 'OFF'
                                : step.passKey === 'pass1'
                                ? pass1Thinking || 'MEDIUM'
                                : step.passKey === 'pass2'
                                ? pass2Thinking || 'MEDIUM'
                                : pass3Thinking || 'MEDIUM';
                            const rawModel =
                              rawAudit?.model ||
                              (rawAudit as any)?.modelUsed ||
                              (passState as any).modelUsed ||
                              passState.data?.modelUsed ||
                              fallbackModel;
                            const normalizedModel =
                              rawModel === 'gemini-4-argon' ? 'gemini-1.5-pro' : rawModel;
                            const resolvedThinking =
                              rawAudit?.thinkingLevel ||
                              (rawAudit?.generationConfig as any)?.thinkingConfig?.thinkingLevel ||
                              (passState as any).thinkingLevel ||
                              passState.data?.thinkingLevel ||
                              fallbackThinking;
                            const baseAudit: ExecutionAudit = rawAudit || {
                              model: normalizedModel,
                              thinkingLevel: resolvedThinking,
                              endpoint: 'us',
                              calledAt: passState.completedAt || new Date().toISOString(),
                              promptText:
                                step.passKey === 'pass1'
                                  ? 'Pass 1 Action Detection Prompt'
                                  : step.passKey === 'pass2'
                                  ? 'Pass 2 Event Detection & Boundary Refinement Prompt'
                                  : step.passKey === 'pass3'
                                  ? 'Pass 3 Analysis Refinement Prompt'
                                  : 'Pass 0 Workflow Classification Prompt',
                              systemInstruction: null,
                              generationConfig:
                                step.passKey === 'pass1'
                                  ? {
                                      temperature: 0.2,
                                      maxOutputTokens: 16384,
                                      responseMimeType: 'application/json',
                                      thinkingConfig: {
                                        thinkingLevel: resolvedThinking,
                                      },
                                    }
                                  : step.passKey === 'pass2'
                                  ? {
                                      temperature: 0.1,
                                      fps: 4,
                                      responseMimeType: 'application/json',
                                      thinkingConfig: {
                                        thinkingLevel: resolvedThinking,
                                      },
                                    }
                                  : step.passKey === 'pass3'
                                  ? {
                                      responseMimeType: 'application/json',
                                      thinkingConfig: {
                                        thinkingLevel: resolvedThinking,
                                      },
                                    }
                                  : {
                                      temperature: 0.1,
                                      maxOutputTokens: 8192,
                                      responseMimeType: 'application/json',
                                    },
                              videoMetadata: {
                                durationSeconds:
                                  selectedVideo.durationSeconds || (selectedVideo as any).durationSec || 120,
                                uri: selectedVideo.normalizedGcsUri || selectedVideo.rawGcsUri,
                              },
                              modelDiagnostics: {
                                finishReason: 'STOP',
                                thoughtsTokenCount:
                                  (passState as any).executionAudit?.modelDiagnostics?.thoughtsTokenCount ??
                                  (passState.data as any)?.executionAudit?.modelDiagnostics?.thoughtsTokenCount ??
                                  (step.passKey !== 'pass0' ? 0 : undefined),
                              },
                            };
                            const auditData: ExecutionAudit = {
                              ...baseAudit,
                              model: normalizedModel,
                              thinkingLevel: resolvedThinking,
                              generationConfig: {
                                ...(baseAudit.generationConfig || {}),
                                ...(resolvedThinking && resolvedThinking !== 'OFF'
                                  ? {
                                      thinkingConfig: {
                                        ...((baseAudit.generationConfig as any)?.thinkingConfig || {}),
                                        thinkingLevel: resolvedThinking,
                                      },
                                    }
                                  : {}),
                              },
                            };
                            setInspectionModal({ audit: auditData, title: step.title });
                            setCopiedPrompt(false);
                          }}
                        >
                          🔍 Inspect Prompt & Params
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={isPassRunning || Boolean(analyzingIds[selectedVideo.videoId])}
                        onClick={() => handleRunSinglePass(selectedVideo, step.passNumber)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {isPassRunning ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-300" />
                            <span>Running...</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5 text-indigo-300" />
                            <span>{step.buttonLabel}</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Collapsible JSON Artifact Viewer */}
                  {isDrawerOpen && (
                    <div className="mt-2 pt-3 border-t border-slate-800/80 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-300">Artifact: {step.artifactFilename}</span>
                          {passState.completedAt && (
                            <span>• Completed: {formatTimestamp(passState.completedAt)}</span>
                          )}
                        </div>

                        {/* Pass 1 & Pass 2 toggle between structured cards and raw JSON */}
                        {(step.passKey === 'pass1' || step.passKey === 'pass2') && hasJsonData && (
                          <div className="flex items-center gap-1 bg-slate-900 border border-slate-700/80 rounded-lg p-0.5">
                            <button
                              type="button"
                              onClick={() =>
                                setShowRawJsonMap((prev) => ({
                                  ...prev,
                                  [drawerKey]: false,
                                }))
                              }
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                                !showRawJsonMap[drawerKey]
                                  ? 'bg-indigo-600 text-white font-semibold'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              {step.passKey === 'pass2' ? 'Events & Best Frames' : 'Interval Cards'}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setShowRawJsonMap((prev) => ({
                                  ...prev,
                                  [drawerKey]: true,
                                }))
                              }
                              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                                showRawJsonMap[drawerKey]
                                  ? 'bg-indigo-600 text-white font-semibold'
                                  : 'text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              Raw JSON
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Seek feedback toast */}
                      {seekFeedback && step.passKey === 'pass1' && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-950/80 border border-cyan-700 text-xs text-cyan-200 font-mono">
                          <Clock className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                          <span>{seekFeedback}</span>
                        </div>
                      )}

                      {/* Pass 1: Fine-Grained Temporal Interval Cards View */}
                      {step.passKey === 'pass1' && hasJsonData && !showRawJsonMap[drawerKey] ? (
                        (() => {
                          const pass1Data = passState.data;
                          const rawActions = Array.isArray(pass1Data)
                            ? pass1Data
                            : Array.isArray(pass1Data?.actions)
                            ? pass1Data.actions
                            : [];
                          const pass1Events: any[] = Array.isArray(pass1Data?.events)
                            ? pass1Data.events
                            : [];
                          const totalDetected = pass1Data?.totalActionsDetected ?? rawActions.length;
                          const workflowCtx = pass1Data?.workflowContext;

                          if (rawActions.length === 0 && pass1Events.length === 0) {
                            return (
                              <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 text-center text-xs text-slate-400 font-mono">
                                No action intervals detected in this pass.
                              </div>
                            );
                          }

                          return (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between text-xs font-mono px-1">
                                <span className="text-indigo-300 font-semibold flex items-center gap-1.5">
                                  <Sparkles className="w-3.5 h-3.5" />
                                  Total Actions Detected: {totalDetected} ({rawActions.filter((a: any) => (a.actionType || a.actionClass || '').includes('INSERTION')).length} Insertions, {rawActions.filter((a: any) => (a.actionType || a.actionClass || '').includes('REMOVAL')).length} Removals) • Label Events: {pass1Events.length}
                                </span>
                                <div className="flex items-center gap-2">
                                  {pass1Data?.modelUsed && (
                                    <span className="px-2 py-0.5 text-[11px] rounded bg-purple-950/60 text-purple-300 border border-purple-700/50">
                                      Model: {pass1Data.modelUsed}
                                    </span>
                                  )}
                                  {workflowCtx && (
                                    <span className="text-slate-400 text-[11px] bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                                      {workflowCtx}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {rawActions.map((actionItem: any, idx: number) => {
                                  const actId = actionItem.actionId || `act_${idx + 1}`;
                                  const isSelected = activeSeekedActionId === actId;
                                  const startSec =
                                    typeof actionItem.startTimestampSeconds === 'number'
                                      ? actionItem.startTimestampSeconds
                                      : actionItem.startTime
                                      ? parseTimeStringToSeconds(actionItem.startTime)
                                      : 0;
                                  const endSec =
                                    typeof actionItem.endTimestampSeconds === 'number'
                                      ? actionItem.endTimestampSeconds
                                      : actionItem.endTime
                                      ? parseTimeStringToSeconds(actionItem.endTime)
                                      : startSec + 5;
                                  const timeRangeStr = `${actionItem.startTime || formatDuration(startSec)} - ${
                                    actionItem.endTime || formatDuration(endSec)
                                  }`;
                                  const durationSec = Math.max(0, endSec - startSec).toFixed(1);
                                  const actType = actionItem.actionType || actionItem.actionClass || 'ACTION';
                                  const targetCoord =
                                    actionItem.targetCoordinate ||
                                    actionItem.targetLocation?.coordinate ||
                                    (actionItem.boxRowId
                                      ? `${actionItem.boxRowId}${actionItem.boxColId || ''}`
                                      : undefined);
                                  const confidence = Math.round(
                                    (typeof actionItem.confidenceScore === 'number'
                                      ? actionItem.confidenceScore
                                      : 0.95) * 100
                                  );

                                  let typeBadgeColor = 'bg-slate-800 text-slate-300 border-slate-700';
                                  if (actType === 'VIAL_INSERTION' || actType.includes('INSERTION')) {
                                    typeBadgeColor = 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80';
                                  } else if (actType === 'VIAL_REMOVAL' || actType.includes('REMOVAL')) {
                                    typeBadgeColor = 'bg-amber-950/80 text-amber-300 border-amber-800/80';
                                  } else if (actType.includes('SEEDING')) {
                                    typeBadgeColor = 'bg-cyan-950/80 text-cyan-300 border-cyan-800/80';
                                  } else if (actType.includes('MIXING')) {
                                    typeBadgeColor = 'bg-purple-950/80 text-purple-300 border-purple-800/80';
                                  }

                                  return (
                                    <div
                                      key={actId}
                                      className={`rounded-xl p-3.5 space-y-2.5 transition-all border ${
                                        isSelected
                                          ? 'bg-indigo-950/50 border-indigo-500 shadow-lg shadow-indigo-500/10'
                                          : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                                      }`}
                                    >
                                      {/* Top Row: Interval & Action Type */}
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                                          <Clock className="w-3.5 h-3.5 text-cyan-400" />
                                          <span>{timeRangeStr}</span>
                                          <span className="text-[10px] text-slate-400 font-normal">
                                            ({durationSec}s)
                                          </span>
                                        </div>

                                        <span
                                          className={`text-[11px] font-mono px-2 py-0.5 rounded border uppercase font-semibold ${typeBadgeColor}`}
                                        >
                                          {actType}
                                        </span>
                                      </div>

                                      {/* Middle Row: Description */}
                                      <p className="text-xs text-slate-200 line-clamp-2">
                                        {actionItem.description || `${actType} action detected`}
                                      </p>

                                      {Array.isArray(actionItem.eventList) && actionItem.eventList.length > 0 && (
                                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                                          <span className="text-slate-400">Associated Label Events:</span>
                                          {actionItem.eventList.map((evtId: string) => (
                                            <span
                                              key={evtId}
                                              className="px-1.5 py-0.5 rounded bg-indigo-950/70 text-indigo-300 border border-indigo-700/60"
                                            >
                                              {evtId}
                                            </span>
                                          ))}
                                        </div>
                                      )}

                                      {typeof actionItem.refinedStartTimestampSeconds === 'number' &&
                                        typeof actionItem.pass1StartTimestampSeconds === 'number' && (
                                          <div className="text-[10px] font-mono text-purple-300 bg-purple-950/40 border border-purple-800/50 rounded px-2 py-1 flex items-center justify-between">
                                            <span>
                                              Pass 1 (1fps): {actionItem.pass1StartTimestampSeconds.toFixed(2)}s–
                                              {(actionItem.pass1EndTimestampSeconds ?? endSec).toFixed(2)}s
                                            </span>
                                            <span>
                                              Pass 2 (4fps): {actionItem.refinedStartTimestampSeconds.toFixed(2)}s–
                                              {(actionItem.refinedEndTimestampSeconds ?? endSec).toFixed(2)}s
                                            </span>
                                          </div>
                                        )}

                                      {/* Bottom Row: Metadata Chips + Seek Button */}
                                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/60 text-xs">
                                        <div className="flex flex-wrap items-center gap-2">
                                          {targetCoord && (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-slate-950 text-indigo-300 border border-slate-800">
                                              <MapPin className="w-3 h-3 text-indigo-400" />
                                              <span>Target: {targetCoord}</span>
                                            </span>
                                          )}
                                          <span
                                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border ${
                                              confidence >= 90
                                                ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50'
                                                : confidence >= 70
                                                ? 'bg-amber-950/40 text-amber-300 border-amber-800/50'
                                                : 'bg-rose-950/40 text-rose-300 border-rose-800/50'
                                            }`}
                                          >
                                            <CheckCircle2 className="w-3 h-3" />
                                            <span>{confidence}% Conf</span>
                                          </span>
                                        </div>

                                        {/* Seek Video Button */}
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleSeekToInterval(
                                              startSec,
                                              actId,
                                              actionItem.startTime || formatDuration(startSec)
                                            )
                                          }
                                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium transition-colors border ${
                                            isSelected
                                              ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-bold'
                                              : 'bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border-cyan-800/70 hover:border-cyan-600'
                                          }`}
                                        >
                                          <Play className="w-3 h-3 fill-current" />
                                          <span>Seek Video</span>
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              {/* Pass 1 Label Presentation Events & Action Associations */}
                              {pass1Events.length > 0 && (
                                <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-3.5 space-y-2.5">
                                  <div className="flex items-center justify-between text-xs font-mono">
                                    <span className="font-semibold text-cyan-300">
                                      Pass 1 Label Presentation Events & Action Associations (1 fps)
                                    </span>
                                    <span className="text-[11px] text-slate-400">
                                      Best frames extracted at 4 fps in Pass 2
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                    {pass1Events.map((evt: any, eIdx: number) => {
                                      const evtId = evt.eventId || `evt_${eIdx + 1}`;
                                      const isBoxEvt = String(evt.eventClass || '').includes('BOX_LABEL');
                                      const assocIds: string[] =
                                        Array.isArray(evt.actionIds) && evt.actionIds.length > 0
                                          ? evt.actionIds
                                          : evt.actionId
                                          ? [evt.actionId]
                                          : [];
                                      const evtStart = typeof evt.startTime === 'number' ? evt.startTime : 0;
                                      const evtEnd = typeof evt.endTime === 'number' ? evt.endTime : evtStart;

                                      return (
                                        <div
                                          key={evtId}
                                          className="rounded-lg bg-slate-900/90 border border-slate-800 p-3 space-y-2 text-xs font-mono"
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <span
                                              className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                                                isBoxEvt
                                                  ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/60'
                                                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
                                              }`}
                                            >
                                              {isBoxEvt
                                                ? 'BOX_LABEL_PRESENTATION'
                                                : 'VIAL_LABEL_PRESENTATION'}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleSeekToInterval(
                                                  evtStart,
                                                  evtId,
                                                  `${evtStart.toFixed(1)}s`
                                                )
                                              }
                                              className="text-[11px] text-cyan-300 hover:text-cyan-200 flex items-center gap-1"
                                            >
                                              <Clock className="w-3 h-3" />
                                              <span>
                                                {evtStart.toFixed(1)}s–{evtEnd.toFixed(1)}s
                                              </span>
                                            </button>
                                          </div>
                                          {evt.description && (
                                            <p className="text-[11px] text-slate-300 font-sans">
                                              {evt.description}
                                            </p>
                                          )}
                                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                            <span className="text-slate-400">
                                              Associated Actions ({assocIds.length}):
                                            </span>
                                            {assocIds.map((aid) => (
                                              <span
                                                key={aid}
                                                className="px-1.5 py-0.5 rounded bg-indigo-950/70 text-indigo-200 border border-indigo-700/50"
                                              >
                                                {aid}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()
                      ) : step.passKey === 'pass2' && hasJsonData && !showRawJsonMap[drawerKey] ? (
                        (() => {
                          const pass2Data = passState.data;
                          const rawEvents: any[] = Array.isArray(pass2Data)
                            ? pass2Data
                            : Array.isArray(pass2Data?.events)
                            ? pass2Data.events
                            : [];
                          const pass1Raw = selectedPasses.pass1?.data;
                          const pass1Actions: any[] = Array.isArray(pass1Raw)
                            ? pass1Raw
                            : Array.isArray(pass1Raw?.actions)
                            ? pass1Raw.actions
                            : [];
                          const refinedActions: any[] =
                            Array.isArray((pass2Data as any)?.refinedActions) &&
                            (pass2Data as any).refinedActions.length > 0
                              ? (pass2Data as any).refinedActions
                              : pass1Actions.filter(
                                  (a: any) =>
                                    typeof a.beforeActionTimestampSeconds === 'number' ||
                                    typeof a.refinedStartTimestampSeconds === 'number' ||
                                    typeof a.startTimestampSeconds === 'number'
                                );

                          return (
                            <div className="space-y-4">
                              {/* Summary Header */}
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono px-1">
                                <span className="text-purple-300 font-semibold flex items-center gap-1.5">
                                  <Sparkles className="w-3.5 h-3.5" />
                                  Detected Presentation Events: {rawEvents.length} (Box Labels &amp; Vial Labels)
                                </span>
                                <span className="px-2 py-0.5 text-[11px] rounded bg-cyan-950/60 text-cyan-300 border border-cyan-700/50">
                                  4 FPS Action Boundary Refinement Window: [Pass1 Start - 1s, Pass1 End + 1s]
                                </span>
                              </div>

                              {/* 1. Box & Vial Label Presentation Events + 2 Best Frames */}
                              {rawEvents.length === 0 ? (
                                <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 text-center text-xs text-slate-400 font-mono">
                                  No label presentation events detected in Pass 2.
                                </div>
                              ) : (
                                <div className="space-y-3">
                                  {rawEvents.map((evt: any, idx: number) => {
                                    const evtId = evt.eventId || `evt_${idx + 1}`;
                                    const evtClass = String(evt.eventClass || 'VIAL_LABEL_PRESENTATION');
                                    const isBoxLabel = evtClass.toUpperCase().includes('BOX_LABEL');
                                    const startSec = Number(evt.startTime || 0);
                                    const endSec = Number(evt.endTime || startSec);
                                    const associatedActionIds: string[] =
                                      Array.isArray(evt.actionIds) && evt.actionIds.length > 0
                                        ? evt.actionIds
                                        : evt.actionId
                                        ? [evt.actionId]
                                        : [];

                                    const bestFrames: any[] =
                                      Array.isArray(evt.bestFrames) && evt.bestFrames.length > 0
                                        ? evt.bestFrames
                                        : (evt.bestShotUrls || []).map((u: string, bIdx: number) => ({
                                            frameType: bIdx === 0 ? 'HIGHEST_CONTRAST' : 'MINIMAL_BLUR',
                                            label: bIdx === 0 ? 'Highest Contrast' : 'Minimal Blur',
                                            timestampSeconds: evt.bestShotTimes?.[bIdx] ?? startSec,
                                            gcsUri: u,
                                            url: u.startsWith('gs://')
                                              ? `/api/videos/${encodeURIComponent(
                                                  selectedVideo.videoId
                                                )}/frames/${encodeURIComponent(u.split('/').pop() || 'frame.jpg')}`
                                              : u,
                                          }));

                                    return (
                                      <div
                                        key={evtId}
                                        className="rounded-xl p-4 bg-slate-900/95 border border-slate-800 space-y-3"
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <span
                                              className={`text-[11px] font-mono px-2.5 py-0.5 rounded border font-semibold ${
                                                isBoxLabel
                                                  ? 'bg-amber-950/80 text-amber-300 border-amber-700/80'
                                                  : 'bg-purple-950/80 text-purple-300 border-purple-700/80'
                                              }`}
                                            >
                                              {isBoxLabel ? '📦 BOX LABEL PRESENTATION' : '🧪 VIAL LABEL PRESENTATION'}
                                            </span>
                                            <span className="text-xs font-mono text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                                              {startSec.toFixed(2)}s – {endSec.toFixed(2)}s
                                            </span>
                                            <span className="text-[11px] font-mono text-slate-400">
                                              ID: {evtId}
                                            </span>
                                          </div>

                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleSeekToInterval(
                                                startSec,
                                                evtId,
                                                `${startSec.toFixed(1)}s`
                                              )
                                            }
                                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/70 transition-colors"
                                          >
                                            <Play className="w-3 h-3 fill-current" />
                                            <span>Seek Event</span>
                                          </button>
                                        </div>

                                        {/* Associated Actions & Spoken Context */}
                                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                                          <span className="text-slate-400">Associated Pass 1 Actions:</span>
                                          {associatedActionIds.map((aid) => (
                                            <span
                                              key={aid}
                                              className="px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-200 border border-indigo-700/70 text-[11px] font-semibold"
                                            >
                                              {aid}
                                            </span>
                                          ))}
                                          {evt.spokenContext && (
                                            <span className="px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-700/60 text-[11px]">
                                              🗣 Spoken: &ldquo;{evt.spokenContext}&rdquo;
                                            </span>
                                          )}
                                        </div>

                                        {evt.associationReason && (
                                          <p className="text-[11px] text-slate-400 font-mono">
                                            {evt.associationReason}
                                          </p>
                                        )}

                                        {/* 2 Best Frames: Highest Contrast & Minimal Blur */}
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                                          {bestFrames.map((frame: any, fIdx: number) => {
                                            const isContrast = frame.frameType === 'HIGHEST_CONTRAST' || fIdx === 0;
                                            const frameTs = Number(
                                              frame.timestampSeconds ?? frame.timestamp ?? startSec
                                            );
                                            const rawUrl = String(frame.url || frame.gcsUri || '');
                                            const fallbackFilename =
                                              rawUrl.split('/').pop() ||
                                              `frame_${evtId}_${isContrast ? 'contrast' : 'blur'}_${Number(
                                                frameTs.toFixed(2)
                                              )}.jpg`;
                                            const basePreviewUrl =
                                              rawUrl && !rawUrl.startsWith('gs://')
                                                ? rawUrl
                                                : `/api/videos/${encodeURIComponent(
                                                    selectedVideo.videoId
                                                  )}/frames/${encodeURIComponent(fallbackFilename)}`;
                                            const previewUrl = basePreviewUrl.includes('?')
                                              ? basePreviewUrl
                                              : `${basePreviewUrl}?t=${Number(frameTs.toFixed(2))}`;
                                            return (
                                              <div
                                                key={`${evtId}_frame_${fIdx}`}
                                                className="rounded-lg bg-slate-950 border border-slate-800 p-2.5 flex flex-col gap-2"
                                              >
                                                <div className="flex items-center justify-between text-[11px] font-mono">
                                                  <span
                                                    className={`px-2 py-0.5 rounded font-semibold border ${
                                                      isContrast
                                                        ? 'bg-amber-950/80 text-amber-300 border-amber-700/70'
                                                        : 'bg-sky-950/80 text-sky-300 border-sky-700/70'
                                                    }`}
                                                  >
                                                    {isContrast
                                                      ? '1. Highest Contrast Frame'
                                                      : '2. Minimal Blur Frame'}
                                                  </span>
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      handleSeekToInterval(
                                                        frameTs,
                                                        `${evtId}_${fIdx}`,
                                                        `${frameTs.toFixed(2)}s`
                                                      )
                                                    }
                                                    className="text-cyan-400 hover:underline"
                                                  >
                                                    @{frameTs.toFixed(2)}s
                                                  </button>
                                                </div>

                                                <div className="w-full rounded bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center">
                                                  <img
                                                    src={previewUrl}
                                                    alt={frame.label || frame.frameType}
                                                    className="w-full h-auto max-h-[360px] object-contain block"
                                                  />
                                                </div>

                                                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
                                                  {typeof frame.contrastScore === 'number' && (
                                                    <span>Contrast: {frame.contrastScore.toFixed(1)}</span>
                                                  )}
                                                  {typeof frame.blurScore === 'number' && (
                                                    <span>Blur: {frame.blurScore.toFixed(3)}</span>
                                                  )}
                                                  {typeof frame.sharpnessScore === 'number' && (
                                                    <span>Sharpness: {frame.sharpnessScore.toFixed(1)}</span>
                                                  )}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {/* 2. 4 FPS Refined Inventory Update Action Boundaries */}
                              {refinedActions.length > 0 && (
                                <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3">
                                  <div className="text-xs font-mono font-semibold text-cyan-300 flex items-center justify-between">
                                    <span>Refined Inventory Update Action Boundaries (4 FPS)</span>
                                    <span className="text-[10px] text-slate-400">
                                      Window = [Pass 1 Start - 1.0s, Pass 1 End + 1.0s] @ 4 fps
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-1 gap-2.5">
                                    {refinedActions.map((ra: any) => {
                                      const p1Start = Number(
                                        ra.pass1StartTimestampSeconds ?? ra.startTimestampSeconds ?? 0
                                      );
                                      const p1End = Number(
                                        ra.pass1EndTimestampSeconds ?? ra.endTimestampSeconds ?? p1Start
                                      );
                                      const winStart = Number(
                                        ra.searchWindowStartSeconds ??
                                          ra.refinementWindow?.startSeconds ??
                                          Math.max(0, p1Start - 1)
                                      );
                                      const winEnd = Number(
                                        ra.searchWindowEndSeconds ??
                                          ra.refinementWindow?.endSeconds ??
                                          p1End + 1
                                      );
                                      const refStart = Number(
                                        ra.refinedStartTimestampSeconds ??
                                          ra.startTimestampSeconds ??
                                          p1Start
                                      );
                                      const refEnd = Number(
                                        ra.refinedEndTimestampSeconds ??
                                          ra.endTimestampSeconds ??
                                          p1End
                                      );
                                      const actType = String(ra.actionType || ra.actionClass || 'VIAL_ACTION');
                                      const associatedEvents: string[] = Array.isArray(ra.associatedEventIds)
                                        ? ra.associatedEventIds
                                        : Array.isArray(ra.eventList)
                                        ? ra.eventList
                                        : [];

                                      return (
                                        <div
                                          key={ra.actionId}
                                          className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-[11px] font-mono space-y-2"
                                        >
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex flex-wrap items-center gap-2">
                                              <span className="font-bold text-indigo-300">{ra.actionId}</span>
                                              <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 text-[10px]">
                                                {actType}
                                              </span>
                                              <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/60 text-emerald-300 font-semibold">
                                                Refined (4fps): {refStart.toFixed(2)}s – {refEnd.toFixed(2)}s
                                                {ra.startTime && ra.endTime ? ` (${ra.startTime} – ${ra.endTime})` : ''}
                                              </span>
                                            </div>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleSeekToInterval(
                                                  refStart,
                                                  ra.actionId,
                                                  `${refStart.toFixed(2)}s`
                                                )
                                              }
                                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono font-medium bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/70 transition-colors"
                                            >
                                              <Play className="w-3 h-3 fill-current" />
                                              <span>Seek Action</span>
                                            </button>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                                            <span>
                                              Pass 1 Action (1fps): {p1Start.toFixed(2)}s – {p1End.toFixed(2)}s
                                            </span>
                                            <span>
                                              4fps Search Window: [{winStart.toFixed(2)}s, {winEnd.toFixed(2)}s]
                                            </span>
                                            {associatedEvents.length > 0 && (
                                              <span>
                                                Associated Events: {associatedEvents.join(', ')}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <pre className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-cyan-200 overflow-x-auto max-h-72">
                          {hasJsonData
                            ? JSON.stringify(passState.data, null, 2)
                            : `// ${step.artifactFilename} has not been generated yet. Click "${step.buttonLabel}" to execute this pass.`}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Step 5: Human-in-the-Loop (HITL) Verification Card */}
            <div className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-sm font-bold text-slate-100 flex items-center gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Human-in-the-Loop (HITL) Verification</span>
                  {renderPassStatusBadge(selectedPasses.hitl?.status || 'PENDING', false)}
                </div>
                <p className="text-xs text-slate-400 font-mono">
                  Inspect extracted cryo-inventory coordinates or experiment notebook entries and commit atomic sign-off
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleInspectResults(selectedVideo, true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-500/40 transition-colors"
              >
                <Eye className="w-3.5 h-3.5 text-emerald-300" />
                <span>Review in Sign-Off Tab</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pipeline Call & Prompt Inspector Modal */}
      {inspectionModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
          onClick={() => setInspectionModal(null)}
        >
          <div
            className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400">
                  <Terminal className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100 flex items-center gap-2 flex-wrap">
                    <span>Pipeline Call & Prompt Inspector</span>
                    <span className="px-2 py-0.5 text-xs rounded bg-purple-950/60 text-purple-300 border border-purple-700/50">
                      {inspectionModal.audit.model === 'gemini-4-argon'
                        ? 'gemini-1.5-pro'
                        : inspectionModal.audit.model || 'gemini-1.5-pro'}
                    </span>
                    <span className="px-2 py-0.5 text-xs rounded bg-indigo-950/60 text-indigo-300 border border-indigo-700/50 font-mono">
                      Thinking:{' '}
                      {inspectionModal.audit.thinkingLevel ||
                        (inspectionModal.audit.generationConfig as any)?.thinkingConfig?.thinkingLevel ||
                        (inspectionModal.title?.includes('Pass 0') ? 'OFF' : 'MEDIUM')}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 font-mono">
                    {inspectionModal.title}
                    {inspectionModal.audit.calledAt && (
                      <span> • Called: {formatTimestamp(inspectionModal.audit.calledAt)}</span>
                    )}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setInspectionModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                title="Close Modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-5 overflow-y-auto font-sans text-xs">
              {/* Top Diagnostics Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Model & Endpoint */}
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-mono">
                    <Cpu className="w-3.5 h-3.5 text-purple-400" />
                    <span>Model & Endpoint</span>
                  </div>
                  <div className="font-bold text-slate-100 truncate">
                    {inspectionModal.audit.model === 'gemini-4-argon'
                      ? 'gemini-1.5-pro'
                      : inspectionModal.audit.model || 'gemini-1.5-pro'}
                  </div>
                  <div className="text-[11px] font-mono text-indigo-300 truncate">
                    Thinking Level:{' '}
                    {inspectionModal.audit.thinkingLevel ||
                      (inspectionModal.audit.generationConfig as any)?.thinkingConfig?.thinkingLevel ||
                      (inspectionModal.title?.includes('Pass 0') ? 'OFF' : 'MEDIUM')}
                  </div>
                  <div className="text-[11px] font-mono text-cyan-400 truncate">
                    Endpoint: {inspectionModal.audit.endpoint || 'us endpoint'}
                  </div>
                </div>

                {/* Finish Reason & Tokens */}
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-mono">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Finish Reason & Tokens</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-100">
                      {inspectionModal.audit.modelDiagnostics?.finishReason || 'STOP'}
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-950 border border-emerald-800 text-emerald-300">
                      OK
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">
                    Prompt: {inspectionModal.audit.modelDiagnostics?.usageMetadata?.promptTokenCount ?? 'N/A'} • Output:{' '}
                    {inspectionModal.audit.modelDiagnostics?.usageMetadata?.candidatesTokenCount ?? 'N/A'}
                  </div>
                  <div className="text-[11px] font-mono text-indigo-300 pt-1 border-t border-slate-800/60 space-y-0.5">
                    <div>
                      Thinking Level:{' '}
                      {inspectionModal.audit.thinkingLevel ||
                        (inspectionModal.audit.generationConfig as any)?.thinkingConfig?.thinkingLevel ||
                        (inspectionModal.title?.includes('Pass 0') ? 'OFF' : 'MEDIUM')}
                    </div>
                    <div>
                      Thinking Tokens:{' '}
                      {inspectionModal.audit.modelDiagnostics?.thoughtsTokenCount ?? 'N/A'}
                    </div>
                  </div>
                </div>

                {/* Generation Config */}
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-mono">
                    <Sliders className="w-3.5 h-3.5 text-amber-400" />
                    <span>Generation Config</span>
                  </div>
                  <div className="text-slate-100 font-mono">
                    temp: {inspectionModal.audit.generationConfig?.temperature ?? 0.1} • maxTokens:{' '}
                    {inspectionModal.audit.generationConfig?.maxOutputTokens ?? 8192}
                  </div>
                  <div className="text-[11px] font-mono text-indigo-300 truncate">
                    thinkingLevel:{' '}
                    {inspectionModal.audit.thinkingLevel ||
                      (inspectionModal.audit.generationConfig as any)?.thinkingConfig?.thinkingLevel ||
                      (inspectionModal.title?.includes('Pass 0') ? 'OFF' : 'MEDIUM')}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate">
                    MIME: {inspectionModal.audit.generationConfig?.responseMimeType || 'application/json'}
                  </div>
                </div>

                {/* Video Source & Duration */}
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-mono">
                    <Clock className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Video Source & Duration</span>
                  </div>
                  <div className="text-slate-100 font-mono">
                    {inspectionModal.audit.videoMetadata?.durationSeconds
                      ? `${inspectionModal.audit.videoMetadata.durationSeconds}s (${formatDuration(
                          inspectionModal.audit.videoMetadata.durationSeconds
                        )})`
                      : 'N/A'}
                  </div>
                  <div
                    className="text-[11px] font-mono text-slate-400 truncate"
                    title={inspectionModal.audit.videoMetadata?.uri || ''}
                  >
                    {inspectionModal.audit.videoMetadata?.uri || 'GCS URI N/A'}
                  </div>
                </div>
              </div>

              {/* Prompt Sent to Model */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-200 text-xs font-mono uppercase tracking-wider">
                    Prompt Sent to Model
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const textToCopy = inspectionModal.audit.promptText || '';
                      if (navigator?.clipboard) {
                        navigator.clipboard.writeText(textToCopy);
                        setCopiedPrompt(true);
                        setTimeout(() => setCopiedPrompt(false), 2000);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-mono bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-700 transition-colors"
                  >
                    {copiedPrompt ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-300 font-semibold">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Prompt</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="bg-slate-900 p-3 rounded-xl font-mono text-xs overflow-x-auto text-slate-200 border border-slate-800 whitespace-pre-wrap max-h-72">
                  {inspectionModal.audit.promptText || '// No prompt text captured'}
                </pre>
              </div>

              {/* System Instruction (if available) */}
              {inspectionModal.audit.systemInstruction && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200 text-xs font-mono uppercase tracking-wider">
                      System Instruction / Guidelines
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const textToCopy = inspectionModal.audit.systemInstruction || '';
                        if (navigator?.clipboard) {
                          navigator.clipboard.writeText(textToCopy);
                          setCopiedPrompt(true);
                          setTimeout(() => setCopiedPrompt(false), 2000);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-mono bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700 transition-colors"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Instructions</span>
                    </button>
                  </div>
                  <pre className="bg-slate-900 p-3 rounded-xl font-mono text-xs overflow-x-auto text-slate-300 border border-slate-800 whitespace-pre-wrap max-h-48">
                    {inspectionModal.audit.systemInstruction}
                  </pre>
                </div>
              )}

              {/* Response Schema (if available) */}
              {inspectionModal.audit.schema && (
                <div className="space-y-2">
                  <span className="font-bold text-slate-200 text-xs font-mono uppercase tracking-wider">
                    Target Output JSON Schema (generationConfig.responseSchema)
                  </span>
                  <pre className="bg-slate-900 p-3 rounded-xl font-mono text-xs overflow-x-auto text-slate-400 border border-slate-800 max-h-48">
                    {JSON.stringify(inspectionModal.audit.schema, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-900/40 text-xs font-mono text-slate-400">
              <span>Endpoint: {inspectionModal.audit.endpoint || 'us'}</span>
              <button
                type="button"
                onClick={() => setInspectionModal(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const VideoManagerView = VideoManager;
export default VideoManager;
