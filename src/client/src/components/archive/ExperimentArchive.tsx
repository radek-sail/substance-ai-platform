import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BookOpen,
  FlaskConical,
  ListChecks,
  User,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Edit3,
  Save,
  Plus,
  Trash2,
  Eraser,
  Clock,
  Loader2,
  Pipette,
  Grid,
  Beaker,
  RotateCcw,
  FileCheck2,
} from 'lucide-react';
import {
  generateReagentAcronym,
  computeExpectedSeedingEvents,
  parseColumnNumbersFromText,
  resolveSeededColumnsAndWells,
  render96WellPlateMarkdown,
  areSameReagent,
  mergeReagentRecords,
  toActiveVoiceDescription,
  type ArchiveRecord,
  type ArchiveReagent,
  type ArchiveWorkStep,
  type CreateArchiveInput,
  type VideoAnalysisDoc,
} from '@sail/shared';
import {
  apiService,
  compileArchiveMarkdownFromAnalysis,
  deriveArchiveDataFromAnalysis,
  DEFAULT_TENANT_CONFIG,
  type TenantConfig,
} from '../../services/api.service';
import ArchiveSidebar from './ArchiveSidebar';

interface ExperimentArchiveProps {
  tenant?: TenantConfig;
  selectedArchiveId?: string | null;
  onSelectArchiveId?: (id: string | null) => void;
  onSeekVideo?: (seconds: number) => void;
  signOffVersion?: number;
  activeAnalysis?: VideoAnalysisDoc | null;
  isSignedOff?: boolean;
  onUndoSignOff?: () => void;
  onOpenSignOffModal?: () => void;
}

const formatTimestamp = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const normalizeNA = (val?: string | null): string => {
  if (!val || !val.trim()) return 'N/A';
  return val.trim();
};

