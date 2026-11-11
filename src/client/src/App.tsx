import React, { useState, useEffect, useMemo } from 'react';
import { RibbonNav, WorkflowTab } from './components/layout/RibbonNav';
import { VideoPlayer } from './components/timeline/VideoPlayer';
import { TimelineViewer } from './components/timeline/TimelineViewer';
import { BoxGridView } from './components/inventory/BoxGridView';
import { VialInspector, HumanEditedVialData } from './components/inventory/VialInspector';
import { CryoInventory } from './components/inventory/CryoInventory';
import { ExperimentArchive } from './components/archive/ExperimentArchive';
import { MicroplateView } from './components/archive/MicroplateView';
import {
  NotebookEditor,
  DEFAULT_EXPERIMENT_MARKDOWN,
  DEFAULT_REAGENTS,
  ReagentMapping,
} from './components/archive/NotebookEditor';
import { VideoManager } from './components/VideoManager';
import { SignOffModal } from './components/review/SignOffModal';
import {
  TenantConfig,
  DEFAULT_TENANT_CONFIG,
  apiService,
  SignOffResponse,
  SAMPLE_INVENTORY_ANALYSIS,
  SAMPLE_ARCHIVE_ANALYSIS,
  compileArchiveMarkdownFromAnalysis,
  deriveArchiveDataFromAnalysis,
} from './services/api.service';
import type { VideoAnalysisDoc, VideoRecord } from '@sail/shared';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { CheckCircle2, AlertCircle, Info, Lock, Loader2, LogOut } from 'lucide-react';
import { auth } from './firebase';
import { Login } from './components/Login';
import {
  ThemeMode,
  getInitialTheme,
  applyThemeToDocument,
  getNextTheme,
} from './utils/theme';

function deriveInventoryDataFromAnalysis(
  doc: VideoAnalysisDoc | null,
  actionId?: string | null
): HumanEditedVialData {
  const targetAction =
    (actionId && doc?.actions?.find((a) => a.actionId === actionId)) ||
    doc?.actions?.[0];
  const spatialRef = doc?.refinements?.find(
    (r) =>
      (targetAction?.eventList?.includes(r.eventId || '') || !actionId) &&
      r.spatialResult?.row &&
      r.spatialResult?.col !== undefined
  );
  const ocrRef = doc?.refinements?.find(
    (r) =>
      (targetAction?.eventList?.includes(r.eventId || '') || !actionId) &&
      (r.vialLabelData || r.refinementClass === 'OCR_CONFLATION')
  );
  const wellLoc = targetAction?.boxWellLocation || spatialRef?.boxWellLocation;
  const row = (
    wellLoc?.row ||
    targetAction?.boxRowId ||
    spatialRef?.spatialResult?.row ||
    'C'
  ).toUpperCase();
  const col = Number(
    wellLoc?.col ?? targetAction?.boxColId ?? spatialRef?.spatialResult?.col ?? 4
  );
  const cellLineInfo = (targetAction?.cellLineInfo || {}) as Record<string, any>;
  const isDemoDoc = !doc?.videoId || doc.videoId === 'vid_cryo_demo_01';
  const labelRec = doc?.labelTranscriptions?.find(
    (lt) =>
      (targetAction?.actionId && lt.actionIds?.includes(targetAction.actionId)) ||
      (targetAction?.eventList && lt.eventId && targetAction.eventList.includes(lt.eventId)) ||
      !actionId
  );
  const vialLabelData =
    targetAction?.vialLabelData ||
    labelRec?.vialLabelData ||
    ocrRef?.vialLabelData;

  const isRemoval = String(
    targetAction?.actionType || targetAction?.actionClass || ''
  )
    .toUpperCase()
    .includes('REMOVAL');

  const cellLineName = isRemoval
    ? String(
        vialLabelData?.cellLineName ||
          targetAction?.cellLineName ||
          cellLineInfo.name ||
          ''
      )
    : vialLabelData?.cellLineName ||
      labelRec?.cellLineName ||
      targetAction?.cellLineName ||
      cellLineInfo.name ||
      (isDemoDoc ? 'HEK293T' : '');
  const userInitials = isRemoval
    ? String(
        vialLabelData?.userInitials ||
          cellLineInfo.userInitials ||
          cellLineInfo.operatorInitials ||
          ''
      )
    : String(
        vialLabelData?.userInitials ||
          labelRec?.userInitials ||
          cellLineInfo.userInitials ||
          cellLineInfo.operatorInitials ||
          cellLineInfo.operator ||
          (isDemoDoc ? 'RS' : '')
      );
  const dateFrozen = isRemoval
    ? String(vialLabelData?.dateFrozen || cellLineInfo.dateFrozen || '')
    : String(
        vialLabelData?.dateFrozen ||
          labelRec?.dateFrozen ||
          cellLineInfo.dateFrozen ||
          (isDemoDoc ? '2026-03-15' : '')
      );
  const fullText = isRemoval
    ? String(
        vialLabelData?.fullText ||
          targetAction?.conflatedLabelText ||
          cellLineInfo.fullText ||
          ''
      )
    : String(
        vialLabelData?.fullText ||
          labelRec?.fullText ||
          labelRec?.conflatedText ||
          targetAction?.conflatedLabelText ||
          cellLineInfo.fullText ||
          ocrRef?.transcriptionText ||
          (isDemoDoc ? `${cellLineName} P5 Lot#8841 ${userInitials} ${dateFrozen}` : cellLineName)
      );

  return {
    cellLineName,
    userInitials,
    dateFrozen,
    fullText,
    lotNumber: isRemoval
      ? String(cellLineInfo.lotNumber || cellLineInfo.lot || '')
      : String(cellLineInfo.lotNumber || cellLineInfo.lot || 'LOT-8841'),
    passage: typeof cellLineInfo.passage === 'number' ? cellLineInfo.passage : isRemoval ? 1 : 5,
    operatorInitials: userInitials,
    targetCoordinate: String(
      wellLoc?.coordinate || cellLineInfo.targetCoordinate || `${row}${col}`
    ),
    boxId: String(cellLineInfo.boxId || 'box_01'),
    actionId: targetAction?.actionId || 'act_cryo_001',
    actionType: isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION',
  };
}

