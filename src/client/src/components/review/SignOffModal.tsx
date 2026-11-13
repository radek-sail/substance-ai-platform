import React, { useState, useEffect } from 'react';
import {
  FileCheck2,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Database,
  Building,
  User,
  ShieldCheck,
  Lock,
  FlaskConical,
  BookOpen,
  Calendar,
  ListChecks,
  Beaker,
  Pipette,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  TenantConfig,
  DEFAULT_GCS_BUCKET,
  apiService,
  SignOffResponse,
  compileArchiveMarkdownFromAnalysis,
} from '../../services/api.service';
import { HumanEditedVialData } from '../inventory/VialInspector';
import {
  type Action,
  type BoxUpdate,
  type ArchiveReagent,
  type ArchiveWorkStep,
  render96WellPlateMarkdown,
  parseColumnNumbersFromText,
  resolveSeededColumnsAndWells,
  generateReagentAcronym,
  computeExpectedSeedingEvents,
} from '@sail/shared';

interface SignOffModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowType: 'INVENTORY_UPDATE_WORKFLOW' | 'EXPERIMENT_NOTEBOOK_WORKFLOW';
  tenant: TenantConfig;
  videoId: string;
  inventoryId?: string;
  archiveId?: string;
  rawAiInventoryData?: HumanEditedVialData;
  editedInventoryData?: HumanEditedVialData;
  onChangeInventoryField?: (field: keyof HumanEditedVialData, value: any) => void;
  inventoryActions?: Action[];
  editedActionsMap?: Record<string, HumanEditedVialData>;
  markdownDoc?: string;
  archiveName?: string;
  creatorName?: string;
  creationDate?: string;
  purpose?: string;
  reagents?: ArchiveReagent[];
  labelTranscriptions?: string[];
  workSteps?: ArchiveWorkStep[];
  onCommitSuccess: (res: SignOffResponse) => void;
}

