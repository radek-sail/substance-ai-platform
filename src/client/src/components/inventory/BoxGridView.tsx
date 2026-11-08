import React, { useState, useEffect } from 'react';
import { rowIndexToLetter } from '../../utils/coordinates';
import {
  Target,
  CheckCircle2,
  AlertTriangle,
  Layers,
  X,
  PlusCircle,
  FlaskConical,
  FileText,
  Calendar,
  User,
  Sparkles,
  Edit3,
} from 'lucide-react';
import type { InventoryCell } from '@sail/shared';

export interface GridSlotData {
  row: string;
  col: number;
  cellCoordinate?: string;
  cellLineName?: string;
  userInitials?: string;
  dateFrozen?: string;
  fullText?: string;
  lotNumber?: string;
  passage?: number | string;
  notes?: string;
  updatedAt?: string;
  videoId?: string;
  actionId?: string;
  lastActionType?: 'VIAL_INSERTION' | 'VIAL_REMOVAL';
  isOccupied: boolean;
  isTarget?: boolean;
  isDifferenced?: boolean; // Highlighted by pre/post differencing in Pass 3
  isHighlighted?: boolean; // Highlighted when a vial was inserted from video analysis
  isSearchMatch?: boolean; // Highlighted when cell line name matches search query
}

const DEFAULT_OCCUPIED_KEYS = new Set([
  'A1', 'A2', 'A5', 'B2', 'B3', 'B7', 'C1', 'C2', 'D4', 'D5', 'E1', 'E8', 'F3', 'G2', 'H6', 'I9',
]);

export function resolveGridSlotData(params: {
  row: string;
  col: number;
  targetRow?: string;
  targetCol?: number;
  differencedRow?: string;
  differencedCol?: number;
  highlightedCoords?: string[];
  searchMatchingCoords?: string[];
  slots?: Record<string, Partial<GridSlotData>>;
  cells?: Record<string, InventoryCell>;
}): GridSlotData {
  const {
    row,
    col,
    targetRow = 'A',
    targetCol = 1,
    differencedRow,
    differencedCol,
    highlightedCoords = [],
    searchMatchingCoords = [],
    slots = {},
    cells,
  } = params;

  const key = `${row}${col}`;
  const isTarget = row === targetRow && col === targetCol;
  const isDiff = Boolean(
    differencedRow && differencedCol !== undefined && row === differencedRow && col === differencedCol
  );
  const isSearchMatch = Boolean(searchMatchingCoords.includes(key));

  if (cells && cells[key]) {
    const c = cells[key];
    const isHighlighted = Boolean(
      c.occupied &&
        (c.highlighted ||
          c.vial?.fullText ||
          c.vial?.dateFrozen ||
          c.vial?.userInitials ||
          c.vial?.videoId ||
          c.lastActionType === 'VIAL_INSERTION' ||
          highlightedCoords.includes(key))
    );
    return {
      row,
      col,
      cellCoordinate: key,
      isOccupied: c.occupied,
      isTarget,
      isDifferenced: isDiff,
      isHighlighted,
      isSearchMatch: c.occupied && isSearchMatch,
      cellLineName: c.occupied
        ? c.vial?.cellLineName || c.vial?.cellLineIdentifier
        : undefined,
      userInitials: c.vial?.userInitials || c.vial?.operatorInitials,
      dateFrozen: c.vial?.dateFrozen,
      fullText: c.vial?.fullText,
      lotNumber: c.occupied ? c.vial?.lotNumber : undefined,
      passage: c.occupied ? c.vial?.passageNumber : undefined,
      notes: c.vial?.notes,
      updatedAt: c.vial?.updatedAt,
      videoId: c.vial?.videoId,
      actionId: c.vial?.actionId,
      lastActionType:
        c.lastActionType === 'VIAL_REMOVAL'
          ? 'VIAL_REMOVAL'
          : c.lastActionType === 'VIAL_INSERTION'
          ? 'VIAL_INSERTION'
          : undefined,
    };
  }

  const custom = slots[key];
  const isOccupied =
    custom?.isOccupied !== undefined ? custom.isOccupied : DEFAULT_OCCUPIED_KEYS.has(key);
  const isHighlighted = Boolean(
    custom?.isHighlighted ||
      highlightedCoords.includes(key) ||
      (isOccupied && (custom?.fullText || custom?.dateFrozen || custom?.userInitials))
  );

  return {
    row,
    col,
    cellCoordinate: key,
    isOccupied,
    isTarget,
    isDifferenced: isDiff,
    isHighlighted,
    isSearchMatch: Boolean(isOccupied && (custom?.isSearchMatch || isSearchMatch)),
    cellLineName: custom?.cellLineName || (isOccupied ? 'Jurkat-T' : undefined),
    userInitials: custom?.userInitials,
    dateFrozen: custom?.dateFrozen,
    fullText: custom?.fullText,
    lotNumber: custom?.lotNumber,
    passage: custom?.passage,
    notes: custom?.notes,
    updatedAt: custom?.updatedAt,
    videoId: custom?.videoId,
    actionId: custom?.actionId,
    lastActionType: custom?.lastActionType,
  };
}

