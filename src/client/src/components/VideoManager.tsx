import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  UploadCloud,
  FileVideo,
  CheckCircle2,
  Loader2,
  Sparkles,
  Building,
  Layers,
  AlertCircle,
  Clock,
  Radio,
  RefreshCw,
  Play,
  Eye,
  ChevronDown,
  ChevronLeft,
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
  Trash2,
  RotateCcw,
  Pause,
} from 'lucide-react';
import {
  type VideoAnalysisDoc,
  type VideoRecord,
  type VideoPasses,
  type PassStatus,
  type ExecutionAudit,
  type ArchiveReagent,
  type ArchiveWorkStep,
  DEFAULT_VIDEO_PASSES,
  generateReagentAcronym,
  parseReagentLabelFields,
  isLikelyReagentBottleLabelText,
  computeExpectedSeedingEvents,
  render96WellPlateMarkdown,
  resolveSeededColumnsAndWells,
  parseColumnNumbersFromText,
} from '@sail/shared';
import {
  TenantConfig,
  DEFAULT_GCS_BUCKET,
  apiService,
  UploadVideoResponse,
  compileArchiveMarkdownFromAnalysis,
  type InventoryRecord,
  type ArchiveRecord,
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
  onNavigateToArchive?: (archiveId?: string, videoId?: string) => void;
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

function parseTimestampToDate(ts: any): Date | null {
  if (!ts) return null;
  if (ts instanceof Date) {
    return Number.isNaN(ts.getTime()) ? null : ts;
  }
  if (typeof ts === 'string' || typeof ts === 'number') {
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof ts === 'object') {
    if (typeof ts.toDate === 'function') {
      const d = ts.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (typeof ts._seconds === 'number') {
      return new Date(ts._seconds * 1000);
    }
    if (typeof ts.seconds === 'number') {
      return new Date(ts.seconds * 1000);
    }
  }
  return null;
}

function formatTimestamp(ts: any): string {
  const d = parseTimestampToDate(ts);
  if (d) return d.toLocaleString();
  if (!ts) return 'Just now';
  if (typeof ts === 'string') return ts;
  return 'Recorded';
}

function formatTimeOfDay(ts: any): string {
  const d = parseTimestampToDate(ts);
  if (d) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return 'Recorded';
}

function extractCaptureDay(ts: any): { dayKey: string; dayLabel: string } {
  const d = parseTimestampToDate(ts);
  if (d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return {
      dayKey: `${yyyy}-${mm}-${dd}`,
      dayLabel: d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    };
  }
  if (typeof ts === 'string' && ts.trim()) {
    return {
      dayKey: ts.trim().slice(0, 10),
      dayLabel: ts.trim().slice(0, 10),
    };
  }
  return {
    dayKey: 'unknown-date',
    dayLabel: 'Unspecified Date',
  };
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

function formatWorkflowClassificationLabel(workflowType?: string, pass0Status?: string): string {
  if (workflowType === 'INVENTORY_UPDATE_WORKFLOW') {
    return 'inventory update workflow';
  }
  if (workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW') {
    return 'experiment update workflow';
  }
  if (workflowType === 'UNCLASSIFIED_WORKFLOW') {
    return 'unclassified workflow';
  }
  if (pass0Status === 'RUNNING') {
    return 'Classifying workflow (Pass 0)...';
  }
  if (pass0Status === 'COMPLETED') {
    return 'unclassified workflow';
  }
  return 'Pending Pass 0 classification';
}

interface ActiveStreamThumbnailPreviewProps {
  videoId: string;
  originalName: string;
  status: string;
  tenant?: TenantConfig;
  organizationId?: string;
  durationSeconds?: number;
  chunks?: { index: number; gcsUri: string }[];
  totalChunks?: number;
}

const ActiveStreamThumbnailPreview: React.FC<ActiveStreamThumbnailPreviewProps> = ({
  videoId,
  originalName,
  status,
  tenant,
  organizationId,
  durationSeconds,
  chunks,
  totalChunks,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number>(0);

  const durationEstimatedChunks =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 600
      ? Math.ceil(durationSeconds / 600)
      : 1;
  const numChunks = Math.max(1, totalChunks || 0, chunks?.length || 0, durationEstimatedChunks);
  const isIngesting = status === 'UPLOADING' || status === 'TRANSCODING';

  const effectiveCustomerId = organizationId || tenant?.customerId;
  const tenantParams = new URLSearchParams();
  tenantParams.set('v', '2');
  if (effectiveCustomerId) tenantParams.set('customerId', effectiveCustomerId);
  if (organizationId) tenantParams.set('organizationId', organizationId);
  if (tenant?.databaseId) tenantParams.set('databaseId', tenant.databaseId);
  tenantParams.set('chunk', String(currentChunkIndex));
  if (retryCount > 0) {
    tenantParams.set('retry', String(retryCount));
  }
  const thumbnailUrl = `/api/videos/${encodeURIComponent(videoId)}/thumbnail?${tenantParams.toString()}`;

  useEffect(() => {
    setIsPlaying(false);
    setHasError(false);
    setRetryCount(0);
    setCurrentChunkIndex(0);
    setIsLoading(!isIngesting);
  }, [videoId, isIngesting]);

  const handleLoadedData = () => {
    setIsLoading(false);
    setHasError(false);
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = 0;
    const playPromise = el.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          setIsPlaying(true);
        })
        .catch(() => {
          setIsPlaying(false);
        });
    }
  };

  const handleEnded = () => {
    const el = videoRef.current;
    if (numChunks > 1 && currentChunkIndex + 1 < numChunks) {
      setHasError(false);
      setRetryCount(0);
      setCurrentChunkIndex((c) => c + 1);
      setIsLoading(true);
      return;
    }
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    if (numChunks > 1) {
      setHasError(false);
      setRetryCount(0);
      setCurrentChunkIndex(0);
    }
    setIsPlaying(false);
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isIngesting) return;
    if (hasError) {
      setHasError(false);
      setIsLoading(true);
      setRetryCount((c) => c + 1);
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      if (el.ended || (el.duration && el.currentTime >= el.duration - 0.05)) {
        el.currentTime = 0;
      }
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleRewindStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    if (numChunks > 1) {
      setCurrentChunkIndex(0);
    }
    setIsPlaying(false);
  };

  return (
    <div
      data-testid={`active-stream-thumbnail-preview-${videoId}`}
      onClick={handleTogglePlay}
      title={`${originalName}${
        numChunks > 1 ? ` (Chunk ${currentChunkIndex + 1} of ${numChunks})` : ''
      } — Plays once, then rewinds to 00:00 and stops (click to replay/pause)`}
      className="relative w-24 h-40 sm:w-28 sm:h-48 rounded-xl overflow-hidden bg-slate-950 border border-cyan-500/50 shadow-md shadow-cyan-950/40 shrink-0 group select-none cursor-pointer"
    >
      {isIngesting ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-amber-300 bg-slate-950 p-2 text-center">
          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
          <span className="text-[10px] font-mono leading-tight">Generating thumbnail...</span>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            key={`${videoId}-${currentChunkIndex}-${retryCount}`}
            src={thumbnailUrl}
            muted
            playsInline
            preload="auto"
            onLoadedData={handleLoadedData}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={handleEnded}
            onError={() => {
              if (retryCount < 6) {
                setTimeout(() => {
                  setRetryCount((c) => c + 1);
                }, Math.min(3000, 800 * (retryCount + 1)));
              } else {
                setIsLoading(false);
                setHasError(true);
              }
            }}
            className="w-full h-full object-contain bg-black"
          />

          {isLoading && !hasError && (
            <div className="absolute inset-0 bg-slate-950/85 flex flex-col items-center justify-center gap-1 text-cyan-300 p-2 text-center pointer-events-none">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
              <span className="text-[9px] font-mono leading-tight">
                {numChunks > 1 ? `Loading chunk ${currentChunkIndex + 1}...` : 'Loading preview...'}
              </span>
            </div>
          )}

          {hasError && (
            <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-1 text-slate-400 p-2 text-center">
              <FileVideo className="w-5 h-5 text-cyan-400/70" />
              <span className="text-[9px] font-mono leading-tight">Preview Ready on Demand</span>
              <span className="text-[8px] font-mono text-cyan-400/80 underline mt-0.5">Click to retry</span>
            </div>
          )}

          {/* Top-left LIVE PREVIEW badge */}
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm border border-cyan-500/40 flex items-center gap-1 pointer-events-none z-10">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400'
              }`}
            />
            <span className="text-[9px] font-mono font-semibold text-cyan-200 tracking-tight">
              {isPlaying ? 'PLAYING 1X' : 'PREVIEW'}
            </span>
          </div>

          {/* Top-right Chunk Switcher (when multiple chunks exist) */}
          {numChunks > 1 && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute top-1.5 right-1.5 px-1 py-0.5 rounded bg-black/85 backdrop-blur-sm border border-slate-700/70 flex items-center gap-0.5 z-10 select-none shadow-sm"
            >
              <button
                type="button"
                disabled={currentChunkIndex === 0}
                onClick={() => {
                  if (currentChunkIndex > 0) {
                    setCurrentChunkIndex((c) => c - 1);
                    setIsLoading(true);
                  }
                }}
                className="text-slate-400 hover:text-cyan-300 disabled:opacity-20 disabled:hover:text-slate-400 p-0.5 transition-colors"
                title="Previous chunk"
              >
                <ChevronLeft className="w-2.5 h-2.5" />
              </button>
              <span className="text-[8px] font-mono font-semibold text-cyan-300">
                {currentChunkIndex + 1}/{numChunks}
              </span>
              <button
                type="button"
                disabled={currentChunkIndex + 1 >= numChunks}
                onClick={() => {
                  if (currentChunkIndex + 1 < numChunks) {
                    setCurrentChunkIndex((c) => c + 1);
                    setIsLoading(true);
                  }
                }}
                className="text-slate-400 hover:text-cyan-300 disabled:opacity-20 disabled:hover:text-slate-400 p-0.5 transition-colors"
                title="Next chunk"
              >
                <ChevronRight className="w-2.5 h-2.5" />
              </button>
            </div>
          )}

          {/* Bottom-right Play/Pause & Rewind controls */}
          {!hasError && !isLoading && (
            <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 opacity-90 group-hover:opacity-100 transition-opacity z-10">
              <button
                type="button"
                onClick={handleTogglePlay}
                className="p-1 rounded bg-black/75 hover:bg-cyan-600/80 text-white border border-slate-700/70 transition-colors"
                title={isPlaying ? 'Pause preview' : 'Play preview once'}
              >
                {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={handleRewindStop}
                className="p-1 rounded bg-black/75 hover:bg-slate-800 text-slate-200 border border-slate-700/70 transition-colors"
                title="Rewind to beginning and stop"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

interface IntervalThumbnailPreviewProps {
  videoId: string;
  status?: string;
  tenant?: TenantConfig;
  organizationId?: string;
  startSeconds: number;
  endSeconds?: number;
  intervalId: string;
  onPlayInterval?: () => void;
}

const IntervalThumbnailPreview: React.FC<IntervalThumbnailPreviewProps> = ({
  videoId,
  status,
  tenant,
  organizationId,
  startSeconds,
  endSeconds,
  intervalId,
  onPlayInterval,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingAutoPlayRef = useRef<boolean>(false);

  const safeStart = Number.isFinite(startSeconds) && startSeconds >= 0 ? startSeconds : 0;
  const startChunkIndex = Math.floor(safeStart / 600);
  const localStartSec = Math.max(0, safeStart - startChunkIndex * 600);
  const hasExplicitEnd =
    typeof endSeconds === 'number' && Number.isFinite(endSeconds) && endSeconds > safeStart;
  const safeEnd = hasExplicitEnd ? (endSeconds as number) : undefined;
  const endChunkIndex = safeEnd !== undefined ? Math.floor(safeEnd / 600) : startChunkIndex;

  const [isVisible, setIsVisible] = useState<boolean>(
    typeof IntersectionObserver === 'undefined'
  );
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number>(startChunkIndex);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [displayTimeSec, setDisplayTimeSec] = useState<number>(safeStart);

  const isIngesting = status === 'UPLOADING' || status === 'TRANSCODING';

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }
    const node = containerRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    pendingAutoPlayRef.current = false;
    setIsPlaying(false);
    setHasError(false);
    setRetryCount(0);
    setCurrentChunkIndex(startChunkIndex);
    setDisplayTimeSec(safeStart);
    setIsLoading(!isIngesting);
  }, [videoId, safeStart, startChunkIndex, isIngesting]);

  const effectiveCustomerId = organizationId || tenant?.customerId;
  const tenantParams = new URLSearchParams();
  tenantParams.set('v', '2');
  if (effectiveCustomerId) tenantParams.set('customerId', effectiveCustomerId);
  if (organizationId) tenantParams.set('organizationId', organizationId);
  if (tenant?.databaseId) tenantParams.set('databaseId', tenant.databaseId);
  tenantParams.set('chunk', String(currentChunkIndex));
  if (retryCount > 0) {
    tenantParams.set('retry', String(retryCount));
  }
  const initialLocalOffset = currentChunkIndex === startChunkIndex ? localStartSec : 0;
  const mediaFragment = initialLocalOffset > 0 ? `#t=${initialLocalOffset.toFixed(2)}` : '';
  const thumbnailUrl = `/api/videos/${encodeURIComponent(videoId)}/thumbnail?${tenantParams.toString()}${mediaFragment}`;

  const handleLoadedMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    setHasError(false);

    const maxDur =
      el.duration && Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.05) : undefined;

    if (pendingAutoPlayRef.current) {
      pendingAutoPlayRef.current = false;
      const target =
        currentChunkIndex === startChunkIndex
          ? maxDur !== undefined
            ? Math.min(localStartSec, maxDur)
            : localStartSec
          : 0;
      el.currentTime = target;
      const playPromise = el.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            setIsLoading(false);
            setIsPlaying(true);
          })
          .catch(() => {
            setIsLoading(false);
            setIsPlaying(false);
          });
      }
      return;
    }

    const target = maxDur !== undefined ? Math.min(localStartSec, maxDur) : localStartSec;
    el.pause();
    setIsPlaying(false);
    setDisplayTimeSec(safeStart);
    if (Math.abs(el.currentTime - target) > 0.03) {
      try {
        el.currentTime = target;
      } catch {
        setIsLoading(false);
      }
    } else {
      setIsLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    const el = videoRef.current;
    if (!el) return;
    const globalTime = currentChunkIndex * 600 + el.currentTime;
    setDisplayTimeSec(globalTime);
    if (!el.paused && safeEnd !== undefined && globalTime >= safeEnd) {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleEnded = () => {
    if (safeEnd !== undefined && currentChunkIndex < endChunkIndex) {
      pendingAutoPlayRef.current = true;
      setHasError(false);
      setRetryCount(0);
      setIsLoading(true);
      setCurrentChunkIndex((c) => c + 1);
      return;
    }
    setIsPlaying(false);
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isIngesting) return;
    onPlayInterval?.();

    if (hasError) {
      setHasError(false);
      setIsLoading(true);
      setRetryCount((c) => c + 1);
      return;
    }

    const el = videoRef.current;
    if (!el) return;

    if (el.paused) {
      const globalTime = currentChunkIndex * 600 + el.currentTime;
      const reachedEnd =
        el.ended ||
        (safeEnd !== undefined && globalTime >= safeEnd - 0.08) ||
        globalTime < safeStart - 0.25;

      if (reachedEnd) {
        if (currentChunkIndex !== startChunkIndex) {
          pendingAutoPlayRef.current = true;
          setIsLoading(true);
          setCurrentChunkIndex(startChunkIndex);
          return;
        }
        const maxDur =
          el.duration && Number.isFinite(el.duration)
            ? Math.max(0, el.duration - 0.05)
            : localStartSec;
        el.currentTime = Math.min(localStartSec, maxDur);
        setDisplayTimeSec(safeStart);
      }

      const playPromise = el.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleResetToStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    pendingAutoPlayRef.current = false;
    const el = videoRef.current;
    if (currentChunkIndex !== startChunkIndex) {
      setIsPlaying(false);
      setIsLoading(true);
      setCurrentChunkIndex(startChunkIndex);
      setDisplayTimeSec(safeStart);
      return;
    }
    if (el) {
      el.pause();
      const maxDur =
        el.duration && Number.isFinite(el.duration)
          ? Math.max(0, el.duration - 0.05)
          : localStartSec;
      el.currentTime = Math.min(localStartSec, maxDur);
    }
    setDisplayTimeSec(safeStart);
    setIsPlaying(false);
  };

  return (
    <div
      ref={containerRef}
      data-testid={`interval-thumbnail-preview-${intervalId}`}
      onClick={handleTogglePlay}
      title={`Interval preview (${formatDuration(safeStart)}${
        safeEnd !== undefined ? ` – ${formatDuration(safeEnd)}` : ''
      }) — Click to ${isPlaying ? 'pause' : 'play'}`}
      className="relative w-44 h-28 sm:w-48 sm:h-32 rounded-xl overflow-hidden bg-slate-950 border border-cyan-500/40 hover:border-cyan-400 shadow-md shadow-cyan-950/30 shrink-0 group select-none cursor-pointer transition-colors"
    >
      {isIngesting ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-amber-300 bg-slate-950 p-2 text-center">
          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
          <span className="text-[10px] font-mono leading-tight">Generating thumbnail...</span>
        </div>
      ) : !isVisible ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400 bg-slate-950 p-2 text-center">
          <FileVideo className="w-4 h-4 text-cyan-400/70" />
          <span className="text-[9px] font-mono">@{formatDuration(safeStart)}</span>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            key={`${videoId}-${intervalId}-${currentChunkIndex}-${retryCount}`}
            src={thumbnailUrl}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onLoadedData={() => {
              setIsLoading(false);
              setHasError(false);
            }}
            onSeeked={() => {
              setIsLoading(false);
              setHasError(false);
            }}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={handleEnded}
            onError={() => {
              if (retryCount < 4) {
                setTimeout(() => {
                  setRetryCount((c) => c + 1);
                }, Math.min(2500, 700 * (retryCount + 1)));
              } else {
                setIsLoading(false);
                setHasError(true);
              }
            }}
            className="w-full h-full object-contain bg-black"
          />

          {isLoading && !hasError && (
            <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center gap-1 text-cyan-300 p-2 text-center pointer-events-none z-20">
              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
              <span className="text-[9px] font-mono leading-tight">
                Frame @{formatDuration(safeStart)}...
              </span>
            </div>
          )}

          {hasError && (
            <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-1 text-slate-400 p-2 text-center z-20">
              <FileVideo className="w-4 h-4 text-cyan-400/70" />
              <span className="text-[9px] font-mono leading-tight">Preview Unavailable</span>
              <span className="text-[8px] font-mono text-cyan-400/80 underline">Click to retry</span>
            </div>
          )}

          {/* Top-left timestamp indicator */}
          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-sm border border-cyan-500/40 flex items-center gap-1 pointer-events-none z-10">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isPlaying ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400'
              }`}
            />
            <span className="text-[9px] font-mono font-semibold text-cyan-200 tracking-tight">
              {formatDuration(displayTimeSec)}
              {safeEnd !== undefined ? ` / ${formatDuration(safeEnd)}` : ''}
            </span>
          </div>

          {/* Center Play button overlay when paused on frame */}
          {!isPlaying && !isLoading && !hasError && (
            <button
              type="button"
              data-testid={`interval-thumbnail-play-${intervalId}`}
              onClick={handleTogglePlay}
              aria-label="Play interval video"
              className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/35 transition-colors z-10"
            >
              <span className="w-9 h-9 rounded-full bg-black/75 group-hover:bg-cyan-500 text-cyan-300 group-hover:text-slate-950 border border-cyan-400/70 flex items-center justify-center shadow-lg transition-all">
                <Play className="w-4 h-4 fill-current ml-0.5" />
              </span>
            </button>
          )}

          {/* Bottom-right Play/Pause & Reset to Start Frame controls */}
          {!hasError && !isLoading && (isPlaying || Math.abs(displayTimeSec - safeStart) > 0.15) && (
            <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 z-20">
              <button
                type="button"
                onClick={handleTogglePlay}
                className="p-1 rounded bg-black/80 hover:bg-cyan-600/80 text-white border border-slate-700/70 transition-colors"
                title={isPlaying ? 'Pause video' : 'Play video'}
              >
                {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              <button
                type="button"
                onClick={handleResetToStart}
                className="p-1 rounded bg-black/80 hover:bg-slate-800 text-slate-200 border border-slate-700/70 transition-colors"
                title={`Reset to start frame (${formatDuration(safeStart)})`}
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export const VideoManager: React.FC<VideoManagerViewProps> = ({
  tenant,
  activeStreamId,
  onSelectActiveStream,
  onSelectVideoForReview,
  onNavigateToInventory,
  onNavigateToArchive,
  onSeekVideo,
  currentTime,
}) => {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [deletingIds, setDeletingIds] = useState<Record<string, boolean>>({});
  const deletedVideoIdsRef = useRef<Set<string>>(new Set());
  const autoTriggeredPass0Ref = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(true);
  const isLoadingRegistry = loading;
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [probedDuration, setProbedDuration] = useState<number | undefined>(undefined);

  // Inventories for automatic/manual association
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [assigningInventoryMap, setAssigningInventoryMap] = useState<Record<string, string>>({});
  const [isAssigningMap, setIsAssigningMap] = useState<Record<string, boolean>>({});

  // Experiment Archives for Pass 0 automatic matching, manual association & new archive confirmation
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [assigningArchiveMap, setAssigningArchiveMap] = useState<Record<string, string>>({});
  const [isAssigningArchiveMap, setIsAssigningArchiveMap] = useState<Record<string, boolean>>({});
  const [archiveDraftMap, setArchiveDraftMap] = useState<
    Record<
      string,
      {
        name: string;
        creatorName: string;
        creationDate: string;
        purpose?: string;
        showCreateForm?: boolean;
      }
    >
  >({});

  // Selected video for the Pass Stepper & Execution UI
  const [activeStream, setActiveStreamState] = useState<string | null>(
    activeStreamId && !activeStreamId.startsWith('vid_cryo_demo') && !activeStreamId.startsWith('vid_archive_demo')
      ? activeStreamId
      : null
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(activeStream);
  const [isSelectedGroupCollapsed, setIsSelectedGroupCollapsed] = useState<boolean>(false);
  const [isReviewAnalysisModalOpen, setIsReviewAnalysisModalOpen] = useState<boolean>(false);

  // Decoupled Upload & Transcoding State
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
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
  const [inspectionModal, setInspectionModal] = useState<{
    audit: ExecutionAudit;
    title: string;
  } | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<boolean>(false);
  const [hitlActionEdits, setHitlActionEdits] = useState<
    Record<
      string,
      {
        actionId: string;
        actionType: 'VIAL_INSERTION' | 'VIAL_REMOVAL';
        boxId: string;
        coordinate: string;
        cellLineName: string;
        userInitials: string;
        dateFrozen: string;
        fullText: string;
        lotNumber: string;
        passage: string;
      }
    >
  >({});
  const [hitlArchiveEdits, setHitlArchiveEdits] = useState<
    Record<
      string,
      {
        archiveName?: string;
        creatorName?: string;
        creationDate?: string;
        reagents?: ArchiveReagent[];
        labelTranscriptions?: string[];
        workSteps?: ArchiveWorkStep[];
      }
    >
  >({});
  const [isCommittingHitl, setIsCommittingHitl] = useState<boolean>(false);
  const [isUndoingHitl, setIsUndoingHitl] = useState<boolean>(false);
  const [hitlCommitError, setHitlCommitError] = useState<string | null>(null);
  const [hitlCommitSuccess, setHitlCommitSuccess] = useState<string | null>(null);

  const handleUndoHitlCommit = async (videoId: string) => {
    setIsUndoingHitl(true);
    setHitlCommitError(null);
    setHitlCommitSuccess(null);
    try {
      await apiService.undoVideoCommit(videoId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });

      // Update passesByVideo locally
      setPassesByVideo((prev) => {
        const cur = prev[videoId] || { ...DEFAULT_VIDEO_PASSES };
        return {
          ...prev,
          [videoId]: {
            ...cur,
            hitl: {
              status: 'PENDING',
              error: null,
            },
          },
        };
      });

      // Update videos list
      setVideos((prev) =>
        prev.map((v) =>
          v.videoId === videoId
            ? ({
                ...v,
                isSignedOff: false,
                signedOffAt: null,
                passes: {
                  ...(v.passes || {}),
                  hitl: { status: 'PENDING' },
                },
              } as any)
            : v
        )
      );

      // Update analysisCache if present
      setAnalysisCache((prev) => {
        const cached = prev[videoId];
        if (!cached) return prev;
        return {
          ...prev,
          [videoId]: {
            ...cached,
            isSignedOff: false,
          },
        };
      });

      setStatusBanner(`Reset commit state for ${videoId}. You can now edit and re-commit.`);
    } catch (err: any) {
      console.error(`[VideoManager] Failed to undo commit for ${videoId}:`, err);
      setHitlCommitError(err?.message || 'Failed to undo commit.');
    } finally {
      setIsUndoingHitl(false);
    }
  };

  // Model & Thinking Level Selectors (Default: Pass 0 -> gemini-3.8-flash, Passes 1-3 -> gemini-1.5-pro, Passes 1-3 Thinking -> MEDIUM)
  const [pass0Model, setPass0Model] = useState<string>('gemini-3.8-flash');
  const [pass1Model, setPass1Model] = useState<string>('gemini-1.5-pro');
  const [pass1Thinking, setPass1Thinking] = useState<string>('MEDIUM');
  const [pass2Model, setPass2Model] = useState<string>('gemini-1.5-pro');
  const [pass2Thinking, setPass2Thinking] = useState<string>('MEDIUM');
  const [pass3Model, setPass3Model] = useState<string>('gemini-1.5-pro');
  const [pass3Thinking, setPass3Thinking] = useState<string>('MEDIUM');

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
      const authHeaders = await apiService.getHeaders();
      const res = await fetch('/api/videos', {
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rawList: VideoRecord[] = Array.isArray(json) ? json : (json.videos || []);
      const list = rawList.filter((v) => v?.videoId && !deletedVideoIdsRef.current.has(v.videoId));
      console.log('[VideoManager] Loaded videos:', list.length);
      setVideos((prev) => {
        const mergedMap = new Map<string, VideoRecord>();
        for (const v of list) {
          if (v?.videoId && !deletedVideoIdsRef.current.has(v.videoId)) {
            mergedMap.set(v.videoId, v);
          }
        }
        for (const v of prev) {
          if (
            v?.videoId &&
            !mergedMap.has(v.videoId) &&
            !deletedVideoIdsRef.current.has(v.videoId) &&
            v.status === 'UPLOADING'
          ) {
            mergedMap.set(v.videoId, v);
          }
        }
        const merged = Array.from(mergedMap.values());
        merged.sort(
          (a, b) =>
            new Date(String((b as any).capturedAt || b.uploadedAt || 0)).getTime() -
            new Date(String((a as any).capturedAt || a.uploadedAt || 0)).getTime()
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
  }, [fetchVideos, tenant.customerId]);

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

  const loadArchives = useCallback(async () => {
    try {
      const data = await apiService.fetchArchives({
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      setArchives(data);
    } catch (err) {
      console.error('[VideoManager] Failed to load archives:', err);
    }
  }, [tenant.customerId, tenant.databaseId]);

  useEffect(() => {
    loadArchives();
  }, [loadArchives]);

  const getArchiveDraftForVideo = (video: VideoRecord) => {
    const existing = archiveDraftMap[video.videoId];
    if (existing) return existing;
    const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
    const pass0Data = vPasses.pass0.data || {};
    return {
      name:
        video.unmatchedArchiveName ||
        video.archiveName ||
        pass0Data.archiveName ||
        video.originalName?.replace(/\.[^.]+$/, '') ||
        '',
      creatorName: video.archiveCreatorName || pass0Data.creatorName || '',
      creationDate: video.archiveCreationDate || pass0Data.creationDate || '',
      purpose:
        (video as any).archivePurpose ||
        pass0Data.purpose ||
        pass0Data.identificationEvent?.purpose ||
        '',
      showCreateForm: false,
    };
  };

  const updateArchiveDraftForVideo = (
    video: VideoRecord,
    patch: Partial<{ name: string; creatorName: string; creationDate: string; purpose?: string; showCreateForm?: boolean }>
  ) => {
    setArchiveDraftMap((prev) => {
      const base = prev[video.videoId] || getArchiveDraftForVideo(video);
      return {
        ...prev,
        [video.videoId]: {
          ...base,
          ...patch,
        },
      };
    });
  };

  const handleAssociateArchive = async (videoId: string, archiveIdToAssign?: string) => {
    const archId = archiveIdToAssign || assigningArchiveMap[videoId] || archives[0]?.id;
    if (!archId) return;

    setIsAssigningArchiveMap((prev) => ({ ...prev, [videoId]: true }));
    try {
      const result = await apiService.associateVideoArchive(videoId, archId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      if (result.success) {
        const canonicalName = result.archiveName || archives.find((a) => a.id === archId)?.name || archId;
        const canonicalCreator =
          result.archiveCreatorName ?? archives.find((a) => a.id === archId)?.creatorName ?? null;
        const canonicalDate =
          result.archiveCreationDate ?? archives.find((a) => a.id === archId)?.creationDate ?? null;

        setVideos((prev) =>
          prev.map((v) =>
            v.videoId === videoId
              ? {
                  ...v,
                  ...(result.video || {}),
                  archiveId: result.archiveId,
                  archiveName: canonicalName,
                  archiveCreatorName: canonicalCreator ?? v.archiveCreatorName,
                  archiveCreationDate: canonicalDate ?? v.archiveCreationDate,
                  unmatchedArchiveName: null,
                  archiveAssociationType: 'MANUAL',
                }
              : v
          )
        );
        setPassesByVideo((prev) => {
          const curPasses = prev[videoId];
          if (!curPasses?.pass0?.data) return prev;
          return {
            ...prev,
            [videoId]: {
              ...curPasses,
              pass0: {
                ...curPasses.pass0,
                data: {
                  ...curPasses.pass0.data,
                  archiveName: canonicalName,
                  ...(canonicalCreator ? { creatorName: canonicalCreator } : {}),
                  ...(canonicalDate ? { creationDate: canonicalDate } : {}),
                  archiveIntent: 'APPEND',
                  isAppending: true,
                },
              },
            },
          };
        });
        setAnalysisCache((prev) => {
          const curAnalysis = prev[videoId];
          if (!curAnalysis) return prev;
          return {
            ...prev,
            [videoId]: {
              ...curAnalysis,
              archiveId: result.archiveId,
              archiveName: canonicalName,
              ...(canonicalCreator ? { creatorName: canonicalCreator } : {}),
              ...(canonicalDate ? { creationDate: canonicalDate } : {}),
              ...(curAnalysis.workflowClassification
                ? {
                    workflowClassification: {
                      ...curAnalysis.workflowClassification,
                      archiveName: canonicalName,
                      ...(canonicalCreator ? { creatorName: canonicalCreator } : {}),
                      ...(canonicalDate ? { creationDate: canonicalDate } : {}),
                    },
                  }
                : {}),
              ...(curAnalysis.workloadClassification
                ? {
                    workloadClassification: {
                      ...curAnalysis.workloadClassification,
                      archiveName: canonicalName,
                      ...(canonicalCreator ? { creatorName: canonicalCreator } : {}),
                      ...(canonicalDate ? { creationDate: canonicalDate } : {}),
                    },
                  }
                : {}),
            } as VideoAnalysisDoc,
          };
        });
        setArchiveDraftMap((prev) => ({
          ...prev,
          [videoId]: {
            name: canonicalName,
            creatorName: canonicalCreator || prev[videoId]?.creatorName || '',
            creationDate: canonicalDate || prev[videoId]?.creationDate || '',
          },
        }));
        const targetVideo = videos.find((v) => v.videoId === videoId);
        if (targetVideo && (selectedVideoId === videoId || activeStreamId === videoId)) {
          const existingAnalysis = analysisCache[videoId];
          const syncedAnalysis = existingAnalysis
            ? ({
                ...existingAnalysis,
                archiveId: result.archiveId,
                archiveName: canonicalName,
                ...(canonicalCreator ? { creatorName: canonicalCreator } : {}),
                ...(canonicalDate ? { creationDate: canonicalDate } : {}),
                ...(existingAnalysis.workflowClassification
                  ? {
                      workflowClassification: {
                        ...existingAnalysis.workflowClassification,
                        archiveName: canonicalName,
                      },
                    }
                  : {}),
                ...(existingAnalysis.workloadClassification
                  ? {
                      workloadClassification: {
                        ...existingAnalysis.workloadClassification,
                        archiveName: canonicalName,
                      },
                    }
                  : {}),
              } as VideoAnalysisDoc)
            : undefined;
          onSelectActiveStream?.(
            {
              ...targetVideo,
              ...(result.video || {}),
              archiveId: result.archiveId,
              archiveName: canonicalName,
              archiveCreatorName: canonicalCreator ?? targetVideo.archiveCreatorName,
              archiveCreationDate: canonicalDate ?? targetVideo.archiveCreationDate,
              unmatchedArchiveName: null,
              archiveAssociationType: 'MANUAL',
            },
            syncedAnalysis
          );
        }
        await loadArchives();
        setStatusBanner(
          `Successfully associated ${videoId} with archive "${canonicalName}".`
        );
      }
    } catch (err: any) {
      console.error(`[VideoManager] Failed to associate archive for ${videoId}:`, err);
      setStatusBanner(`Failed to associate archive: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsAssigningArchiveMap((prev) => ({ ...prev, [videoId]: false }));
    }
  };

  const handleConfirmCreateArchive = async (video: VideoRecord) => {
    const draft = getArchiveDraftForVideo(video);
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setStatusBanner('Archive name is required to initialize a new archive.');
      return;
    }

    setIsAssigningArchiveMap((prev) => ({ ...prev, [video.videoId]: true }));
    try {
      const created = await apiService.createArchive(
        {
          name: trimmedName,
          creatorName: draft.creatorName.trim() || null,
          creationDate: draft.creationDate.trim() || null,
          purpose: (draft.purpose || '').trim() || null,
          videoId: video.videoId,
        },
        {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        }
      );

      setVideos((prev) =>
        prev.map((v) =>
          v.videoId === video.videoId
            ? {
                ...v,
                ...(created.video || {}),
                archiveId: created.id,
                archiveName: created.name,
                archiveCreatorName: created.creatorName ?? null,
                archiveCreationDate: created.creationDate ?? null,
                archivePurpose: created.purpose ?? null,
                unmatchedArchiveName: null,
                archiveAssociationType: 'MANUAL',
              }
            : v
        )
      );
      setPassesByVideo((prev) => {
        const curPasses = prev[video.videoId];
        if (!curPasses?.pass0?.data) return prev;
        return {
          ...prev,
          [video.videoId]: {
            ...curPasses,
            pass0: {
              ...curPasses.pass0,
              data: {
                ...curPasses.pass0.data,
                archiveName: created.name,
                creatorName: created.creatorName ?? curPasses.pass0.data.creatorName ?? null,
                creationDate: created.creationDate ?? curPasses.pass0.data.creationDate ?? null,
                purpose: created.purpose ?? curPasses.pass0.data.purpose ?? null,
              },
            },
          },
        };
      });
      await loadArchives();
      setStatusBanner(
        `Created and confirmed experiment archive "${created.name}" (${created.id}) for video ${video.videoId}.`
      );
    } catch (err: any) {
      console.error(`[VideoManager] Failed to create archive for ${video.videoId}:`, err);
      setStatusBanner(`Failed to create archive: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsAssigningArchiveMap((prev) => ({ ...prev, [video.videoId]: false }));
    }
  };

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

  const handleDeleteVideo = async (video: VideoRecord) => {
    const { videoId, originalName } = video;
    setDeletingIds((prev) => ({ ...prev, [videoId]: true }));
    deletedVideoIdsRef.current.add(videoId);
    try {
      await apiService.deleteVideo(videoId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      setVideos((prev) => {
        const remaining = prev.filter((v) => v.videoId !== videoId);
        if (selectedVideoId === videoId) {
          const nextId = remaining.length > 0 ? remaining[0].videoId : null;
          setSelectedVideoId(nextId);
          setActiveStreamState(nextId);
        }
        return remaining;
      });
      setPassesByVideo((prev) => {
        const copy = { ...prev };
        delete copy[videoId];
        return copy;
      });
      setAnalysisCache((prev) => {
        const copy = { ...prev };
        delete copy[videoId];
        return copy;
      });
      setStatusBanner(`Video "${originalName}" (${videoId}) removed from the database.`);
    } catch (err: any) {
      deletedVideoIdsRef.current.delete(videoId);
      console.error(`[VideoManager] Failed to delete video ${videoId}:`, err);
      setStatusBanner(`Failed to delete video "${originalName}": ${err?.message || 'Unknown error'}`);
    } finally {
      setDeletingIds((prev) => ({ ...prev, [videoId]: false }));
    }
  };

  /**
   * Poll GET /api/videos every 4 seconds while any video has status === 'TRANSCODING'
   * or Pass 0 is actively running in the background.
   * When the active video status becomes 'READY_FOR_ANALYSIS':
   * - Automatically trigger Pass 0 if still PENDING.
   * - Once Pass 0 finishes, stop polling and refresh registry.
   */
  useEffect(() => {
    const hasTranscodingOrPass0Running = videos.some(
      (v) =>
        v.status === 'TRANSCODING' ||
        ensurePasses(passesByVideo[v.videoId] || v.passes).pass0.status === 'RUNNING'
    );
    if (!hasTranscodingOrPass0Running || pollingStoppedForActive) {
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const list = await fetchVideos(false);
        const currentActiveId = selectedVideoId || activeStreamId || transcodingVideoId;
        const activeVid = list.find((v) => v.videoId === currentActiveId);

        if (activeVid && activeVid.status === 'TRANSCODING') {
          // Progress is already displayed in the Video Ingestion progress bar
        } else if (activeVid && activeVid.status === 'READY_FOR_ANALYSIS') {
          setTranscodingVideoId(null);
          setUploadStep('SAVED');
          setUploading(false);
          setUploadProgress(0);
          setLatestUploadedVideo(activeVid);

          const p0Status = ensurePasses(activeVid.passes).pass0.status;
          if (p0Status === 'PENDING' && !autoTriggeredPass0Ref.current.has(activeVid.videoId)) {
            autoTriggeredPass0Ref.current.add(activeVid.videoId);
            console.log(
              `[VideoManager] Active video ${currentActiveId} finished transcoding. Automatically executing Pass 0...`
            );
            setStatusBanner(
              `Video "${activeVid.originalName}" finished transcoding. Automatically executing Pass 0 (Workflow Classification)...`
            );
            void handleRunSinglePass(activeVid, 0);
          } else if (p0Status === 'COMPLETED' || p0Status === 'ERROR') {
            console.log(
              `[VideoManager] Active video ${currentActiveId} is READY_FOR_ANALYSIS and Pass 0 is ${p0Status}. Stopping polling.`
            );
            setPollingStoppedForActive(true);
            const wfType = activeVid.passes?.pass0?.data?.workflowType;
            const wfLabel = formatWorkflowClassificationLabel(wfType, p0Status);
            setStatusBanner(
              `Video "${activeVid.originalName}" transcoding & Pass 0 classification complete (${wfLabel}).`
            );
            await fetchVideos(false);
            if (onSelectActiveStream) {
              onSelectActiveStream(activeVid, analysisCache[activeVid.videoId]);
            }
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
          setUploadProgress(0);
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
    passesByVideo,
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
    setHitlCommitError(null);
    setHitlCommitSuccess(null);
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
      try {
        const analysisDoc = await apiService.fetchVideoAnalysis(selectedVideoId, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        if (!cancelled && analysisDoc) {
          setAnalysisCache((prev) => ({ ...prev, [selectedVideoId]: analysisDoc }));
          if (analysisDoc.isSignedOff) {
            setPassesByVideo((prev) => {
              const cur = ensurePasses(prev[selectedVideoId]);
              if (cur.hitl?.status === 'COMPLETED') return prev;
              return {
                ...prev,
                [selectedVideoId]: {
                  ...cur,
                  hitl: {
                    ...cur.hitl,
                    status: 'COMPLETED',
                    completedAt: (analysisDoc as any).signedOffAt || cur.hitl?.completedAt,
                  },
                },
              };
            });
          }
        }
      } catch {
        // Ignore analysis fetch errors if analysis does not exist yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVideoId, tenant.customerId, tenant.databaseId]);

  const handleSelectVideo = (video: VideoRecord) => {
    setIsSelectedGroupCollapsed(false);
    setActiveStream(video.videoId, video);
    if (video.status === 'TRANSCODING') {
      setPollingStoppedForActive(false);
      setTranscodingVideoId(video.videoId);
      setUploadStep('TRANSCODING');
      setUploadProgress(100);
    }
  };

  const toggleJsonDrawer = (drawerKey: string) => {
    setOpenJsonDrawers((prev) => ({
      ...prev,
      [drawerKey]: !prev[drawerKey],
    }));
  };

  const probeVideoDuration = (file: File): Promise<number | undefined> => {
    return new Promise((resolve) => {
      try {
        const videoEl = document.createElement('video');
        videoEl.preload = 'metadata';
        const objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
          resolve(undefined);
        }, 2500);
        videoEl.onloadedmetadata = () => {
          clearTimeout(timeoutId);
          URL.revokeObjectURL(objectUrl);
          if (videoEl.duration && Number.isFinite(videoEl.duration)) {
            const dur = Math.round(videoEl.duration * 100) / 100;
            setProbedDuration(Math.round(videoEl.duration));
            resolve(dur);
          } else {
            resolve(undefined);
          }
        };
        videoEl.onerror = () => {
          clearTimeout(timeoutId);
          URL.revokeObjectURL(objectUrl);
          resolve(undefined);
        };
        videoEl.src = objectUrl;
      } catch {
        setProbedDuration(undefined);
        resolve(undefined);
      }
    });
  };

  /**
   * Direct-to-GCS V4 Signed URL Upload & Chunked FFmpeg Normalization Flow:
   * 1. Request signed URL: POST /api/videos/request-upload-url with file metadata.
   * 2. Upload raw file directly to GCS via PUT to signedUrl.
   * 3. Notify server to process 10-minute normalized chunks: POST /api/videos/finalize-upload.
   * 4. Refresh video registry on success.
   */
  const uploadToGcsWithProgress = (
    signedUrl: string,
    file: File,
    onProgress: (pct: number) => void
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', signedUrl, true);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
  
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      };
  
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`GCS Upload failed with status ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network error during GCS upload'));
      xhr.send(file);
    });
  };

  const uploadVideoFile = async (file: File) => {
    try {
      setUploading(true);
      const contentType = file.type || 'video/mp4';
      setUploadProgress(0);
      console.log('[VideoManager] Starting direct-to-GCS upload for:', file.name, file.size);

      setSelectedFile(file);
      const durationPromise = probeVideoDuration(file);
      setUploadError(null);
      setLatestUploadedVideo(null);
      setUploadStep('UPLOADING');
      setStatusBanner(null);

      // 1. Request signed URL: POST /api/videos/request-upload-url
      const uploadHeaders = await apiService.getHeaders({
        'Content-Type': 'application/json',
      });
      const urlRes = await fetch('/api/videos/request-upload-url', {
        method: 'POST',
        headers: uploadHeaders,
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

      // 2. Upload raw file directly to GCS via PUT to V4 Signed URL with progress tracking
      setUploadProgress(0);
      await uploadToGcsWithProgress(signedUrl, file, (pct) => {
        setUploadProgress(pct);
      });
      setUploadProgress(100);

      // 3. Notify server to process chunks asynchronously: POST /api/videos/finalize-upload
      setUploadStep('TRANSCODING');
      setUploadProgress(100);

      const browserDuration = await durationPromise;
      const fallbackCapturedAt =
        file.lastModified && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : undefined;

      const finalizeHeaders = await apiService.getHeaders({
        'Content-Type': 'application/json',
      });
      const finalizeRes = await fetch('/api/videos/finalize-upload', {
        method: 'POST',
        headers: finalizeHeaders,
        body: JSON.stringify({
          videoId,
          rawGcsUri,
          originalName: file.name,
          ...(browserDuration !== undefined ? { durationSeconds: browserDuration } : {}),
          ...(fallbackCapturedAt ? { capturedAt: fallbackCapturedAt } : {}),
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
      setUploadProgress(0);
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

      const latestFromList = videos.find((v) => v.videoId === videoId);
      const effectiveArchiveId = latestFromList?.archiveId ?? video.archiveId;
      const effectiveArchiveName = latestFromList?.archiveName ?? video.archiveName;
      const effectiveArchiveCreator = latestFromList?.archiveCreatorName ?? video.archiveCreatorName;
      const effectiveArchiveDate = latestFromList?.archiveCreationDate ?? video.archiveCreationDate;
      const effectiveArchiveAssocType =
        latestFromList?.archiveAssociationType ?? video.archiveAssociationType;

      if (effectiveArchiveName && updatedPasses.pass0?.data) {
        updatedPasses.pass0 = {
          ...updatedPasses.pass0,
          data: {
            ...updatedPasses.pass0.data,
            archiveName: effectiveArchiveName,
            ...(effectiveArchiveCreator ? { creatorName: effectiveArchiveCreator } : {}),
            ...(effectiveArchiveDate ? { creationDate: effectiveArchiveDate } : {}),
          },
        };
      }

      const updatedVideo: VideoRecord = {
        ...video,
        ...(latestFromList || {}),
        ...(effectiveArchiveId !== undefined ? { archiveId: effectiveArchiveId } : {}),
        ...(effectiveArchiveName !== undefined ? { archiveName: effectiveArchiveName } : {}),
        ...(effectiveArchiveCreator !== undefined
          ? { archiveCreatorName: effectiveArchiveCreator }
          : {}),
        ...(effectiveArchiveDate !== undefined ? { archiveCreationDate: effectiveArchiveDate } : {}),
        ...(effectiveArchiveAssocType !== undefined
          ? { archiveAssociationType: effectiveArchiveAssocType }
          : {}),
        status: res.status || (passNum === 3 ? 'ANALYSIS_COMPLETE' : video.status),
        geminiFileUri: res.geminiFileUri || video.geminiFileUri,
        passes: updatedPasses,
      };

      setVideos((prev) =>
        prev.map((v) =>
          v.videoId === videoId
            ? {
                ...updatedVideo,
                archiveId: v.archiveId ?? updatedVideo.archiveId,
                archiveName: v.archiveName ?? updatedVideo.archiveName,
                archiveCreatorName: v.archiveCreatorName ?? updatedVideo.archiveCreatorName,
                archiveCreationDate: v.archiveCreationDate ?? updatedVideo.archiveCreationDate,
                archiveAssociationType:
                  v.archiveAssociationType ?? updatedVideo.archiveAssociationType,
              }
            : v
        )
      );
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

      // If Pass 0 completed, refresh video list from Firestore to pull automatic inventory/archive association
      if (passNum === 0) {
        await fetchVideos(false);
        await loadArchives();
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
   * Master "Run All Passes" handler: executes Pass 1 -> Pass 2 -> Pass 3 sequentially
   * (Pass 0 is executed automatically upon completion of the uploading & transcoding stage).
   * Each pass card shows real-time spinners and updates its JSON output as it completes.
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
      await handleRunSinglePass(video, 1);
      await handleRunSinglePass(video, 2);
      const res3 = await handleRunSinglePass(video, 3);

      setStatusBanner(
        `AI Passes (Pass 1 – Pass 3) completed for ${video.originalName} (${videoId}) and persisted to Firestore video_analyses/${videoId}.`
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
    const rawCached = analysisCache[video.videoId];
    const passes = (passesByVideo[video.videoId] || video.passes) as Record<string, any> | undefined;
    const pass0Data = passes?.pass0?.data;
    const rawPass1 = passes?.pass1?.data;
    const pass1Actions = Array.isArray(rawPass1)
      ? rawPass1
      : Array.isArray(rawPass1?.actions)
      ? rawPass1.actions
      : [];
    const rawPass2 = passes?.pass2?.data;
    const pass2Events = Array.isArray(rawPass2)
      ? rawPass2
      : Array.isArray(rawPass2?.events)
      ? rawPass2.events
      : [];
    const rawPass3 = passes?.pass3?.data;
    const pass3Refinements = Array.isArray(rawPass3)
      ? rawPass3
      : Array.isArray(rawPass3?.refinements)
      ? rawPass3.refinements
      : [];
    const pass3Reagents = Array.isArray(passes?.pass3?.reagents)
      ? passes.pass3.reagents
      : Array.isArray(rawPass3?.reagents)
      ? rawPass3.reagents
      : undefined;
    const pass3WorkSteps = Array.isArray(passes?.pass3?.workSteps)
      ? passes.pass3.workSteps
      : Array.isArray(rawPass3?.workSteps)
      ? rawPass3.workSteps
      : undefined;
    const pass3Transcriptions = Array.isArray(passes?.pass3?.labelTranscriptions)
      ? passes.pass3.labelTranscriptions
      : Array.isArray(rawPass3?.labelTranscriptions)
      ? rawPass3.labelTranscriptions
      : undefined;
    const currentArchiveEdits = hitlArchiveEdits[video.videoId] || {};

    const detectedWorkflow =
      rawCached?.workflowClassification?.workflowType ||
      rawCached?.workloadClassification?.workflowType ||
      pass0Data?.workflowType;
    const isArchiveWorkflow =
      detectedWorkflow === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      Boolean(video.archiveId) ||
      video.originalName.toLowerCase().includes('archive') ||
      video.videoId.toLowerCase().includes('archive') ||
      pass1Actions.some((a: any) => {
        const cls = String(a?.actionType || a?.actionClass || '').toUpperCase();
        return cls.includes('MIX') || cls.includes('SEED');
      });

    const candidateArchiveName =
      video.archiveName ||
      (rawCached as any)?.archiveName ||
      pass0Data?.archiveName;
    const matchedArchive = isArchiveWorkflow
      ? archives.find(
          (a) =>
            (video.archiveId && a.id === video.archiveId) ||
            (Array.isArray(a.videoIds) && a.videoIds.includes(video.videoId)) ||
            (candidateArchiveName &&
              a.name &&
              a.name.trim().toLowerCase() === String(candidateArchiveName).trim().toLowerCase())
        )
      : undefined;
    const assignedArchiveId = assigningArchiveMap[video.videoId];
    const resolvedArchiveId =
      video.archiveId ||
      (assignedArchiveId && assignedArchiveId !== '__NEW__' ? assignedArchiveId : undefined) ||
      matchedArchive?.id ||
      (rawCached as any)?.archiveId ||
      (isArchiveWorkflow ? archives[0]?.id : undefined);
    const resolvedArchiveName =
      matchedArchive?.name ||
      video.archiveName ||
      candidateArchiveName;
    const resolvedCreatorName =
      matchedArchive?.creatorName ||
      video.archiveCreatorName ||
      (rawCached as any)?.creatorName ||
      pass0Data?.creatorName;
    const resolvedCreationDate =
      matchedArchive?.creationDate ||
      video.archiveCreationDate ||
      (rawCached as any)?.creationDate ||
      pass0Data?.creationDate;

    const mergedReagents =
      currentArchiveEdits.reagents ??
      (Array.isArray(rawCached?.reagents) && rawCached.reagents.length > 0
        ? rawCached.reagents
        : pass3Reagents);
    const mergedWorkSteps =
      currentArchiveEdits.workSteps ??
      (Array.isArray(rawCached?.workSteps) && rawCached.workSteps.length > 0
        ? rawCached.workSteps
        : pass3WorkSteps);
    const mergedTranscriptions =
      currentArchiveEdits.labelTranscriptions ??
      (Array.isArray((rawCached as any)?.labelTranscriptions) &&
      (rawCached as any).labelTranscriptions.length > 0
        ? (rawCached as any).labelTranscriptions
        : pass3Transcriptions);

    const hasPassData =
      Boolean(rawCached) ||
      Boolean(pass0Data) ||
      pass1Actions.length > 0 ||
      pass2Events.length > 0 ||
      pass3Refinements.length > 0 ||
      Boolean(mergedReagents && mergedReagents.length > 0) ||
      Boolean(mergedWorkSteps && mergedWorkSteps.length > 0);

    const baseClassification =
      rawCached?.workflowClassification ||
      rawCached?.workloadClassification ||
      pass0Data;
    const syncedClassification = baseClassification
      ? {
          ...baseClassification,
          ...(resolvedArchiveName ? { archiveName: resolvedArchiveName } : {}),
          ...(resolvedCreatorName ? { creatorName: resolvedCreatorName } : {}),
          ...(resolvedCreationDate ? { creationDate: resolvedCreationDate } : {}),
        }
      : undefined;

    const fallbackClassification = syncedClassification || {
      workflowType: isArchiveWorkflow
        ? 'EXPERIMENT_NOTEBOOK_WORKFLOW'
        : 'INVENTORY_UPDATE_WORKFLOW',
      transcribedAudio: '',
      ...(resolvedArchiveName ? { archiveName: resolvedArchiveName } : {}),
      ...(resolvedCreatorName ? { creatorName: resolvedCreatorName } : {}),
      ...(resolvedCreationDate ? { creationDate: resolvedCreationDate } : {}),
      ...(video.inventoryName ? { inventoryName: video.inventoryName } : {}),
    };

    const cachedAnalysis: VideoAnalysisDoc = {
      videoId: video.videoId,
      ...(rawCached || {}),
      workflowClassification: fallbackClassification as any,
      workloadClassification: fallbackClassification as any,
      actions:
        Array.isArray(rawCached?.actions) && rawCached.actions.length > 0
          ? rawCached.actions
          : pass1Actions,
      events:
        Array.isArray(rawCached?.events) && rawCached.events.length > 0
          ? rawCached.events
          : pass2Events,
      refinements:
        Array.isArray(rawCached?.refinements) && rawCached.refinements.length > 0
          ? rawCached.refinements
          : pass3Refinements,
      ...(mergedReagents ? { reagents: mergedReagents } : {}),
      ...(mergedWorkSteps ? { workSteps: mergedWorkSteps } : {}),
      ...(mergedTranscriptions ? { labelTranscriptions: mergedTranscriptions } : {}),
      ...(resolvedArchiveId ? { archiveId: resolvedArchiveId } : {}),
      ...(resolvedArchiveName ? { archiveName: resolvedArchiveName } : {}),
      ...(resolvedCreatorName ? { creatorName: resolvedCreatorName } : {}),
      ...(resolvedCreationDate ? { creationDate: resolvedCreationDate } : {}),
      ...(video.inventoryId ? { inventoryId: video.inventoryId } : {}),
      isSignedOff: Boolean(
        (video as any).isSignedOff ||
          rawCached?.isSignedOff ||
          passes?.hitl?.status === 'COMPLETED'
      ),
    } as VideoAnalysisDoc;

    if (cachedAnalysis) {
      setAnalysisCache((prev) => ({ ...prev, [video.videoId]: cachedAnalysis }));
    }
    onSelectActiveStream?.(video, cachedAnalysis);

    if (forceHitlTab) {
      if (isArchiveWorkflow && resolvedArchiveId) {
        onNavigateToArchive?.(resolvedArchiveId, video.videoId);
      } else if (!isArchiveWorkflow && video.inventoryId) {
        onNavigateToInventory?.(video.inventoryId, video.videoId);
      }
      onSelectVideoForReview(video.videoId, 'hitl', cachedAnalysis);
      return;
    }

    const targetTab: 'inventory' | 'archive' = isArchiveWorkflow ? 'archive' : 'inventory';

    if (targetTab === 'archive' && resolvedArchiveId) {
      onNavigateToArchive?.(resolvedArchiveId, video.videoId);
    } else if (targetTab === 'inventory' && video.inventoryId) {
      onNavigateToInventory?.(video.inventoryId, video.videoId);
    }
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
      const pct = typeof video.transcodeProgress === 'number' ? video.transcodeProgress : 0;
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-yellow-950/80 text-yellow-300 border border-yellow-700/60">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{`Transcoding (${video.transcodeProgress || 0}%)`}</span>
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
        <span>Transcoded</span>
      </span>
    );
  };

  const renderAnalysisBadge = (video: VideoRecord) => {
    const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
    const runningMap = runningPassMap[video.videoId] || {};
    const anyPassRunning =
      Boolean(analyzingIds[video.videoId]) ||
      Object.values(runningMap).some(Boolean) ||
      vPasses.pass0.status === 'RUNNING' ||
      vPasses.pass1.status === 'RUNNING' ||
      vPasses.pass2.status === 'RUNNING' ||
      vPasses.pass3.status === 'RUNNING' ||
      video.status === 'ANALYZING';

    if (anyPassRunning) {
      let runningPassNum = 1;
      if (runningMap.pass0 || vPasses.pass0.status === 'RUNNING') {
        runningPassNum = 0;
      } else if (runningMap.pass1 || vPasses.pass1.status === 'RUNNING') {
        runningPassNum = 1;
      } else if (runningMap.pass2 || vPasses.pass2.status === 'RUNNING') {
        runningPassNum = 2;
      } else if (runningMap.pass3 || vPasses.pass3.status === 'RUNNING') {
        runningPassNum = 3;
      } else if (vPasses.pass0.status !== 'COMPLETED') {
        runningPassNum = 0;
      } else if (vPasses.pass1.status !== 'COMPLETED') {
        runningPassNum = 1;
      } else if (vPasses.pass2.status !== 'COMPLETED') {
        runningPassNum = 2;
      } else {
        runningPassNum = 3;
      }

      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-950/80 text-blue-300 border border-blue-600/60"
        >
          <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
          <span>Running Pass {runningPassNum}</span>
        </span>
      );
    }

    if (video.status === 'ANALYSIS_COMPLETE' || vPasses.pass3.status === 'COMPLETED') {
      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/60"
        >
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          <span>Pass 3 Finished</span>
        </span>
      );
    }

    if (vPasses.pass2.status === 'COMPLETED') {
      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-cyan-950/80 text-cyan-300 border border-cyan-700/60"
        >
          <CheckCircle2 className="w-3 h-3 text-cyan-400" />
          <span>Pass 2 Finished</span>
        </span>
      );
    }

    if (vPasses.pass1.status === 'COMPLETED') {
      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-cyan-950/80 text-cyan-300 border border-cyan-700/60"
        >
          <CheckCircle2 className="w-3 h-3 text-cyan-400" />
          <span>Pass 1 Finished</span>
        </span>
      );
    }

    if (vPasses.pass0.status === 'COMPLETED') {
      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-cyan-950/80 text-cyan-300 border border-cyan-700/60"
        >
          <CheckCircle2 className="w-3 h-3 text-cyan-400" />
          <span>Pass 0 Finished</span>
        </span>
      );
    }

    if (video.status === 'FAILED') {
      return (
        <span
          data-testid={`pipeline-status-badge-${video.videoId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-950/80 text-rose-300 border border-rose-600/60"
        >
          <AlertCircle className="w-3 h-3 text-rose-400" />
          <span>Error</span>
        </span>
      );
    }

    return (
      <span
        data-testid={`pipeline-status-badge-${video.videoId}`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-800/90 text-slate-400 border border-slate-700"
      >
        <Clock className="w-3 h-3 text-slate-500" />
        <span>No Pass Finished</span>
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

  const renderArchiveBadge = (video: VideoRecord) => {
    const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
    const pass0Data = vPasses.pass0.data;
    const isArchiveWorkflow =
      pass0Data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      Boolean(video.archiveId) ||
      Boolean(video.archiveAssociationType);

    if (!isArchiveWorkflow) {
      return null;
    }

    // 1. Matched / Confirmed / Associated Archive
    if (video.archiveId) {
      const matchTypeLabel =
        video.archiveAssociationType === 'AUTOMATIC' ? 'High-Confidence Auto-Match' : 'Confirmed';
      const creatorLabel = video.archiveCreatorName || pass0Data?.creatorName;
      const dateLabel = video.archiveCreationDate || pass0Data?.creationDate;
      const purposeLabel =
        (video as any).archivePurpose ||
        pass0Data?.purpose ||
        pass0Data?.identificationEvent?.purpose;

      return (
        <div
          className="flex items-center gap-1.5 flex-wrap mt-1.5"
          onClick={(e) => e.stopPropagation()}
          data-testid={`archive-associated-badge-${video.videoId}`}
        >
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-600/60 font-mono">
            <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>
              Linked to Archive: {video.archiveName || video.archiveId} ({matchTypeLabel})
            </span>
          </span>
          {creatorLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 text-slate-300 border border-slate-700">
              Creator: {creatorLabel}
            </span>
          )}
          {dateLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 text-slate-300 border border-slate-700">
              Date: {dateLabel}
            </span>
          )}
          {purposeLabel && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 text-indigo-300 border border-indigo-700/60">
              Purpose: {purposeLabel}
            </span>
          )}
        </div>
      );
    }

    const intent: 'CREATE' | 'APPEND' =
      video.archiveIntent ||
      pass0Data?.archiveIntent ||
      (pass0Data?.isAppending === true
        ? 'APPEND'
        : video.archiveAssociationType === 'UNMATCHED'
        ? 'APPEND'
        : 'CREATE');

    const draft = getArchiveDraftForVideo(video);
    const isBusy = Boolean(isAssigningArchiveMap[video.videoId]);
    const selectedArch = assigningArchiveMap[video.videoId] || (archives[0]?.id ?? '');

    // 2. Appending to existing archive, but no high-confidence match found in database
    if (video.archiveAssociationType === 'UNMATCHED' || intent === 'APPEND') {
      const unmatchedName =
        video.unmatchedArchiveName || pass0Data?.archiveName || 'Unspecified Archive';

      return (
        <div
          className="mt-2 p-2.5 rounded-lg bg-amber-950/30 border border-amber-700/60 space-y-2"
          onClick={(e) => e.stopPropagation()}
          data-testid={`archive-unmatched-prompt-${video.videoId}`}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-300 font-mono">
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                Append target &ldquo;{unmatchedName}&rdquo; has no high-confidence match. Associate with an existing archive or create a new one:
              </span>
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              aria-label={`Select existing archive for ${video.videoId}`}
              value={selectedArch}
              onChange={(e) =>
                setAssigningArchiveMap((prev) => ({
                  ...prev,
                  [video.videoId]: e.target.value,
                }))
              }
              className="bg-slate-950 border border-slate-700 text-slate-200 text-[11px] rounded px-2 py-1 font-mono focus:border-cyan-500 focus:outline-none"
            >
              <option value="" disabled>
                Select existing archive...
              </option>
              {archives.map((arch) => (
                <option key={arch.id} value={arch.id}>
                  {arch.name} ({arch.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedArch || isBusy}
              onClick={() => handleAssociateArchive(video.videoId, selectedArch)}
              className="px-2.5 py-1 rounded text-[11px] font-semibold bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1"
            >
              {isBusy && <Loader2 className="w-3 h-3 animate-spin" />}
              <span>Associate Existing Archive</span>
            </button>
            <button
              type="button"
              onClick={() =>
                updateArchiveDraftForVideo(video, { showCreateForm: !draft.showCreateForm })
              }
              className="px-2.5 py-1 rounded text-[11px] font-semibold bg-indigo-950 hover:bg-indigo-900 text-indigo-200 border border-indigo-700/70 transition-colors"
            >
              {draft.showCreateForm ? 'Hide New Archive Form' : 'Create New Archive Instead'}
            </button>
          </div>

          {draft.showCreateForm && (
            <div className="pt-2 border-t border-amber-800/40 grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                  Archive Name (Required) *
                </label>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => updateArchiveDraftForVideo(video, { name: e.target.value })}
                  placeholder="Archive Name"
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-cyan-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                  Creator Name (Optional)
                </label>
                <input
                  type="text"
                  value={draft.creatorName}
                  onChange={(e) =>
                    updateArchiveDraftForVideo(video, { creatorName: e.target.value })
                  }
                  placeholder="e.g., Dr. Jane Smith"
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-cyan-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-slate-400 mb-0.5">
                  Creation Date (Optional)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={draft.creationDate}
                    onChange={(e) =>
                      updateArchiveDraftForVideo(video, { creationDate: e.target.value })
                    }
                    placeholder="YYYY-MM-DD"
                    className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-cyan-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!draft.name.trim() || isBusy}
                    onClick={() => handleConfirmCreateArchive(video)}
                    className="shrink-0 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1"
                  >
                    {isBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                    <span>Create &amp; Associate</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // 3. Creating a new archive (auto-populated from transcribed audio, awaiting user confirmation)
    return (
      <div
        className="mt-2 p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-700/60 space-y-2"
        onClick={(e) => e.stopPropagation()}
        data-testid={`archive-create-confirmation-${video.videoId}`}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-indigo-200 font-mono">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
            <span>
              New Experiment Archive detected from audio transcript — Confirm archive creation:
            </span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <label className="block text-[10px] font-mono text-slate-300 mb-0.5">
              Archive Name (Required) *
            </label>
            <input
              type="text"
              aria-label={`Archive Name for ${video.videoId}`}
              value={draft.name}
              onChange={(e) => updateArchiveDraftForVideo(video, { name: e.target.value })}
              placeholder="Archive Name"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-300 mb-0.5">
              Creator Name (Optional)
            </label>
            <input
              type="text"
              aria-label={`Creator Name for ${video.videoId}`}
              value={draft.creatorName}
              onChange={(e) => updateArchiveDraftForVideo(video, { creatorName: e.target.value })}
              placeholder="Not specified in audio"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-300 mb-0.5">
              Creation Date (Optional)
            </label>
            <input
              type="text"
              aria-label={`Creation Date for ${video.videoId}`}
              value={draft.creationDate}
              onChange={(e) => updateArchiveDraftForVideo(video, { creationDate: e.target.value })}
              placeholder="Not specified in audio"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-indigo-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-300 mb-0.5">
              Purpose (Optional)
            </label>
            <input
              type="text"
              aria-label={`Purpose for ${video.videoId}`}
              value={draft.purpose || ''}
              onChange={(e) => updateArchiveDraftForVideo(video, { purpose: e.target.value })}
              placeholder="Reason for experiment (optional)"
              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:border-indigo-400 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
          <button
            type="button"
            disabled={!draft.name.trim() || isBusy}
            onClick={() => handleConfirmCreateArchive(video)}
            className="px-3 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {isBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            <span>Confirm &amp; Create Archive</span>
          </button>

          {archives.length > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] font-mono text-slate-400">Or link existing:</span>
              <select
                value={selectedArch}
                onChange={(e) =>
                  setAssigningArchiveMap((prev) => ({
                    ...prev,
                    [video.videoId]: e.target.value,
                  }))
                }
                className="bg-slate-950 border border-slate-700 text-slate-200 text-[11px] rounded px-2 py-0.5 font-mono focus:border-cyan-500 focus:outline-none"
              >
                {archives.map((arch) => (
                  <option key={arch.id} value={arch.id}>
                    {arch.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!selectedArch || isBusy}
                onClick={() => handleAssociateArchive(video.videoId, selectedArch)}
                className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-600 disabled:opacity-50 transition-colors"
              >
                Associate
              </button>
            </div>
          )}
        </div>
      </div>
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
      {/* Top Panel: Compact Video Ingestion Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <div className="flex items-center justify-between pb-2.5 border-b border-slate-800 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-400">
              <UploadCloud className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">
                Video Ingestion
              </h2>
            </div>
          </div>
        </div>

        {/* Drag & drop upload area */}
        <label
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className="border-2 border-dashed border-slate-700 hover:border-cyan-500 rounded-xl px-4 py-3 flex items-center justify-center gap-3 cursor-pointer transition-colors bg-slate-950/60 hover:bg-slate-950 group"
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
          <div className="w-9 h-9 rounded-full bg-slate-800 group-hover:bg-cyan-950 text-slate-400 group-hover:text-cyan-400 flex items-center justify-center transition-colors shrink-0">
            <FileVideo className="w-4 h-4" />
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2.5">
            <span className="text-xs font-semibold text-slate-200">
              {selectedFile ? selectedFile.name : 'Choose video to upload'}
            </span>
            {selectedFile && (
              <span className="text-xs text-slate-500">
                {`${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB${
                  probedDuration ? ` • Duration: ${formatDuration(probedDuration)}` : ''
                }`}
              </span>
            )}
          </div>
        </label>

            {/* Action Button for Upload & Transcoding */}
            {selectedFile && (
              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
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
                <span>{uploadStep === 'UPLOADING' ? `Stage 1/2: Uploading raw video to Cloud Storage... [${uploadProgress}%]` : '1. Uploading Raw Video'}</span>
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
                <span>
                  {uploadStep === 'TRANSCODING'
                    ? `Stage 2/2: Normalizing & segmenting video... [${(videos.find((v) => v.videoId === transcodingVideoId) || latestUploadedVideo)?.transcodeProgress || 0}%]`
                    : '2. Transcoding & segmenting video in background...'}
                </span>
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

            {uploadStep === 'UPLOADING' && (
              <div className="space-y-1.5 pt-2 font-mono">
                <div className="flex items-center justify-between text-xs text-cyan-300">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
                    <span>{`Stage 1/2: Uploading raw video to Cloud Storage... [${uploadProgress}%]`}</span>
                  </span>
                  <span className="font-bold">{`${uploadProgress}%`}</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {uploadStep === 'TRANSCODING' && (() => {
              const activeVid = videos.find((v) => v.videoId === transcodingVideoId) || latestUploadedVideo;
              const transcodePct = activeVid?.transcodeProgress || 0;
              return (
                <div className="space-y-1.5 pt-2 font-mono">
                  <div className="flex items-center justify-between text-xs text-amber-300">
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                      <span>{`Stage 2/2: Normalizing & segmenting video... [${transcodePct}%]`}</span>
                    </span>
                    <span className="font-bold">{`${transcodePct}%`}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-yellow-500 rounded-full transition-all duration-300"
                      style={{ width: `${transcodePct}%` }}
                    />
                  </div>
                </div>
              );
            })()}

            {uploadError && (
              <div className="flex items-center gap-2 text-xs font-mono text-rose-300">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* Status Banner */}
        {statusBanner && uploadStep !== 'UPLOADING' && uploadStep !== 'TRANSCODING' && (
          <div className="mt-4 p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-cyan-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{statusBanner}</span>
            </div>
          </div>
        )}
      </div>

      {/* Aligned Bottom Row: Video Registry (Left) & Video Analysis and Verification (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Left Column: Video Registry */}
        <div className="space-y-6 min-w-0">
          {/* Video Registry */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-5 h-5 text-cyan-400" />
              <span>Video Registry</span>
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Select a video below to set the global activeStream context
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
          <div className="space-y-3">
            {(() => {
              interface VideoGroup {
                groupKey: string;
                entityType: 'archive' | 'inventory' | 'unassociated';
                entityId: string | null;
                entityName: string;
                creatorName: string | null;
                creationDate: string | null;
                captureDayKey: string;
                captureDayLabel: string;
                classificationLabel: string;
                associationLabel: string;
                isMatched: boolean;
                videos: VideoRecord[];
              }

              const groupsMap = new Map<string, VideoGroup>();

              for (const video of videos) {
                const vPasses = ensurePasses(passesByVideo[video.videoId] || video.passes);
                const pass0Data = vPasses.pass0.data;
                const pass0WorkflowType =
                  pass0Data?.workflowType ||
                  analysisCache[video.videoId]?.workflowClassification?.workflowType ||
                  analysisCache[video.videoId]?.workloadClassification?.workflowType;
                const classificationLabel = formatWorkflowClassificationLabel(
                  pass0WorkflowType,
                  vPasses.pass0.status
                );
                const { dayKey: captureDayKey, dayLabel: captureDayLabel } = extractCaptureDay(
                  (video as any).capturedAt || video.uploadedAt
                );

                const isArchive =
                  pass0WorkflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                  Boolean(video.archiveId) ||
                  Boolean(video.archiveAssociationType) ||
                  Boolean(video.archiveName) ||
                  Boolean(video.unmatchedArchiveName);

                const isInventory =
                  !isArchive &&
                  (pass0WorkflowType === 'INVENTORY_UPDATE_WORKFLOW' ||
                    Boolean(video.inventoryId) ||
                    Boolean(video.inventoryAssociationType) ||
                    Boolean(video.inventoryName) ||
                    Boolean(video.unmatchedInventoryName));

                let entityType: 'archive' | 'inventory' | 'unassociated' = 'unassociated';
                let entityId: string | null = null;
                let entityName = 'Unassociated Videos';
                let creatorName: string | null = (video as any).uploadedBy || null;
                let creationDate: string | null = null;
                let associationLabel = classificationLabel;
                let isMatched = false;
                let entityKey = 'unassociated';

                if (isArchive) {
                  entityType = 'archive';
                  const candidateName =
                    video.archiveName ||
                    video.unmatchedArchiveName ||
                    pass0Data?.archiveName ||
                    '';
                  const matchedArchive = archives.find(
                    (a) =>
                      (video.archiveId && a.id === video.archiveId) ||
                      (Array.isArray(a.videoIds) && a.videoIds.includes(video.videoId)) ||
                      (candidateName &&
                        a.name &&
                        a.name.trim().toLowerCase() === String(candidateName).trim().toLowerCase())
                  );
                  entityId = video.archiveId || matchedArchive?.id || null;
                  entityName =
                    matchedArchive?.name ||
                    video.archiveName ||
                    video.unmatchedArchiveName ||
                    pass0Data?.archiveName ||
                    'Unspecified Experiment Archive';
                  creatorName =
                    matchedArchive?.creatorName ||
                    video.archiveCreatorName ||
                    pass0Data?.creatorName ||
                    null;
                  creationDate =
                    matchedArchive?.creationDate ||
                    video.archiveCreationDate ||
                    pass0Data?.creationDate ||
                    null;
                  isMatched = Boolean(video.archiveId || matchedArchive?.id);
                  associationLabel = video.archiveId
                    ? video.archiveAssociationType === 'AUTOMATIC'
                      ? 'High-Confidence Auto-Match'
                      : 'Confirmed'
                    : video.archiveAssociationType === 'UNMATCHED'
                    ? 'Unmatched Archive'
                    : 'Pending Archive Confirmation';
                  entityKey = entityId
                    ? `archive:${entityId}`
                    : `archive_name:${entityName.trim().toLowerCase()}`;
                } else if (isInventory) {
                  entityType = 'inventory';
                  const candidateInvName =
                    video.inventoryName ||
                    video.unmatchedInventoryName ||
                    pass0Data?.inventoryName ||
                    '';
                  const matchedInventory = inventories.find(
                    (inv) =>
                      (video.inventoryId && inv.id === video.inventoryId) ||
                      (candidateInvName &&
                        inv.name &&
                        inv.name.trim().toLowerCase() ===
                          String(candidateInvName).trim().toLowerCase())
                  );
                  entityId = video.inventoryId || matchedInventory?.id || null;
                  entityName =
                    matchedInventory?.name ||
                    video.inventoryName ||
                    video.unmatchedInventoryName ||
                    pass0Data?.inventoryName ||
                    'Unspecified Cryo-Inventory';
                  creatorName =
                    (matchedInventory as any)?.creatorName ||
                    (video as any).uploadedBy ||
                    null;
                  creationDate = matchedInventory?.createdAt
                    ? extractCaptureDay(matchedInventory.createdAt).dayLabel
                    : null;
                  isMatched = Boolean(video.inventoryId || matchedInventory?.id);
                  associationLabel = video.inventoryId
                    ? video.inventoryAssociationType === 'MANUAL'
                      ? 'Manual'
                      : 'Auto-Matched'
                    : 'Unmatched Inventory';
                  entityKey = entityId
                    ? `inventory:${entityId}`
                    : `inventory_name:${entityName.trim().toLowerCase()}`;
                }

                const groupKey = `${entityKey}__${captureDayKey}`;
                const existing = groupsMap.get(groupKey);
                if (existing) {
                  existing.videos.push(video);
                  if (!existing.creatorName && creatorName) existing.creatorName = creatorName;
                  if (!existing.creationDate && creationDate) existing.creationDate = creationDate;
                  if (!existing.entityId && entityId) existing.entityId = entityId;
                  if (!existing.isMatched && isMatched) {
                    existing.isMatched = true;
                    existing.associationLabel = associationLabel;
                  }
                } else {
                  groupsMap.set(groupKey, {
                    groupKey,
                    entityType,
                    entityId,
                    entityName,
                    creatorName,
                    creationDate,
                    captureDayKey,
                    captureDayLabel,
                    classificationLabel,
                    associationLabel,
                    isMatched,
                    videos: [video],
                  });
                }
              }

              const videoGroups = Array.from(groupsMap.values());

              return videoGroups.map((group) => {
                const isSelectedGroup = Boolean(
                  selectedVideo &&
                    group.videos.some((v) => v.videoId === selectedVideo.videoId)
                );
                // Only the panel for the selected video should be not collapsed. All other panels should be collapsed.
                const isExpanded = isSelectedGroup && !isSelectedGroupCollapsed;

                const unlinkedVideosInGroup = group.videos.filter(
                  (v) =>
                    (group.entityType === 'archive' && !v.archiveId) ||
                    (group.entityType === 'inventory' && !v.inventoryId)
                );

                return (
                  <div
                    key={group.groupKey}
                    data-testid={`video-group-panel-${group.groupKey}`}
                    className={`rounded-xl border transition-all overflow-hidden ${
                      isSelectedGroup
                        ? 'border-cyan-500/50 bg-slate-950/90 shadow-lg shadow-cyan-950/20'
                        : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                    }`}
                  >
                    {/* Collapsible Group Panel Header: Archive/Inventory & Capture Day Info */}
                    <button
                      type="button"
                      onClick={() => {
                        if (isSelectedGroup) {
                          setIsSelectedGroupCollapsed((prev) => !prev);
                        } else if (group.videos.length > 0) {
                          handleSelectVideo(group.videos[0]);
                        }
                      }}
                      className={`w-full text-left px-4 py-3.5 flex flex-wrap items-center justify-between gap-3 transition-colors ${
                        isSelectedGroup
                          ? 'bg-slate-900/90 hover:bg-slate-900'
                          : 'bg-slate-900/40 hover:bg-slate-900/70'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2.5">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-cyan-400 shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                        )}

                        {group.entityType === 'archive' ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-indigo-950/90 text-indigo-300 border border-indigo-700/60">
                            <Sparkles className="w-3 h-3 text-indigo-400 shrink-0" />
                            <span>Experiment Archive</span>
                          </span>
                        ) : group.entityType === 'inventory' ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-cyan-950/90 text-cyan-300 border border-cyan-700/60">
                            <Package className="w-3 h-3 text-cyan-400 shrink-0" />
                            <span>Cryo-Inventory</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                            <FileVideo className="w-3 h-3 text-slate-400 shrink-0" />
                            <span>Unassociated</span>
                          </span>
                        )}

                        <span className="text-sm font-bold text-slate-100">
                          {group.entityName}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        {group.creatorName && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-slate-950 text-slate-300 border border-slate-800">
                            Creator: <strong className="ml-1 text-slate-100">{group.creatorName}</strong>
                          </span>
                        )}

                        {group.creationDate && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-slate-950 text-slate-300 border border-slate-800">
                            Created: <strong className="ml-1 text-slate-100">{group.creationDate}</strong>
                          </span>
                        )}

                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-950 text-cyan-300 border border-slate-800">
                          <Clock className="w-3 h-3 text-cyan-400" />
                          <span>Captured: {group.captureDayLabel}</span>
                        </span>

                        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700 text-[11px]">
                          {group.videos.length} {group.videos.length === 1 ? 'Video' : 'Videos'}
                        </span>
                      </div>
                    </button>

                    {/* Collapsible Group Panel Body */}
                    {isExpanded && (
                      <div className="p-3.5 border-t border-slate-800/80 space-y-2.5 bg-slate-950/60">
                        {/* If any video in this group is awaiting archive/inventory confirmation or association, show the prompt once at the top of the panel */}
                        {unlinkedVideosInGroup.length > 0 && (
                          <div className="pb-1">
                            {group.entityType === 'inventory'
                              ? renderInventoryBadge(unlinkedVideosInGroup[0])
                              : renderArchiveBadge(unlinkedVideosInGroup[0])}
                          </div>
                        )}

                        {group.videos.map((video) => {
                          const isActive =
                            selectedVideo
                              ? selectedVideo.videoId === video.videoId
                              : activeStreamId === video.videoId;
                          const isVideoAnalyzing =
                            Boolean(analyzingIds[video.videoId]) ||
                            Object.values(runningPassMap[video.videoId] || {}).some(Boolean) ||
                            video.status === 'ANALYZING';
                          const vPasses = ensurePasses(
                            passesByVideo[video.videoId] || video.passes
                          );
                          const isAnalysisComplete =
                            video.status === 'ANALYSIS_COMPLETE' ||
                            vPasses.pass3.status === 'COMPLETED';
                          const canInspectResults =
                            isAnalysisComplete ||
                            vPasses.pass2.status === 'COMPLETED' ||
                            Boolean(video.archiveId) ||
                            Boolean(video.inventoryId);
                          const isDeleting = Boolean(deletingIds[video.videoId]);

                          return (
                            <div
                              key={video.videoId}
                              data-testid={`video-card-${video.videoId}`}
                              onClick={() => handleSelectVideo(video)}
                              className={`rounded-xl p-4 border cursor-pointer transition-all flex items-center gap-4 ${
                                isActive
                                  ? 'bg-cyan-950/25 border-cyan-500/60 shadow-md shadow-cyan-950/30'
                                  : 'bg-slate-900/70 border-slate-800 hover:bg-slate-900 hover:border-slate-700'
                              }`}
                            >
                              {/* Left: Portrait Thumbnail Preview (when active) or FileVideo Icon */}
                              {isActive ? (
                                <ActiveStreamThumbnailPreview
                                  videoId={video.videoId}
                                  originalName={video.originalName}
                                  status={video.status}
                                  tenant={tenant}
                                  organizationId={(video as any).organizationId}
                                  durationSeconds={video.durationSeconds}
                                  chunks={video.chunks}
                                  totalChunks={video.totalChunks}
                                />
                              ) : (
                                <div className="w-9 h-9 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0">
                                  <FileVideo className="w-4 h-4 text-cyan-400" />
                                </div>
                              )}

                              {/* Right of Preview: Video Info, Status Badges & Action Controls */}
                              <div className="flex-1 min-w-0 space-y-2.5">
                                {/* Video Identity & Capture Time/Duration */}
                                <div>
                                  <div className="font-semibold text-slate-100 text-xs sm:text-sm flex items-center gap-2 flex-wrap">
                                    <span className="truncate">{video.originalName}</span>
                                    {isActive && (
                                      <span className="text-[10px] font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 px-1.5 py-0.5 rounded shrink-0">
                                        ACTIVE STREAM
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] font-mono text-slate-400 mt-1 flex flex-wrap items-center gap-2">
                                    <span>
                                      ID: <span className="text-slate-300">{video.videoId}</span>
                                    </span>
                                    <span>•</span>
                                    <span className="inline-flex items-center gap-1 text-slate-300">
                                      <Clock className="w-3 h-3 text-slate-500" />
                                      <span>
                                        {formatTimestamp(
                                          (video as any).capturedAt || video.uploadedAt
                                        )}
                                      </span>
                                    </span>
                                    <span>•</span>
                                    <span>
                                      Duration:{' '}
                                      {video.durationSeconds !== undefined &&
                                      video.durationSeconds > 0
                                        ? formatDuration(video.durationSeconds)
                                        : '--:--'}
                                    </span>
                                    {isActive && video.fileSizeBytes ? (
                                      <>
                                        <span>•</span>
                                        <span>
                                          {(video.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB
                                        </span>
                                      </>
                                    ) : null}
                                  </div>
                                </div>

                                {video.status === 'TRANSCODING' && (
                                  <div className="w-full space-y-1.5 py-1 font-mono">
                                    <div className="flex items-center justify-between text-xs text-amber-300">
                                      <span className="flex items-center gap-1.5">
                                        <Loader2 className="w-3 h-3 animate-spin text-amber-400 shrink-0" />
                                        <span>{`Stage 2/2: Normalizing & segmenting video... [${video.transcodeProgress || 0}%]`}</span>
                                      </span>
                                      <span className="font-bold">{`${video.transcodeProgress || 0}%`}</span>
                                    </div>
                                    <div className="w-full h-2 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
                                      <div
                                        className="h-full bg-gradient-to-r from-amber-500 to-yellow-500 rounded-full transition-all duration-300"
                                        style={{ width: `${video.transcodeProgress || 0}%` }}
                                      />
                                    </div>
                                  </div>
                                )}

                                {isActive && (
                                  <>
                                    {/* Ingestion & Pipeline Status Badges */}
                                    <div className="flex flex-wrap items-center gap-2">
                                      {renderIngestionBadge(video)}
                                      {renderAnalysisBadge(video)}
                                    </div>

                                    {/* Action Controls — below status badges */}
                                    <div
                                      className="flex items-center gap-2 flex-wrap pt-0.5"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        type="button"
                                        disabled={isDeleting}
                                        onClick={() => handleDeleteVideo(video)}
                                        title="Delete video from database"
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                      >
                                        {isDeleting ? (
                                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        ) : (
                                          <Trash2 className="w-3.5 h-3.5" />
                                        )}
                                        <span>Delete</span>
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
        </div>

        {/* Right Column: Video Analysis and Verification */}
        <div className="space-y-6 min-w-0">
      {/* Video Analysis and Verification */}
      {selectedVideo && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-800 flex-wrap">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <Sparkles className="w-5 h-5 text-indigo-400 shrink-0" />
                <h3 className="text-base font-bold text-slate-100">
                  Video Analysis and Verification
                </h3>
              </div>
              <div>
                <span className="inline-block text-xs font-mono px-2.5 py-0.5 rounded-md bg-slate-950 text-cyan-300 border border-slate-800">
                  {selectedVideo.originalName} ({selectedVideo.videoId})
                </span>
              </div>
            </div>

            {selectedVideo.status === 'TRANSCODING' && (
              <div className="w-full p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 space-y-2 font-mono">
                <div className="flex items-center justify-between text-xs text-amber-300">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 shrink-0" />
                    <span>{`Stage 2/2: Normalizing & segmenting video... [${selectedVideo.transcodeProgress || 0}%]`}</span>
                  </span>
                  <span className="font-bold">{`${selectedVideo.transcodeProgress || 0}%`}</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-yellow-500 rounded-full transition-all duration-300"
                    style={{ width: `${selectedVideo.transcodeProgress || 0}%` }}
                  />
                </div>
              </div>
            )}

            <div className="w-full space-y-2.5">
              <div className="flex flex-wrap items-center gap-3">
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
                      <span>Running Passes 1-3...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      <span>Run Passes 1-3</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  data-testid="review-analysis-button"
                  onClick={() => setIsReviewAnalysisModalOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600/25 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-500/40 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5 text-indigo-300" />
                  <span>View Analysis</span>
                </button>

                <button
                  type="button"
                  data-testid="verify-analysis-button"
                  onClick={() => handleInspectResults(selectedVideo, true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-500/40 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Verify Analysis</span>
                </button>

                {(() => {
                  const selectedPass0Data = selectedPasses.pass0?.data;
                  const selectedPass0WorkflowType =
                    selectedPass0Data?.workflowType ||
                    analysisCache[selectedVideo.videoId]?.workflowClassification?.workflowType ||
                    analysisCache[selectedVideo.videoId]?.workloadClassification?.workflowType;
                  const rawSelectedPass1 = selectedPasses.pass1?.data;
                  const selectedPass1Actions = Array.isArray(rawSelectedPass1)
                    ? rawSelectedPass1
                    : Array.isArray(rawSelectedPass1?.actions)
                    ? rawSelectedPass1.actions
                    : [];
                  const isSelectedArchive =
                    selectedPass0WorkflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                    Boolean(selectedVideo.archiveId) ||
                    Boolean(selectedVideo.archiveAssociationType) ||
                    Boolean(selectedVideo.archiveName) ||
                    Boolean(selectedVideo.unmatchedArchiveName) ||
                    Boolean(selectedVideo.originalName?.toLowerCase().includes('archive')) ||
                    Boolean(selectedVideo.videoId?.toLowerCase().includes('archive')) ||
                    selectedPass1Actions.some((a: any) => {
                      const cls = String(a?.actionType || a?.actionClass || '').toUpperCase();
                      return (
                        cls.includes('MIX') ||
                        cls.includes('SEED') ||
                        cls.includes('INCUBAT') ||
                        cls.includes('ASPIRAT') ||
                        cls.includes('ASPRIRAT') ||
                        cls.includes('HEMOCYTOMETER')
                      );
                    });

                  if (isSelectedArchive) {
                    const candidateName =
                      selectedVideo.archiveName ||
                      selectedVideo.unmatchedArchiveName ||
                      selectedPass0Data?.archiveName ||
                      '';
                    const matchedArchive = archives.find(
                      (a) =>
                        (selectedVideo.archiveId && a.id === selectedVideo.archiveId) ||
                        (Array.isArray(a.videoIds) && a.videoIds.includes(selectedVideo.videoId)) ||
                        (candidateName &&
                          a.name &&
                          a.name.trim().toLowerCase() === String(candidateName).trim().toLowerCase())
                    );
                    const resolvedArchiveId = selectedVideo.archiveId || matchedArchive?.id;
                    const resolvedArchiveName =
                      matchedArchive?.name ||
                      selectedVideo.archiveName ||
                      selectedVideo.unmatchedArchiveName ||
                      selectedPass0Data?.archiveName;

                    return (
                      <button
                        type="button"
                        data-testid="open-archive-button"
                        onClick={() =>
                          handleInspectResults(
                            {
                              ...selectedVideo,
                              archiveId: resolvedArchiveId || selectedVideo.archiveId,
                              archiveName: resolvedArchiveName || selectedVideo.archiveName,
                            },
                            false
                          )
                        }
                        title={
                          resolvedArchiveName
                            ? `Jump to Experiment Archive: ${resolvedArchiveName}`
                            : 'Jump to Experiment Archive'
                        }
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600/25 hover:bg-cyan-600/40 text-cyan-200 border border-cyan-500/40 transition-colors"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-cyan-300" />
                        <span>Open Archive</span>
                      </button>
                    );
                  }

                  const candidateInvName =
                    selectedVideo.inventoryName ||
                    selectedVideo.unmatchedInventoryName ||
                    selectedPass0Data?.inventoryName ||
                    '';
                  const matchedInventory = inventories.find(
                    (inv) =>
                      (selectedVideo.inventoryId && inv.id === selectedVideo.inventoryId) ||
                      (candidateInvName &&
                        inv.name &&
                        inv.name.trim().toLowerCase() ===
                          String(candidateInvName).trim().toLowerCase())
                  );
                  const resolvedInventoryId = selectedVideo.inventoryId || matchedInventory?.id;
                  const resolvedInventoryName =
                    matchedInventory?.name ||
                    selectedVideo.inventoryName ||
                    selectedVideo.unmatchedInventoryName ||
                    selectedPass0Data?.inventoryName;

                  return (
                    <button
                      type="button"
                      data-testid="open-inventory-button"
                      onClick={() => {
                        handleInspectResults(
                          {
                            ...selectedVideo,
                            inventoryId: resolvedInventoryId || selectedVideo.inventoryId,
                            inventoryName: resolvedInventoryName || selectedVideo.inventoryName,
                          },
                          false
                        );
                        if (resolvedInventoryId) {
                          onNavigateToInventory?.(resolvedInventoryId);
                        }
                      }}
                      title={
                        resolvedInventoryName
                          ? `Jump to Cryo-Inventory: ${resolvedInventoryName}`
                          : 'Jump to Cryo-Inventory'
                      }
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600/25 hover:bg-cyan-600/40 text-cyan-200 border border-cyan-500/40 transition-colors"
                    >
                      <Package className="w-3.5 h-3.5 text-cyan-300" />
                      <span>Open Inventory</span>
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Video Analysis Passes Summary Card (Pass 0-3 + Analysis Verification Status) */}
          <div className="space-y-3">
            {(() => {
              const isHitlCommitted =
                selectedPasses.hitl?.status === 'COMPLETED' ||
                selectedVideo.passes?.hitl?.status === 'COMPLETED' ||
                Boolean((selectedPasses.hitl as any)?.data?.signedOffAt) ||
                Boolean((selectedVideo.passes?.hitl as any)?.data?.signedOffAt) ||
                Boolean((selectedVideo as any)?.isSignedOff) ||
                Boolean(analysisCache[selectedVideo.videoId]?.isSignedOff) ||
                Boolean(hitlCommitSuccess);

              return (
                <div
                  data-testid="passes-0-3-panel"
                  className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 transition-all"
                >
                  <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono">
                    {passStepsConfig.map((step) => {
                      const pState = selectedPasses[step.passKey] || { status: 'PENDING' };
                      const pRunning =
                        Boolean(runningPassMap[selectedVideo.videoId]?.[step.passKey]) ||
                        pState.status === 'RUNNING';
                      return (
                        <span key={step.passKey} className="inline-flex items-center gap-1.5">
                          <span className="text-[11px] text-slate-400">Pass {step.passNumber}:</span>
                          {renderPassStatusBadge(pState.status, pRunning)}
                        </span>
                      );
                    })}
                    <span
                      data-testid="hitl-verification-card"
                      className="inline-flex items-center gap-1.5"
                    >
                      <span className="text-[11px] text-slate-400">Analysis:</span>
                      {renderPassStatusBadge(
                        isHitlCommitted ? 'COMPLETED' : selectedPasses.hitl?.status || 'PENDING',
                        isCommittingHitl
                      )}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}
        </div>
      </div>

      {/* Wide Video Analysis Passes Pop-up Window Modal */}
      {isReviewAnalysisModalOpen && selectedVideo && (
        <div
          data-testid="review-analysis-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
          onClick={() => setIsReviewAnalysisModalOpen(false)}
        >
          <div
            className="bg-slate-950 border border-slate-800 rounded-2xl w-[96vw] max-w-7xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-slate-800 bg-slate-900/70">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-xl bg-indigo-950 border border-indigo-800 text-indigo-400 shrink-0">
                  <Cpu className="w-5 h-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="inline-block text-xs font-mono px-2.5 py-0.5 rounded-md bg-slate-950 text-cyan-300 border border-slate-800">
                      {selectedVideo.originalName} ({selectedVideo.videoId})
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                    {passStepsConfig.map((step) => {
                      const pState = selectedPasses[step.passKey] || { status: 'PENDING' };
                      const pRunning =
                        Boolean(runningPassMap[selectedVideo.videoId]?.[step.passKey]) ||
                        pState.status === 'RUNNING';
                      return (
                        <span key={step.passKey} className="inline-flex items-center gap-1.5">
                          <span className="text-[11px] text-slate-400">Pass {step.passNumber}:</span>
                          {renderPassStatusBadge(pState.status, pRunning)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
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
                      <span>Running Passes 1-3...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      <span>Run Passes 1-3</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  data-testid="close-review-analysis-modal"
                  onClick={() => setIsReviewAnalysisModalOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                  title="Close Review Analysis Window"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body: Wide 4 AI Pass Cards */}
            <div className="p-6 space-y-4 overflow-y-auto bg-slate-950/60">

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
                      {step.passKey === 'pass0' && renderArchiveBadge(selectedVideo)}
                      {step.passKey === 'pass0' && pass0Data?.identificationEvent && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-mono bg-slate-900/90 border border-slate-800 rounded-lg px-2.5 py-1.5">
                          <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-950/80 text-indigo-300 border border-indigo-700/60">
                            {pass0Data.identificationEvent.eventClass}
                          </span>
                          <span className="text-[11px] text-cyan-300 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {Number(pass0Data.identificationEvent.startTime || 0).toFixed(1)}s–
                            {Number(pass0Data.identificationEvent.endTime || 0).toFixed(1)}s
                          </span>
                          {pass0Data.identificationEvent.description && (
                            <span className="text-[11px] text-slate-300 font-sans">
                              {pass0Data.identificationEvent.description}
                            </span>
                          )}
                          {(pass0Data.identificationEvent.purpose || pass0Data.purpose) && (
                            <span className="px-2 py-0.5 rounded text-[11px] bg-indigo-950/60 text-indigo-200 border border-indigo-700/50">
                              Purpose: {pass0Data.identificationEvent.purpose || pass0Data.purpose}
                            </span>
                          )}
                        </div>
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
                          const isArchiveWorkflow =
                            selectedPasses.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            selectedVideo.passes?.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            Boolean(selectedVideo.archiveId) ||
                            Boolean(selectedVideo.archiveAssociationType);

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
                                  const isArchiveAct =
                                    actType.toUpperCase().includes('SEED') ||
                                    actType.toUpperCase().includes('MIX') ||
                                    actType.toUpperCase().includes('INCUBAT') ||
                                    actType.toUpperCase().includes('ASPIRAT') ||
                                    actType.toUpperCase().includes('ASPRIRAT') ||
                                    actType.toUpperCase().includes('HEMOCYTOMETER') ||
                                    Boolean(actionItem.seedReagentsData) ||
                                    Boolean(actionItem.mixReagentsData) ||
                                    Boolean(actionItem.incubateCellsData || actionItem.incubatorSettings) ||
                                    Boolean(actionItem.hemocytometerLoadingData || actionItem.hemocytometerLoad);
                                  const targetCoord =
                                    !isArchiveAct && !isArchiveWorkflow
                                      ? actionItem.targetCoordinate ||
                                        actionItem.targetLocation?.coordinate ||
                                        (actionItem.boxRowId
                                          ? `${actionItem.boxRowId}${actionItem.boxColId || ''}`
                                          : undefined)
                                      : undefined;
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
                                  } else if (actType.includes('SEED')) {
                                    typeBadgeColor = 'bg-cyan-950/80 text-cyan-300 border-cyan-800/80';
                                  } else if (actType.includes('MIX')) {
                                    typeBadgeColor = 'bg-purple-950/80 text-purple-300 border-purple-800/80';
                                  } else if (actType.includes('INCUBAT')) {
                                    typeBadgeColor = 'bg-amber-950/80 text-amber-300 border-amber-800/80';
                                  } else if (actType.includes('ASPIRAT') || actType.includes('ASPRIRAT')) {
                                    typeBadgeColor = 'bg-sky-950/80 text-sky-300 border-sky-800/80';
                                  } else if (actType.toUpperCase().includes('HEMOCYTOMETER')) {
                                    typeBadgeColor = 'bg-teal-950/80 text-teal-300 border-teal-800/80';
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

                                      {(actionItem.vialLabelData || actionItem.boxWellLocation || actionItem.cellLineName) && (
                                        <div className="text-[10px] font-mono bg-emerald-950/35 border border-emerald-800/50 rounded-lg p-2 space-y-1">
                                          <div className="text-emerald-300 font-semibold flex items-center justify-between">
                                            <span>Pass 3 Appended Action JSON ({`action_${actId}.json`})</span>
                                            {(actionItem.boxWellLocation?.coordinate || targetCoord) && !isArchiveAct && !isArchiveWorkflow && (
                                              <span className="px-1.5 py-0.5 rounded bg-emerald-900/60 border border-emerald-600/50 text-emerald-200">
                                                Well {actionItem.boxWellLocation?.coordinate || targetCoord} (Origin: Top-Left Black A1)
                                              </span>
                                            )}
                                          </div>
                                          <div className="grid grid-cols-2 gap-1 text-slate-300">
                                            <span>
                                              Cell Line:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.vialLabelData?.cellLineName || actionItem.cellLineName || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Initials:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.vialLabelData?.userInitials ||
                                                  actionItem.cellLineInfo?.userInitials ||
                                                  '—'}
                                              </strong>
                                            </span>
                                            <span>
                                              Date Frozen:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.vialLabelData?.dateFrozen ||
                                                  actionItem.cellLineInfo?.dateFrozen ||
                                                  '—'}
                                              </strong>
                                            </span>
                                            <span className="truncate">
                                              Full Text:{' '}
                                              <strong className="text-cyan-200">
                                                {actionItem.vialLabelData?.fullText ||
                                                  actionItem.cellLineInfo?.fullText ||
                                                  '—'}
                                              </strong>
                                            </span>
                                          </div>
                                        </div>
                                      )}

                                      {actionItem.mixReagentsData && (
                                        <div className="text-[10px] font-mono bg-indigo-950/35 border border-indigo-800/50 rounded-lg p-2 space-y-1">
                                          <div className="text-indigo-300 font-semibold">
                                            Action: Mix Reagents ({`action_${actId}.json`})
                                          </div>
                                          <div className="grid grid-cols-2 gap-1 text-slate-300">
                                            <span>
                                              First Reagent:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.mixReagentsData.firstReagentName || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              First Amount:{' '}
                                              <strong className="text-indigo-200">
                                                {actionItem.mixReagentsData.firstReagentAmount || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Second Reagent:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.mixReagentsData.secondReagentName || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Second Amount:{' '}
                                              <strong className="text-indigo-200">
                                                {actionItem.mixReagentsData.secondReagentAmount || 'N/A'}
                                              </strong>
                                            </span>
                                          </div>
                                        </div>
                                      )}

                                      {actionItem.seedReagentsData && (
                                        <div className="text-[10px] font-mono bg-emerald-950/35 border border-emerald-800/50 rounded-lg p-2 space-y-1">
                                          <div className="text-emerald-300 font-semibold flex items-center justify-between">
                                            <span>Action: Seed Reagents ({`action_${actId}.json`})</span>
                                            <span
                                              className={`px-1.5 py-0.5 rounded border ${
                                                actionItem.seedReagentsData.isSeedingCountCorrect !== false
                                                  ? 'bg-emerald-900/60 border-emerald-600/50 text-emerald-200'
                                                  : 'bg-amber-900/60 border-amber-600/50 text-amber-200'
                                              }`}
                                            >
                                              Seeding Events: {actionItem.seedReagentsData.seedingEventsCount ?? 0}
                                              {actionItem.seedReagentsData.expectedSeedingEventsCount !== undefined
                                                ? ` / ${actionItem.seedReagentsData.expectedSeedingEventsCount}`
                                                : ''}
                                            </span>
                                          </div>
                                          <div className="grid grid-cols-2 gap-1 text-slate-300">
                                            <span>
                                              Plate:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.seedReagentsData.plateType || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Pipette:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.seedReagentsData.pipetteType || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Cells:{' '}
                                              <strong className="text-slate-100">
                                                {actionItem.seedReagentsData.cellsSeeded || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Cells / Well:{' '}
                                              <strong className="text-emerald-200">
                                                {actionItem.seedReagentsData.cellsPerWell || 'N/A'}
                                              </strong>
                                            </span>
                                          </div>
                                          {Array.isArray(actionItem.seedReagentsData.seededColumns) &&
                                            actionItem.seedReagentsData.seededColumns.length > 0 && (
                                              <div className="text-slate-300 pt-0.5">
                                                Seeded Columns:{' '}
                                                <strong className="text-cyan-300">
                                                  {actionItem.seedReagentsData.seededColumns.join(', ')}
                                                </strong>{' '}
                                                (1–12, Left to Right)
                                              </div>
                                            )}
                                        </div>
                                      )}

                                      {(actionItem.incubateCellsData || actionItem.incubatorSettings) && (
                                        <div className="text-[10px] font-mono bg-amber-950/35 border border-amber-800/50 rounded-lg p-2 space-y-1">
                                          <div className="text-amber-300 font-semibold">
                                            Action: Incubate Cells — INCUBATOR_SETTINGS ({`action_${actId}.json`})
                                          </div>
                                          <div className="grid grid-cols-2 gap-1 text-slate-300">
                                            <span>
                                              Temperature:{' '}
                                              <strong className="text-amber-200">
                                                {(actionItem.incubateCellsData || actionItem.incubatorSettings)?.temperature || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              CO2 Level:{' '}
                                              <strong className="text-amber-200">
                                                {(actionItem.incubateCellsData || actionItem.incubatorSettings)?.co2Level || 'N/A'}
                                              </strong>
                                            </span>
                                          </div>
                                        </div>
                                      )}

                                      {(actionItem.hemocytometerLoadingData ||
                                        actionItem.hemocytometerLoad ||
                                        actionItem.substanceLoaded ||
                                        actType.toUpperCase().includes('HEMOCYTOMETER')) && (
                                        <div className="text-[10px] font-mono bg-teal-950/35 border border-teal-800/50 rounded-lg p-2 space-y-1">
                                          <div className="text-teal-300 font-semibold">
                                            Action: Hemocytometer Loading — hemocytometer_load ({`action_${actId}.json`})
                                          </div>
                                          <div className="text-slate-300">
                                            Substance Loaded:{' '}
                                            <strong className="text-teal-200">
                                              {(actionItem.hemocytometerLoadingData || actionItem.hemocytometerLoad)
                                                ?.substanceLoaded ||
                                                actionItem.substanceLoaded ||
                                                'N/A'}
                                            </strong>
                                          </div>
                                        </div>
                                      )}

                                      {/* Bottom Row: Metadata Chips + Interval Thumbnail Video */}
                                      <div className="flex flex-wrap items-end justify-between gap-3 pt-2 border-t border-slate-800/60 text-xs">
                                        <div className="flex flex-wrap items-center gap-2">
                                          {targetCoord && !isArchiveAct && !isArchiveWorkflow && (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-slate-950 text-indigo-300 border border-slate-800">
                                              <MapPin className="w-3 h-3 text-indigo-400" />
                                              <span>Target: {targetCoord}</span>
                                            </span>
                                          )}
                                          {actionItem.seedReagentsData &&
                                            Array.isArray(actionItem.seedReagentsData.seededColumns) &&
                                            actionItem.seedReagentsData.seededColumns.length > 0 && (
                                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-slate-950 text-cyan-300 border border-slate-800">
                                                <span>
                                                  Cols {actionItem.seedReagentsData.seededColumns.join(', ')} (1–12)
                                                </span>
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

                                        {/* Interval Thumbnail Video Paused on Start Frame */}
                                        <IntervalThumbnailPreview
                                          videoId={selectedVideo.videoId}
                                          status={selectedVideo.status}
                                          tenant={tenant}
                                          organizationId={(selectedVideo as any).organizationId}
                                          startSeconds={startSec}
                                          endSeconds={endSec}
                                          intervalId={actId}
                                          onPlayInterval={() => setActiveSeekedActionId(actId)}
                                        />
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
                                      {isArchiveWorkflow
                                        ? 'Pass 1 Reagent Label Presentation Events & Action Associations (1 fps)'
                                        : 'Pass 1 Label Presentation Events & Action Associations (1 fps)'}
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
                                              {evt.eventClass ||
                                                (isBoxEvt
                                                  ? 'BOX_LABEL_PRESENTATION'
                                                  : isArchiveWorkflow
                                                  ? 'REAGENT_LABEL_PRESENTATION_EVENT'
                                                  : 'VIAL_LABEL_PRESENTATION')}
                                            </span>
                                            <span className="text-[11px] text-cyan-300 flex items-center gap-1">
                                              <Clock className="w-3 h-3" />
                                              <span>
                                                {evtStart.toFixed(1)}s–{evtEnd.toFixed(1)}s
                                              </span>
                                            </span>
                                          </div>
                                          {evt.description && (
                                            <p className="text-[11px] text-slate-300 font-sans">
                                              {evt.description}
                                            </p>
                                          )}
                                          <div className="flex flex-wrap items-end justify-between gap-2 pt-1">
                                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                                              <span className="text-slate-400">
                                                Associated Actions ({assocIds.length}):
                                              </span>
                                              {assocIds.length > 0 ? (
                                                assocIds.map((aid) => (
                                                  <span
                                                    key={aid}
                                                    className="px-1.5 py-0.5 rounded bg-indigo-950/70 text-indigo-200 border border-indigo-700/50"
                                                  >
                                                    {aid}
                                                  </span>
                                                ))
                                              ) : (
                                                <span className="text-slate-500 italic">
                                                  None (standalone event)
                                                </span>
                                              )}
                                            </div>
                                            <IntervalThumbnailPreview
                                              videoId={selectedVideo.videoId}
                                              status={selectedVideo.status}
                                              tenant={tenant}
                                              organizationId={(selectedVideo as any).organizationId}
                                              startSeconds={evtStart}
                                              endSeconds={evtEnd}
                                              intervalId={`p1_${evtId}`}
                                              onPlayInterval={() => setActiveSeekedActionId(evtId)}
                                            />
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
                          const isArchiveWorkflow =
                            selectedPasses.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            selectedVideo.passes?.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            Boolean(selectedVideo.archiveId) ||
                            Boolean(selectedVideo.archiveAssociationType);
                          const unfilteredEvents: any[] = Array.isArray(pass2Data)
                            ? pass2Data
                            : Array.isArray(pass2Data?.events)
                            ? pass2Data.events
                            : [];
                          const rawEvents: any[] = isArchiveWorkflow
                            ? unfilteredEvents.filter((evt: any) => {
                                const cls = String(evt?.eventClass || evt?.actionType || '').toUpperCase();
                                return (
                                  (cls.includes('REAGENT_LABEL') ||
                                    cls.includes('INCUBATOR_SETTINGS') ||
                                    cls.includes('HEMOCYTOMETER_LOAD') ||
                                    cls.includes('SEEDING') ||
                                    cls.includes('WELL_SEEDING')) &&
                                  !cls.includes('AUDIO_UTTERANCE') &&
                                  !cls.includes('STATEMENT_EVENT') &&
                                  evt?.eventTrack !== 'audio'
                                );
                              })
                            : unfilteredEvents;
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
                                  Detected Presentation Events: {rawEvents.length} {isArchiveWorkflow ? '(Reagent Labels)' : '(Box Labels & Vial Labels)'}
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
                                    const defaultEvtClass = isArchiveWorkflow ? 'REAGENT_LABEL_PRESENTATION_EVENT' : 'VIAL_LABEL_PRESENTATION';
                                    const evtClass = String(evt.eventClass || defaultEvtClass);
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
                                                  : evtClass.toUpperCase().includes('REAGENT_LABEL')
                                                  ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/80'
                                                  : evtClass.toUpperCase().includes('MIXING') ||
                                                    evtClass.toUpperCase().includes('SEEDING')
                                                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/80'
                                                  : 'bg-purple-950/80 text-purple-300 border-purple-700/80'
                                              }`}
                                            >
                                              {isBoxLabel
                                                ? '📦 BOX LABEL PRESENTATION'
                                                : evtClass.toUpperCase().includes('INCUBATOR_SETTINGS')
                                                ? '🌡 INCUBATOR SETTINGS'
                                                : evtClass.toUpperCase().includes('HEMOCYTOMETER_LOAD')
                                                ? '🔬 HEMOCYTOMETER LOAD (hemocytometer_load)'
                                                : evtClass.toUpperCase().includes('REAGENT_LABEL')
                                                ? '🧪 REAGENT LABEL PRESENTATION'
                                                : evtClass.toUpperCase().includes('MIXING_AMOUNT')
                                                ? '🎙 MIXING AMOUNT STATEMENT'
                                                : evtClass.toUpperCase().includes('SEEDING_PARAMETER')
                                                ? '🎙 SEEDING PARAMETER STATEMENT'
                                                : evtClass.toUpperCase().includes('WELL_SEEDING') ||
                                                  evtClass.toUpperCase().includes('SEEDING')
                                                ? '💧 WELL SEEDING EVENT'
                                                : isArchiveWorkflow
                                                ? '🧪 REAGENT LABEL PRESENTATION'
                                                : '🧪 VIAL LABEL PRESENTATION'}
                                            </span>
                                            {(evt.incubatorSettings || evt.temperature || evt.co2Level) && (
                                              <span className="text-xs font-mono text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-800/60 font-semibold">
                                                Temp: {evt.incubatorSettings?.temperature || evt.temperature || 'N/A'} • CO2: {evt.incubatorSettings?.co2Level || evt.co2Level || 'N/A'}
                                              </span>
                                            )}
                                            {(evt.hemocytometerLoadingData ||
                                              evt.hemocytometerLoad ||
                                              evt.substanceLoaded ||
                                              evtClass.toUpperCase().includes('HEMOCYTOMETER_LOAD')) && (
                                              <span className="text-xs font-mono text-teal-300 bg-teal-950/60 px-2 py-0.5 rounded border border-teal-800/60 font-semibold">
                                                Substance Loaded:{' '}
                                                {(evt.hemocytometerLoadingData || evt.hemocytometerLoad)
                                                  ?.substanceLoaded ||
                                                  evt.substanceLoaded ||
                                                  'N/A'}
                                              </span>
                                            )}
                                            {(evt.seededColumn != null ||
                                              evt.metadata?.seededColumn != null ||
                                              evt.targetLocation) && (
                                              <span className="text-xs font-mono text-emerald-300 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60 font-semibold">
                                                {evt.seededColumn != null || evt.metadata?.seededColumn != null
                                                  ? `Column ${evt.seededColumn ?? evt.metadata?.seededColumn} (1–12, Left to Right)`
                                                  : `Well ${evt.targetLocation}`}
                                              </span>
                                            )}
                                            <span className="text-xs font-mono text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/60">
                                              {startSec.toFixed(2)}s – {endSec.toFixed(2)}s
                                            </span>
                                            <span className="text-[11px] font-mono text-slate-400">
                                              ID: {evtId}
                                            </span>
                                          </div>

                                            <IntervalThumbnailPreview
                                              videoId={selectedVideo.videoId}
                                              status={selectedVideo.status}
                                              tenant={tenant}
                                              organizationId={(selectedVideo as any).organizationId}
                                              startSeconds={startSec}
                                              endSeconds={endSec}
                                              intervalId={`p2_${evtId}`}
                                              onPlayInterval={() => setActiveSeekedActionId(evtId)}
                                            />
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
                                                  <span className="text-cyan-400">
                                                    @{frameTs.toFixed(2)}s
                                                  </span>
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
                                            <IntervalThumbnailPreview
                                              videoId={selectedVideo.videoId}
                                              status={selectedVideo.status}
                                              tenant={tenant}
                                              organizationId={(selectedVideo as any).organizationId}
                                              startSeconds={refStart}
                                              endSeconds={refEnd}
                                              intervalId={`p2_ref_${ra.actionId}`}
                                              onPlayInterval={() => setActiveSeekedActionId(ra.actionId)}
                                            />
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
                      ) : step.passKey === 'pass3' && hasJsonData && !showRawJsonMap[drawerKey] ? (
                        (() => {
                          const pass3Raw = passState.data as any;
                          const cachedDoc = analysisCache[selectedVideo.videoId] as any;
                          const refinementsList: any[] = Array.isArray(pass3Raw)
                            ? pass3Raw
                            : Array.isArray(pass3Raw?.refinements)
                            ? pass3Raw.refinements
                            : Array.isArray(cachedDoc?.refinements)
                            ? cachedDoc.refinements
                            : [];
                          const pass2EventsList: any[] = Array.isArray(selectedPasses.pass2?.data)
                            ? selectedPasses.pass2.data
                            : Array.isArray((selectedPasses.pass2?.data as any)?.events)
                            ? (selectedPasses.pass2.data as any).events
                            : Array.isArray(cachedDoc?.events)
                            ? cachedDoc.events
                            : [];
                          const isArchiveWorkflowForPass3 =
                            (selectedPasses.pass0?.data as any)?.workflowType ===
                              'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            cachedDoc?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                            (selectedVideo as any).workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW';
                          const isArchiveWorkflow = isArchiveWorkflowForPass3;
                          const labelTranscriptions: any[] = Array.isArray(
                            (passState as any).labelTranscriptions
                          )
                            ? (passState as any).labelTranscriptions
                            : Array.isArray(pass3Raw?.labelTranscriptions)
                            ? pass3Raw.labelTranscriptions
                            : Array.isArray(cachedDoc?.labelTranscriptions)
                            ? cachedDoc.labelTranscriptions
                            : refinementsList
                                .filter(
                                  (r: any) =>
                                    r.vialLabelData ||
                                    r.reagentData ||
                                    r.refinementClass === 'OCR_CONFLATION' ||
                                    r.refinementClass === 'REAGENT_OCR_CONFLATION'
                                )
                                .map((r: any) => ({
                                  eventId: r.eventId,
                                  eventClass: r.eventClass,
                                  actionIds: r.actionIds || (r.actionId ? [r.actionId] : []),
                                  isVialLabel: !r.reagentData,
                                  isReagentLabel: Boolean(r.reagentData),
                                  highestContrastShotText:
                                    r.highestContrastShotText || r.frame1Text || r.transcriptionText,
                                  minimalBlurShotText:
                                    r.minimalBlurShotText || r.frame2Text || r.transcriptionText,
                                  conflatedText:
                                    r.reagentData?.rawLabelText ||
                                    r.vialLabelData?.fullText ||
                                    r.fullText ||
                                    r.transcriptionText,
                                  ...(r.reagentData ? { reagentData: r.reagentData } : {}),
                                  ...(r.vialLabelData
                                    ? { vialLabelData: r.vialLabelData }
                                    : !r.reagentData
                                    ? {
                                        vialLabelData: {
                                          cellLineName:
                                            r.cellLineName || r.transcriptionText?.split(/\s+/)[0] || '',
                                          userInitials: r.userInitials,
                                          dateFrozen: r.dateFrozen,
                                          fullText: r.fullText || r.transcriptionText || '',
                                        },
                                      }
                                    : {}),
                                }));
                          const actionWellLocations: any[] = Array.isArray(
                            (passState as any).actionWellLocations
                          )
                            ? (passState as any).actionWellLocations
                            : Array.isArray(pass3Raw?.actionWellLocations)
                            ? pass3Raw.actionWellLocations
                            : Array.isArray(cachedDoc?.actionWellLocations)
                            ? cachedDoc.actionWellLocations
                            : refinementsList
                                .filter((r: any) => r.boxWellLocation || r.spatialResult)
                                .map((r: any) =>
                                  r.boxWellLocation || {
                                    actionId: r.actionId || 'act_01',
                                    actionType: 'VIAL_INSERTION',
                                    row: r.spatialResult?.row || 'A',
                                    col: r.spatialResult?.col || 1,
                                    coordinate: `${r.spatialResult?.row || 'A'}${r.spatialResult?.col || 1}`,
                                    originCorner: 'TOP_LEFT_BLACK',
                                    confidence: r.conflationMetadata?.confidence || 0.98,
                                  }
                                );
                          const pass1ActionsList: any[] = Array.isArray(selectedPasses.pass1?.data)
                            ? selectedPasses.pass1.data
                            : Array.isArray((selectedPasses.pass1?.data as any)?.actions)
                            ? (selectedPasses.pass1.data as any).actions
                            : Array.isArray(cachedDoc?.actions)
                            ? cachedDoc.actions
                            : [];

                          return (
                            <div className="space-y-4" data-testid="pass3-refinement-results">
                              {/* 1. Dual-Shot Label Transcriptions & Conflation (label_transcriptions.json) */}
                              <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                                  <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                                    <Sparkles className="w-3.5 h-3.5" />
                                    1. Label Presentation Dual-Shot OCR & Conflation (label_transcriptions.json)
                                  </span>
                                  <span className="text-[10px] text-slate-400">
                                    2 Full-Res Best Shots: Highest Contrast + Minimal Blur → Conflated JSON
                                  </span>
                                </div>

                                {labelTranscriptions.length === 0 ? (
                                  <div className="text-xs font-mono text-slate-400">
                                    No label presentation events detected for transcription.
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-1 gap-2.5">
                                    {labelTranscriptions.map((lt: any, idx: number) => {
                                      const vData = lt.vialLabelData || {};
                                      const rData = lt.reagentData || {};
                                      const matchedPass2Evt = pass2EventsList.find(
                                        (e: any) => e && e.eventId === lt.eventId
                                      );
                                      const evtClsUpper = String(
                                        lt.eventClass || matchedPass2Evt?.eventClass || ''
                                      ).toUpperCase();
                                      const actIds: string[] = Array.isArray(lt.actionIds)
                                        ? lt.actionIds
                                        : [];
                                      const shot1Text =
                                        lt.highestContrastShotText ||
                                        lt.frame1Text ||
                                        lt.conflatedText ||
                                        lt.fullText ||
                                        vData.fullText ||
                                        rData.rawLabelText ||
                                        '';
                                      const shot2Text =
                                        lt.minimalBlurShotText ||
                                        lt.frame2Text ||
                                        lt.conflatedText ||
                                        lt.fullText ||
                                        vData.fullText ||
                                        rData.rawLabelText ||
                                        '';
                                      const resolvedCellLine =
                                        vData.cellLineName || lt.cellLineName || '';
                                      const resolvedInitials =
                                        vData.userInitials || lt.userInitials || '';
                                      const resolvedDate =
                                        vData.dateFrozen || lt.dateFrozen || '';
                                      const resolvedFullText =
                                        vData.fullText ||
                                        rData.rawLabelText ||
                                        lt.fullText ||
                                        lt.conflatedText ||
                                        '';
                                      const isReagent =
                                        Boolean(lt.isReagentLabel || lt.reagentData) ||
                                        evtClsUpper.includes('REAGENT_LABEL') ||
                                        (isArchiveWorkflowForPass3 && !evtClsUpper.includes('BOX_LABEL')) ||
                                        isLikelyReagentBottleLabelText(shot1Text || resolvedFullText);
                                      const parsedFallbackReagent = isReagent
                                        ? parseReagentLabelFields(shot1Text || resolvedFullText, {
                                            ...lt,
                                            ...rData,
                                          })
                                        : null;
                                      const resolvedReagentName =
                                        (rData.reagentName && rData.reagentName !== 'N/A'
                                          ? rData.reagentName
                                          : '') ||
                                        (lt.reagentName && lt.reagentName !== 'N/A'
                                          ? lt.reagentName
                                          : '') ||
                                        parsedFallbackReagent?.reagentName ||
                                        'N/A';
                                      const resolvedReagentAcronym =
                                        (rData.reagentAcronym && rData.reagentAcronym !== 'N/A'
                                          ? rData.reagentAcronym
                                          : '') ||
                                        (lt.reagentAcronym && lt.reagentAcronym !== 'N/A'
                                          ? lt.reagentAcronym
                                          : '') ||
                                        parsedFallbackReagent?.reagentAcronym ||
                                        'N/A';
                                      const resolvedManufacturer =
                                        (rData.manufacturer && rData.manufacturer !== 'N/A'
                                          ? rData.manufacturer
                                          : '') ||
                                        (lt.manufacturer && lt.manufacturer !== 'N/A'
                                          ? lt.manufacturer
                                          : '') ||
                                        parsedFallbackReagent?.manufacturer ||
                                        'N/A';
                                      const resolvedCatalogNumber =
                                        (rData.catalogNumber && rData.catalogNumber !== 'N/A'
                                          ? rData.catalogNumber
                                          : '') ||
                                        (lt.catalogNumber && lt.catalogNumber !== 'N/A'
                                          ? lt.catalogNumber
                                          : '') ||
                                        parsedFallbackReagent?.catalogNumber ||
                                        'N/A';
                                      const resolvedLotNumber =
                                        (rData.lotNumber && rData.lotNumber !== 'N/A'
                                          ? rData.lotNumber
                                          : '') ||
                                        (lt.lotNumber && lt.lotNumber !== 'N/A'
                                          ? lt.lotNumber
                                          : '') ||
                                        parsedFallbackReagent?.lotNumber ||
                                        'N/A';
                                      return (
                                        <div
                                          key={lt.eventId || idx}
                                          className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs font-mono space-y-2"
                                        >
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                              <span className="font-bold text-cyan-300">
                                                Event: {lt.eventId}
                                              </span>
                                              <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 text-[10px]">
                                                {isReagent
                                                  ? 'REAGENT_LABEL_PRESENTATION'
                                                  : lt.eventClass || (isArchiveWorkflowForPass3 ? 'REAGENT_LABEL_PRESENTATION_EVENT' : 'VIAL_LABEL_PRESENTATION')}
                                              </span>
                                              <span className="px-2 py-0.5 rounded bg-indigo-950/70 border border-indigo-700/60 text-indigo-300 text-[10px]">
                                                label_transcription_{lt.eventId}.json
                                              </span>
                                            </div>
                                            {actIds.length > 0 && (
                                              <span className="text-[10px] text-emerald-300">
                                                Appended to Actions: {actIds.join(', ')}
                                              </span>
                                            )}
                                          </div>

                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                                            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                                              <div className="text-[10px] text-amber-300 font-semibold">
                                                Shot 1 (Highest Contrast OCR - Full Res):
                                              </div>
                                              <div className="text-slate-200 mt-0.5">
                                                {shot1Text || '(not visible)'}
                                              </div>
                                            </div>
                                            <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                                              <div className="text-[10px] text-emerald-300 font-semibold">
                                                Shot 2 (Minimal Blur OCR - Full Res):
                                              </div>
                                              <div className="text-slate-200 mt-0.5">
                                                {shot2Text || '(not visible)'}
                                              </div>
                                            </div>
                                          </div>

                                          {isReagent ? (
                                            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 pt-1 border-t border-slate-800/80 text-[11px]">
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Reagent Name
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedReagentName}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Reagent Acronym
                                                </span>
                                                <span className="font-bold text-emerald-300">
                                                  {resolvedReagentAcronym}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Manufacturer
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedManufacturer}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Catalog / Ref #
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedCatalogNumber}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Lot #
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedLotNumber}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Full Label Text
                                                </span>
                                                <span className="font-bold text-cyan-200">
                                                  {resolvedFullText || 'N/A'}
                                                </span>
                                              </div>
                                            </div>
                                          ) : (
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-1 border-t border-slate-800/80 text-[11px]">
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Cell Line Name (Required)
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedCellLine || '(none)'}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  User Initials (Optional)
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedInitials || '—'}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Date Frozen (Optional)
                                                </span>
                                                <span className="font-bold text-slate-100">
                                                  {resolvedDate || '—'}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Full Label Text (Required)
                                                </span>
                                                <span className="font-bold text-cyan-200">
                                                  {resolvedFullText || '(none)'}
                                                </span>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>

                              {/* 2. Vial Insertion/Removal Well Locations (Top-Left Black Corner Origin) */}
                              {!isArchiveWorkflow && (
                                <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                                    <span className="font-semibold text-cyan-300 flex items-center gap-1.5">
                                      <MapPin className="w-3.5 h-3.5" />
                                      2. Vial Insertion/Removal Box Well Locations
                                    </span>
                                    <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-amber-300 text-[10px]">
                                      Origin A1 (Row A, Col 1) = Top-Left Black Corner (TOP_LEFT_BLACK)
                                    </span>
                                  </div>

                                  {actionWellLocations.length === 0 ? (
                                    <div className="text-xs font-mono text-slate-400">
                                      No vial insertion/removal well coordinates extracted.
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                                      {actionWellLocations.map((wl: any, idx: number) => (
                                        <div
                                          key={wl.actionId || idx}
                                          className="rounded-lg bg-slate-950 border border-slate-800 p-3 text-xs font-mono flex items-center justify-between gap-3"
                                        >
                                          <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                              <span className="font-bold text-indigo-300">
                                                {wl.actionId}
                                              </span>
                                              <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-slate-300">
                                                {wl.actionType || 'VIAL_INSERTION'}
                                              </span>
                                            </div>
                                            <div className="text-[11px] text-slate-400">
                                              Row <strong className="text-slate-100">{wl.row}</strong> • Col{' '}
                                              <strong className="text-slate-100">{wl.col}</strong> • Origin:{' '}
                                              <span className="text-amber-300">
                                                {wl.originCorner || 'TOP_LEFT_BLACK'}
                                              </span>
                                            </div>
                                          </div>
                                          <div className="px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-500/60 text-emerald-300 font-bold text-sm">
                                            Well {wl.coordinate || `${wl.row}${wl.col}`}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* 3. Appended Inventory Update Action JSONs (action_{id}.json) */}
                              {!isArchiveWorkflow && pass1ActionsList.filter((a: any) => {
                                const cls = String(a.actionType || a.actionClass || '').toUpperCase();
                                return (
                                  !cls.includes('MIX') &&
                                  !cls.includes('SEED') &&
                                  !cls.includes('INCUBAT') &&
                                  !cls.includes('ASPIRAT') &&
                                  !cls.includes('ASPRIRAT')
                                );
                              }).length > 0 && (
                                <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-2.5">
                                  <div className="text-xs font-mono font-semibold text-emerald-300 flex items-center justify-between">
                                    <span>
                                      3. Enriched Inventory Update Action JSON Files (action_*.json)
                                    </span>
                                    <span className="text-[10px] text-slate-400">
                                      Appended with Conflated Label Text + Top-Left Black Origin Well Location
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-1 gap-2">
                                    {pass1ActionsList
                                      .filter((a: any) => {
                                        const cls = String(a.actionType || a.actionClass || '').toUpperCase();
                                        return (
                                          !cls.includes('MIX') &&
                                          !cls.includes('SEED') &&
                                          !cls.includes('INCUBAT') &&
                                          !cls.includes('ASPIRAT') &&
                                          !cls.includes('ASPRIRAT')
                                        );
                                      })
                                      .map((act: any, idx: number) => {
                                        const actId = act.actionId || `act_${idx + 1}`;
                                        const isActRemoval = String(
                                          act.actionType || act.actionClass || ''
                                        )
                                          .toUpperCase()
                                          .includes('REMOVAL');
                                        return (
                                          <div
                                            key={actId}
                                            className="rounded-lg bg-slate-950 border border-slate-800 p-2.5 text-[11px] font-mono flex flex-wrap items-center justify-between gap-2"
                                          >
                                            <div className="flex flex-wrap items-center gap-2">
                                              <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-700/60 text-emerald-300 font-bold">
                                                action_{actId}.json
                                              </span>
                                              <span className="text-slate-300">
                                                Cell Line:{' '}
                                                <strong className="text-slate-100">
                                                  {act.vialLabelData?.cellLineName ||
                                                    act.cellLineName ||
                                                    act.cellLineInfo?.name ||
                                                    (isActRemoval ? '—' : '(untranscribed)')}
                                                </strong>
                                              </span>
                                              <span className="text-slate-300">
                                                Initials:{' '}
                                                <strong className="text-slate-100">
                                                  {act.vialLabelData?.userInitials ||
                                                    act.cellLineInfo?.userInitials ||
                                                    '—'}
                                                </strong>
                                              </span>
                                              <span className="text-slate-300">
                                                Date Frozen:{' '}
                                                <strong className="text-slate-100">
                                                  {act.vialLabelData?.dateFrozen ||
                                                    act.cellLineInfo?.dateFrozen ||
                                                    '—'}
                                                </strong>
                                              </span>
                                              <span className="text-cyan-300">
                                                Well:{' '}
                                                <strong>
                                                  {act.boxWellLocation?.coordinate ||
                                                    act.targetCoordinate ||
                                                    (act.boxRowId
                                                      ? `${act.boxRowId}${act.boxColId || 1}`
                                                      : 'A1')}
                                                </strong>
                                              </span>
                                            </div>
                                            <span className="text-[10px] text-slate-400 truncate max-w-md">
                                              Full Text:{' '}
                                              {act.vialLabelData?.fullText ||
                                                act.conflatedLabelText ||
                                                act.cellLineInfo?.fullText ||
                                                '—'}
                                            </span>
                                          </div>
                                        );
                                      })}
                                  </div>
                                </div>
                              )}

                              {/* 4. Experiment Archive Pass 3 Reagents & Conflated Work Steps */}
                              {(Array.isArray(pass3Raw?.reagents) && pass3Raw.reagents.length > 0) ||
                              (Array.isArray(pass3Raw?.workSteps) && pass3Raw.workSteps.length > 0) ? (
                                <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-3.5 space-y-3">
                                  <div className="text-xs font-mono font-semibold text-indigo-300 flex items-center justify-between">
                                    <span>
                                      Experiment Archive Pass 3: OCR Reagent Table &amp; Conflated Work Steps
                                    </span>
                                    <span className="text-[10px] text-slate-400">
                                      Reagent Acronym from First Letters • Mix &amp; Seed Conflation
                                    </span>
                                  </div>

                                  {Array.isArray(pass3Raw?.reagents) && pass3Raw.reagents.length > 0 && (
                                    <div className="overflow-x-auto border border-slate-800 rounded-lg">
                                      <table className="w-full text-left text-[11px] font-mono">
                                        <thead className="bg-slate-950 border-b border-slate-800 text-slate-400">
                                          <tr>
                                            <th className="py-1.5 px-2.5">Reagent Name</th>
                                            <th className="py-1.5 px-2.5">Reagent Acronym</th>
                                            <th className="py-1.5 px-2.5">Manufacturer</th>
                                            <th className="py-1.5 px-2.5">Catalog / Ref #</th>
                                            <th className="py-1.5 px-2.5">Lot #</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-800/70">
                                          {pass3Raw.reagents.map((r: any, rIdx: number) => (
                                            <tr key={rIdx} className="bg-slate-950/60">
                                              <td className="py-1.5 px-2.5 text-slate-100 font-semibold">
                                                {r.reagentName || 'N/A'}
                                              </td>
                                              <td className="py-1.5 px-2.5 text-cyan-300 font-bold">
                                                {r.reagentAcronym ||
                                                  generateReagentAcronym(r.reagentName || '')}
                                              </td>
                                              <td className="py-1.5 px-2.5 text-slate-300">
                                                {r.manufacturer || 'N/A'}
                                              </td>
                                              <td className="py-1.5 px-2.5 text-slate-300">
                                                {r.catalogNumber || 'N/A'}
                                              </td>
                                              <td className="py-1.5 px-2.5 text-slate-300">
                                                {r.lotNumber || 'N/A'}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}

                                  {Array.isArray(pass3Raw?.workSteps) && pass3Raw.workSteps.length > 0 && (
                                    <div className="space-y-2">
                                      {pass3Raw.workSteps.map((ws: any, wsIdx: number) => (
                                        <div
                                          key={ws.stepId || wsIdx}
                                          className="rounded-lg bg-slate-950 border border-slate-800 p-2.5 text-[11px] font-mono space-y-1"
                                        >
                                          <div className="flex items-center justify-between text-slate-200 font-semibold">
                                            <span>
                                              Step {wsIdx + 1}: {ws.actionType} — {ws.description}
                                            </span>
                                          </div>
                                          {ws.mixReagentsData && (
                                            <div className="text-slate-300">
                                              First: <strong className="text-slate-100">{ws.mixReagentsData.firstReagentName}</strong> ({ws.mixReagentsData.firstReagentAmount}) • Second: <strong className="text-slate-100">{ws.mixReagentsData.secondReagentName}</strong> ({ws.mixReagentsData.secondReagentAmount})
                                            </div>
                                          )}
                                          {ws.seedReagentsData && (
                                            <div className="text-slate-300 space-y-1 pt-1">
                                              <div>
                                                Plate: <strong className="text-slate-100">{ws.seedReagentsData.plateType || 'N/A'}</strong> • Pipette: <strong className="text-slate-100">{ws.seedReagentsData.pipetteType || 'N/A'}</strong> • Cells: <strong className="text-slate-100">{ws.seedReagentsData.cellsSeeded || 'N/A'}</strong> ({ws.seedReagentsData.cellsPerWell ? (String(ws.seedReagentsData.cellsPerWell).toLowerCase().includes('well') || ws.seedReagentsData.cellsPerWell === 'N/A' ? ws.seedReagentsData.cellsPerWell : `${ws.seedReagentsData.cellsPerWell}/well`) : 'N/A'}) • Seeding Events: <strong className="text-emerald-300">{ws.seedReagentsData.seedingEventsCount ?? 0}</strong> / {ws.seedReagentsData.expectedSeedingEventsCount ?? 12}
                                              </div>
                                              {Array.isArray(ws.seedReagentsData.seededColumns) && ws.seedReagentsData.seededColumns.length > 0 && (
                                                <div className="text-cyan-300 text-[10px]">
                                                  Columns Seeded: <strong>{ws.seedReagentsData.seededColumns.join(', ')}</strong> (1–12, Left to Right)
                                                </div>
                                              )}
                                              <pre className="bg-slate-900/90 p-2 rounded border border-slate-800 text-[9px] font-mono text-emerald-300 overflow-x-auto whitespace-pre">
                                                {render96WellPlateMarkdown(ws.seedReagentsData.seededColumns, ws.seedReagentsData.seededWells)}
                                              </pre>
                                            </div>
                                          )}
                                          {(ws.incubateCellsData || ws.incubatorSettings) && (
                                            <div className="text-slate-300 pt-1">
                                              Incubator Settings (INCUBATOR_SETTINGS): Temperature: <strong className="text-amber-300">{(ws.incubateCellsData || ws.incubatorSettings)?.temperature || 'N/A'}</strong> • CO2 Level: <strong className="text-amber-300">{(ws.incubateCellsData || ws.incubatorSettings)?.co2Level || 'N/A'}</strong>
                                            </div>
                                          )}
                                          {(ws.hemocytometerLoadingData || ws.hemocytometerLoad || ws.substanceLoaded) && (
                                            <div className="text-slate-300 pt-1">
                                              Hemocytometer Load (hemocytometer_load): Substance Loaded: <strong className="text-teal-300">{(ws.hemocytometerLoadingData || ws.hemocytometerLoad)?.substanceLoaded || ws.substanceLoaded || 'N/A'}</strong>
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ) : null}
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
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-slate-800 bg-slate-900/50 text-xs font-mono text-slate-400">
              <span>
                Active Video: {selectedVideo.originalName} ({selectedVideo.videoId})
              </span>
              <button
                type="button"
                onClick={() => setIsReviewAnalysisModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pipeline Call & Prompt Inspector Modal */}
      {inspectionModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
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