export const SignOffModal: React.FC<SignOffModalProps> = ({
  isOpen,
  onClose,
  workflowType,
  tenant,
  videoId,
  inventoryId = 'tank_alpha_01',
  archiveId = 'archive_exp_402',
  rawAiInventoryData,
  editedInventoryData,
  onChangeInventoryField,
  inventoryActions = [],
  editedActionsMap = {},
  markdownDoc = '',
  archiveName,
  creatorName,
  creationDate,
  purpose,
  reagents,
  labelTranscriptions,
  workSteps,
  onCommitSuccess,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmedCheck, setConfirmedCheck] = useState(false);
  const [operatorInitials, setOperatorInitials] = useState(
    editedInventoryData?.userInitials ||
      editedInventoryData?.operatorInitials ||
      tenant.operatorInitials ||
      'RS'
  );

  const [modalArchiveName, setModalArchiveName] = useState(archiveName || 'archive_exp_402');
  const [modalCreationDate, setModalCreationDate] = useState(
    creationDate || new Date().toISOString().split('T')[0]
  );
  const [modalCreatorName, setModalCreatorName] = useState(creatorName || 'Lab Technician');
  const [modalPurpose, setModalPurpose] = useState(purpose || '');

  const [modalReagents, setModalReagents] = useState<ArchiveReagent[]>(reagents || []);
  const [modalTranscriptions, setModalTranscriptions] = useState<string[]>(labelTranscriptions || []);
  const [modalWorkSteps, setModalWorkSteps] = useState<ArchiveWorkStep[]>(workSteps || []);

  useEffect(() => {
    if (archiveName) setModalArchiveName(archiveName);
  }, [archiveName, isOpen]);

  useEffect(() => {
    if (creationDate) setModalCreationDate(creationDate);
  }, [creationDate, isOpen]);

  useEffect(() => {
    if (creatorName) setModalCreatorName(creatorName);
  }, [creatorName, isOpen]);

  useEffect(() => {
    setModalPurpose(purpose || '');
  }, [purpose, isOpen]);

  useEffect(() => {
    if (reagents) setModalReagents(reagents);
  }, [reagents, isOpen]);

  useEffect(() => {
    if (labelTranscriptions) setModalTranscriptions(labelTranscriptions);
  }, [labelTranscriptions, isOpen]);

  useEffect(() => {
    if (workSteps) setModalWorkSteps(workSteps);
  }, [workSteps, isOpen]);

  const handleUpdateReagent = (idx: number, field: keyof ArchiveReagent, val: string) => {
    setModalReagents((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const updated = { ...r, [field]: val };
        if (field === 'reagentName' && (!r.reagentAcronym || r.reagentAcronym === generateReagentAcronym(r.reagentName || ''))) {
          updated.reagentAcronym = generateReagentAcronym(val);
        }
        return updated;
      })
    );
  };

  const handleAddReagent = () => {
    setModalReagents((prev) => [
      ...prev,
      {
        reagentName: '',
        reagentAcronym: '',
        manufacturer: '',
        catalogNumber: '',
        lotNumber: '',
      },
    ]);
  };

  const handleRemoveReagent = (idx: number) => {
    setModalReagents((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateTranscription = (idx: number, val: string) => {
    setModalTranscriptions((prev) =>
      prev.map((t, i) => (i === idx ? val : t))
    );
  };

  const handleAddTranscription = () => {
    setModalTranscriptions((prev) => [...prev, '']);
  };

  const handleRemoveTranscription = (idx: number) => {
    setModalTranscriptions((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateWorkStep = (idx: number, patch: Partial<ArchiveWorkStep>) => {
    setModalWorkSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  };

  // Local editable fallback state when parent does not provide onChangeInventoryField
  const [localEdited, setLocalEdited] = useState<HumanEditedVialData>({
    cellLineName: editedInventoryData?.cellLineName || 'HEK293T',
    lotNumber: editedInventoryData?.lotNumber || 'LOT-8841',
    passage: editedInventoryData?.passage ?? 5,
    operatorInitials: editedInventoryData?.operatorInitials || tenant.operatorInitials || 'JS',
    userInitials:
      editedInventoryData?.userInitials ||
      editedInventoryData?.operatorInitials ||
      tenant.operatorInitials ||
      'JS',
    dateFrozen: editedInventoryData?.dateFrozen || '2026-03-15',
    fullText:
      editedInventoryData?.fullText ||
      `${editedInventoryData?.cellLineName || 'HEK293T'} | P${editedInventoryData?.passage ?? 5} | ${
        editedInventoryData?.lotNumber || 'LOT-8841'
      }`,
    targetCoordinate: editedInventoryData?.targetCoordinate || 'C4',
    boxId: editedInventoryData?.boxId || 'box_01',
    actionId: editedInventoryData?.actionId,
    actionType: editedInventoryData?.actionType || 'VIAL_INSERTION',
  });

  useEffect(() => {
    if (editedInventoryData) {
      setLocalEdited((prev) => ({
        ...prev,
        ...editedInventoryData,
        userInitials:
          editedInventoryData.userInitials ??
          editedInventoryData.operatorInitials ??
          prev.userInitials,
        fullText:
          editedInventoryData.fullText ??
          `${editedInventoryData.cellLineName || 'HEK293T'} | P${editedInventoryData.passage ?? 5} | ${
            editedInventoryData.lotNumber || 'LOT-8841'
          }`,
      }));
    }
  }, [editedInventoryData]);

  if (!isOpen) return null;

  const isInventory = workflowType === 'INVENTORY_UPDATE_WORKFLOW';
  const activeEdited = editedInventoryData
    ? {
        ...localEdited,
        ...editedInventoryData,
        userInitials:
          editedInventoryData.userInitials ??
          editedInventoryData.operatorInitials ??
          localEdited.userInitials,
        dateFrozen: editedInventoryData.dateFrozen ?? localEdited.dateFrozen,
        fullText: editedInventoryData.fullText ?? localEdited.fullText,
      }
    : localEdited;

  const handleFieldEdit = (field: keyof HumanEditedVialData, value: any) => {
    setLocalEdited((prev) => ({ ...prev, [field]: value }));
    onChangeInventoryField?.(field, value);
  };

  // Compare diffs for inventory
  const diffs: {
    field: keyof HumanEditedVialData;
    label: string;
    raw: string;
    edited: string;
    isModified: boolean;
  }[] = [];

  if (isInventory && rawAiInventoryData) {
    const fieldDefs: { field: keyof HumanEditedVialData; label: string }[] = [
      { field: 'cellLineName', label: 'Cell Line Name' },
      { field: 'userInitials', label: "User's Initials" },
      { field: 'dateFrozen', label: 'Date Frozen' },
      { field: 'fullText', label: 'Full Label Text' },
      { field: 'targetCoordinate', label: 'Box Well Location' },
      { field: 'lotNumber', label: 'Lot Number' },
      { field: 'passage', label: 'Passage' },
    ];
    fieldDefs.forEach(({ field, label }) => {
      const rawVal = String(
        rawAiInventoryData[field] ??
          (field === 'userInitials' ? rawAiInventoryData.operatorInitials : '') ??
          ''
      );
      const editedVal = String(activeEdited[field] ?? '');
      diffs.push({
        field,
        label,
        raw: rawVal,
        edited: editedVal,
        isModified: rawVal !== editedVal,
      });
    });
  }

  const handleCommit = async () => {
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      let result: SignOffResponse;
      if (isInventory) {
        const boxUpdates: BoxUpdate[] = [];

        // If multiple inventory update actions exist, build a BoxUpdate for each
        const relevantActions = inventoryActions.filter((a) => {
          const cls = String(a.actionClass || '');
          return cls.includes('INSERTION') || cls.includes('REMOVAL') || cls.includes('HANDLING');
        });

        if (relevantActions.length > 0) {
          relevantActions.forEach((act, idx) => {
            const actEdit =
              editedActionsMap[act.actionId] ||
              (act.actionId === activeEdited.actionId || idx === 0 ? activeEdited : undefined);
            const targetCoord =
              actEdit?.targetCoordinate ||
              act.boxWellLocation?.coordinate ||
              (act.boxRowId && act.boxColId ? `${act.boxRowId}${act.boxColId}` : undefined) ||
              (act.targetRow && act.targetCol ? `${act.targetRow}${act.targetCol}` : 'C4');
            const match = targetCoord.trim().toUpperCase().match(/^([A-Z])(\d+)$/);
            const row = match
              ? match[1]
              : act.boxWellLocation?.row || act.boxRowId || act.targetRow || 'C';
            const col = match
              ? parseInt(match[2], 10)
              : act.boxWellLocation?.col || act.boxColId || act.targetCol || 4;
            const rawActType =
              actEdit?.actionType ||
              act.boxWellLocation?.actionType ||
              (String(act.actionType || act.actionClass || '').toUpperCase().includes('REMOVAL')
                ? 'VIAL_REMOVAL'
                : 'VIAL_INSERTION');
            const actionType: 'VIAL_INSERTION' | 'VIAL_REMOVAL' =
              rawActType === 'VIAL_REMOVAL' ? 'VIAL_REMOVAL' : 'VIAL_INSERTION';
            const isActRemoval = actionType === 'VIAL_REMOVAL';
            const cellLineName = isActRemoval
              ? (actEdit?.cellLineName ?? act.vialLabelData?.cellLineName ?? act.cellLineInfo?.name ?? '')
              : (actEdit?.cellLineName ||
                act.vialLabelData?.cellLineName ||
                act.cellLineInfo?.name ||
                activeEdited.cellLineName ||
                'HEK293T');
            const userInitials = isActRemoval
              ? (actEdit?.userInitials ?? act.vialLabelData?.userInitials ?? '')
              : (actEdit?.userInitials ||
                act.vialLabelData?.userInitials ||
                activeEdited.userInitials ||
                operatorInitials);
            const dateFrozen = isActRemoval
              ? (actEdit?.dateFrozen ?? act.vialLabelData?.dateFrozen ?? '')
              : (actEdit?.dateFrozen ||
                act.vialLabelData?.dateFrozen ||
                activeEdited.dateFrozen);
            const fullText = isActRemoval
              ? (actEdit?.fullText ?? act.vialLabelData?.fullText ?? act.conflatedLabelText ?? '')
              : (actEdit?.fullText ||
                act.vialLabelData?.fullText ||
                act.conflatedLabelText ||
                activeEdited.fullText ||
                `${cellLineName} | ${userInitials}${dateFrozen ? ` | ${dateFrozen}` : ''}`);

            boxUpdates.push({
              boxId: actEdit?.boxId || activeEdited.boxId || 'box_01',
              row,
              col,
              cellLineName,
              userInitials: userInitials || undefined,
              operatorInitials: userInitials || operatorInitials,
              dateFrozen: dateFrozen || undefined,
              fullText,
              lotNumber: isActRemoval
                ? (actEdit?.lotNumber || act.cellLineInfo?.lotNumber || undefined)
                : (actEdit?.lotNumber || act.cellLineInfo?.lotNumber || activeEdited.lotNumber),
              passage: isActRemoval
                ? (actEdit?.passage ?? act.cellLineInfo?.passage)
                : (actEdit?.passage ?? act.cellLineInfo?.passage ?? activeEdited.passage),
              actionId: act.actionId,
              actionType,
              highlighted: actionType !== 'VIAL_REMOVAL',
              status: actionType === 'VIAL_REMOVAL' ? 'EMPTY' : 'OCCUPIED',
              updatedAt: new Date().toISOString(),
            });
          });
        } else {
          const boxId = activeEdited.boxId || 'box_01';
          const targetCoord = activeEdited.targetCoordinate || 'C4';
          const match = targetCoord.trim().toUpperCase().match(/^([A-Z])(\d+)$/);
          const row = match ? match[1] : 'C';
          const col = match ? parseInt(match[2], 10) : 4;
          const actionType = activeEdited.actionType || 'VIAL_INSERTION';
          const isActRemoval = actionType === 'VIAL_REMOVAL';

          boxUpdates.push({
            boxId,
            row,
            col,
            cellLineName: isActRemoval ? (activeEdited.cellLineName || '') : (activeEdited.cellLineName || 'HEK293T'),
            userInitials: isActRemoval ? (activeEdited.userInitials || undefined) : (activeEdited.userInitials || operatorInitials),
            operatorInitials: activeEdited.userInitials || operatorInitials,
            dateFrozen: activeEdited.dateFrozen || undefined,
            fullText: isActRemoval
              ? (activeEdited.fullText || '')
              : (activeEdited.fullText ||
                `${activeEdited.cellLineName || 'HEK293T'} | P${activeEdited.passage ?? 5} | ${
                  activeEdited.lotNumber || 'LOT-8841'
                }`),
            lotNumber: activeEdited.lotNumber || undefined,
            passage: activeEdited.passage,
            actionId: activeEdited.actionId,
            actionType,
            highlighted: actionType !== 'VIAL_REMOVAL',
            status: actionType === 'VIAL_REMOVAL' ? 'EMPTY' : 'OCCUPIED',
            updatedAt: new Date().toISOString(),
          });
        }

        result = await apiService.commitInventorySignOff(
          tenant.databaseId,
          videoId,
          inventoryId,
          boxUpdates
        );
      } else {
        const effectiveArchiveName = modalArchiveName || archiveName || 'archive_exp_402';
        const effectiveCreatorName = modalCreatorName || creatorName || 'Lab Technician';
        const effectiveCreationDate =
          modalCreationDate || creationDate || new Date().toISOString().split('T')[0];
        const effectivePurpose = (modalPurpose ?? purpose ?? '').trim() || null;

        const effectiveMarkdown =
          modalReagents.length > 0 || modalWorkSteps.length > 0 || modalPurpose
            ? compileArchiveMarkdownFromAnalysis({
                videoId,
                workflow: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
                archiveName: effectiveArchiveName,
                creatorName: effectiveCreatorName,
                creationDate: effectiveCreationDate,
                purpose: effectivePurpose,
                reagents: modalReagents,
                workSteps: modalWorkSteps,
                labelTranscriptions: modalTranscriptions,
              })
            : (markdownDoc ||
              compileArchiveMarkdownFromAnalysis({
                videoId,
                workflow: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
                archiveName: effectiveArchiveName,
                creatorName: effectiveCreatorName,
                creationDate: effectiveCreationDate,
                purpose: effectivePurpose,
                reagents: modalReagents,
                workSteps: modalWorkSteps,
                labelTranscriptions: modalTranscriptions,
              }));

        result = await apiService.commitArchiveSignOff(
          tenant.databaseId,
          videoId,
          archiveId,
          effectiveMarkdown,
          {
            archiveName: effectiveArchiveName,
            creatorName: effectiveCreatorName,
            creationDate: effectiveCreationDate,
            purpose: effectivePurpose,
            reagents: modalReagents,
            labelTranscriptions: modalTranscriptions,
            workSteps: modalWorkSteps,
          }
        );
      }

      onCommitSuccess(result);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Atomic sign-off commit failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
    <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150 my-8 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-amber-500 to-orange-600 text-white shadow-md shadow-orange-500/30">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <span>Analysis Verification</span>
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Stream ID: {videoId} • Workflow: {workflowType}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-slate-100 text-lg font-bold"
          >
            ✕
          </button>
        </div>

        {/* Tenant Scoping Path Summary */}
        <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-xs font-mono space-y-1.5">
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5">
              <Building className="w-3.5 h-3.5 text-cyan-400" />
              <span>Customer Storage:</span>
            </span>
            <span className="text-slate-200">
              gs://{tenant.bucketName || DEFAULT_GCS_BUCKET}/
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-cyan-400" />
              <span>Target Firestore Collection:</span>
            </span>
            <span className="text-cyan-300">
              {isInventory
                ? `/databases/${tenant.databaseId}/documents/inventories/${inventoryId}/contents/box_01`
                : `/databases/${tenant.databaseId}/documents/archives/${archiveId}`}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Audit Document:</span>
            </span>
            <span className="text-emerald-400">
              /databases/{tenant.databaseId}/documents/video_analyses/{videoId} (isSignedOff: true)
            </span>
          </div>
        </div>

        {/* Diff Review & Inline Edit Table */}
        {isInventory ? (
          <div>
            <h3 className="text-xs font-semibold text-slate-300 mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <FileCheck2 className="w-3.5 h-3.5 text-cyan-400" />
                <span>Audit Summary: Human Modifications vs Raw AI Extractions</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                Origin A1: Top-Left Black Corner
              </span>
            </h3>

            <div className="border border-slate-800 rounded-xl overflow-hidden text-xs">
              <table className="w-full text-left font-mono">
                <thead className="bg-slate-950 border-b border-slate-800 text-slate-400 text-[11px]">
                  <tr>
                    <th className="py-2 px-3">Field</th>
                    <th className="py-2 px-3">Raw AI (Pass 1–3)</th>
                    <th className="py-2 px-3">Operator Verified (Editable)</th>
                    <th className="py-2 px-3 text-right">Audit Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 bg-slate-900/50">
                  {diffs.map((d) => (
                    <tr key={d.field} className="hover:bg-slate-800/40">
                      <td className="py-2 px-3 text-slate-300 font-sans font-medium">
                        {d.label}
                      </td>
                      <td className="py-2 px-3 text-slate-400 max-w-[160px] truncate" title={d.raw}>
                        {d.raw || '—'}
                      </td>
                      <td className="py-1.5 px-3">
                        <input
                          type={d.field === 'passage' ? 'number' : 'text'}
                          value={d.edited}
                          onChange={(e) =>
                            handleFieldEdit(
                              d.field,
                              d.field === 'passage'
                                ? parseInt(e.target.value, 10) || 1
                                : d.field === 'targetCoordinate'
                                ? e.target.value.toUpperCase()
                                : e.target.value
                            )
                          }
                          className={`w-full bg-slate-950 border rounded px-2 py-1 text-xs font-mono focus:outline-none ${
                            d.isModified
                              ? 'border-amber-500/70 text-amber-300 font-bold'
                              : 'border-slate-700 text-slate-200 focus:border-cyan-500'
                          }`}
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        {d.isModified ? (
                          <span className="bg-amber-950 border border-amber-800/80 text-amber-300 text-[10px] px-2 py-0.5 rounded-full">
                            Modified
                          </span>
                        ) : (
                          <span className="bg-emerald-950 border border-emerald-800/80 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full">
                            Unaltered
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Section 1: Identification */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
                <BookOpen className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-bold font-mono text-slate-200">
                  1. Experiment Notebook Identification
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
                <div>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Archive Name</span>
                  <input
                    type="text"
                    value={modalArchiveName}
                    onChange={(e) => setModalArchiveName(e.target.value)}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Creation Date</span>
                  <input
                    type="text"
                    value={modalCreationDate}
                    onChange={(e) => setModalCreationDate(e.target.value)}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Creator / Operator</span>
                  <input
                    type="text"
                    value={modalCreatorName}
                    onChange={(e) => setModalCreatorName(e.target.value)}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Purpose (Optional)</span>
                  <input
                    type="text"
                    value={modalPurpose}
                    placeholder="Reason for experiment (optional)"
                    onChange={(e) => setModalPurpose(e.target.value)}
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: Reagents Table with Acronyms */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-2">
                  <FlaskConical className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-bold font-mono text-slate-200">
                    2. Extracted Reagents & Acronyms ({modalReagents.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleAddReagent}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono font-semibold rounded bg-indigo-950 text-indigo-300 border border-indigo-700 hover:bg-indigo-900 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Reagent</span>
                </button>
              </div>
              {modalReagents.length > 0 ? (
                <div className="border border-slate-800 rounded-lg overflow-x-auto text-xs">
                  <table className="w-full text-left font-mono">
                    <thead className="bg-slate-900 border-b border-slate-800 text-[10px] text-slate-400">
                      <tr>
                        <th className="py-1.5 px-2.5">Reagent Name</th>
                        <th className="py-1.5 px-2.5">Acronym</th>
                        <th className="py-1.5 px-2.5">Manufacturer</th>
                        <th className="py-1.5 px-2.5">Catalog #</th>
                        <th className="py-1.5 px-2.5">Lot #</th>
                        <th className="py-1.5 px-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-950/40 text-[11px]">
                      {modalReagents.map((r, idx) => (
                        <tr key={idx} className="hover:bg-slate-900/40">
                          <td className="py-1 px-2">
                            <input
                              type="text"
                              value={r.reagentName || ''}
                              onChange={(e) => handleUpdateReagent(idx, 'reagentName', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                              placeholder="Reagent name"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              type="text"
                              value={r.reagentAcronym || ''}
                              onChange={(e) => handleUpdateReagent(idx, 'reagentAcronym', e.target.value)}
                              className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-indigo-300 font-bold"
                              placeholder="Acronym"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              type="text"
                              value={r.manufacturer || ''}
                              onChange={(e) => handleUpdateReagent(idx, 'manufacturer', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-300"
                              placeholder="Manufacturer"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              type="text"
                              value={r.catalogNumber || ''}
                              onChange={(e) => handleUpdateReagent(idx, 'catalogNumber', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-300"
                              placeholder="Catalog #"
                            />
                          </td>
                          <td className="py-1 px-2">
                            <input
                              type="text"
                              value={r.lotNumber || ''}
                              onChange={(e) => handleUpdateReagent(idx, 'lotNumber', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-300"
                              placeholder="Lot #"
                            />
                          </td>
                          <td className="py-1 px-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveReagent(idx)}
                              className="p-1 hover:bg-slate-800 text-slate-400 hover:text-rose-400 rounded transition-colors"
                              title="Delete reagent"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-slate-400 font-mono italic">No reagents detected. Click "Add Reagent" to add one.</p>
              )}
            </div>

            {/* Section 3: Bottle Label Transcriptions */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-2">
                  <FileCheck2 className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold font-mono text-slate-200">
                    3. Bottle Label Transcriptions ({modalTranscriptions.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleAddTranscription}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono font-semibold rounded bg-amber-950 text-amber-300 border border-amber-700 hover:bg-amber-900 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Transcription</span>
                </button>
              </div>
              {modalTranscriptions.length > 0 ? (
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {modalTranscriptions.map((lt, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={lt}
                        onChange={(e) => handleUpdateTranscription(idx, e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs font-mono text-slate-200"
                        placeholder="Transcription text"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveTranscription(idx)}
                        className="p-1 text-slate-400 hover:text-rose-400 transition-colors"
                        title="Delete transcription"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 font-mono italic">No bottle label transcriptions recorded.</p>
              )}
            </div>

            {/* Section 4: Work Steps */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="flex items-center gap-2 border-b border-slate-800/80 pb-2">
                <ListChecks className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold font-mono text-slate-200">
                  4. Protocol Work Steps ({modalWorkSteps.length})
                </span>
              </div>
              {modalWorkSteps.length > 0 ? (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                  {modalWorkSteps.map((step, idx) => {
                    const isSingleReagent = Boolean(
                      step.actionType === 'MIX_REAGENTS' &&
                      step.mixReagentsData &&
                      (!step.mixReagentsData.secondReagentName ||
                        step.mixReagentsData.secondReagentName.trim() === '' ||
                        step.mixReagentsData.secondReagentName.trim().toUpperCase() === 'N/A')
                    );

                    return (
                    <div key={step.stepId || idx} className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-xs font-mono space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-950 text-indigo-300 border border-indigo-800">
                          {isSingleReagent ? 'ADD_REAGENT' : step.actionType}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {step.startTimeSeconds ?? 0}s – {step.endTimeSeconds ?? 0}s
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block mb-0.5">Description:</span>
                        <input
                          type="text"
                          value={
                            isSingleReagent &&
                            (!step.description ||
                              step.description.trim().toLowerCase() === 'mix reagents' ||
                              step.description.trim().toLowerCase() === 'mix reagents.')
                              ? 'Add Reagent'
                              : (step.description || '')
                          }
                          onChange={(e) => handleUpdateWorkStep(idx, { description: e.target.value })}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
                        />
                      </div>
                      {step.actionType === 'MIX_REAGENTS' && step.mixReagentsData && (
                        <div className={`text-[11px] text-slate-300 bg-slate-950/60 p-2 rounded border border-slate-800 grid ${isSingleReagent ? 'grid-cols-1' : 'grid-cols-2'} gap-2`}>
                          <div>
                            <span className="text-[10px] text-slate-400 block">
                              {isSingleReagent ? 'Reagent Name & Amount:' : 'Reagent 1 Name & Amount:'}
                            </span>
                            <div className="flex gap-1.5 mt-0.5">
                              <input
                                type="text"
                                value={step.mixReagentsData.firstReagentName || ''}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    mixReagentsData: {
                                      ...step.mixReagentsData!,
                                      firstReagentName: e.target.value,
                                    },
                                  })
                                }
                                className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                                placeholder="Name"
                              />
                              <input
                                type="text"
                                value={step.mixReagentsData.firstReagentAmount || ''}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    mixReagentsData: {
                                      ...step.mixReagentsData!,
                                      firstReagentAmount: e.target.value,
                                    },
                                  })
                                }
                                className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                                placeholder="Amount"
                              />
                            </div>
                          </div>
                          {!isSingleReagent && (
                            <div>
                              <span className="text-[10px] text-slate-400 block">Reagent 2 Name &amp; Amount:</span>
                              <div className="flex gap-1.5 mt-0.5">
                                <input
                                  type="text"
                                  value={step.mixReagentsData.secondReagentName || ''}
                                  onChange={(e) =>
                                    handleUpdateWorkStep(idx, {
                                      mixReagentsData: {
                                        ...step.mixReagentsData!,
                                        secondReagentName: e.target.value,
                                      },
                                    })
                                  }
                                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                                  placeholder="Name"
                                />
                                <input
                                  type="text"
                                  value={step.mixReagentsData.secondReagentAmount || ''}
                                  onChange={(e) =>
                                    handleUpdateWorkStep(idx, {
                                      mixReagentsData: {
                                        ...step.mixReagentsData!,
                                        secondReagentAmount: e.target.value,
                                      },
                                    })
                                  }
                                  className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                                  placeholder="Amount"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {step.actionType === 'SEED_REAGENTS' && step.seedReagentsData && (
                        <div className="text-[11px] text-slate-300 bg-slate-950/60 p-2.5 rounded border border-slate-800 space-y-2">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div>
                              <span className="text-[10px] text-slate-400 block">Plate Type:</span>
                              <input
                                type="text"
                                value={step.seedReagentsData.plateType || 'N/A'}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      plateType: e.target.value,
                                    },
                                  })
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 mt-0.5"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 block">Pipette Type:</span>
                              <input
                                type="text"
                                value={step.seedReagentsData.pipetteType || 'N/A'}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      pipetteType: e.target.value,
                                    },
                                  })
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 mt-0.5"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 block">Cells Seeded:</span>
                              <input
                                type="text"
                                value={step.seedReagentsData.cellsSeeded || 'N/A'}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      cellsSeeded: e.target.value,
                                    },
                                  })
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 mt-0.5"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 block">Cells Per Well:</span>
                              <input
                                type="text"
                                value={step.seedReagentsData.cellsPerWell || 'N/A'}
                                onChange={(e) =>
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      cellsPerWell: e.target.value,
                                    },
                                  })
                                }
                                className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200 mt-0.5"
                              />
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-800">
                            <span className="text-[11px]">
                              Events Detected:{' '}
                              <input
                                type="number"
                                value={step.seedReagentsData.seedingEventsCount ?? 12}
                                onChange={(e) => {
                                  const count = parseInt(e.target.value, 10) || 0;
                                  const exp = step.seedReagentsData?.expectedSeedingEventsCount ?? 12;
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      seedingEventsCount: count,
                                      isSeedingCountCorrect: count === exp,
                                    },
                                  });
                                }}
                                className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200"
                              />
                            </span>
                            <span className="text-[11px] text-slate-400">
                              Expected: {step.seedReagentsData.expectedSeedingEventsCount ?? 12}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                step.seedReagentsData.isSeedingCountCorrect
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                  : 'bg-amber-950 text-amber-300 border border-amber-800'
                              }`}
                            >
                              {step.seedReagentsData.isSeedingCountCorrect ? '✓ Verified (All Wells Seeded)' : '⚠ Discrepancy'}
                            </span>
                          </div>
                          <div className="pt-1 border-t border-slate-800 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-slate-400">
                                Seeded Columns (1–12, left to right):
                              </span>
                              <input
                                type="text"
                                value={step.seedReagentsData.seededColumns?.join(', ') || ''}
                                onChange={(e) => {
                                  const parsed = parseColumnNumbersFromText(e.target.value);
                                  const resolved = resolveSeededColumnsAndWells({
                                    seededColumns: parsed,
                                    seedingEventsCount: step.seedReagentsData?.seedingEventsCount,
                                  });
                                  handleUpdateWorkStep(idx, {
                                    seedReagentsData: {
                                      ...step.seedReagentsData!,
                                      seededColumns: resolved.seededColumns,
                                      seededWells: resolved.seededWells,
                                    },
                                  });
                                }}
                                className="w-48 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-cyan-300"
                                placeholder="1, 2, ..., 12"
                              />
                            </div>
                            <pre className="bg-slate-950 p-2 rounded border border-slate-800 text-[10px] font-mono text-emerald-300 overflow-x-auto whitespace-pre">
                              {render96WellPlateMarkdown(step.seedReagentsData.seededColumns, step.seedReagentsData.seededWells)}
                            </pre>
                          </div>
                        </div>
                      )}
                      {(step.actionType === 'INCUBATE_CELLS' ||
                        step.actionType === 'INCUBATE_CELLS_ACTION' ||
                        step.incubateCellsData ||
                        step.incubatorSettings) && (
                        <div className="text-[11px] text-slate-300 bg-slate-950/60 p-2.5 rounded border border-slate-800 grid grid-cols-2 gap-2">
                          <div>
                            <span className="text-[10px] text-slate-400 block">
                              Incubator Temperature (INCUBATOR_SETTINGS):
                            </span>
                            <input
                              type="text"
                              value={
                                (step.incubateCellsData || step.incubatorSettings)?.temperature ||
                                'N/A'
                              }
                              onChange={(e) =>
                                handleUpdateWorkStep(idx, {
                                  incubateCellsData: {
                                    temperature: e.target.value,
                                    co2Level:
                                      (step.incubateCellsData || step.incubatorSettings)?.co2Level ||
                                      'N/A',
                                  },
                                })
                              }
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-amber-300 mt-0.5"
                            />
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 block">
                              Incubator CO2 Level (INCUBATOR_SETTINGS):
                            </span>
                            <input
                              type="text"
                              value={
                                (step.incubateCellsData || step.incubatorSettings)?.co2Level ||
                                'N/A'
                              }
                              onChange={(e) =>
                                handleUpdateWorkStep(idx, {
                                  incubateCellsData: {
                                    temperature:
                                      (step.incubateCellsData || step.incubatorSettings)
                                        ?.temperature || 'N/A',
                                    co2Level: e.target.value,
                                  },
                                })
                              }
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-amber-300 mt-0.5"
                            />
                          </div>
                        </div>
                      )}
                      {(step.actionType === 'HEMOCYTOMETER_LOADING' ||
                        step.actionType === 'HEMOCYTOMETER_LOADING_ACTION' ||
                        step.actionType === 'hemocytometer_loading' ||
                        step.hemocytometerLoadingData ||
                        step.hemocytometerLoad) && (
                        <div className="text-[11px] text-slate-300 bg-slate-950/60 p-2.5 rounded border border-slate-800">
                          <div>
                            <span className="text-[10px] text-slate-400 block">
                              Substance Loaded (hemocytometer_load):
                            </span>
                            <input
                              type="text"
                              value={
                                (step.hemocytometerLoadingData || step.hemocytometerLoad)
                                  ?.substanceLoaded ||
                                step.substanceLoaded ||
                                'N/A'
                              }
                              onChange={(e) =>
                                handleUpdateWorkStep(idx, {
                                  hemocytometerLoadingData: {
                                    substanceLoaded: e.target.value,
                                  },
                                  hemocytometerLoad: {
                                    substanceLoaded: e.target.value,
                                  },
                                  substanceLoaded: e.target.value,
                                })
                              }
                              className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs text-teal-300 mt-0.5"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              ) : (
                <p className="text-xs text-slate-400 font-mono italic">No work steps detected.</p>
              )}
            </div>
          </div>
        )}

        {/* Error notification */}
        {errorMsg && (
          <div className="bg-rose-950/80 border border-rose-500/40 text-rose-300 p-3 rounded-xl text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Commit Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
          >
            Cancel & Return
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleCommit}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg transition-all duration-150 ${
              !isSubmitting
                ? 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white shadow-emerald-500/25 active:scale-95 cursor-pointer'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/60'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>Writing to Archive Notebook...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>Write to Archive Notebook</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SignOffModal;
