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
} from 'lucide-react';
import { TenantConfig, DEFAULT_GCS_BUCKET, apiService, SignOffResponse } from '../../services/api.service';
import { HumanEditedVialData } from '../inventory/VialInspector';
import type { Action, BoxUpdate } from '@sail/shared';

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
    if (!confirmedCheck) return;
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
        result = await apiService.commitArchiveSignOff(
          tenant.databaseId,
          videoId,
          archiveId,
          markdownDoc
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
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150 my-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-tr from-amber-500 to-orange-600 text-white shadow-md shadow-orange-500/30">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <span>Atomic HITL Sign-Off & Multi-Tenant Commit</span>
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
            className="text-slate-400 hover:text-white text-lg font-bold"
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
          <div>
            <h3 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
              <FileCheck2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Experiment Archive ELN Markdown Payload</span>
            </h3>
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs font-mono text-slate-300 max-h-40 overflow-y-auto whitespace-pre-wrap">
              {markdownDoc}
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

        {/* Operator Confirmation & Initials */}
        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-slate-800 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <label className="text-slate-300 font-medium flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-cyan-400" />
              <span>Signing Operator Initials:</span>
            </label>
            <input
              type="text"
              maxLength={4}
              value={operatorInitials}
              onChange={(e) => setOperatorInitials(e.target.value.toUpperCase())}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-100 font-mono text-center uppercase focus:outline-none focus:border-cyan-500"
              required
            />
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-300 select-none">
            <input
              type="checkbox"
              checked={confirmedCheck}
              onChange={(e) => setConfirmedCheck(e.target.checked)}
              className="mt-0.5 rounded border-slate-700 bg-slate-900 text-cyan-600 focus:ring-cyan-500"
            />
            <span>
              I certify as the responsible laboratory operator that all physical actions, vial
              locations, and reagent parameters have been verified against experimental video
              evidence. Committing will permanently sign off this analysis.
            </span>
          </label>
        </div>

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
            disabled={!confirmedCheck || isSubmitting}
            onClick={handleCommit}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold shadow-lg transition-all duration-150 ${
              confirmedCheck && !isSubmitting
                ? 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white shadow-emerald-500/25 active:scale-95 cursor-pointer'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/60'
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                <span>Committing Atomic Batch...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-4 h-4" />
                <span>Execute Atomic Sign-Off & Lock Record</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SignOffModal;
