import React, { useState, useEffect } from 'react';
import { RibbonNav, WorkflowTab } from './components/layout/RibbonNav';
import { VideoPlayer } from './components/timeline/VideoPlayer';
import { TimelineViewer } from './components/timeline/TimelineViewer';
import { BoxGridView } from './components/inventory/BoxGridView';
import { VialInspector, HumanEditedVialData } from './components/inventory/VialInspector';
import { CryoInventory } from './components/inventory/CryoInventory';
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
} from './services/api.service';
import type { VideoAnalysisDoc, VideoRecord } from '@sail/shared';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { CheckCircle2, AlertCircle, Info, Lock, Loader2, LogOut } from 'lucide-react';
import { auth } from './firebase';
import { Login } from './components/Login';

function deriveInventoryDataFromAnalysis(doc: VideoAnalysisDoc | null): HumanEditedVialData {
  const firstAction = doc?.actions?.[0];
  const spatialRef = doc?.refinements?.find(
    (r) => r.spatialResult?.row && r.spatialResult?.col !== undefined
  );
  const row = (firstAction?.boxRowId || spatialRef?.spatialResult?.row || 'C').toUpperCase();
  const col = Number(firstAction?.boxColId ?? spatialRef?.spatialResult?.col ?? 4);
  const cellLineInfo = (firstAction?.cellLineInfo || {}) as Record<string, any>;

  return {
    cellLineName: firstAction?.cellLineName || 'HEK293T',
    lotNumber: String(cellLineInfo.lotNumber || cellLineInfo.lot || 'LOT-8841'),
    passage: typeof cellLineInfo.passage === 'number' ? cellLineInfo.passage : 5,
    operatorInitials: String(cellLineInfo.operatorInitials || cellLineInfo.operator || 'RS'),
    targetCoordinate: String(cellLineInfo.targetCoordinate || `${row}${col}`),
  };
}

export const App: React.FC = () => {
  // Authentication state gated via Firebase Auth
  const [user, setUser] = useState<User | null>(auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<WorkflowTab>('inventory');

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

  // Sign-Off & Lock State
  const [isSignedOff, setIsSignedOff] = useState<boolean>(false);
  const [isSignOffModalOpen, setIsSignOffModalOpen] = useState<boolean>(false);
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
    const resolvedTab: WorkflowTab =
      targetTab === 'hitl'
        ? analysisDoc?.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
          analysisDoc?.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
          videoId.toLowerCase().includes('archive')
          ? 'archive'
          : 'inventory'
        : targetTab;

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

  // Handle seeking from timeline
  const handleTimelineSeek = (time: number) => {
    setCurrentTime(time);
    setSeekTarget(time);
  };

  // Handle selecting action from timeline
  const handleSelectAction = (actionId: string) => {
    setSelectedActionId(actionId);
    const actionsList = analysis?.actions ?? [];
    const action = actionsList.find((a) => a.actionId === actionId);
    if (action) {
      if (action.boxRowId && action.boxColId) {
        setEditedInventoryData((prev) => ({
          ...prev,
          targetCoordinate: `${action.boxRowId}${action.boxColId}`,
        }));
      }
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
    setIsSignedOff(true);
    setAnalysis((prev) => (prev ? { ...prev, isSignedOff: true } : prev));
    showToast('success', res.message);
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
    return <Login />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500 selection:text-white">
      {/* Navigation Ribbon Shell */}
      <RibbonNav
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        tenant={tenant}
        onUpdateTenant={(updated) => {
          setTenant((prev) => ({ ...prev, ...updated }));
          apiService.setTenant(updated);
          showToast('success', 'Tenant context updated');
        }}
        isSignedOff={isSignedOff}
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
          }
          setIsSignOffModalOpen(true);
        }}
        videoTitle={activeVideoId}
        userEmail={user.email}
        onSignOut={handleSignOut}
        authControls={
          <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
            <span className="text-xs font-mono text-slate-300 bg-slate-800/60 border border-slate-700/60 px-2.5 py-1.5 rounded-lg">
              {user.email}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
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
        {isSignedOff && (
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
            {/* Top Workspace: Synchronized Video & Timeline Scrubber */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* HTML5 Programmatic Video Player */}
              <div className="lg:col-span-5">
                <VideoPlayer
                  currentTime={currentTime}
                  duration={duration}
                  isPlaying={isPlaying}
                  onTimeUpdate={setCurrentTime}
                  onDurationChange={setDuration}
                  onPlayPause={setIsPlaying}
                  seekTarget={seekTarget}
                  onSeekHandled={() => setSeekTarget(null)}
                />
              </div>

              {/* Synchronized Recharts Audio Waveform & Multi-Track Timeline */}
              <div className="lg:col-span-7">
                <TimelineViewer
                  duration={duration}
                  currentTime={currentTime}
                  actions={safeActions}
                  events={safeEvents}
                  selectedActionId={selectedActionId}
                  selectedEventId={selectedEventId}
                  onSeek={handleTimelineSeek}
                  onSelectAction={handleSelectAction}
                  onSelectEvent={handleSelectEvent}
                />
              </div>
            </div>

            {/* Bottom Workspace: Domain Specific Panels */}
            {activeTab === 'inventory' ? (
              <CryoInventory
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
              />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                {/* 96-Well Microplate View with 8-Channel Multichannel Pipette Confirmation */}
                <div className="lg:col-span-6">
                  <MicroplateView
                    seededColumns={seededColumns}
                    volumePerWellUls={100}
                    onToggleColumn={handleTogglePlateColumn}
                    readOnly={isSignedOff}
                  />
                </div>

                {/* ELN Markdown Editor & Reagent Acronym Resolver */}
                <div className="lg:col-span-6">
                  <NotebookEditor
                    markdownDoc={markdownDoc}
                    onChangeMarkdown={setMarkdownDoc}
                    reagentMappings={reagentMappings}
                    readOnly={isSignedOff}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Atomic HITL Sign-Off Modal */}
      <SignOffModal
        isOpen={isSignOffModalOpen}
        onClose={() => setIsSignOffModalOpen(false)}
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
          analysis?.actions?.[0]?.archiveId ||
          analysis?.workflowClassification?.archiveName ||
          'archive_exp_402'
        }
        rawAiInventoryData={rawAiInventoryData}
        editedInventoryData={editedInventoryData}
        markdownDoc={markdownDoc}
        onCommitSuccess={handleSignOffSuccess}
      />
    </div>
  );
};

export default App;