export const ExperimentArchive: React.FC<ExperimentArchiveProps> = ({
  tenant,
  selectedArchiveId,
  onSelectArchiveId,
  onSeekVideo,
  signOffVersion,
  activeAnalysis,
  isSignedOff,
  onUndoSignOff,
  onOpenSignOffModal,
}) => {
  const activeTenant = tenant || DEFAULT_TENANT_CONFIG;
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [activeArchiveId, setActiveArchiveId] = useState<string | null>(selectedArchiveId || null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [isCommitting, setIsCommitting] = useState<boolean>(false);
  const [isErasing, setIsErasing] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [commitSuccess, setCommitSuccess] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const deletedArchiveIdsRef = useRef<Set<string>>(new Set());
  const erasedArchiveIdsRef = useRef<Set<string>>(new Set());

  // Editable state for HITL review / editing
  const [editName, setEditName] = useState<string>('');
  const [editCreationDate, setEditCreationDate] = useState<string>('');
  const [editCreatorName, setEditCreatorName] = useState<string>('');
  const [editReagents, setEditReagents] = useState<ArchiveReagent[]>([]);
  const [editLabelTranscriptions, setEditLabelTranscriptions] = useState<string[]>([]);
  const [editWorkSteps, setEditWorkSteps] = useState<ArchiveWorkStep[]>([]);

  const loadArchives = useCallback(async () => {
    setIsLoading(true);
    try {
      let list = await apiService.fetchArchives({
        customerId: activeTenant.customerId,
        databaseId: activeTenant.databaseId,
      });

      list = list.filter((a) => !deletedArchiveIdsRef.current.has(a.id));
      for (const a of list) {
        if (
          !a.contentErased &&
          ((Array.isArray(a.reagents) && a.reagents.length > 0) ||
            (Array.isArray(a.workSteps) && a.workSteps.length > 0) ||
            Boolean((a as any).isSignedOff))
        ) {
          erasedArchiveIdsRef.current.delete(a.id);
        }
      }

      const isArchiveWorkflowAnalysis = Boolean(
        activeAnalysis &&
          (activeAnalysis.workflowClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
            activeAnalysis.workloadClassification?.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ||
            Boolean((activeAnalysis as any).archiveId) ||
            (Array.isArray(activeAnalysis.reagents) && activeAnalysis.reagents.length > 0) ||
            (Array.isArray(activeAnalysis.workSteps) && activeAnalysis.workSteps.length > 0))
      );

      const isDemoAnalysis =
        activeAnalysis?.videoId === 'vid_archive_demo_02' ||
        activeAnalysis?.videoId === 'vid_archive_demo_01';

      // If activeAnalysis is an archive workflow, guarantee that its derived archive is included/merged in list
      if (
        activeAnalysis &&
        isArchiveWorkflowAnalysis &&
        (!isDemoAnalysis ||
          Boolean(activeAnalysis.isSignedOff) ||
          (list.length === 0 && deletedArchiveIdsRef.current.size === 0))
      ) {
        const derived = deriveArchiveDataFromAnalysis(activeAnalysis);
        if (!deletedArchiveIdsRef.current.has(derived.archiveId)) {
          const existingIdx = list.findIndex(
            (a) =>
              a.id === derived.archiveId ||
              (activeAnalysis.videoId &&
                Array.isArray(a.videoIds) &&
                a.videoIds.includes(activeAnalysis.videoId)) ||
              (a.name &&
                derived.archiveName &&
                a.name.trim().toLowerCase() === derived.archiveName.trim().toLowerCase())
          );

          const synthetic: ArchiveRecord = {
            id: derived.archiveId,
            name: derived.archiveName,
            creationDate: derived.creationDate,
            creatorName: derived.creatorName,
            markdownDoc: derived.markdownDoc,
            videoIds: activeAnalysis.videoId ? [activeAnalysis.videoId] : [],
            reagents: derived.reagents,
            labelTranscriptions: derived.labelTranscriptions,
            workSteps: (derived.workSteps || []).map((ws) => ({
              ...ws,
              videoId: ws.videoId || activeAnalysis.videoId,
            })),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          if (existingIdx >= 0) {
            const existing = list[existingIdx];
            const isErased =
              Boolean(existing.contentErased) || erasedArchiveIdsRef.current.has(existing.id);

            if (!isErased) {
              const existingReagents = Array.isArray(existing.reagents) ? existing.reagents : [];
              const mergedReagents: ArchiveReagent[] = [...existingReagents];
              if (!activeAnalysis.isSignedOff || existingReagents.length === 0) {
                for (const inc of synthetic.reagents || []) {
                  const mIdx = mergedReagents.findIndex((ex) => areSameReagent(ex, inc));
                  if (mIdx >= 0) {
                    mergedReagents[mIdx] = mergeReagentRecords(mergedReagents[mIdx], inc);
                  } else {
                    mergedReagents.push(inc);
                  }
                }
              }

              const existingTranscriptions = Array.isArray(existing.labelTranscriptions)
                ? existing.labelTranscriptions
                : [];
              const mergedTranscriptions =
                !activeAnalysis.isSignedOff || existingTranscriptions.length === 0
                  ? Array.from(
                      new Set([...existingTranscriptions, ...(synthetic.labelTranscriptions || [])])
                    )
                  : existingTranscriptions;

              const existingWorkSteps = Array.isArray(existing.workSteps) ? existing.workSteps : [];
              let mergedWorkSteps: ArchiveWorkStep[] = existingWorkSteps;
              if (existingWorkSteps.length === 0) {
                mergedWorkSteps = synthetic.workSteps || [];
              } else if (!activeAnalysis.isSignedOff && (synthetic.workSteps || []).length > 0) {
                const fallbackVid =
                  existing.videoIds?.find((id) => id !== activeAnalysis.videoId) || '__initial__';
                const normalizedExistingSteps = existingWorkSteps.map((ws) => ({
                  ...ws,
                  videoId: ws.videoId || fallbackVid,
                }));
                const otherSteps = normalizedExistingSteps.filter(
                  (ws) => ws.videoId !== activeAnalysis.videoId
                );
                mergedWorkSteps = [...otherSteps, ...(synthetic.workSteps || [])].map((ws, idx) => ({
                  ...ws,
                  stepNumber: idx + 1,
                }));
              }

              const existingVideoIds = Array.isArray(existing.videoIds) ? existing.videoIds : [];
              const mergedVideoIds =
                activeAnalysis.videoId && !existingVideoIds.includes(activeAnalysis.videoId)
                  ? [...existingVideoIds, activeAnalysis.videoId]
                  : existingVideoIds;

              list[existingIdx] = {
                ...existing,
                name: existing.name || synthetic.name,
                creationDate: existing.creationDate || synthetic.creationDate,
                creatorName: existing.creatorName || synthetic.creatorName,
                videoIds: mergedVideoIds,
                reagents: mergedReagents,
                labelTranscriptions: mergedTranscriptions,
                workSteps: mergedWorkSteps,
                markdownDoc: existing.markdownDoc || synthetic.markdownDoc,
              };
            }
          } else {
            const isSyntheticErased = erasedArchiveIdsRef.current.has(synthetic.id);
            list = [
              isSyntheticErased
                ? {
                    ...synthetic,
                    reagents: [],
                    labelTranscriptions: [],
                    workSteps: [],
                    videoIds: [],
                    contentErased: true,
                  }
                : synthetic,
              ...list,
            ];
          }
        }
      }

      setArchives(list);
      setActiveArchiveId((prev) => {
        if (selectedArchiveId && list.some((a) => a.id === selectedArchiveId)) {
          return selectedArchiveId;
        }
        if (activeAnalysis && isArchiveWorkflowAnalysis && !isDemoAnalysis) {
          const derived = deriveArchiveDataFromAnalysis(activeAnalysis);
          const matched = list.find(
            (a) =>
              a.id === derived.archiveId ||
              (activeAnalysis.videoId &&
                Array.isArray(a.videoIds) &&
                a.videoIds.includes(activeAnalysis.videoId)) ||
              (a.name &&
                derived.archiveName &&
                a.name.trim().toLowerCase() === derived.archiveName.trim().toLowerCase())
          );
          if (matched) {
            return matched.id;
          }
        }
        if (prev && list.some((a) => a.id === prev)) {
          return prev;
        }
        return list[0]?.id || null;
      });
    } finally {
      setIsLoading(false);
    }
  }, [activeTenant.customerId, activeTenant.databaseId, selectedArchiveId, activeAnalysis]);

  useEffect(() => {
    loadArchives();
  }, [loadArchives, signOffVersion]);

  useEffect(() => {
    if (selectedArchiveId && !deletedArchiveIdsRef.current.has(selectedArchiveId)) {
      setActiveArchiveId(selectedArchiveId);
    }
  }, [selectedArchiveId]);

  const rawActiveArchive = archives.find((a) => a.id === activeArchiveId) || archives[0] || null;
  const isErasedArchive = Boolean(
    rawActiveArchive &&
      (rawActiveArchive.contentErased || erasedArchiveIdsRef.current.has(rawActiveArchive.id))
  );
  const activeArchive = rawActiveArchive
    ? {
        ...rawActiveArchive,
        name: rawActiveArchive.name || 'Experiment Archive',
        creationDate: rawActiveArchive.creationDate || 'N/A',
        creatorName: rawActiveArchive.creatorName || 'N/A',
        reagents: isErasedArchive ? [] : rawActiveArchive.reagents || [],
        labelTranscriptions: isErasedArchive ? [] : rawActiveArchive.labelTranscriptions || [],
        workSteps: isErasedArchive
          ? []
          : (rawActiveArchive.workSteps || []).map((ws) => ({
              ...ws,
              description: ws.description ? toActiveVoiceDescription(ws.description) : ws.description,
            })),
      }
    : null;

  // Sync editable state whenever activeArchive changes and not editing
  useEffect(() => {
    if (!activeArchive || isEditing) return;
    setEditName(activeArchive.name || '');
    setEditCreationDate(
      activeArchive.creationDate ||
        (activeArchive.createdAt ? activeArchive.createdAt.split('T')[0] : 'N/A')
    );
    setEditCreatorName(activeArchive.creatorName || 'N/A');
    setEditReagents(
      (activeArchive.reagents || []).map((r) => ({
        reagentName: normalizeNA(r.reagentName),
        reagentAcronym:
          r.reagentAcronym && r.reagentAcronym !== 'N/A'
            ? r.reagentAcronym
            : generateReagentAcronym(r.reagentName || ''),
        manufacturer: normalizeNA(r.manufacturer),
        catalogNumber: normalizeNA(r.catalogNumber),
        lotNumber: normalizeNA(r.lotNumber),
      }))
    );
    setEditLabelTranscriptions([...(activeArchive.labelTranscriptions || [])]);
    setEditWorkSteps([...(activeArchive.workSteps || [])]);
  }, [activeArchive, isEditing]);

  const handleSelectArchive = (id: string) => {
    setIsEditing(false);
    setCommitSuccess(null);
    setCommitError(null);
    setActiveArchiveId(id);
    onSelectArchiveId?.(id);
  };

  const handleCreateArchive = async (payload: CreateArchiveInput) => {
    const created = await apiService.createArchive(payload, {
      customerId: activeTenant.customerId,
      databaseId: activeTenant.databaseId,
    });
    deletedArchiveIdsRef.current.delete(created.id);
    erasedArchiveIdsRef.current.delete(created.id);
    setArchives((prev) => [...prev, created]);
    setActiveArchiveId(created.id);
    onSelectArchiveId?.(created.id);
  };

  const handleEraseArchiveContent = async (archiveId: string) => {
    const targetArchive = archives.find((a) => a.id === archiveId);
    if (!targetArchive) return;

    setIsErasing(true);
    setCommitError(null);
    setCommitSuccess(null);
    erasedArchiveIdsRef.current.add(archiveId);

    const nowIso = new Date().toISOString();
    const defaultMarkdownHeader = [
      `# ${targetArchive.name || archiveId}`,
      '',
      ...(targetArchive.creatorName ? [`- **Creator**: ${targetArchive.creatorName}`] : []),
      ...(targetArchive.creationDate ? [`- **Creation Date**: ${targetArchive.creationDate}`] : []),
      '',
      '## Experiment Log',
      '',
    ].join('\n');

    setArchives((prev) =>
      prev.map((a) =>
        a.id === archiveId
          ? {
              ...a,
              reagents: [],
              labelTranscriptions: [],
              workSteps: [],
              videoIds: [],
              markdownDoc: defaultMarkdownHeader,
              contentErased: true,
              updatedAt: nowIso,
            }
          : a
      )
    );

    if (activeArchive?.id === archiveId) {
      setEditReagents([]);
      setEditLabelTranscriptions([]);
      setEditWorkSteps([]);
      setIsEditing(false);
    }

    try {
      const updated = await apiService.emptyArchive(archiveId, {
        customerId: activeTenant.customerId,
        databaseId: activeTenant.databaseId,
        name: targetArchive.name,
        creatorName: targetArchive.creatorName,
        creationDate: targetArchive.creationDate,
      });
      if (updated) {
        setArchives((prev) =>
          prev.map((a) =>
            a.id === archiveId
              ? {
                  ...updated,
                  reagents: [],
                  labelTranscriptions: [],
                  workSteps: [],
                  videoIds: [],
                  contentErased: true,
                }
              : a
          )
        );
      }
      setCommitSuccess(`Erased notebook content for "${targetArchive.name}".`);
    } catch (err: any) {
      console.warn('[ExperimentArchive] emptyArchive API warning (local state cleared):', err);
      setCommitSuccess(`Erased notebook content for "${targetArchive.name}".`);
    } finally {
      setIsErasing(false);
    }
  };

  const handleDeleteArchive = async (archiveId: string) => {
    const targetArchive = archives.find((a) => a.id === archiveId);
    setIsDeleting(true);
    setCommitError(null);
    setCommitSuccess(null);
    deletedArchiveIdsRef.current.add(archiveId);
    erasedArchiveIdsRef.current.delete(archiveId);

    const remaining = archives.filter((a) => a.id !== archiveId);
    setArchives(remaining);

    if (activeArchiveId === archiveId || !remaining.some((a) => a.id === activeArchiveId)) {
      const nextId = remaining[0]?.id || null;
      setActiveArchiveId(nextId);
      onSelectArchiveId?.(nextId);
    }
    setIsEditing(false);

    try {
      await apiService.deleteArchive(archiveId, {
        customerId: activeTenant.customerId,
        databaseId: activeTenant.databaseId,
      });
    } catch (err: any) {
      console.warn(
        `[ExperimentArchive] deleteArchive API warning for "${targetArchive?.name || archiveId}":`,
        err
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleAddReagent = () => {
    setEditReagents((prev) => [
      ...prev,
      {
        reagentName: '',
        reagentAcronym: 'N/A',
        manufacturer: 'N/A',
        catalogNumber: 'N/A',
        lotNumber: 'N/A',
      },
    ]);
  };

  const handleUpdateReagent = (
    idx: number,
    field: keyof ArchiveReagent,
    value: string
  ) => {
    setEditReagents((prev) =>
      prev.map((item, i) => {
        if (i !== idx) return item;
        const updated = { ...item, [field]: value };
        if (field === 'reagentName') {
          updated.reagentAcronym = generateReagentAcronym(value);
        }
        return updated;
      })
    );
  };

  const handleRemoveReagent = (idx: number) => {
    setEditReagents((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddMixStep = () => {
    setEditWorkSteps((prev) => [
      ...prev,
      {
        stepId: `step-mix-${Date.now()}`,
        actionType: 'MIX_REAGENTS',
        startTimeSeconds: 0,
        endTimeSeconds: 10,
        description: 'Mixing two reagents',
        mixReagentsData: {
          firstReagentName: 'N/A',
          firstReagentAmount: 'N/A',
          secondReagentName: 'N/A',
          secondReagentAmount: 'N/A',
        },
      },
    ]);
  };

  const handleAddSeedStep = () => {
    setEditWorkSteps((prev) => [
      ...prev,
      {
        stepId: `step-seed-${Date.now()}`,
        actionType: 'SEED_REAGENTS',
        startTimeSeconds: 10,
        endTimeSeconds: 30,
        description: 'Seeding cells into plate',
        seedReagentsData: {
          plateType: '96-well plate',
          pipetteType: '8-channel pipette',
          cellsSeeded: 'N/A',
          cellsPerWell: 'N/A',
          seedingEventsCount: 12,
          expectedSeedingEventsCount: 12,
          isSeedingCountCorrect: true,
        },
      },
    ]);
  };

  const handleRemoveWorkStep = (idx: number) => {
    setEditWorkSteps((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCommitChanges = async () => {
    if (!activeArchive) return;
    setIsCommitting(true);
    setCommitError(null);
    setCommitSuccess(null);

    try {
      const normalizedReagents: ArchiveReagent[] = editReagents.map((r) => ({
        reagentName: normalizeNA(r.reagentName),
        reagentAcronym:
          r.reagentAcronym && r.reagentAcronym.trim() && r.reagentAcronym !== 'N/A'
            ? r.reagentAcronym.trim()
            : generateReagentAcronym(r.reagentName),
        manufacturer: normalizeNA(r.manufacturer),
        catalogNumber: normalizeNA(r.catalogNumber),
        lotNumber: normalizeNA(r.lotNumber),
      }));

      const normalizedSteps: ArchiveWorkStep[] = editWorkSteps.map((step) => {
        if (step.actionType === 'SEED_REAGENTS' && step.seedReagentsData) {
          const expected =
            computeExpectedSeedingEvents(
              step.seedReagentsData.plateType,
              step.seedReagentsData.pipetteType
            ) ?? step.seedReagentsData.expectedSeedingEventsCount;
          const isCorrect =
            expected !== undefined
              ? step.seedReagentsData.seedingEventsCount === expected
              : step.seedReagentsData.isSeedingCountCorrect;
          return {
            ...step,
            seedReagentsData: {
              ...step.seedReagentsData,
              expectedSeedingEventsCount: expected,
              isSeedingCountCorrect: isCorrect,
            },
          };
        }
        return step;
      });

      const cleanedTranscriptions = editLabelTranscriptions
        .map((t) => t.trim())
        .filter(Boolean);

      const markdownDoc = compileArchiveMarkdownFromAnalysis({
        videoId: activeArchive.id,
        workflowClassification: {
          workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
          transcribedAudio: `Experiment Archive: ${editName.trim() || activeArchive.name}`,
          archiveName: editName.trim() || activeArchive.name,
        },
        reagents: normalizedReagents,
        workSteps: normalizedSteps,
        actions: [],
        events: [],
        refinements: [],
        updatedAt: new Date().toISOString(),
      } as Record<string, any>);

      await apiService.commitArchiveSignOff(
        activeTenant.databaseId,
        activeArchive.id,
        activeArchive.id,
        markdownDoc,
        {
          archiveName: editName.trim() || activeArchive.name,
          creatorName: editCreatorName.trim() || 'N/A',
          creationDate: editCreationDate.trim() || 'N/A',
          reagents: normalizedReagents,
          labelTranscriptions: cleanedTranscriptions,
          workSteps: normalizedSteps,
          replaceArchiveContent: true,
        }
      );

      erasedArchiveIdsRef.current.delete(activeArchive.id);

      const updatedRecord: ArchiveRecord = {
        ...activeArchive,
        name: editName.trim() || activeArchive.name,
        creatorName: editCreatorName.trim() || 'N/A',
        creationDate: editCreationDate.trim() || 'N/A',
        reagents: normalizedReagents,
        labelTranscriptions: cleanedTranscriptions,
        workSteps: normalizedSteps,
        markdownDoc,
        contentErased: false,
        updatedAt: new Date().toISOString(),
      };

      setArchives((prev) =>
        prev.map((a) => (a.id === updatedRecord.id ? updatedRecord : a))
      );
      setIsEditing(false);
      setCommitSuccess('Archive Notebook sections committed to database.');
    } catch (err: any) {
      setCommitError(err?.message || 'Failed to commit archive notebook changes');
    } finally {
      setIsCommitting(false);
    }
  };

  const displayReagents = isEditing
    ? editReagents
    : (activeArchive?.reagents || []).map((r) => ({
        reagentName: normalizeNA(r.reagentName),
        reagentAcronym:
          r.reagentAcronym && r.reagentAcronym !== 'N/A'
            ? r.reagentAcronym
            : generateReagentAcronym(r.reagentName || ''),
        manufacturer: normalizeNA(r.manufacturer),
        catalogNumber: normalizeNA(r.catalogNumber),
        lotNumber: normalizeNA(r.lotNumber),
      }));

  const displayWorkSteps = isEditing
    ? editWorkSteps
    : activeArchive?.workSteps || [];

  return (
    <div
      data-testid="experiment-archive-view"
      className="flex flex-col lg:flex-row gap-6 items-start"
    >
      {/* Left Sidebar: List of Experiment Archives */}
      <div className="w-full lg:w-72 shrink-0">
        <ArchiveSidebar
          archives={archives}
          activeArchiveId={activeArchive?.id || null}
          isLoading={isLoading}
          onSelectArchive={handleSelectArchive}
          onCreateArchive={handleCreateArchive}
          onEmptyArchive={handleEraseArchiveContent}
          onDeleteArchive={handleDeleteArchive}
        />
      </div>

      {/* Right Main Area: Structured Archive Notebook (3 Main Sections) */}
      <div className="flex-1 w-full space-y-6">
        {!activeArchive ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
            <BookOpen className="w-8 h-8 text-indigo-400 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-200">
              No Experiment Archive Selected
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Select an archive on the left or create a new archive to view its Experiment Notebook.
            </p>
          </div>
        ) : (
          <div
            data-testid="archive-notebook-document"
            className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6"
          >
            {/* Top Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-950 border border-indigo-800 text-indigo-400">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-slate-100 font-mono">
                      Archive Notebook
                    </h2>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800">
                      EXPERIMENT_NOTEBOOK_WORKFLOW
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Compiled from multi-pass video & audio analysis (Pass 1 Actions · Pass 2 Events · Pass 3 OCR & Conflation)
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!isEditing ? (
                  <>
                    {isSignedOff || Boolean((activeArchive as any)?.isSignedOff) ? (
                      <div className="flex items-center gap-2">
                        <div
                          data-testid="archive-signed-off-badge"
                          className="flex items-center gap-1.5 bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm shadow-emerald-950"
                        >
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <span>Signed Off</span>
                        </div>
                        {onUndoSignOff && (
                          <button
                            type="button"
                            onClick={onUndoSignOff}
                            data-testid="ribbon-undo-signoff-btn"
                            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-slate-100 border border-slate-700 hover:border-slate-600 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors shadow-sm"
                            title="Re-open experiment notes for editing and re-committing"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-cyan-400" />
                            <span>Undo Sign-Off</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      onOpenSignOffModal && (
                        <button
                          type="button"
                          onClick={onOpenSignOffModal}
                          data-testid="archive-review-signoff-btn"
                          className="flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-md shadow-orange-500/20 active:scale-95 transition-all"
                        >
                          <FileCheck2 className="w-4 h-4" />
                          <span>Review & Sign Off</span>
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      data-testid="erase-archive-notebook-btn"
                      disabled={isErasing || isDeleting}
                      onClick={() => handleEraseArchiveContent(activeArchive.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-950/70 hover:bg-amber-900/80 text-amber-200 border border-amber-700/60 text-xs font-semibold transition-colors disabled:opacity-50"
                      title="Erase all reagents, label transcriptions, and work steps in this archive notebook"
                    >
                      {isErasing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
                      ) : (
                        <Eraser className="w-3.5 h-3.5 text-amber-400" />
                      )}
                      <span>{isErasing ? 'Erasing...' : 'Erase Content'}</span>
                    </button>
                    <button
                      type="button"
                      data-testid="delete-archive-btn"
                      disabled={isDeleting || isErasing}
                      onClick={() => handleDeleteArchive(activeArchive.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-950/70 hover:bg-rose-900/80 text-rose-200 border border-rose-700/60 text-xs font-semibold transition-colors disabled:opacity-50"
                      title="Delete this archive from the database"
                    >
                      {isDeleting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                      )}
                      <span>{isDeleting ? 'Deleting...' : 'Delete Archive'}</span>
                    </button>
                    <button
                      type="button"
                      data-testid="edit-archive-notebook-btn"
                      onClick={() => {
                        setCommitSuccess(null);
                        setCommitError(null);
                        setIsEditing(true);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition-colors"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-indigo-400" />
                      <span>HITL Review / Edit</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsEditing(false)}
                      className="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-semibold text-slate-300 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="commit-archive-notebook-btn"
                      disabled={isCommitting}
                      onClick={handleCommitChanges}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 shadow-sm"
                    >
                      {isCommitting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      <span>{isCommitting ? 'Committing...' : 'Commit to Database'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {commitSuccess && (
              <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/40 text-emerald-200 text-xs font-mono flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{commitSuccess}</span>
              </div>
            )}

            {commitError && (
              <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-200 text-xs font-mono flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{commitError}</span>
              </div>
            )}

            {/* ===================================================================== */}
            {/* SECTION 1: Experiment Notebook Identification                         */}
            {/* ===================================================================== */}
            <section
              data-testid="section-experiment-identification"
              className="bg-slate-950/70 border border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 text-xs font-mono font-bold">
                    Section 1
                  </span>
                  <h3 className="text-sm font-bold text-slate-100 font-mono">
                    Experiment Notebook Identification
                  </h3>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-900/90 border border-slate-800/90 rounded-xl p-3.5">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 block mb-1">
                    Archive Name
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
                    />
                  ) : (
                    <div
                      data-testid="identification-archive-name"
                      className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2"
                    >
                      <BookOpen className="w-4 h-4 text-indigo-400 shrink-0" />
                      <span>{activeArchive.name || 'N/A'}</span>
                    </div>
                  )}
                </div>

                <div className="bg-slate-900/90 border border-slate-800/90 rounded-xl p-3.5">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 block mb-1">
                    Date Created On
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={editCreationDate}
                      onChange={(e) => setEditCreationDate(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
                    />
                  ) : (
                    <div
                      data-testid="identification-creation-date"
                      className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2"
                    >
                      <Calendar className="w-4 h-4 text-cyan-400 shrink-0" />
                      <span>
                        {activeArchive.creationDate ||
                          (activeArchive.createdAt
                            ? activeArchive.createdAt.split('T')[0]
                            : 'N/A')}
                      </span>
                    </div>
                  )}
                </div>

                <div className="bg-slate-900/90 border border-slate-800/90 rounded-xl p-3.5">
                  <span className="text-[11px] font-mono uppercase tracking-wider text-slate-400 block mb-1">
                    Archive Owner
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={editCreatorName}
                      onChange={(e) => setEditCreatorName(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
                    />
                  ) : (
                    <div
                      data-testid="identification-archive-owner"
                      className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2"
                    >
                      <User className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{activeArchive.creatorName || 'N/A'}</span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* ===================================================================== */}
            {/* SECTION 2: Reagents & Label Transcriptions                            */}
            {/* ===================================================================== */}
            <section
              data-testid="section-reagents"
              className="bg-slate-950/70 border border-slate-800 rounded-xl p-5 space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 text-xs font-mono font-bold">
                    Section 2
                  </span>
                  <FlaskConical className="w-4 h-4 text-cyan-400" />
                  <h3 className="text-sm font-bold text-slate-100 font-mono">
                    Reagents
                  </h3>
                </div>
                {isEditing && (
                  <button
                    type="button"
                    onClick={handleAddReagent}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 text-xs font-mono font-semibold transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Reagent</span>
                  </button>
                )}
              </div>

              {/* Reagents Table */}
              <div className="overflow-x-auto border border-slate-800 rounded-xl">
                <table
                  data-testid="reagents-table"
                  className="w-full text-left border-collapse text-xs font-mono"
                >
                  <thead>
                    <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-300">
                      <th className="py-2.5 px-3 font-semibold">Reagent Name</th>
                      <th className="py-2.5 px-3 font-semibold">Reagent Acronym</th>
                      <th className="py-2.5 px-3 font-semibold">Manufacturer</th>
                      <th className="py-2.5 px-3 font-semibold">Catalog / Ref #</th>
                      <th className="py-2.5 px-3 font-semibold">Lot #</th>
                      {isEditing && <th className="py-2.5 px-3 font-semibold w-12"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {displayReagents.length === 0 ? (
                      <tr>
                        <td
                          colSpan={isEditing ? 6 : 5}
                          className="py-4 px-3 text-center text-slate-400"
                        >
                          No reagents recorded yet.
                        </td>
                      </tr>
                    ) : (
                      displayReagents.map((reagent, idx) => (
                        <tr
                          key={`${reagent.reagentName}-${idx}`}
                          data-testid={`reagent-row-${idx}`}
                          className="bg-slate-950/40 hover:bg-slate-900/50 transition-colors"
                        >
                          <td className="py-2.5 px-3 text-slate-100 font-semibold">
                            {isEditing ? (
                              <input
                                type="text"
                                value={reagent.reagentName}
                                placeholder="e.g. Fetal Bovine Serum"
                                onChange={(e) =>
                                  handleUpdateReagent(idx, 'reagentName', e.target.value)
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-100"
                              />
                            ) : (
                              normalizeNA(reagent.reagentName)
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            {isEditing ? (
                              <input
                                type="text"
                                value={reagent.reagentAcronym}
                                placeholder="e.g. FBS"
                                onChange={(e) =>
                                  handleUpdateReagent(idx, 'reagentAcronym', e.target.value)
                                }
                                className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-cyan-300 font-bold"
                              />
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-800/80 font-bold">
                                {normalizeNA(reagent.reagentAcronym)}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">
                            {isEditing ? (
                              <input
                                type="text"
                                value={reagent.manufacturer}
                                placeholder="N/A"
                                onChange={(e) =>
                                  handleUpdateReagent(idx, 'manufacturer', e.target.value)
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                              />
                            ) : (
                              <span
                                className={
                                  normalizeNA(reagent.manufacturer) === 'N/A'
                                    ? 'text-slate-500 italic'
                                    : 'text-slate-200'
                                }
                              >
                                {normalizeNA(reagent.manufacturer)}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">
                            {isEditing ? (
                              <input
                                type="text"
                                value={reagent.catalogNumber}
                                placeholder="N/A"
                                onChange={(e) =>
                                  handleUpdateReagent(idx, 'catalogNumber', e.target.value)
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                              />
                            ) : (
                              <span
                                className={
                                  normalizeNA(reagent.catalogNumber) === 'N/A'
                                    ? 'text-slate-500 italic'
                                    : 'text-slate-200'
                                }
                              >
                                {normalizeNA(reagent.catalogNumber)}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300">
                            {isEditing ? (
                              <input
                                type="text"
                                value={reagent.lotNumber}
                                placeholder="N/A"
                                onChange={(e) =>
                                  handleUpdateReagent(idx, 'lotNumber', e.target.value)
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                              />
                            ) : (
                              <span
                                className={
                                  normalizeNA(reagent.lotNumber) === 'N/A'
                                    ? 'text-slate-500 italic'
                                    : 'text-slate-200'
                                }
                              >
                                {normalizeNA(reagent.lotNumber)}
                              </span>
                            )}
                          </td>
                          {isEditing && (
                            <td className="py-2.5 px-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleRemoveReagent(idx)}
                                className="text-rose-400 hover:text-rose-300 p-1"
                                title="Remove Reagent"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ===================================================================== */}
            {/* SECTION 3: Procedure (Mix Reagents & Seed Reagents)                   */}
            {/* ===================================================================== */}
            <section
              data-testid="section-work-steps"
              className="bg-slate-950/70 border border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-mono font-bold">
                    Section 3
                  </span>
                  <ListChecks className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-sm font-bold text-slate-100 font-mono">
                    Procedure
                  </h3>
                </div>

                {isEditing && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAddMixStep}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-800 text-xs font-mono font-semibold transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Mix Reagents Step</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleAddSeedStep}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 text-xs font-mono font-semibold transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Seed Reagents Step</span>
                    </button>
                  </div>
                )}
              </div>

              {displayWorkSteps.length === 0 ? (
                <div className="p-6 text-center border border-dashed border-slate-800 rounded-xl text-xs font-mono text-slate-400">
                  No experimental work steps recorded for this archive.
                </div>
              ) : (
                <div className="space-y-4">
                  {displayWorkSteps.map((step, idx) => {
                    const isMix = step.actionType === 'MIX_REAGENTS';
                    const mix = step.mixReagentsData;
                    const seed = step.seedReagentsData;
                    const expectedCount = seed
                      ? computeExpectedSeedingEvents(seed.plateType, seed.pipetteType) ??
                        seed.expectedSeedingEventsCount
                      : undefined;
                    const isSeedCountValid = seed
                      ? expectedCount !== undefined
                        ? seed.seedingEventsCount === expectedCount
                        : seed.isSeedingCountCorrect ?? true
                      : true;

                    return (
                      <div
                        key={step.stepId || idx}
                        data-testid={`work-step-card-${idx}`}
                        className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs font-mono font-bold">
                              Step {idx + 1}
                            </span>
                            {isMix ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800 text-xs font-mono font-semibold">
                                <Beaker className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Action: Mix Reagents</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 text-xs font-mono font-semibold">
                                <Pipette className="w-3.5 h-3.5 text-emerald-400" />
                                <span>Action: Seed Reagents</span>
                              </span>
                            )}
                            <span className="text-xs text-slate-300 font-mono">
                              {toActiveVoiceDescription(step.description)}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            {step.startTimeSeconds !== undefined &&
                              step.endTimeSeconds !== undefined && (
                                <button
                                  type="button"
                                  onClick={() => onSeekVideo?.(step.startTimeSeconds!)}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950 text-slate-400 hover:text-cyan-300 border border-slate-800 text-[11px] font-mono transition-colors"
                                >
                                  <Clock className="w-3 h-3" />
                                  <span>
                                    {formatTimestamp(step.startTimeSeconds)} –{' '}
                                    {formatTimestamp(step.endTimeSeconds)}
                                  </span>
                                </button>
                              )}
                            {isEditing && (
                              <button
                                type="button"
                                onClick={() => handleRemoveWorkStep(idx)}
                                className="text-rose-400 hover:text-rose-300 p-1"
                                title="Remove Work Step"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Action 1: Mix Reagents Details */}
                        {isMix && mix && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                              <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                First Reagent Name
                              </span>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={mix.firstReagentName}
                                  onChange={(e) =>
                                    setEditWorkSteps((prev) =>
                                      prev.map((s, i) =>
                                        i === idx && s.mixReagentsData
                                          ? {
                                              ...s,
                                              mixReagentsData: {
                                                ...s.mixReagentsData,
                                                firstReagentName: e.target.value,
                                              },
                                            }
                                          : s
                                      )
                                    )
                                  }
                                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                                />
                              ) : (
                                <span className="text-xs font-mono font-bold text-slate-100">
                                  {normalizeNA(mix.firstReagentName)}
                                </span>
                              )}
                            </div>

                            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                              <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                First Reagent Mixing Amount
                              </span>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={mix.firstReagentAmount}
                                  onChange={(e) =>
                                    setEditWorkSteps((prev) =>
                                      prev.map((s, i) =>
                                        i === idx && s.mixReagentsData
                                          ? {
                                              ...s,
                                              mixReagentsData: {
                                                ...s.mixReagentsData,
                                                firstReagentAmount: e.target.value,
                                              },
                                            }
                                          : s
                                      )
                                    )
                                  }
                                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-indigo-300"
                                />
                              ) : (
                                <span className="text-xs font-mono font-bold text-indigo-300">
                                  {normalizeNA(mix.firstReagentAmount)}
                                </span>
                              )}
                            </div>

                            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                              <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                Second Reagent Name
                              </span>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={mix.secondReagentName}
                                  onChange={(e) =>
                                    setEditWorkSteps((prev) =>
                                      prev.map((s, i) =>
                                        i === idx && s.mixReagentsData
                                          ? {
                                              ...s,
                                              mixReagentsData: {
                                                ...s.mixReagentsData,
                                                secondReagentName: e.target.value,
                                              },
                                            }
                                          : s
                                      )
                                    )
                                  }
                                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                                />
                              ) : (
                                <span className="text-xs font-mono font-bold text-slate-100">
                                  {normalizeNA(mix.secondReagentName)}
                                </span>
                              )}
                            </div>

                            <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                              <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                Second Reagent Mixing Amount
                              </span>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={mix.secondReagentAmount}
                                  onChange={(e) =>
                                    setEditWorkSteps((prev) =>
                                      prev.map((s, i) =>
                                        i === idx && s.mixReagentsData
                                          ? {
                                              ...s,
                                              mixReagentsData: {
                                                ...s.mixReagentsData,
                                                secondReagentAmount: e.target.value,
                                              },
                                            }
                                          : s
                                      )
                                    )
                                  }
                                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-indigo-300"
                                />
                              ) : (
                                <span className="text-xs font-mono font-bold text-indigo-300">
                                  {normalizeNA(mix.secondReagentAmount)}
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Action 2: Seed Reagents Details */}
                        {!isMix && seed && (
                          <div className="space-y-3 pt-1">
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                              <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                                <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                  Plate Type
                                </span>
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={seed.plateType}
                                    onChange={(e) =>
                                      setEditWorkSteps((prev) =>
                                        prev.map((s, i) =>
                                          i === idx && s.seedReagentsData
                                            ? {
                                                ...s,
                                                seedReagentsData: {
                                                  ...s.seedReagentsData,
                                                  plateType: e.target.value,
                                                },
                                              }
                                            : s
                                        )
                                      )
                                    }
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                                  />
                                ) : (
                                  <span className="text-xs font-mono font-bold text-slate-100 flex items-center gap-1.5">
                                    <Grid className="w-3.5 h-3.5 text-cyan-400" />
                                    <span>{normalizeNA(seed.plateType)}</span>
                                  </span>
                                )}
                              </div>

                              <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                                <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                  Pipette Type
                                </span>
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={seed.pipetteType}
                                    onChange={(e) =>
                                      setEditWorkSteps((prev) =>
                                        prev.map((s, i) =>
                                          i === idx && s.seedReagentsData
                                            ? {
                                                ...s,
                                                seedReagentsData: {
                                                  ...s.seedReagentsData,
                                                  pipetteType: e.target.value,
                                                },
                                              }
                                            : s
                                        )
                                      )
                                    }
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                                  />
                                ) : (
                                  <span className="text-xs font-mono font-bold text-slate-100 flex items-center gap-1.5">
                                    <Pipette className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>{normalizeNA(seed.pipetteType)}</span>
                                  </span>
                                )}
                              </div>

                              <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                                <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                  Cells Seeded
                                </span>
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={seed.cellsSeeded}
                                    onChange={(e) =>
                                      setEditWorkSteps((prev) =>
                                        prev.map((s, i) =>
                                          i === idx && s.seedReagentsData
                                            ? {
                                                ...s,
                                                seedReagentsData: {
                                                  ...s.seedReagentsData,
                                                  cellsSeeded: e.target.value,
                                                },
                                              }
                                            : s
                                        )
                                      )
                                    }
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
                                  />
                                ) : (
                                  <span className="text-xs font-mono font-bold text-slate-100">
                                    {normalizeNA(seed.cellsSeeded)}
                                  </span>
                                )}
                              </div>

                              <div className="bg-slate-950/80 border border-slate-800/80 rounded-lg p-3">
                                <span className="text-[10px] font-mono uppercase text-slate-400 block mb-1">
                                  Cells Per Well
                                </span>
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={seed.cellsPerWell}
                                    onChange={(e) =>
                                      setEditWorkSteps((prev) =>
                                        prev.map((s, i) =>
                                          i === idx && s.seedReagentsData
                                            ? {
                                                ...s,
                                                seedReagentsData: {
                                                  ...s.seedReagentsData,
                                                  cellsPerWell: e.target.value,
                                                },
                                              }
                                            : s
                                        )
                                      )
                                    }
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-emerald-300"
                                  />
                                ) : (
                                  <span className="text-xs font-mono font-bold text-emerald-300">
                                    {normalizeNA(seed.cellsPerWell)}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Seeding Events Count & Verification Banner */}
                            <div
                              data-testid={`seeding-verification-banner-${idx}`}
                              className={`rounded-lg p-3 border flex flex-wrap items-center justify-between gap-3 ${
                                isSeedCountValid
                                  ? 'bg-emerald-950/30 border-emerald-700/50 text-emerald-200'
                                  : 'bg-amber-950/40 border-amber-600/60 text-amber-200'
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                {isSeedCountValid ? (
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                                )}
                                <div className="text-xs font-mono">
                                  <span className="font-bold">
                                    Seeding Events Detected:{' '}
                                    {isEditing ? (
                                      <input
                                        type="number"
                                        min="0"
                                        value={seed.seedingEventsCount}
                                        onChange={(e) =>
                                          setEditWorkSteps((prev) =>
                                            prev.map((s, i) =>
                                              i === idx && s.seedReagentsData
                                                ? {
                                                    ...s,
                                                    seedReagentsData: {
                                                      ...s.seedReagentsData,
                                                      seedingEventsCount:
                                                        parseInt(e.target.value, 10) || 0,
                                                    },
                                                  }
                                                : s
                                            )
                                          )
                                        }
                                        className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-slate-100 mx-1"
                                      />
                                    ) : (
                                      seed.seedingEventsCount
                                    )}
                                  </span>
                                  {expectedCount !== undefined && (
                                    <span className="text-slate-300 ml-2">
                                      (Expected: {expectedCount} seeding events for{' '}
                                      {seed.plateType} with {seed.pipetteType})
                                    </span>
                                  )}
                                </div>
                              </div>

                              <span
                                className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold ${
                                  isSeedCountValid
                                    ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700'
                                    : 'bg-amber-900/60 text-amber-300 border border-amber-700'
                                }`}
                              >
                                {isSeedCountValid
                                  ? 'All Wells Seeded — Count Correct'
                                  : 'Seeding Event Count Mismatch'}
                              </span>
                            </div>

                            {/* 96-Well Plate Map */}
                            <div className="mt-3 pt-2.5 border-t border-slate-800/80 space-y-1.5">
                              <div className="text-[11px] font-mono text-slate-300 font-semibold flex items-center justify-between">
                                <span>96-Well Plate Map (Rows A–H, Columns 1–12 Left to Right)</span>
                                {isEditing && (
                                  <span className="text-[10px] text-slate-400">
                                    Seeded Columns (1–12):
                                    <input
                                      type="text"
                                      value={seed.seededColumns?.join(', ') || ''}
                                      onChange={(e) => {
                                        const raw = e.target.value;
                                        const parsed = parseColumnNumbersFromText(raw);
                                        const resolved = resolveSeededColumnsAndWells({
                                          seededColumns: parsed,
                                          seedingEventsCount: seed.seedingEventsCount,
                                        });
                                        setEditWorkSteps((prev) =>
                                          prev.map((s, i) =>
                                            i === idx && s.seedReagentsData
                                              ? {
                                                  ...s,
                                                  seedReagentsData: {
                                                    ...s.seedReagentsData,
                                                    seededColumns: resolved.seededColumns,
                                                    seededWells: resolved.seededWells,
                                                  },
                                                }
                                              : s
                                          )
                                        );
                                      }}
                                      className="ml-1.5 w-32 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs font-mono text-cyan-300"
                                      placeholder="1, 2, ..., 12"
                                    />
                                  </span>
                                )}
                              </div>
                              <pre className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-[10px] font-mono text-emerald-300 overflow-x-auto whitespace-pre">
                                {render96WellPlateMarkdown(seed.seededColumns, seed.seededWells)}
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExperimentArchive;
