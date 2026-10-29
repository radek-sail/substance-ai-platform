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
} from 'lucide-react';
import {
  type VideoAnalysisDoc,
  type VideoRecord,
  type VideoPasses,
  type PassStatus,
  DEFAULT_VIDEO_PASSES,
} from '@sail/shared';
import {
  TenantConfig,
  DEFAULT_GCS_BUCKET,
  apiService,
  UploadVideoResponse,
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
}

export type VideoManagerProps = VideoManagerViewProps;

type UploadStep = 'IDLE' | 'UPLOADING' | 'TRANSCODING' | 'SAVED' | 'ERROR';

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
}) => {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const isLoadingRegistry = loading;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [probedDuration, setProbedDuration] = useState<number | undefined>(undefined);

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
            error: undefined,
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

    try {
      const res = await apiService.runPipelinePass(videoId, passNum, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
        videoGcsUri: normalizedGcsUri,
      });

      const updatedPasses = ensurePasses(res.passes);
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

  const isUploadingOrTranscoding =
    uploading || uploadStep === 'UPLOADING' || uploadStep === 'TRANSCODING';

  const selectedVideo =
    videos.find((v) => v.videoId === selectedVideoId) ||
    (videos.length > 0 ? videos[0] : null);

  const selectedPasses = selectedVideo
    ? ensurePasses(passesByVideo[selectedVideo.videoId] || selectedVideo.passes)
    : ensurePasses();

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
      title: 'Pass 1: Action Detection (Pro @ 1 fps)',
      subtitle: 'Coarse temporal action span detection using Pass 0 workflow context',
      buttonLabel: 'Run Pass 1',
      artifactFilename: 'action_detection_pass.json',
    },
    {
      passNumber: 2,
      passKey: 'pass2',
      title: 'Pass 2: Event Detection (Temporal 4 fps)',
      subtitle: 'Fine-grained sub-event extraction & candidate frame extraction at 4 fps',
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
                      </div>
                      <p className="text-xs text-slate-400 font-mono">{step.subtitle}</p>
                      {passState.error && (
                        <p className="text-xs text-rose-400 font-mono mt-1">
                          Error: {passState.error}
                        </p>
                      )}
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
                    <div className="mt-2 pt-3 border-t border-slate-800/80">
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-2">
                        <span>Artifact: {step.artifactFilename}</span>
                        {passState.completedAt && (
                          <span>Completed: {formatTimestamp(passState.completedAt)}</span>
                        )}
                      </div>
                      <pre className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs font-mono text-cyan-200 overflow-x-auto max-h-72">
                        {hasJsonData
                          ? JSON.stringify(passState.data, null, 2)
                          : `// ${step.artifactFilename} has not been generated yet. Click "${step.buttonLabel}" to execute this pass.`}
                      </pre>
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
    </div>
  );
};

export const VideoManagerView = VideoManager;
export default VideoManager;