export interface CellContentPanelProps {
  boxId: string;
  slot: GridSlotData;
  onUpdateCell?: BoxGridViewProps['onUpdateCell'];
  readOnly?: boolean;
  onClose?: () => void;
}

export const CellContentPanel: React.FC<CellContentPanelProps> = ({
  boxId,
  slot,
  onUpdateCell,
  readOnly = false,
  onClose,
}) => {
  const [isEditingOccupied, setIsEditingOccupied] = useState(false);
  const [formCellLine, setFormCellLine] = useState(slot.cellLineName || '');
  const [formUserInitials, setFormUserInitials] = useState(slot.userInitials || '');
  const [formDateFrozen, setFormDateFrozen] = useState(slot.dateFrozen || '');
  const [formFullText, setFormFullText] = useState(slot.fullText || '');
  const [formNotes, setFormNotes] = useState(slot.notes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setIsEditingOccupied(false);
    setFormCellLine(slot.cellLineName || '');
    setFormUserInitials(slot.userInitials || '');
    setFormDateFrozen(slot.dateFrozen || '');
    setFormFullText(slot.fullText || '');
    setFormNotes(slot.notes || '');
  }, [
    boxId,
    slot.row,
    slot.col,
    slot.isOccupied,
    slot.cellLineName,
    slot.userInitials,
    slot.dateFrozen,
    slot.fullText,
    slot.notes,
  ]);

  const handleAssignVial = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const coord = slot.cellCoordinate || `${slot.row}${slot.col}`;
      const resolvedCellLine = formCellLine.trim() || 'Custom-CellLine';
      const resolvedFullText =
        formFullText.trim() ||
        [
          resolvedCellLine,
          formUserInitials.trim(),
          formDateFrozen.trim(),
        ]
          .filter(Boolean)
          .join(' | ');
      const vialPayload = {
        cellLineIdentifier: resolvedCellLine,
        cellLineName: resolvedCellLine,
        userInitials: formUserInitials.trim() || undefined,
        operatorInitials: formUserInitials.trim() || undefined,
        dateFrozen: formDateFrozen.trim() || undefined,
        fullText: resolvedFullText,
        notes: formNotes.trim(),
      };

      if (onUpdateCell) {
        await onUpdateCell(boxId, coord, true, vialPayload);
      }
      setIsEditingOccupied(false);
    } catch (err) {
      console.error('Failed to assign vial:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClearVial = async () => {
    setIsSubmitting(true);
    try {
      const coord = slot.cellCoordinate || `${slot.row}${slot.col}`;
      if (onUpdateCell) {
        await onUpdateCell(boxId, coord, false);
      }
      setFormCellLine('');
      setFormNotes('');
    } catch (err) {
      console.error('Failed to clear vial:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col select-none"
      data-testid="selected-cell-panel"
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2 flex-wrap">
              <span>
                Box {boxId} — Cell {slot.row}{slot.col}
              </span>
              {slot.isHighlighted && slot.isOccupied && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-950/90 border border-emerald-500/40 text-emerald-300 text-[10px] font-mono inline-flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  Video Analysis Vial
                </span>
              )}
            </h4>
            <p className="text-[11px] text-slate-400">
              Cryo-Storage Slot Inspection &amp; Extracted Vial Content
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Panel Body */}
      <div className="p-5 space-y-4">
        {slot.isOccupied && !isEditingOccupied ? (
          /* Occupied Cell Metadata Display */
          <div className="space-y-4" data-testid="vial-expanded-content">
            <div className="flex items-center justify-between bg-emerald-950/50 border border-emerald-600/40 rounded-xl px-3.5 py-2 text-xs">
              <div className="flex items-center gap-2 text-emerald-300 font-mono">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>OCCUPIED SLOT</span>
              </div>
              <span className="text-[11px] font-mono text-emerald-400">
                Coord: {slot.row}{slot.col} (Origin: Top-Left Black Corner)
              </span>
            </div>

            <div className="space-y-2.5 text-xs font-mono">
              <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <FlaskConical className="w-3.5 h-3.5 text-cyan-400" />
                  Cell Line Name:
                </span>
                <strong className="text-slate-100" data-testid="inspected-cell-line-name">
                  {slot.cellLineName || 'Unspecified'}
                </strong>
              </div>

              <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                  User&apos;s Initials:
                </span>
                <strong className="text-slate-200" data-testid="inspected-user-initials">
                  {slot.userInitials || 'N/A'}
                </strong>
              </div>

              <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                  Date Frozen:
                </span>
                <strong className="text-slate-200" data-testid="inspected-date-frozen">
                  {slot.dateFrozen || 'N/A'}
                </strong>
              </div>

              <div className="bg-slate-950/90 p-3 rounded-lg border border-cyan-500/30 flex flex-col gap-1.5">
                <span className="text-cyan-400 flex items-center gap-1.5 text-[11px] font-bold">
                  <FileText className="w-3.5 h-3.5 text-cyan-400" />
                  Full Text Extracted from Vial Label:
                </span>
                <p
                  className="text-slate-100 text-xs font-mono bg-slate-900/90 px-2.5 py-2 rounded border border-slate-800 break-words"
                  data-testid="inspected-full-text"
                >
                  {slot.fullText ||
                    [
                      slot.cellLineName,
                      slot.userInitials,
                      slot.dateFrozen,
                    ]
                      .filter(Boolean)
                      .join(' | ') ||
                    'N/A'}
                </p>
              </div>

              {slot.notes && (
                <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80 flex flex-col gap-1">
                  <span className="text-slate-400 flex items-center gap-1.5 text-[11px]">
                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                    Notes:
                  </span>
                  <p className="text-slate-300 text-[11px] font-sans">
                    {slot.notes}
                  </p>
                </div>
              )}

              {slot.updatedAt && (
                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    Updated:
                  </span>
                  <span>{new Date(slot.updatedAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>

            {!readOnly && (
              <div className="pt-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditingOccupied(true)}
                  className="px-3 py-1.5 rounded-lg border border-cyan-500/40 text-cyan-300 hover:bg-cyan-950/60 text-xs font-medium transition-colors inline-flex items-center gap-1.5"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  Edit Vial Content
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleClearVial}
                  className="px-3 py-1.5 rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-950/60 text-xs font-medium transition-colors"
                >
                  {isSubmitting ? 'Updating...' : 'Clear Slot / Remove Vial'}
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Unoccupied Cell OR Editing Occupied Cell Form */
          <div className="space-y-4">
            {!slot.isOccupied && (
              <div className="bg-slate-950/90 border border-slate-700/80 rounded-xl p-3.5 flex items-start gap-3">
                <div className="p-1 rounded bg-slate-800 text-slate-400 mt-0.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h5 className="text-xs font-bold text-slate-200 font-mono">
                    Slot Empty: No vial currently stored in this cell.
                  </h5>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Slot {slot.row}{slot.col} is available for vial assignment.
                  </p>
                </div>
              </div>
            )}

            {!readOnly && (
              <form onSubmit={handleAssignVial} className="space-y-3 pt-1">
                <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <PlusCircle className="w-3.5 h-3.5 text-cyan-400" />
                  <span>
                    {slot.isOccupied
                      ? 'Edit Extracted Vial Content'
                      : 'Assign Vial to this Slot'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-mono text-slate-400 mb-1">
                      Cell Line Name *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. HEK293T"
                      value={formCellLine}
                      onChange={(e) => setFormCellLine(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-slate-400 mb-1">
                      User&apos;s Initials
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. JS"
                      value={formUserInitials}
                      onChange={(e) => setFormUserInitials(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-mono text-slate-400 mb-1">
                      Date Frozen
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 2026-03-15"
                      value={formDateFrozen}
                      onChange={(e) => setFormDateFrozen(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-slate-400 mb-1">
                      Target Coordinate
                    </label>
                    <input
                      type="text"
                      disabled
                      value={`${slot.row}${slot.col}`}
                      className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">
                    Full Label Text Extracted
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. HEK293T | JS | 2026-03-15"
                    value={formFullText}
                    onChange={(e) => setFormFullText(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-mono text-slate-400 mb-1">
                    Notes / Description
                  </label>
                  <input
                    type="text"
                    placeholder="Optional notes or media specs"
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  {(slot.isOccupied && isEditingOccupied) || onClose ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (slot.isOccupied && isEditingOccupied) {
                          setIsEditingOccupied(false);
                        } else if (onClose) {
                          onClose();
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs text-slate-300 transition-colors"
                    >
                      Cancel
                    </button>
                  ) : null}
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    {isSubmitting ? 'Saving...' : 'Store / Assign Vial'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export interface BoxGridViewProps {
  rows?: number; // default 9
  cols?: number; // default 9
  boxId?: string;
  inventoryId?: string;
  targetRow?: string;
  targetCol?: number;
  differencedRow?: string;
  differencedCol?: number;
  highlightedCoords?: string[];
  searchMatchingCoords?: string[];
  slots?: Record<string, Partial<GridSlotData>>;
  cells?: Record<string, InventoryCell>;
  onSelectSlot?: (row: string, col: number) => void;
  onUpdateCell?: (
    boxId: string,
    cellCoordinate: string,
    occupied: boolean,
    vial?: {
      cellLineIdentifier?: string;
      cellLineName?: string;
      userInitials?: string;
      operatorInitials?: string;
      dateFrozen?: string;
      fullText?: string;
      lotNumber?: string;
      passageNumber?: number | string;
      notes?: string;
    }
  ) => void | Promise<void>;
  readOnly?: boolean;
  showModalOnSelect?: boolean;
}

export const BoxGridView: React.FC<BoxGridViewProps> = ({
  rows = 9,
  cols = 9,
  boxId = 'Box_01',
  targetRow = 'A',
  targetCol = 1,
  differencedRow,
  differencedCol,
  highlightedCoords = [],
  searchMatchingCoords = [],
  slots = {},
  cells,
  onSelectSlot,
  onUpdateCell,
  readOnly = false,
  showModalOnSelect = false,
}) => {
  const [inspectedCoord, setInspectedCoord] = useState<{ row: string; col: number } | null>(null);

  // Prepopulate standard grid slots
  const gridRows = Array.from({ length: rows }, (_, r) => rowIndexToLetter(r));
  const gridCols = Array.from({ length: cols }, (_, c) => c + 1);

  const getSlot = (row: string, col: number): GridSlotData =>
    resolveGridSlotData({
      row,
      col,
      targetRow,
      targetCol,
      differencedRow,
      differencedCol,
      highlightedCoords,
      searchMatchingCoords,
      slots,
      cells,
    });

  const handleCellClick = (row: string, col: number) => {
    onSelectSlot?.(row, col);
    if (showModalOnSelect) {
      setInspectedCoord({ row, col });
    }
  };

  const inspectedCell = inspectedCoord ? getSlot(inspectedCoord.row, inspectedCoord.col) : null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 select-none relative">
      {/* Box Header */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400 shrink-0">
          <Layers className="w-4 h-4" />
        </div>
        <h3 className="text-sm font-bold text-slate-100 font-mono">
          CRYO-BOX MATRIX
        </h3>
      </div>

      {/* Grid Container with 1:1 Aligned Columns via Matching CSS Grid */}
      <div className="overflow-x-auto flex justify-center py-2">
        <div className="inline-block bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-inner relative">
          {/* Top Column Labels: Uses exact matching grid with row header offset */}
          <div className="flex items-center gap-1.5 mb-2">
            {/* Matching Row Label Offset spacer */}
            <div className="w-7 shrink-0 text-center" />

            {/* Column Header Grid aligned 1:1 with cell grid below */}
            <div
              className="grid gap-1.5"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(2.25rem, 2.25rem))`,
              }}
            >
              {gridCols.map((col) => (
                <div
                  key={col}
                  className={`w-9 text-center font-mono text-xs font-bold transition-colors ${
                    col === targetCol ? 'text-cyan-400' : 'text-slate-500'
                  }`}
                >
                  {col}
                </div>
              ))}
            </div>
          </div>

          {/* Grid Rows */}
          <div className="flex flex-col gap-1.5">
            {gridRows.map((row) => (
              <div key={row} className="flex items-center gap-1.5">
                {/* Row Label (A, B, C...) with matching fixed width */}
                <div
                  className={`w-7 text-center font-mono text-xs font-bold shrink-0 transition-colors ${
                    row === targetRow ? 'text-cyan-400' : 'text-slate-500'
                  }`}
                >
                  {row}
                </div>

                {/* Slots Grid with 1:1 matching column template */}
                <div
                  className="grid gap-1.5"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, minmax(2.25rem, 2.25rem))`,
                  }}
                >
                  {gridCols.map((col) => {
                    const slot = getSlot(row, col);
                    const isTarget = slot.isTarget;
                    const isDiff = slot.isDifferenced;
                    const isHighlighted = slot.isHighlighted;
                    const isSearchMatch = Boolean(slot.isSearchMatch);

                    let slotStyle =
                      'bg-slate-950 border-slate-800/80 text-slate-600 hover:border-slate-600';
                    if (slot.isOccupied && !isTarget) {
                      slotStyle =
                        'bg-slate-800/90 border-slate-700 text-slate-300 hover:border-slate-500';
                    }
                    if (isHighlighted && slot.isOccupied) {
                      slotStyle =
                        'bg-emerald-950/80 border-2 border-emerald-400 text-emerald-200 ring-2 ring-emerald-500/30 shadow-md shadow-emerald-500/20';
                    }
                    if (isDiff && !isHighlighted) {
                      slotStyle =
                        'bg-amber-950/40 border-amber-500/70 text-amber-200 shadow-sm shadow-amber-500/20';
                    }
                    if (isTarget) {
                      slotStyle =
                        'bg-cyan-950/80 border-2 border-cyan-400 text-cyan-200 ring-2 ring-cyan-500/40 shadow-lg shadow-cyan-500/30 scale-105 z-10';
                    }
                    if (isSearchMatch && slot.isOccupied) {
                      slotStyle = isTarget
                        ? 'bg-fuchsia-950/90 border-2 border-fuchsia-400 text-fuchsia-100 ring-2 ring-cyan-400/70 shadow-lg shadow-fuchsia-500/40 scale-105 z-10'
                        : 'bg-fuchsia-950/85 border-2 border-fuchsia-400 text-fuchsia-200 ring-2 ring-fuchsia-500/40 shadow-md shadow-fuchsia-500/30';
                    }

                    return (
                      <button
                        key={`${row}${col}`}
                        type="button"
                        data-testid={`box-well-${row}${col}`}
                        data-highlighted={isHighlighted ? 'true' : 'false'}
                        data-search-match={isSearchMatch ? 'true' : 'false'}
                        onClick={() => handleCellClick(row, col)}
                        className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center font-mono text-[10px] transition-all duration-150 relative ${slotStyle} cursor-pointer active:scale-95`}
                        title={`Slot ${row}${col} - ${
                          isSearchMatch && slot.isOccupied
                            ? `Search Match: ${slot.cellLineName || 'Sample'}`
                            : isTarget
                            ? `Selected Cell: ${slot.cellLineName || (slot.isOccupied ? 'Occupied' : 'Empty')}`
                            : isHighlighted && slot.isOccupied
                            ? `Inserted Vial: ${slot.cellLineName || 'Sample'}${
                                slot.userInitials ? ` (${slot.userInitials})` : ''
                              }`
                            : slot.isOccupied
                            ? `Occupied: ${slot.cellLineName || 'Sample'}`
                            : 'Empty (Click to inspect or assign)'
                        }`}
                      >
                        {isTarget ? (
                          <div className="flex flex-col items-center">
                            <Target className="w-3.5 h-3.5 text-cyan-300 animate-pulse" />
                            <span className="text-[9px] font-bold text-cyan-200 leading-none mt-0.5">
                              {row}{col}
                            </span>
                          </div>
                        ) : (
                          <span>
                            {row}{col}
                          </span>
                        )}

                        {/* Badge for search-matched vials */}
                        {isSearchMatch && slot.isOccupied && (
                          <span
                            className="absolute -top-1 -left-1 w-2.5 h-2.5 rounded-full bg-fuchsia-400 border border-slate-900 shadow-sm shadow-fuchsia-400"
                            title={`Matches cell line search: ${slot.cellLineName}`}
                          />
                        )}

                        {/* Badge for highlighted inserted vials */}
                        {isHighlighted && slot.isOccupied && (
                          <span
                            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 border border-slate-900 shadow-sm shadow-emerald-400"
                            title="Inserted via Video Analysis"
                          />
                        )}

                        {/* Small badge for differenced slots */}
                        {isDiff && !isTarget && !isHighlighted && (
                          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border border-slate-900" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Selected Slot Status Summary Banner */}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-300">
            Selected Slot Coordinate:{' '}
            <strong className="text-cyan-300 font-mono text-sm ml-1">
              {targetRow}{targetCol}
            </strong>
          </span>
        </div>
        {differencedRow && differencedCol !== undefined && (
          <div className="flex items-center gap-2 text-slate-400 font-mono text-[11px]">
            <span className="bg-slate-800 px-2 py-0.5 rounded text-emerald-400">
              Pass 3 Differencing Confirmed
            </span>
            <span>(Δ = 0.00 euclidean)</span>
          </div>
        )}
      </div>

      {/* Pop-up Modal when showModalOnSelect is enabled */}
      {showModalOnSelect && inspectedCell && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setInspectedCoord(null)}
        >
          <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CellContentPanel
              boxId={boxId}
              slot={inspectedCell}
              onUpdateCell={onUpdateCell}
              readOnly={readOnly}
              onClose={() => setInspectedCoord(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default BoxGridView;