export const App: React.FC = () => {
  // Authentication state gated via Firebase Auth
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [organizationId, setOrganizationId] = useState<string>('');
  const [userRole, setUserRole] = useState<string>('user');

  // Theme state (Light Mode default, switches between 'light' and 'dark')
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const handleToggleTheme = () => {
    setTheme((prev) => {
      const next = getNextTheme(prev);
      applyThemeToDocument(next);
      return next;
    });
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser((prevUser) => {
        if (!prevUser && currentUser) {
          setActiveTab('videos');
        }
        return currentUser;
      });

      if (currentUser) {
        try {
          const token = await currentUser.getIdToken();
          const res = await fetch('/api/auth/me', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });
          if (res.ok) {
            const profile = await res.json();
            const resolvedOrgId = profile.organizationId || 'default-org';
            setOrganizationId(resolvedOrgId);
            setUserRole(profile.role || 'user');
            setTenant((prev) => ({ ...prev, customerId: resolvedOrgId }));
            apiService.setTenant({ customerId: resolvedOrgId });
          } else {
            setOrganizationId('default-org');
          }
        } catch (err) {
          console.warn('[App] Could not fetch /api/auth/me profile:', err);
          setOrganizationId('default-org');
        }
      } else {
        setOrganizationId('');
        setUserRole('user');
      }
    });
    return () => unsubscribe();
  }, []);

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<WorkflowTab>('videos');
  const [signOffReturnTab, setSignOffReturnTab] = useState<WorkflowTab | null>(null);
  const [selectedInventoryId, setSelectedInventoryId] = useState<string | null>(null);
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);

  // Multi-tenant configuration
  const [tenant, setTenant] = useState<TenantConfig>(DEFAULT_TENANT_CONFIG);

  // Analysis document (supports null/loading fallback state)
  const [analysis, setAnalysis] = useState<VideoAnalysisDoc | null>(SAMPLE_INVENTORY_ANALYSIS);
  const [activeVideoId, setActiveVideoId] = useState<string>('vid_cryo_demo_01');

  // Synchronized Video & Timeline state
  const [currentTime, setCurrentTime] = useState<number>(6.5);
  const [duration, setDuration] = useState<number>(35.0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [selectedActionId, setSelectedActionId] = useState<string | null>('act_cryo_001');
  const [selectedEventId, setSelectedEventId] = useState<string | null>('evt_001');

  // --- State persistence across tab toggles ---

  // Inventory workspace persistent state
  const [rawAiInventoryData, setRawAiInventoryData] = useState<HumanEditedVialData>(() =>
    deriveInventoryDataFromAnalysis(SAMPLE_INVENTORY_ANALYSIS)
  );
  const [editedInventoryData, setEditedInventoryData] = useState<HumanEditedVialData>(() =>
    deriveInventoryDataFromAnalysis(SAMPLE_INVENTORY_ANALYSIS)
  );

  // Archive workspace persistent state
  const [seededColumns, setSeededColumns] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [markdownDoc, setMarkdownDoc] = useState<string>(DEFAULT_EXPERIMENT_MARKDOWN);
  const [reagentMappings] = useState<ReagentMapping[]>(DEFAULT_REAGENTS);

  // Derived structured archive data from active video analysis
  const derivedArchiveData = useMemo(
    () => deriveArchiveDataFromAnalysis(analysis),
    [analysis]
  );

  // Sign-Off & Lock State
  const [isSignedOff, setIsSignedOff] = useState<boolean>(false);
  const [isSignOffModalOpen, setIsSignOffModalOpen] = useState<boolean>(false);
  const [signOffVersion, setSignOffVersion] = useState<number>(0);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(
    null
  );

  // Show transient toast notification
  const showToast = (type: 'success' | 'error' | 'info', text: string) => {
    setToast({ type, text });
    setTimeout(() => {
      setToast((current) => (current?.text === text ? null : current));
    }, 4500);
  };

  // Apply a loaded or newly analyzed VideoAnalysisDoc to active application state
  const applyAnalysisDocument = (
    videoId: string,
    doc: VideoAnalysisDoc,
    targetTab?: WorkflowTab
  ) => {
    setActiveVideoId(videoId);
    setAnalysis(doc);
    setIsSignedOff(Boolean(doc.isSignedOff));

    const rawActionArchiveId = doc.actions?.[0]?.archiveId;
    const validActionArchiveId =
      typeof rawActionArchiveId === 'string' &&
      rawActionArchiveId.trim().length > 0 &&
      !/\s/.test(rawActionArchiveId.trim())
        ? rawActionArchiveId.trim()
        : undefined;
    const docArchiveId = (doc as any)?.archiveId || validActionArchiveId;
    if (docArchiveId) {
      setSelectedArchiveId(docArchiveId);
    }
    const docInventoryId = (doc as any)?.inventoryId || doc.actions?.[0]?.inventoryId;
    if (docInventoryId) {
      setSelectedInventoryId(docInventoryId);
    }

    const maxEnd = doc.events?.reduce((max, e) => Math.max(max, e.endTime || 0), 0) || 0;
    const fallbackDuration = targetTab === 'archive' ? 45.0 : 35.0;
    setDuration(maxEnd > 0 ? Math.max(maxEnd + 5, fallbackDuration) : fallbackDuration);
    setCurrentTime(doc.events?.[0]?.startTime ?? 0);
    setSelectedActionId(doc.actions?.[0]?.actionId ?? null);
    setSelectedEventId(doc.events?.[0]?.eventId ?? null);

    const derivedInv = deriveInventoryDataFromAnalysis(doc);
    setRawAiInventoryData(derivedInv);
    setEditedInventoryData(derivedInv);

    if (videoId === 'vid_archive_demo_02') {
      setMarkdownDoc(DEFAULT_EXPERIMENT_MARKDOWN);
    } else if (
      targetTab === 'archive' ||
      doc.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      doc.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
    ) {
      setMarkdownDoc(compileArchiveMarkdownFromAnalysis(doc));
    }
  };

  // Switch video stream when tab changes, or fetch analysis for selected active stream
  const handleSelectTab = async (tab: WorkflowTab) => {
    setActiveTab(tab);
    if (tab === 'videos') {
      return;
    }

    const isDemoStream =
      activeVideoId === 'vid_cryo_demo_01' || activeVideoId === 'vid_archive_demo_02';
    if (isDemoStream) {
      if (tab === 'inventory' && activeVideoId !== 'vid_cryo_demo_01') {
        applyAnalysisDocument('vid_cryo_demo_01', SAMPLE_INVENTORY_ANALYSIS, 'inventory');
      } else if (tab === 'archive' && activeVideoId !== 'vid_archive_demo_02') {
        applyAnalysisDocument('vid_archive_demo_02', SAMPLE_ARCHIVE_ANALYSIS, 'archive');
      }
      return;
    }

    // Ensure the active stream's analysis document from Firestore is loaded
    if (!analysis || analysis.videoId !== activeVideoId) {
      try {
        const fetchedDoc = await apiService.fetchVideoAnalysis(activeVideoId, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        applyAnalysisDocument(activeVideoId, fetchedDoc, tab);
      } catch {
        // Stream may not have completed AI analysis yet
      }
    }
  };

  // Handle selecting any video from the registry as the global Active Stream
  const handleSelectActiveStream = async (
    video: VideoRecord,
    cachedAnalysis?: VideoAnalysisDoc
  ) => {
    const videoId = video.videoId;
    setActiveVideoId(videoId);
    if (video.archiveId) {
      setSelectedArchiveId(video.archiveId);
    }
    if (video.inventoryId) {
      setSelectedInventoryId(video.inventoryId);
    }

    if (cachedAnalysis) {
      applyAnalysisDocument(videoId, cachedAnalysis);
      showToast('info', `Selected active stream: ${videoId}`);
      return;
    }

    if (videoId === 'vid_cryo_demo_01') {
      applyAnalysisDocument(videoId, SAMPLE_INVENTORY_ANALYSIS, 'inventory');
      showToast('info', `Selected active stream: ${videoId}`);
      return;
    }

    if (videoId === 'vid_archive_demo_02') {
      applyAnalysisDocument(videoId, SAMPLE_ARCHIVE_ANALYSIS, 'archive');
      showToast('info', `Selected active stream: ${videoId}`);
      return;
    }

    const hasCompletedInventoryPasses =
      video.status === 'ANALYSIS_COMPLETE' ||
      Boolean(video.analysisId) ||
      video.passes?.pass2?.status === 'COMPLETED' ||
      video.passes?.pass3?.status === 'COMPLETED';

    if (hasCompletedInventoryPasses) {
      try {
        const fetchedDoc = await apiService.fetchVideoAnalysis(videoId, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        applyAnalysisDocument(videoId, fetchedDoc);
        showToast('info', `Selected active stream: ${videoId}`);
      } catch {
        setAnalysis(null);
        showToast('info', `Selected active stream: ${videoId}`);
      }
    } else {
      setAnalysis(null);
      setIsSignedOff(false);
      showToast('info', `Selected active stream: ${videoId} (awaiting AI analysis)`);
    }
  };

  // Handle switching video from Video Manager (or upon analysis completion / HITL sign-off review)
  const handleSelectVideoFromManager = async (
    videoId: string,
    targetTab: 'inventory' | 'archive' | 'hitl',
    analysisDoc?: VideoAnalysisDoc
  ) => {
    const isArchiveDoc =
      analysisDoc?.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      analysisDoc?.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
      Boolean((analysisDoc as any)?.archiveId) ||
      (Array.isArray(analysisDoc?.reagents) && analysisDoc.reagents.length > 0) ||
      (Array.isArray(analysisDoc?.workSteps) && analysisDoc.workSteps.length > 0) ||
      (Array.isArray(analysisDoc?.actions) &&
        analysisDoc.actions.some((a: any) => {
          const cls = String(a?.actionType || a?.actionClass || '').toUpperCase();
          return (
            cls.includes('MIX') ||
            cls.includes('SEED') ||
            cls.includes('INCUBAT') ||
            cls.includes('ASPIRAT') ||
            cls.includes('ASPRIRAT') ||
            cls.includes('HEMOCYTOMETER')
          );
        })) ||
      videoId.toLowerCase().includes('archive');

    const resolvedTab: WorkflowTab =
      targetTab === 'hitl' ? (isArchiveDoc ? 'archive' : 'inventory') : targetTab;

    if (targetTab === 'hitl') {
      setSignOffReturnTab('videos');
    } else {
      setSignOffReturnTab(null);
    }

    setActiveVideoId(videoId);
    setActiveTab(resolvedTab);

    if (analysisDoc) {
      applyAnalysisDocument(videoId, analysisDoc, resolvedTab);
      if (targetTab === 'hitl') {
        setIsSignOffModalOpen(true);
        showToast('info', `Opened HITL Sign-Off review for ${videoId}`);
      } else {
        showToast('info', `Loaded stream ${videoId} into ${resolvedTab} manager`);
      }

      // If archive analysisDoc was constructed from partial client cache without reagents/workSteps,
      // refresh from backend video_analyses/{videoId} and merge without losing client overrides
      const isNonDemo =
        videoId !== 'vid_cryo_demo_01' && videoId !== 'vid_archive_demo_02';
      const needsServerEnrichment =
        isNonDemo &&
        resolvedTab === 'archive' &&
        (!Array.isArray(analysisDoc.reagents) || analysisDoc.reagents.length === 0 ||
          !Array.isArray(analysisDoc.workSteps) || analysisDoc.workSteps.length === 0);
      if (needsServerEnrichment) {
        try {
          const fetchedDoc = await apiService.fetchVideoAnalysis(videoId, {
            customerId: tenant.customerId,
            databaseId: tenant.databaseId,
          });
          const mergedDoc: VideoAnalysisDoc = {
            ...fetchedDoc,
            ...analysisDoc,
            reagents:
              Array.isArray(analysisDoc.reagents) && analysisDoc.reagents.length > 0
                ? analysisDoc.reagents
                : fetchedDoc.reagents,
            workSteps:
              Array.isArray(analysisDoc.workSteps) && analysisDoc.workSteps.length > 0
                ? analysisDoc.workSteps
                : fetchedDoc.workSteps,
            labelTranscriptions:
              Array.isArray((analysisDoc as any).labelTranscriptions) &&
              (analysisDoc as any).labelTranscriptions.length > 0
                ? (analysisDoc as any).labelTranscriptions
                : (fetchedDoc as any).labelTranscriptions,
          };
          applyAnalysisDocument(videoId, mergedDoc, resolvedTab);
        } catch {
          // keep local analysisDoc
        }
      }
      return;
    }

    if (videoId === 'vid_cryo_demo_01') {
      applyAnalysisDocument(videoId, SAMPLE_INVENTORY_ANALYSIS, 'inventory');
      if (targetTab === 'hitl') setIsSignOffModalOpen(true);
      showToast('info', `Loaded stream ${videoId} into ${resolvedTab} manager`);
      return;
    }

    if (videoId === 'vid_archive_demo_02') {
      applyAnalysisDocument(videoId, SAMPLE_ARCHIVE_ANALYSIS, 'archive');
      if (targetTab === 'hitl') setIsSignOffModalOpen(true);
      showToast('info', `Loaded stream ${videoId} into ${resolvedTab} manager`);
      return;
    }

    setAnalysis(null);
    try {
      const fetchedDoc = await apiService.fetchVideoAnalysis(videoId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      applyAnalysisDocument(videoId, fetchedDoc, resolvedTab);
      if (targetTab === 'hitl') {
        setIsSignOffModalOpen(true);
        showToast('info', `Opened HITL Sign-Off review for ${videoId}`);
      } else {
        showToast('info', `Loaded stream ${videoId} into ${resolvedTab} manager`);
      }
    } catch {
      if (targetTab === 'hitl') {
        setIsSignOffModalOpen(true);
      } else {
        showToast('error', `Failed to load analysis for ${videoId}`);
      }
    }
  };

  // Handle direct navigation to inventory tab with pre-selected inventory ID
  const handleNavigateToInventory = (inventoryId?: string, videoId?: string) => {
    if (inventoryId) {
      setSelectedInventoryId(inventoryId);
    }
    if (videoId) {
      setActiveVideoId(videoId);
    }
    setSignOffVersion((v) => v + 1);
    setActiveTab('inventory');
    showToast('info', `Navigated to Cryo-Inventory${inventoryId ? ` (${inventoryId})` : ''}`);
  };

  // Handle direct navigation to archive tab with pre-selected archive ID
  const handleNavigateToArchive = (archiveId?: string, videoId?: string) => {
    if (archiveId) {
      setSelectedArchiveId(archiveId);
    }
    if (videoId) {
      setActiveVideoId(videoId);
    }
    setSignOffVersion((v) => v + 1);
    setActiveTab('archive');
    showToast('info', `Navigated to Experiment Archive${archiveId ? ` (${archiveId})` : ''}`);
  };

  // Handle seeking from timeline
  const handleTimelineSeek = (time: number) => {
    setCurrentTime(time);
    setSeekTarget(time);
  };

  // Listen for cross-component seek events
  useEffect(() => {
    const handleSeekEvent = (e: any) => {
      if (typeof e.detail?.seconds === 'number') {
        handleTimelineSeek(e.detail.seconds);
      }
    };
    window.addEventListener('sail:seek-video', handleSeekEvent);
    return () => window.removeEventListener('sail:seek-video', handleSeekEvent);
  }, []);

  // Handle selecting action from timeline
  const handleSelectAction = (actionId: string) => {
    setSelectedActionId(actionId);
    const actionsList = analysis?.actions ?? [];
    const action = actionsList.find((a) => a.actionId === actionId);
    if (action) {
      const derived = deriveInventoryDataFromAnalysis(analysis, actionId);
      setRawAiInventoryData(derived);
      setEditedInventoryData(derived);
      showToast('info', `Selected action ${action.actionClass}`);
    }
  };

  // Handle selecting event from timeline
  const handleSelectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    const eventsList = analysis?.events ?? [];
    const ev = eventsList.find((e) => e.eventId === eventId);
    if (ev) {
      handleTimelineSeek(ev.startTime);
    }
  };

  // Handle inventory slot click
  const handleSelectGridSlot = (row: string, col: number) => {
    if (isSignedOff) return;
    setEditedInventoryData((prev) => ({
      ...prev,
      targetCoordinate: `${row}${col}`,
    }));
    showToast('info', `Updated target coordinate to ${row}${col}`);
  };

  // Handle toggle column in 96-well microplate
  const handleTogglePlateColumn = (col: number) => {
    if (isSignedOff) return;
    setSeededColumns((prev) =>
      prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col].sort((a, b) => a - b)
    );
  };

  // Handle sign-off commit success
  const handleSignOffSuccess = (res: SignOffResponse) => {
    setSignOffReturnTab(null);
    const details = (res.details || res) as Record<string, any>;
    const committedArchiveId = details?.archiveId || derivedArchiveData.archiveId;
    setIsSignedOff(true);
    if (typeof details?.markdownDoc === 'string' && details.markdownDoc.trim()) {
      setMarkdownDoc(details.markdownDoc);
    }
    setAnalysis((prev) =>
      prev
        ? ({
            ...prev,
            isSignedOff: true,
            ...(committedArchiveId ? { archiveId: committedArchiveId } : {}),
            ...(Array.isArray(details?.reagents) ? { reagents: details.reagents } : {}),
            ...(Array.isArray(details?.labelTranscriptions)
              ? { labelTranscriptions: details.labelTranscriptions }
              : {}),
            ...(Array.isArray(details?.workSteps) ? { workSteps: details.workSteps } : {}),
            ...(typeof details?.markdownDoc === 'string'
              ? { markdownDoc: details.markdownDoc }
              : {}),
          } as VideoAnalysisDoc)
        : prev
    );
    if (committedArchiveId) {
      setSelectedArchiveId(committedArchiveId);
    }
    setSignOffVersion((v) => v + 1);
    showToast('success', res.message);
  };

  const handleUndoSignOff = async () => {
    if (!activeVideoId) return;
    try {
      await apiService.undoVideoCommit(activeVideoId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      setIsSignedOff(false);
      setSignOffVersion((v) => v + 1);
      setAnalysis((prev) => (prev ? { ...prev, isSignedOff: false, signedOffAt: undefined } : prev));
      showToast('success', 'Sign-off undone. Experiment notes can now be modified and re-committed.');
    } catch (err: any) {
      showToast('error', `Failed to undo sign-off: ${err?.message || 'Unknown error'}`);
    }
  };

  // Parse row and col for BoxGridView with safe fallback
  const targetCoordStr = editedInventoryData?.targetCoordinate || 'C4';
  const targetMatch = targetCoordStr.match(/^([A-Z])(\d+)$/);
  const targetRow = targetMatch ? targetMatch[1] : 'C';
  const targetCol = targetMatch ? parseInt(targetMatch[2], 10) : 4;

  const rawCoordStr = rawAiInventoryData?.targetCoordinate || 'C4';
  const rawMatch = rawCoordStr.match(/^([A-Z])(\d+)$/);
  const rawTargetRow = rawMatch ? rawMatch[1] : 'C';
  const rawTargetCol = rawMatch ? parseInt(rawMatch[2], 10) : 4;

  const safeActions = analysis?.actions ?? [];
  const safeEvents = analysis?.events ?? [];
  const safeRefinements = analysis?.refinements ?? [];
  const selectedAction =
    safeActions.find((a) => a.actionId === selectedActionId) ?? safeActions[0];

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
    } catch (err) {
      showToast('error', 'Failed to sign out');
    }
  };

  if (!user) {
    return <Login theme={theme} onToggleTheme={handleToggleTheme} />;
  }

  return (
    <div
      data-theme={theme}
      className={`${theme} min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-white transition-colors duration-200`}
    >
      {/* Navigation Ribbon Shell */}
      <RibbonNav
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        tenant={tenant}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onUpdateTenant={(updated) => {
          setTenant((prev) => ({ ...prev, ...updated }));
          apiService.setTenant(updated);
          showToast('success', 'Tenant context updated');
        }}
        isSignedOff={isSignedOff}
        onUndoSignOff={handleUndoSignOff}
        onOpenSignOffModal={async () => {
          if (
            !analysis &&
            activeVideoId !== 'vid_cryo_demo_01' &&
            activeVideoId !== 'vid_archive_demo_02'
          ) {
            try {
              const fetchedDoc = await apiService.fetchVideoAnalysis(activeVideoId, {
                customerId: tenant.customerId,
                databaseId: tenant.databaseId,
              });
              applyAnalysisDocument(activeVideoId, fetchedDoc);
            } catch {
              // Proceed to open sign-off modal with current state
            }
          } else if (activeTab === 'archive' && (!analysis || analysis.videoId === 'vid_cryo_demo_01')) {
            applyAnalysisDocument('vid_archive_demo_02', SAMPLE_ARCHIVE_ANALYSIS, 'archive');
          }
          setIsSignOffModalOpen(true);
        }}
        videoTitle={activeVideoId}
        userEmail={user.email}
        organizationId={organizationId}
        userRole={userRole}
        onSignOut={handleSignOut}
        authControls={
          <div className="flex items-center gap-3 text-sm pl-2 border-l border-slate-800">
            <span className="px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">
              Org: <strong className={theme === 'light' ? 'text-black' : 'text-white'}>{organizationId || 'Loading...'}</strong>
            </span>
            <span className="text-slate-400">
              User: <strong className="text-slate-200">{user.email}</strong>
            </span>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-rose-950/80 text-slate-300 hover:text-rose-200 border border-slate-700 hover:border-rose-500/50 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        }
      />

      {/* Real-time Toast Notifications */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 duration-200">
          <div
            className={`flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-2xl border text-xs font-mono backdrop-blur-md ${
              toast.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-500/60 text-emerald-200'
                : toast.type === 'error'
                ? 'bg-rose-950/90 border-rose-500/60 text-rose-200'
                : 'bg-cyan-950/90 border-cyan-500/60 text-cyan-200'
            }`}
          >
            {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
            {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />}
            {toast.type === 'info' && <Info className="w-4 h-4 text-cyan-400 shrink-0" />}
            <span>{toast.text}</span>
          </div>
        </div>
      )}

      {/* Main Workspace Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        {/* Signed-off Lock Banner */}
        {isSignedOff && activeTab === 'archive' && (
          <div className="bg-emerald-950/70 border border-emerald-500/50 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-900 border border-emerald-600 text-emerald-300">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-sm font-bold text-emerald-200">
                  Certified Lab Sign-Off Complete (Record Locked)
                </h4>
                <p className="text-xs text-emerald-400 font-mono">
                  State committed atomically to Firestore. Modifications are now locked for audit compliance.
                </p>
              </div>
            </div>
            <span className="font-mono text-xs text-emerald-400 bg-emerald-900/60 px-3 py-1 rounded-lg border border-emerald-700/60">
              AUDIT CERTIFIED
            </span>
          </div>
        )}

        {/* View Mode Switching */}
        {activeTab === 'videos' ? (
          <VideoManager
            tenant={tenant}
            activeStreamId={activeVideoId}
            onSelectActiveStream={handleSelectActiveStream}
            onSelectVideoForReview={handleSelectVideoFromManager}
            onNavigateToInventory={handleNavigateToInventory}
            onNavigateToArchive={handleNavigateToArchive}
            onSeekVideo={handleTimelineSeek}
            currentTime={currentTime}
          />
        ) : !analysis ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 flex flex-col items-center justify-center text-center space-y-4 shadow-xl">
            <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            <div>
              <h3 className="text-sm font-bold text-slate-200 font-mono">
                Loading Multi-Pass Video Analysis Telemetry...
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Synchronizing Pass 0–3 perception tracks for {activeVideoId}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                applyAnalysisDocument('vid_cryo_demo_01', SAMPLE_INVENTORY_ANALYSIS, 'inventory')
              }
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors"
            >
              Load Sample Stream Data
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {activeTab === 'inventory' ? (
              <CryoInventory
                initialInventoryId={selectedInventoryId}
                activeStream={activeVideoId}
                tenant={tenant}
                analysis={analysis}
                selectedAction={selectedAction}
                events={safeEvents}
                refinements={safeRefinements}
                targetRow={targetRow}
                targetCol={targetCol}
                rawTargetRow={rawTargetRow}
                rawTargetCol={rawTargetCol}
                editedInventoryData={editedInventoryData}
                rawAiInventoryData={rawAiInventoryData}
                isSignedOff={isSignedOff}
                onSelectGridSlot={handleSelectGridSlot}
                onChangeField={(field, val) =>
                  setEditedInventoryData((prev) => ({ ...prev, [field]: val }))
                }
                onResetField={(field) =>
                  setEditedInventoryData((prev) => ({
                    ...prev,
                    [field]: rawAiInventoryData[field],
                  }))
                }
                onAnalysisLoaded={(loadedVideoId, doc) =>
                  applyAnalysisDocument(loadedVideoId, doc, 'inventory')
                }
                duration={duration}
                currentTime={currentTime}
                safeActions={safeActions}
                safeEvents={safeEvents}
                selectedActionId={selectedActionId}
                selectedEventId={selectedEventId}
                onSeek={handleTimelineSeek}
                onSelectAction={handleSelectAction}
                onSelectEvent={handleSelectEvent}
                onOpenSignOff={() => setIsSignOffModalOpen(true)}
                signOffVersion={signOffVersion}
              />
            ) : (
              <ExperimentArchive
                tenant={tenant}
                selectedArchiveId={
                  selectedArchiveId ||
                  (activeTab === 'archive' && derivedArchiveData.archiveId ? derivedArchiveData.archiveId : null)
                }
                onSelectArchiveId={setSelectedArchiveId}
                onSeekVideo={handleTimelineSeek}
                signOffVersion={signOffVersion}
                activeAnalysis={analysis}
                isSignedOff={isSignedOff}
                onUndoSignOff={handleUndoSignOff}
                onOpenSignOffModal={() => setIsSignOffModalOpen(true)}
              />
            )}
          </div>
        )}
      </main>

      {/* Atomic HITL Sign-Off Modal */}
      <SignOffModal
        isOpen={isSignOffModalOpen}
        onClose={() => {
          setIsSignOffModalOpen(false);
          if (signOffReturnTab) {
            setActiveTab(signOffReturnTab);
            setSignOffReturnTab(null);
          }
        }}
        workflowType={
          activeTab === 'archive' ||
          analysis?.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
          analysis?.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
            ? 'EXPERIMENT_NOTEBOOK_WORKFLOW'
            : 'INVENTORY_UPDATE_WORKFLOW'
        }
        tenant={tenant}
        videoId={activeVideoId}
        inventoryId={
          analysis?.actions?.[0]?.inventoryId ||
          analysis?.workflowClassification?.inventoryName ||
          'tank_alpha_01'
        }
        archiveId={
          selectedArchiveId ||
          (analysis as any)?.archiveId ||
          derivedArchiveData.archiveId ||
          analysis?.actions?.[0]?.archiveId ||
          analysis?.workflowClassification?.archiveName ||
          'archive_exp_402'
        }
        rawAiInventoryData={rawAiInventoryData}
        editedInventoryData={editedInventoryData}
        onChangeInventoryField={(field, val) =>
          setEditedInventoryData((prev) => ({ ...prev, [field]: val }))
        }
        inventoryActions={safeActions}
        markdownDoc={
          activeTab === 'archive' ||
          analysis?.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
          analysis?.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
            ? (derivedArchiveData.markdownDoc || markdownDoc)
            : markdownDoc
        }
        archiveName={derivedArchiveData.archiveName}
        creatorName={derivedArchiveData.creatorName}
        creationDate={derivedArchiveData.creationDate}
        purpose={derivedArchiveData.purpose}
        reagents={derivedArchiveData.reagents}
        labelTranscriptions={derivedArchiveData.labelTranscriptions}
        workSteps={derivedArchiveData.workSteps}
        onCommitSuccess={handleSignOffSuccess}
      />
    </div>
  );
};

export default App;
