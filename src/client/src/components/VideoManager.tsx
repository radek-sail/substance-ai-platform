import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Trash2,
  RotateCcw,
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
      showCreateForm: false,
    };
  };

  const updateArchiveDraftForVideo = (
    video: VideoRecord,
    patch: Partial<{ name: string; creatorName: string; creationDate: string; showCreateForm?: boolean }>
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

        if (activeVid && activeVid.status === 'READY_FOR_ANALYSIS') {
          setTranscodingVideoId(null);
          setUploadStep('SAVED');
          setUploading(false);
          setUploadProgress('');
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
  const uploadVideoFile = async (file: File) => {
    try {
      setUploading(true);
      const contentType = file.type || 'video/mp4';
      setUploadProgress('Requesting signed GCS upload URL...');
      console.log('[VideoManager] Starting direct-to-GCS upload for:', file.name, file.size);

      setSelectedFile(file);
      const durationPromise = probeVideoDuration(file);
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

      const browserDuration = await durationPromise;
      const fallbackCapturedAt =
        file.lastModified && file.lastModified > 0
          ? new Date(file.lastModified).toISOString()
          : undefined;

      const finalizeRes = await fetch('/api/videos/finalize-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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

    const cachedAnalysis: VideoAnalysisDoc | undefined = hasPassData
      ? ({
          videoId: video.videoId,
          ...rawCached,
          ...(syncedClassification
            ? {
                workflowClassification: syncedClassification,
                workloadClassification: syncedClassification,
              }
            : {}),
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
        } as VideoAnalysisDoc)
      : undefined;

    if (cachedAnalysis) {
      setAnalysisCache((prev) => ({ ...prev, [video.videoId]: cachedAnalysis }));
    }
    onSelectActiveStream?.(video, cachedAnalysis);

    if (forceHitlTab) {
      if (isArchiveWorkflow && resolvedArchiveId) {
        onNavigateToArchive?.(resolvedArchiveId, video.videoId);
      }
      onSelectVideoForReview(video.videoId, 'hitl', cachedAnalysis);
      return;
    }

    const targetTab: 'inventory' | 'archive' = isArchiveWorkflow ? 'archive' : 'inventory';

    if (targetTab === 'archive' && resolvedArchiveId) {
      onNavigateToArchive?.(resolvedArchiveId, video.videoId);
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
          <button
            type="button"
            onClick={() => {
              const rawCached = analysisCache[video.videoId];
              const enrichedCached = rawCached
                ? ({
                    ...rawCached,
                    ...(video.archiveId ? { archiveId: video.archiveId } : {}),
                    ...(video.archiveName ? { archiveName: video.archiveName } : {}),
                    ...(video.archiveCreatorName ? { creatorName: video.archiveCreatorName } : {}),
                    ...(video.archiveCreationDate ? { creationDate: video.archiveCreationDate } : {}),
                  } as VideoAnalysisDoc)
                : undefined;
              onSelectActiveStream?.(video, enrichedCached);
              if (video.archiveId) {
                onNavigateToArchive?.(video.archiveId, video.videoId);
              }
              onSelectVideoForReview(video.videoId, 'archive', enrichedCached);
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-800 transition-colors"
            title="Open in Experiment Archive"
          >
            <span>Open in Experiment Archive</span>
            <ExternalLink className="w-2.5 h-2.5" />
          </button>
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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
                  <th className="py-3 px-4">Capture Timestamp & Duration</th>
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
                  const pass0WorkflowType =
                    vPasses.pass0.data?.workflowType ||
                    analysisCache[video.videoId]?.workflowClassification?.workflowType ||
                    analysisCache[video.videoId]?.workloadClassification?.workflowType;
                  const classificationResultText = formatWorkflowClassificationLabel(
                    pass0WorkflowType,
                    vPasses.pass0.status
                  );
                  const isDeleting = Boolean(deletingIds[video.videoId]);

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
                          <div className="w-full max-w-sm">
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
                            <div
                              className="mt-2 flex items-center gap-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 shrink-0">
                                Classification:
                              </span>
                              <input
                                type="text"
                                readOnly
                                aria-label={`Video classification for ${video.originalName}`}
                                value={classificationResultText}
                                className="w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1 text-[11px] font-mono text-cyan-300 focus:outline-none"
                              />
                            </div>
                            {renderInventoryBadge(video)}
                            {renderArchiveBadge(video)}
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 font-mono">
                        <div className="text-slate-200">
                          {formatTimestamp((video as any).capturedAt || video.uploadedAt)}
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span>
                            {video.durationSeconds !== undefined && video.durationSeconds > 0
                              ? formatDuration(video.durationSeconds)
                              : '--:--'}
                          </span>
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
                                    Boolean(actionItem.seedReagentsData) ||
                                    Boolean(actionItem.mixReagentsData);
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
                                              <strong className="text-white">
                                                {actionItem.vialLabelData?.cellLineName || actionItem.cellLineName || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Initials:{' '}
                                              <strong className="text-white">
                                                {actionItem.vialLabelData?.userInitials ||
                                                  actionItem.cellLineInfo?.userInitials ||
                                                  '—'}
                                              </strong>
                                            </span>
                                            <span>
                                              Date Frozen:{' '}
                                              <strong className="text-white">
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
                                              <strong className="text-white">
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
                                              <strong className="text-white">
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
                                              <strong className="text-white">
                                                {actionItem.seedReagentsData.plateType || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Pipette:{' '}
                                              <strong className="text-white">
                                                {actionItem.seedReagentsData.pipetteType || 'N/A'}
                                              </strong>
                                            </span>
                                            <span>
                                              Cells:{' '}
                                              <strong className="text-white">
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

                                      {/* Bottom Row: Metadata Chips + Seek Button */}
                                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/60 text-xs">
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
                                                <span className="font-bold text-white">
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
                                                <span className="font-bold text-white">
                                                  {resolvedManufacturer}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Catalog / Ref #
                                                </span>
                                                <span className="font-bold text-white">
                                                  {resolvedCatalogNumber}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Lot #
                                                </span>
                                                <span className="font-bold text-white">
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
                                                <span className="font-bold text-white">
                                                  {resolvedCellLine || '(none)'}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  User Initials (Optional)
                                                </span>
                                                <span className="font-bold text-white">
                                                  {resolvedInitials || '—'}
                                                </span>
                                              </div>
                                              <div>
                                                <span className="text-slate-400 block text-[10px]">
                                                  Date Frozen (Optional)
                                                </span>
                                                <span className="font-bold text-white">
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
                                              Row <strong className="text-white">{wl.row}</strong> • Col{' '}
                                              <strong className="text-white">{wl.col}</strong> • Origin:{' '}
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
                                return !cls.includes('MIX') && !cls.includes('SEED');
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
                                        return !cls.includes('MIX') && !cls.includes('SEED');
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
                                                <strong className="text-white">
                                                  {act.vialLabelData?.cellLineName ||
                                                    act.cellLineName ||
                                                    act.cellLineInfo?.name ||
                                                    (isActRemoval ? '—' : '(untranscribed)')}
                                                </strong>
                                              </span>
                                              <span className="text-slate-300">
                                                Initials:{' '}
                                                <strong className="text-white">
                                                  {act.vialLabelData?.userInitials ||
                                                    act.cellLineInfo?.userInitials ||
                                                    '—'}
                                                </strong>
                                              </span>
                                              <span className="text-slate-300">
                                                Date Frozen:{' '}
                                                <strong className="text-white">
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
                                              First: <strong className="text-white">{ws.mixReagentsData.firstReagentName}</strong> ({ws.mixReagentsData.firstReagentAmount}) • Second: <strong className="text-white">{ws.mixReagentsData.secondReagentName}</strong> ({ws.mixReagentsData.secondReagentAmount})
                                            </div>
                                          )}
                                          {ws.seedReagentsData && (
                                            <div className="text-slate-300 space-y-1 pt-1">
                                              <div>
                                                Plate: <strong className="text-white">{ws.seedReagentsData.plateType || 'N/A'}</strong> • Pipette: <strong className="text-white">{ws.seedReagentsData.pipetteType || 'N/A'}</strong> • Cells: <strong className="text-white">{ws.seedReagentsData.cellsSeeded || 'N/A'}</strong> ({ws.seedReagentsData.cellsPerWell ? (String(ws.seedReagentsData.cellsPerWell).toLowerCase().includes('well') || ws.seedReagentsData.cellsPerWell === 'N/A' ? ws.seedReagentsData.cellsPerWell : `${ws.seedReagentsData.cellsPerWell}/well`) : 'N/A'}) • Seeding Events: <strong className="text-emerald-300">{ws.seedReagentsData.seedingEventsCount ?? 0}</strong> / {ws.seedReagentsData.expectedSeedingEventsCount ?? 12}
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

            {/* Step 5: Human-in-the-Loop (HITL) Verification Card */}
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
                  className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 space-y-4"
                  data-testid="hitl-verification-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="text-sm font-bold text-slate-100 flex items-center gap-2.5">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>Human-in-the-Loop (HITL) Verification</span>
                        {renderPassStatusBadge(
                          isHitlCommitted ? 'COMPLETED' : selectedPasses.hitl?.status || 'PENDING',
                          isCommittingHitl
                        )}
                      </div>
                      <p className="text-xs text-slate-400 font-mono">
                        Inspect & edit refined Pass 3 label fields (cellLineName, userInitials, dateFrozen, fullText) and box well coordinates (Origin A1 = Top-Left Black Corner), then commit to the Cryo-Inventory database
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
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

              {/* Inline Editable HITL Inventory / Experiment Archive Actions Table */}
              {(() => {
                const rawPass1 = selectedPasses.pass1?.data as any;
                const pass1Actions: any[] = Array.isArray(rawPass1)
                  ? rawPass1
                  : Array.isArray(rawPass1?.actions)
                  ? rawPass1.actions
                  : analysisCache[selectedVideo.videoId]?.actions || [];

                const isArchiveWorkflow =
                  selectedPasses.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                  selectedVideo.passes?.pass0?.data?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
                  pass1Actions.some((a) => {
                    const cls = String(a?.actionType || a?.actionClass || '').toUpperCase();
                    return cls.includes('MIX') || cls.includes('SEED');
                  });

                if (isArchiveWorkflow) {
                  const pass3Step = (selectedPasses.pass3 ||
                    selectedVideo.passes?.pass3 ||
                    {}) as any;
                  const rawPass3 = (pass3Step.data || {}) as any;
                  const pass3ReagentList = Array.isArray(pass3Step.reagents)
                    ? pass3Step.reagents
                    : Array.isArray(rawPass3.reagents)
                    ? rawPass3.reagents
                    : undefined;
                  const pass3WorkStepList = Array.isArray(pass3Step.workSteps)
                    ? pass3Step.workSteps
                    : Array.isArray(rawPass3.workSteps)
                    ? rawPass3.workSteps
                    : undefined;
                  const pass3TranscriptionList = Array.isArray(pass3Step.labelTranscriptions)
                    ? pass3Step.labelTranscriptions
                    : Array.isArray(rawPass3.labelTranscriptions)
                    ? rawPass3.labelTranscriptions
                    : undefined;
                  const currentArchiveEdits = hitlArchiveEdits[selectedVideo.videoId] || {};
                  const archiveReagents: ArchiveReagent[] = currentArchiveEdits.reagents ?? (
                    pass3ReagentList && pass3ReagentList.length > 0
                      ? pass3ReagentList
                      : analysisCache[selectedVideo.videoId]?.reagents || []
                  );
                  const archiveWorkSteps: ArchiveWorkStep[] = currentArchiveEdits.workSteps ?? (
                    pass3WorkStepList && pass3WorkStepList.length > 0
                      ? pass3WorkStepList
                      : Array.isArray(analysisCache[selectedVideo.videoId]?.workSteps) &&
                        analysisCache[selectedVideo.videoId]!.workSteps!.length > 0
                      ? analysisCache[selectedVideo.videoId]!.workSteps!
                      : pass1Actions.map((act: any, idx: number) => {
                          const cls = String(act.actionType || act.actionClass || '').toUpperCase();
                          const isSeed = cls.includes('SEED');
                          return {
                            stepId: act.actionId || `step_${idx + 1}`,
                            actionType: isSeed ? 'SEED_REAGENTS' : 'MIX_REAGENTS',
                            startTimeSeconds: Number(act.startTimestampSeconds ?? act.startTime ?? 0),
                            endTimeSeconds: Number(act.endTimestampSeconds ?? act.endTime ?? 0),
                            description:
                              act.description ||
                              (isSeed ? 'Seed reagents into plate' : 'Mix two reagents'),
                            mixReagentsData: act.mixReagentsData,
                            seedReagentsData: act.seedReagentsData,
                          };
                        })
                  );
                  const rawLabelTranscriptions: string[] = currentArchiveEdits.labelTranscriptions ?? (
                    pass3TranscriptionList && pass3TranscriptionList.length > 0
                      ? pass3TranscriptionList.map((lt: any) =>
                          typeof lt === 'string'
                            ? lt
                            : lt.fullText || lt.conflatedText || lt.shot1Text || ''
                        ).filter(Boolean)
                      : Array.isArray((analysisCache[selectedVideo.videoId] as any)?.labelTranscriptions)
                      ? (analysisCache[selectedVideo.videoId] as any).labelTranscriptions
                          .map((lt: any) =>
                            typeof lt === 'string'
                              ? lt
                              : lt?.fullText || lt?.conflatedText || lt?.shot1Text || ''
                          )
                          .filter(Boolean)
                      : []
                  );

                  const updateArchiveReagent = (idx: number, patch: Partial<ArchiveReagent>) => {
                    const updated = archiveReagents.map((r, i) => (i === idx ? { ...r, ...patch } : r));
                    setHitlArchiveEdits((prev) => ({
                      ...prev,
                      [selectedVideo.videoId]: {
                        ...prev[selectedVideo.videoId],
                        reagents: updated,
                      },
                    }));
                  };

                  const updateArchiveWorkStep = (idx: number, patch: Partial<ArchiveWorkStep>) => {
                    const updated = archiveWorkSteps.map((ws, i) => (i === idx ? { ...ws, ...patch } : ws));
                    setHitlArchiveEdits((prev) => ({
                      ...prev,
                      [selectedVideo.videoId]: {
                        ...prev[selectedVideo.videoId],
                        workSteps: updated,
                      },
                    }));
                  };

                  const handleCommitArchiveHitl = async () => {
                    setIsCommittingHitl(true);
                    setHitlCommitError(null);
                    setHitlCommitSuccess(null);
                    try {
                      const targetArchiveId =
                        selectedVideo.archiveId ||
                        pass1Actions[0]?.archiveId ||
                        archives[0]?.id ||
                        'archive_exp_402';
                      const matchedArchive = archives.find((a) => a.id === targetArchiveId);
                      const archiveName =
                        matchedArchive?.name ||
                        selectedVideo.archiveName ||
                        selectedPasses.pass0?.data?.archiveName ||
                        targetArchiveId;
                      const creatorName =
                        matchedArchive?.creatorName ||
                        selectedVideo.archiveCreatorName ||
                        selectedPasses.pass0?.data?.creatorName ||
                        'N/A';
                      const creationDate =
                        matchedArchive?.creationDate ||
                        selectedVideo.archiveCreationDate ||
                        selectedPasses.pass0?.data?.creationDate ||
                        new Date().toISOString().split('T')[0];

                      const markdownDoc = compileArchiveMarkdownFromAnalysis({
                        videoId: selectedVideo.videoId,
                        workflow: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
                        status: 'COMPLETED',
                        reagents: archiveReagents,
                        workSteps: archiveWorkSteps,
                        labelTranscriptions: rawLabelTranscriptions,
                        actions: pass1Actions,
                        events: [],
                        refinements: [],
                        updatedAt: new Date().toISOString(),
                        archiveName,
                        creatorName,
                        creationDate,
                      });

                      const res = await apiService.commitArchiveSignOff(
                        tenant.databaseId,
                        selectedVideo.videoId,
                        targetArchiveId,
                        markdownDoc,
                        {
                          archiveName,
                          creatorName,
                          creationDate,
                          reagents: archiveReagents,
                          labelTranscriptions: rawLabelTranscriptions,
                          workSteps: archiveWorkSteps.map((ws) => ({
                            ...ws,
                            videoId: ws.videoId || selectedVideo.videoId,
                          })),
                        }
                      );

                      const committedArchiveName =
                        typeof (res as any).archiveName === 'string' && (res as any).archiveName
                          ? (res as any).archiveName
                          : matchedArchive?.name || archiveName;
                      const committedReagents = Array.isArray((res as any).reagents)
                        ? (res as any).reagents
                        : archiveReagents;
                      const committedWorkSteps = Array.isArray((res as any).workSteps)
                        ? (res as any).workSteps
                        : archiveWorkSteps;
                      const committedTranscriptions = Array.isArray((res as any).labelTranscriptions)
                        ? (res as any).labelTranscriptions
                        : rawLabelTranscriptions;
                      const committedMarkdown =
                        typeof (res as any).markdownDoc === 'string'
                          ? (res as any).markdownDoc
                          : markdownDoc;

                      setArchives((prev) =>
                        prev.map((a) =>
                          a.id === targetArchiveId
                            ? {
                                ...a,
                                name: a.name || committedArchiveName,
                                reagents: committedReagents,
                                labelTranscriptions: committedTranscriptions,
                                workSteps: committedWorkSteps,
                                markdownDoc: committedMarkdown,
                                videoIds: Array.from(
                                  new Set([...(a.videoIds || []), selectedVideo.videoId])
                                ),
                                updatedAt: res.signedOffAt,
                              }
                            : a
                        )
                      );

                      const updatedAnalysisDoc: VideoAnalysisDoc = {
                        ...(analysisCache[selectedVideo.videoId] || {
                          videoId: selectedVideo.videoId,
                          actions: pass1Actions,
                          events: [],
                          refinements: [],
                        }),
                        videoId: selectedVideo.videoId,
                        archiveId: targetArchiveId,
                        archiveName: committedArchiveName,
                        creatorName,
                        creationDate,
                        reagents: archiveReagents,
                        workSteps: archiveWorkSteps.map((ws) => ({
                          ...ws,
                          videoId: ws.videoId || selectedVideo.videoId,
                        })),
                        isSignedOff: true,
                        signedOffAt: res.signedOffAt,
                        updatedAt: res.signedOffAt,
                      };
                      setAnalysisCache((prev) => ({
                        ...prev,
                        [selectedVideo.videoId]: updatedAnalysisDoc,
                      }));
                      onSelectActiveStream?.(
                        {
                          ...selectedVideo,
                          archiveId: targetArchiveId,
                          archiveName: committedArchiveName,
                        },
                        updatedAnalysisDoc
                      );

                      const successMsg = `Committed Experiment Archive Notebook (${archiveReagents.length} reagent(s), ${archiveWorkSteps.length} work step(s)) to Archive Database (${targetArchiveId}).`;
                      setHitlCommitSuccess(successMsg);
                      setStatusBanner(successMsg);
                      setPassesByVideo((prev) => {
                        const cur = ensurePasses(
                          prev[selectedVideo.videoId] || selectedVideo.passes
                        );
                        return {
                          ...prev,
                          [selectedVideo.videoId]: {
                            ...cur,
                            hitl: {
                              status: 'COMPLETED',
                              completedAt: res.signedOffAt,
                              data: {
                                archiveId: targetArchiveId,
                                signedOffAt: res.signedOffAt,
                                reagents: archiveReagents,
                                workSteps: archiveWorkSteps,
                              },
                            } as any,
                          },
                        };
                      });
                      onNavigateToArchive?.(targetArchiveId, selectedVideo.videoId);
                    } catch (err: any) {
                      const errMsg = `Failed to commit HITL archive notebook: ${err?.message || 'Unknown error'}`;
                      setHitlCommitError(errMsg);
                      setStatusBanner(errMsg);
                    } finally {
                      setIsCommittingHitl(false);
                    }
                  };

                  return (
                    <div className="space-y-3 pt-2 border-t border-slate-800/80">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                        <span className="text-indigo-300 font-semibold">
                          Experiment Archive HITL Review: {archiveReagents.length} Reagent(s) &amp;{' '}
                          {archiveWorkSteps.length} Work Step(s)
                        </span>
                      </div>

                      {/* Section A: Editable Reagents Table */}
                      <div className="space-y-2 bg-slate-900/80 border border-slate-800/80 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider">
                            Reagents Table ({archiveReagents.length})
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const newReagent: ArchiveReagent = {
                                id: `reagent_${Date.now()}`,
                                reagentName: 'New Reagent',
                                reagentAcronym: 'NR',
                                manufacturer: '',
                                catalogNumber: '',
                                lotNumber: '',
                              };
                              setHitlArchiveEdits((prev) => ({
                                ...prev,
                                [selectedVideo.videoId]: {
                                  ...prev[selectedVideo.videoId],
                                  reagents: [...archiveReagents, newReagent],
                                },
                              }));
                            }}
                            className="text-[10px] font-mono text-indigo-400 hover:text-indigo-300 underline"
                          >
                            + Add Reagent
                          </button>
                        </div>
                        {archiveReagents.length === 0 ? (
                          <p className="text-xs text-slate-500 font-mono italic">No reagents detected yet.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-xs font-mono">
                              <thead>
                                <tr className="border-b border-slate-800 text-[10px] uppercase text-slate-400">
                                  <th className="pb-1">Reagent Name</th>
                                  <th className="pb-1">Acronym</th>
                                  <th className="pb-1">Manufacturer</th>
                                  <th className="pb-1">Catalog #</th>
                                  <th className="pb-1">Lot #</th>
                                  <th className="pb-1 w-8"></th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/60">
                                {archiveReagents.map((reagent, rIdx) => (
                                  <tr key={reagent.id || `r_${rIdx}`}>
                                    <td className="py-1.5 pr-2">
                                      <input
                                        type="text"
                                        value={reagent.reagentName}
                                        onChange={(e) =>
                                          updateArchiveReagent(rIdx, { reagentName: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                                      />
                                    </td>
                                    <td className="py-1.5 pr-2 w-24">
                                      <input
                                        type="text"
                                        value={reagent.reagentAcronym || ''}
                                        onChange={(e) =>
                                          updateArchiveReagent(rIdx, { reagentAcronym: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none font-bold text-cyan-300"
                                      />
                                    </td>
                                    <td className="py-1.5 pr-2">
                                      <input
                                        type="text"
                                        value={reagent.manufacturer || ''}
                                        onChange={(e) =>
                                          updateArchiveReagent(rIdx, { manufacturer: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                                      />
                                    </td>
                                    <td className="py-1.5 pr-2 w-28">
                                      <input
                                        type="text"
                                        value={reagent.catalogNumber || ''}
                                        onChange={(e) =>
                                          updateArchiveReagent(rIdx, { catalogNumber: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                                      />
                                    </td>
                                    <td className="py-1.5 pr-2 w-28">
                                      <input
                                        type="text"
                                        value={reagent.lotNumber || ''}
                                        onChange={(e) =>
                                          updateArchiveReagent(rIdx, { lotNumber: e.target.value })
                                        }
                                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                                      />
                                    </td>
                                    <td className="py-1.5 text-center">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const updated = archiveReagents.filter((_, i) => i !== rIdx);
                                          setHitlArchiveEdits((prev) => ({
                                            ...prev,
                                            [selectedVideo.videoId]: {
                                              ...prev[selectedVideo.videoId],
                                              reagents: updated,
                                            },
                                          }));
                                        }}
                                        className="text-red-400 hover:text-red-300"
                                        title="Remove Reagent"
                                      >
                                        &times;
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Section B: Editable Work Steps with 96-Well Plate Map */}
                      <div className="space-y-3 bg-slate-900/80 border border-slate-800/80 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider">
                            Work Steps ({archiveWorkSteps.length})
                          </span>
                        </div>
                        {archiveWorkSteps.length === 0 ? (
                          <p className="text-xs text-slate-500 font-mono italic">No work steps detected yet.</p>
                        ) : (
                          <div className="space-y-3">
                            {archiveWorkSteps.map((step, wsIdx) => {
                              const isSeed = step.actionType === 'SEED_REAGENTS';
                              const isMix = step.actionType === 'MIX_REAGENTS';
                              const curMix = step.mixReagentsData || {
                                firstReagentName: '',
                                firstReagentAmount: '',
                                secondReagentName: '',
                                secondReagentAmount: '',
                              };
                              const curSeed = step.seedReagentsData || {
                                plateType: 'N/A',
                                pipetteType: 'N/A',
                                cellsSeeded: 'N/A',
                                cellsPerWell: 'N/A',
                                seedingEventsCount: 0,
                              };
                              const currentCols = curSeed.seededColumns || [];
                              const currentColsText = currentCols.join(', ');

                              return (
                                <div
                                  key={step.stepId || `ws_${wsIdx}`}
                                  className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 space-y-2 text-xs font-mono"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-950 border border-indigo-700/60 text-indigo-300">
                                        Step #{wsIdx + 1}
                                      </span>
                                      <span className="font-semibold text-slate-200">
                                        {isSeed ? '🌱 SEED_REAGENTS' : isMix ? '🧪 MIX_REAGENTS' : step.actionType}
                                      </span>
                                      <span className="text-slate-400 text-[11px]">
                                        ({step.startTimeSeconds ?? 0}s – {step.endTimeSeconds ?? 0}s)
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <select
                                        value={step.actionType}
                                        onChange={(e) =>
                                          updateArchiveWorkStep(wsIdx, {
                                            actionType: e.target.value as 'SEED_REAGENTS' | 'MIX_REAGENTS',
                                          })
                                        }
                                        className="bg-slate-900 border border-slate-700 text-slate-300 text-[11px] rounded px-2 py-0.5 focus:outline-none"
                                      >
                                        <option value="SEED_REAGENTS">SEED_REAGENTS</option>
                                        <option value="MIX_REAGENTS">MIX_REAGENTS</option>
                                      </select>
                                    </div>
                                  </div>

                                  <div>
                                    <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                      Description
                                    </label>
                                    <input
                                      type="text"
                                      value={step.description}
                                      onChange={(e) =>
                                        updateArchiveWorkStep(wsIdx, { description: e.target.value })
                                      }
                                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
                                    />
                                  </div>

                                  {isMix && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1 border-t border-slate-800/60">
                                      <div>
                                        <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                          First Reagent (Name / Amount)
                                        </label>
                                        <div className="flex gap-2">
                                          <input
                                            type="text"
                                            placeholder="e.g. Media"
                                            value={curMix.firstReagentName || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                mixReagentsData: {
                                                  ...curMix,
                                                  firstReagentName: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-2/3 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                          <input
                                            type="text"
                                            placeholder="e.g. 50 µL"
                                            value={curMix.firstReagentAmount || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                mixReagentsData: {
                                                  ...curMix,
                                                  firstReagentAmount: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-1/3 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                      </div>
                                      <div>
                                        <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                          Second Reagent (Name / Amount)
                                        </label>
                                        <div className="flex gap-2">
                                          <input
                                            type="text"
                                            placeholder="e.g. Buffer"
                                            value={curMix.secondReagentName || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                mixReagentsData: {
                                                  ...curMix,
                                                  secondReagentName: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-2/3 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                          <input
                                            type="text"
                                            placeholder="e.g. 10 µL"
                                            value={curMix.secondReagentAmount || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                mixReagentsData: {
                                                  ...curMix,
                                                  secondReagentAmount: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-1/3 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  )}

                                  {isSeed && (
                                    <div className="space-y-2 pt-1 border-t border-slate-800/60">
                                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                        <div>
                                          <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                            Plate Type
                                          </label>
                                          <input
                                            type="text"
                                            placeholder="e.g. 96-well plate"
                                            value={curSeed.plateType || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  plateType: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                        <div>
                                          <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                            Pipette Type
                                          </label>
                                          <input
                                            type="text"
                                            placeholder="e.g. 8-channel pipette"
                                            value={curSeed.pipetteType || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  pipetteType: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                        <div>
                                          <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                            Cells Seeded
                                          </label>
                                          <input
                                            type="text"
                                            placeholder="e.g. Jurkat T-cells"
                                            value={curSeed.cellsSeeded || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  cellsSeeded: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                        <div>
                                          <label className="text-[10px] uppercase text-slate-400 block mb-0.5">
                                            Cells Per Well
                                          </label>
                                          <input
                                            type="text"
                                            placeholder="e.g. 10000"
                                            value={curSeed.cellsPerWell || ''}
                                            onChange={(e) =>
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  cellsPerWell: e.target.value,
                                                },
                                              })
                                            }
                                            className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                          />
                                        </div>
                                      </div>

                                      <div>
                                        <div className="flex items-center justify-between mb-0.5">
                                          <label className="text-[10px] uppercase text-slate-400">
                                            Seeded Columns (1–12, Left to Right)
                                          </label>
                                          <span className="text-[10px] text-cyan-400">
                                            {currentCols.length > 0
                                              ? `${currentCols.length} column(s) selected: [${currentCols.join(', ')}]`
                                              : 'No columns selected'}
                                          </span>
                                        </div>
                                        <input
                                          type="text"
                                          placeholder="e.g. 1, 2, 3 or 1-12"
                                          value={currentColsText}
                                          onChange={(e) => {
                                            const cols = parseColumnNumbersFromText(e.target.value);
                                            const resolved = resolveSeededColumnsAndWells({ seededColumns: cols });
                                            updateArchiveWorkStep(wsIdx, {
                                              seedReagentsData: {
                                                ...curSeed,
                                                seededColumns: resolved.seededColumns,
                                                seededWells: resolved.seededWells,
                                                seedingEventsCount: resolved.seededColumns.length,
                                                isSeedingCountCorrect: resolved.seededColumns.length === 12,
                                              },
                                            });
                                          }}
                                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 text-xs focus:border-indigo-500 focus:outline-none"
                                        />
                                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                          <span className="text-[10px] text-slate-500">Quick set:</span>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const allCols = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
                                              const resolved = resolveSeededColumnsAndWells({ seededColumns: allCols });
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  seededColumns: resolved.seededColumns,
                                                  seededWells: resolved.seededWells,
                                                  seedingEventsCount: 12,
                                                  isSeedingCountCorrect: true,
                                                },
                                              });
                                            }}
                                            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[10px]"
                                          >
                                            All 12 Columns (Full Plate)
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              const resolved = resolveSeededColumnsAndWells({ seededColumns: [] });
                                              updateArchiveWorkStep(wsIdx, {
                                                seedReagentsData: {
                                                  ...curSeed,
                                                  seededColumns: [],
                                                  seededWells: [],
                                                  seedingEventsCount: 0,
                                                  isSeedingCountCorrect: false,
                                                },
                                              });
                                            }}
                                            className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 text-[10px]"
                                          >
                                            Clear
                                          </button>
                                        </div>
                                      </div>

                                      {/* 96-Well Plate Map Preview */}
                                      <div className="pt-2">
                                        <span className="text-[10px] uppercase text-slate-400 font-semibold block mb-1">
                                          96-Well Plate Map (Columns 1–12 Left to Right, Rows A–H)
                                        </span>
                                        <pre className="p-2.5 rounded bg-slate-950/90 border border-slate-800 text-[10px] font-mono text-cyan-300 leading-tight overflow-x-auto whitespace-pre">
                                          {render96WellPlateMarkdown(
                                            curSeed.seededColumns,
                                            curSeed.seededWells
                                          )}
                                        </pre>
                                        <p className="text-[10px] text-slate-500 mt-1">
                                          96-well plate does not use cryo-box top-left black marker. Rows A–H, columns 1–12 left to right. [X] = Seeded well, [ ] = Unseeded well.
                                        </p>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {hitlCommitError && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-950/60 border border-red-800/80 text-red-200 text-xs font-mono">
                          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                          <span>{hitlCommitError}</span>
                        </div>
                      )}

                      {hitlCommitSuccess && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-emerald-200 text-xs font-mono">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{hitlCommitSuccess}</span>
                        </div>
                      )}

                      {isHitlCommitted ? (
                        <div className="flex items-center justify-end gap-3 pt-1">
                          <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            <span>Experiment Archive Notebook has been committed to database.</span>
                          </div>
                          <button
                            type="button"
                            disabled={isUndoingHitl}
                            onClick={() => handleUndoHitlCommit(selectedVideo.videoId)}
                            data-testid="hitl-undo-commit-archive-btn"
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-amber-500/40 hover:border-amber-500 transition-all shadow-sm"
                            title="Unlock notebook notes to edit and re-commit"
                          >
                            {isUndoingHitl ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3.5 h-3.5" />
                            )}
                            <span>Undo Commit</span>
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end pt-1">
                          <button
                            type="button"
                            disabled={isCommittingHitl}
                            onClick={handleCommitArchiveHitl}
                            data-testid="hitl-commit-archive-btn"
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/20 transition-all"
                          >
                            {isCommittingHitl ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            <span>Commit to Database (Experiment Archive Notebook)</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }

                if (pass1Actions.length === 0) return null;

                const committedBoxUpdates: any[] = Array.isArray(
                  (selectedPasses.hitl as any)?.data?.boxUpdates
                )
                  ? (selectedPasses.hitl as any).data.boxUpdates
                  : Array.isArray((selectedVideo.passes?.hitl as any)?.data?.boxUpdates)
                    ? (selectedVideo.passes?.hitl as any).data.boxUpdates
                    : [];

                const getActionEditState = (act: any, idx: number) => {
                  const actId = act.actionId || `act_${idx + 1}`;
                  const key = `${selectedVideo.videoId}_${actId}`;
                  if (hitlActionEdits[key]) {
                    return hitlActionEdits[key];
                  }

                  const committed =
                    committedBoxUpdates.find((u: any) => u?.actionId === actId) ||
                    committedBoxUpdates[idx];
                  if (committed) {
                    const committedRow = String(committed.row || 'A').toUpperCase();
                    const committedCol = Number(committed.col) || 1;
                    const committedCoord = `${committedRow}${committedCol}`;
                    const committedIsRemoval =
                      committed.actionType === 'VIAL_REMOVAL' ||
                      committed.status === 'EMPTY';
                    return {
                      actionId: actId,
                      actionType: (committedIsRemoval
                        ? 'VIAL_REMOVAL'
                        : 'VIAL_INSERTION') as 'VIAL_INSERTION' | 'VIAL_REMOVAL',
                      boxId: String(committed.boxId || 'box_01'),
                      coordinate: committedCoord,
                      cellLineName: String(committed.cellLineName || ''),
                      userInitials: String(
                        committed.userInitials || committed.operatorInitials || ''
                      ),
                      dateFrozen: String(committed.dateFrozen || ''),
                      fullText: String(
                        committed.fullText || committed.cellLineName || ''
                      ),
                      lotNumber: String(committed.lotNumber || ''),
                      passage: String(committed.passage ?? 1),
                    };
                  }

                  const vLabel = act.vialLabelData || {};
                  const cInfo = act.cellLineInfo || {};
                  const wellLoc = act.boxWellLocation || {};
                  const coord =
                    wellLoc.coordinate ||
                    act.targetCoordinate ||
                    cInfo.targetCoordinate ||
                    (act.boxRowId ? `${act.boxRowId}${act.boxColId ?? 1}` : 'A1');
                  const isRemoval = String(act.actionType || act.actionClass || '')
                    .toUpperCase()
                    .includes('REMOVAL');

                  return {
                    actionId: actId,
                    actionType: (isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION') as
                      | 'VIAL_INSERTION'
                      | 'VIAL_REMOVAL',
                    boxId: String(cInfo.boxId || 'box_01'),
                    coordinate: String(coord).toUpperCase(),
                    cellLineName: String(
                      vLabel.cellLineName || act.cellLineName || cInfo.name || ''
                    ),
                    userInitials: String(
                      vLabel.userInitials ||
                        cInfo.userInitials ||
                        cInfo.operatorInitials ||
                        cInfo.operator ||
                        ''
                    ),
                    dateFrozen: String(vLabel.dateFrozen || cInfo.dateFrozen || ''),
                    fullText: String(
                      vLabel.fullText ||
                        act.conflatedLabelText ||
                        cInfo.fullText ||
                        vLabel.cellLineName ||
                        act.cellLineName ||
                        ''
                    ),
                    lotNumber: String(cInfo.lotNumber || cInfo.lot || ''),
                    passage: String(cInfo.passage ?? 1),
                  };
                };

                const updateHitlField = (
                  act: any,
                  idx: number,
                  field: string,
                  value: string
                ) => {
                  const current = getActionEditState(act, idx);
                  const key = `${selectedVideo.videoId}_${current.actionId}`;
                  setHitlCommitError(null);
                  setHitlCommitSuccess(null);
                  setHitlActionEdits((prev) => ({
                    ...prev,
                    [key]: {
                      ...current,
                      [field]: value,
                    },
                  }));
                };

                const handleDirectHitlCommit = async () => {
                  setIsCommittingHitl(true);
                  setHitlCommitError(null);
                  setHitlCommitSuccess(null);
                  try {
                    const targetInventoryId =
                      selectedVideo.inventoryId ||
                      pass1Actions[0]?.inventoryId ||
                      selectedPasses.pass0?.data?.inventoryName ||
                      inventories[0]?.id ||
                      'tank_alpha_01';

                    const boxUpdates = pass1Actions.map((act, idx) => {
                      const st = getActionEditState(act, idx);
                      const m = st.coordinate
                        .trim()
                        .toUpperCase()
                        .match(/^([A-Z])(\d+)$/);
                      const row = m ? m[1] : 'A';
                      const col = m ? Math.max(1, parseInt(m[2], 10)) : 1;
                      const isRemoval = st.actionType === 'VIAL_REMOVAL';
                      return {
                        boxId: st.boxId || 'box_01',
                        row,
                        col,
                        cellLineName: isRemoval ? (st.cellLineName || '') : (st.cellLineName || 'Unknown'),
                        userInitials: st.userInitials || undefined,
                        dateFrozen: st.dateFrozen || undefined,
                        fullText: isRemoval ? (st.fullText || '') : (st.fullText || st.cellLineName || 'Unknown'),
                        lotNumber: st.lotNumber || undefined,
                        passage: isRemoval ? undefined : (Number(st.passage) || 1),
                        operatorInitials: st.userInitials || tenant.operatorInitials || 'RS',
                        actionId: st.actionId,
                        actionType: st.actionType,
                        highlighted: !isRemoval,
                        status: (isRemoval ? 'EMPTY' : 'OCCUPIED') as 'EMPTY' | 'OCCUPIED',
                        updatedAt: new Date().toISOString(),
                      };
                    });

                    const res = await apiService.commitInventorySignOff(
                      tenant.databaseId,
                      selectedVideo.videoId,
                      targetInventoryId,
                      boxUpdates
                    );

                    const applyEditsToActions = (actions: any[]) =>
                      actions.map((act: any, idx: number) => {
                        const actId = act.actionId || `act_${idx + 1}`;
                        const upd =
                          boxUpdates.find((u) => u.actionId === actId) || boxUpdates[idx];
                        if (!upd) return act;
                        const coord = `${upd.row}${upd.col}`;
                        return {
                          ...act,
                          actionId: actId,
                          actionType: upd.actionType,
                          actionClass: upd.actionType,
                          targetCoordinate: coord,
                          boxRowId: upd.row,
                          boxColId: upd.col,
                          cellLineName: upd.cellLineName,
                          conflatedLabelText: upd.fullText,
                          boxWellLocation: {
                            ...(act.boxWellLocation || {}),
                            row: upd.row,
                            column: upd.col,
                            coordinate: coord,
                          },
                          vialLabelData: {
                            ...(act.vialLabelData || {}),
                            cellLineName: upd.cellLineName,
                            userInitials: upd.userInitials || act.vialLabelData?.userInitials,
                            dateFrozen: upd.dateFrozen || act.vialLabelData?.dateFrozen,
                            fullText: upd.fullText,
                          },
                          cellLineInfo: {
                            ...(act.cellLineInfo || {}),
                            boxId: upd.boxId,
                            name: upd.cellLineName,
                            targetCoordinate: coord,
                            userInitials: upd.userInitials || act.cellLineInfo?.userInitials,
                            operatorInitials: upd.operatorInitials,
                            dateFrozen: upd.dateFrozen || act.cellLineInfo?.dateFrozen,
                            fullText: upd.fullText,
                            lotNumber: upd.lotNumber || act.cellLineInfo?.lotNumber,
                            passage: upd.passage,
                          },
                        };
                      });

                    setPassesByVideo((prev) => {
                      const cur = ensurePasses(
                        prev[selectedVideo.videoId] || selectedVideo.passes
                      );
                      const updatedPass1Data = cur.pass1?.data
                        ? {
                            ...cur.pass1.data,
                            actions: Array.isArray(cur.pass1.data.actions)
                              ? applyEditsToActions(cur.pass1.data.actions)
                              : cur.pass1.data.actions,
                          }
                        : cur.pass1?.data;
                      return {
                        ...prev,
                        [selectedVideo.videoId]: {
                          ...cur,
                          pass1: cur.pass1
                            ? { ...cur.pass1, data: updatedPass1Data }
                            : cur.pass1,
                          hitl: {
                            status: 'COMPLETED',
                            completedAt: res.signedOffAt,
                            data: {
                              inventoryId: targetInventoryId,
                              signedOffAt: res.signedOffAt,
                              boxUpdates,
                            },
                          } as any,
                        },
                      };
                    });

                    setVideos((prev) =>
                      prev.map((v) => {
                        if (v.videoId !== selectedVideo.videoId) return v;
                        const cur = ensurePasses(v.passes);
                        const updatedPass1Data = cur.pass1?.data
                          ? {
                              ...cur.pass1.data,
                              actions: Array.isArray(cur.pass1.data.actions)
                                ? applyEditsToActions(cur.pass1.data.actions)
                                : cur.pass1.data.actions,
                            }
                          : cur.pass1?.data;
                        return {
                          ...v,
                          passes: {
                            ...cur,
                            pass1: cur.pass1
                              ? { ...cur.pass1, data: updatedPass1Data }
                              : cur.pass1,
                            hitl: {
                              status: 'COMPLETED',
                              completedAt: res.signedOffAt,
                              data: {
                                inventoryId: targetInventoryId,
                                signedOffAt: res.signedOffAt,
                                boxUpdates,
                              },
                            } as any,
                          },
                        };
                      })
                    );

                    const successMsg = `Committed ${boxUpdates.length} verified inventory action(s) to Cryo-Inventory (${targetInventoryId}).`;
                    setHitlCommitSuccess(successMsg);
                    setStatusBanner(successMsg);
                    onNavigateToInventory?.(targetInventoryId, selectedVideo.videoId);
                  } catch (err: any) {
                    const errMsg = `Failed to commit HITL inventory actions: ${err?.message || 'Unknown error'}`;
                    setHitlCommitError(errMsg);
                    setStatusBanner(errMsg);
                  } finally {
                    setIsCommittingHitl(false);
                  }
                };

                return (
                  <div className="space-y-3 pt-2 border-t border-slate-800/80">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                      <span className="text-emerald-300 font-semibold">
                        Verify & Edit Refined Inventory Update Actions ({pass1Actions.length})
                      </span>
                      <span className="text-[10px] text-amber-300">
                        Origin A1 = Top-Left Black Corner • Rows: A.. • Cols: 1..
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      {pass1Actions.map((act: any, idx: number) => {
                        const st = getActionEditState(act, idx);
                        return (
                          <div
                            key={st.actionId}
                            className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2.5 text-xs font-mono"
                            data-testid={`hitl-action-editor-${st.actionId}`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-cyan-300">{st.actionId}</span>
                                <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-[10px] text-slate-300">
                                  {st.actionType}
                                </span>
                              </div>
                              <span className="text-[10px] text-slate-400">
                                Well Coordinate (A1 = Top-Left Black Corner)
                              </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1">
                                  Well Coordinate (Row+Col)
                                </label>
                                <input
                                  type="text"
                                  value={st.coordinate}
                                  onChange={(e) =>
                                    updateHitlField(
                                      act,
                                      idx,
                                      'coordinate',
                                      e.target.value.toUpperCase()
                                    )
                                  }
                                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-emerald-300 font-bold text-xs focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1">
                                  Cell Line Name *
                                </label>
                                <input
                                  type="text"
                                  value={st.cellLineName}
                                  onChange={(e) =>
                                    updateHitlField(act, idx, 'cellLineName', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1">
                                  User Initials
                                </label>
                                <input
                                  type="text"
                                  value={st.userInitials}
                                  onChange={(e) =>
                                    updateHitlField(act, idx, 'userInitials', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1">
                                  Date Frozen
                                </label>
                                <input
                                  type="text"
                                  value={st.dateFrozen}
                                  onChange={(e) =>
                                    updateHitlField(act, idx, 'dateFrozen', e.target.value)
                                  }
                                  placeholder="YYYY-MM-DD"
                                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                              <div className="sm:col-span-2">
                                <label className="block text-[10px] text-slate-400 mb-1">
                                  Full Label Text *
                                </label>
                                <input
                                  type="text"
                                  value={st.fullText}
                                  onChange={(e) =>
                                    updateHitlField(act, idx, 'fullText', e.target.value)
                                  }
                                  className="w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 text-cyan-200 text-xs focus:outline-none focus:border-cyan-500"
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {hitlCommitError && (
                      <div
                        data-testid="hitl-commit-error"
                        className="flex items-start gap-2 p-3 rounded-lg bg-red-950/60 border border-red-800/80 text-red-200 text-xs font-mono"
                      >
                        <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <span>{hitlCommitError}</span>
                      </div>
                    )}

                    {hitlCommitSuccess && (
                      <div
                        data-testid="hitl-commit-success"
                        className="flex items-start gap-2 p-3 rounded-lg bg-emerald-950/60 border border-emerald-800/80 text-emerald-200 text-xs font-mono"
                      >
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{hitlCommitSuccess}</span>
                      </div>
                    )}

                    {isHitlCommitted ? (
                      <div
                        data-testid="hitl-actions-committed-status"
                        className="flex items-center justify-end gap-3 pt-1"
                      >
                        <div className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold">
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          <span>Inventory update actions have been committed.</span>
                        </div>
                        <button
                          type="button"
                          disabled={isUndoingHitl}
                          onClick={() => handleUndoHitlCommit(selectedVideo.videoId)}
                          data-testid="hitl-undo-commit-inventory-btn"
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-amber-500/40 hover:border-amber-500 transition-all shadow-sm"
                          title="Unlock inventory actions to edit and re-commit"
                        >
                          {isUndoingHitl ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="w-3.5 h-3.5" />
                          )}
                          <span>Undo Commit</span>
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          disabled={isCommittingHitl}
                          onClick={handleDirectHitlCommit}
                          data-testid="hitl-commit-inventory-btn"
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white shadow-lg shadow-emerald-600/20 transition-all"
                        >
                          {isCommittingHitl ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          )}
                          <span>Commit Verified Actions to Inventory Database</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}
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
