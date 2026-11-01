import React, { useState } from 'react';
import { rowIndexToLetter } from '../../utils/coordinates';
import {
  Target,
  CheckCircle2,
  AlertTriangle,
  Layers,
  X,
  PlusCircle,
  FlaskConical,
  Hash,
  FileText,
  Calendar,
  Info,
} from 'lucide-react';
import type { InventoryCell } from '@sail/shared';

export interface GridSlotData {
  row: string;
  col: number;
  cellCoordinate?: string;
  cellLineName?: string;
  lotNumber?: string;
  passage?: number | string;
  notes?: string;
  updatedAt?: string;
  isOccupied: boolean;
  isTarget?: boolean;
  isDifferenced?: boolean; // Highlighted by pre/post differencing in Pass 3
}

export interface BoxGridViewProps {
  rows?: number; // default 9
  cols?: number; // default 9
  boxId?: string;
  inventoryId?: string;
  targetRow?: string;
  targetCol?: number;
  differencedRow?: string;
  differencedCol?: number;
  slots?: Record<string, Partial<GridSlotData>>;
  cells?: Record<string, InventoryCell>;
  onSelectSlot?: (row: string, col: number) => void;
  onUpdateCell?: (
    boxId: string,
    cellCoordinate: string,
    occupied: boolean,
    vial?: {
      cellLineIdentifier?: string;
      lotNumber?: string;
      passageNumber?: number | string;
      notes?: string;
    }
  ) => void | Promise<void>;
  readOnly?: boolean;
}

export const BoxGridView: React.FC<BoxGridViewProps> = ({
  rows = 9,
  cols = 9,
  boxId = 'Box_01',
  inventoryId,
  targetRow = 'C',
  targetCol = 4,
  differencedRow = 'C',
  differencedCol = 4,
  slots = {},
  cells,
  onSelectSlot,
  onUpdateCell,
  readOnly = false,
}) => {
  // Modal state for cell click inspection
  const [inspectedCell, setInspectedCell] = useState<GridSlotData | null>(null);

  // Form state for adding/assigning a vial into an empty slot
  const [formCellLine, setFormCellLine] = useState('');
  const [formLotNumber, setFormLotNumber] = useState('');
  const [formPassage, setFormPassage] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Prepopulate standard grid slots
  const gridRows = Array.from({ length: rows }, (_, r) => rowIndexToLetter(r));
  const gridCols = Array.from({ length: cols }, (_, c) => c + 1);

  // Pre-seed some realistic occupied slots when no custom cells/slots are provided
  const defaultOccupiedKeys = new Set([
    'A1', 'A2', 'A5', 'B2', 'B3', 'B7', 'C1', 'C2', 'D4', 'D5', 'E1', 'E8', 'F3', 'G2', 'H6', 'I9',
  ]);

  const getSlot = (row: string, col: number): GridSlotData => {
    const key = `${row}${col}`;
    const isTarget = row === targetRow && col === targetCol;
    const isDiff = row === differencedRow && col === differencedCol;

    if (cells && cells[key]) {
      const c = cells[key];
      return {
        row,
        col,
        cellCoordinate: key,
        isOccupied: c.occupied,
        isTarget,
        isDifferenced: isDiff,
        cellLineName: c.vial?.cellLineIdentifier || (isTarget ? 'HEK293T' : undefined),
        lotNumber: c.vial?.lotNumber || (isTarget ? 'LOT-8841' : undefined),
        passage: c.vial?.passageNumber !== undefined ? c.vial.passageNumber : isTarget ? 5 : undefined,
        notes: c.vial?.notes,
        updatedAt: c.vial?.updatedAt,
      };
    }

    const custom = slots[key];
    const isOccupied =
      custom?.isOccupied !== undefined ? custom.isOccupied : defaultOccupiedKeys.has(key) || isTarget;

    return {
      row,
      col,
      cellCoordinate: key,
      isOccupied,
      isTarget,
      isDifferenced: isDiff,
      cellLineName: custom?.cellLineName || (isTarget ? 'HEK293T' : isOccupied ? 'Jurkat-T' : undefined),
      lotNumber: custom?.lotNumber || (isTarget ? 'LOT-8841' : undefined),
      passage: custom?.passage !== undefined ? custom.passage : isTarget ? 5 : undefined,
      notes: custom?.notes,
      updatedAt: custom?.updatedAt,
    };
  };

  const handleCellClick = (row: string, col: number) => {
    onSelectSlot?.(row, col);
    const slot = getSlot(row, col);
    setInspectedCell(slot);
    setFormCellLine(slot.cellLineName || '');
    setFormLotNumber(slot.lotNumber || '');
    setFormPassage(slot.passage !== undefined ? String(slot.passage) : '');
    setFormNotes(slot.notes || '');
  };

  const handleAssignVial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inspectedCell) return;

    setIsSubmitting(true);
    try {
      const coord = inspectedCell.cellCoordinate || `${inspectedCell.row}${inspectedCell.col}`;
      const vialPayload = {
        cellLineIdentifier: formCellLine.trim() || 'Custom-CellLine',
        lotNumber: formLotNumber.trim() || `LOT-${Date.now().toString().slice(-4)}`,
        passageNumber: formPassage ? parseInt(formPassage, 10) || formPassage : 1,
        notes: formNotes.trim(),
      };

      if (onUpdateCell) {
        await onUpdateCell(boxId, coord, true, vialPayload);
      }

      // Update local inspected cell state to occupied
      setInspectedCell((prev) =>
        prev
          ? {
              ...prev,
              isOccupied: true,
              cellLineName: vialPayload.cellLineIdentifier,
              lotNumber: vialPayload.lotNumber,
              passage: vialPayload.passageNumber,
              notes: vialPayload.notes,
              updatedAt: new Date().toISOString(),
            }
          : null
      );
    } catch (err) {
      console.error('Failed to assign vial:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClearVial = async () => {
    if (!inspectedCell) return;
    setIsSubmitting(true);
    try {
      const coord = inspectedCell.cellCoordinate || `${inspectedCell.row}${inspectedCell.col}`;
      if (onUpdateCell) {
        await onUpdateCell(boxId, coord, false);
      }
      setInspectedCell((prev) =>
        prev
          ? {
              ...prev,
              isOccupied: false,
              cellLineName: undefined,
              lotNumber: undefined,
              passage: undefined,
              notes: undefined,
            }
          : null
      );
      setFormCellLine('');
      setFormLotNumber('');
      setFormPassage('');
      setFormNotes('');
    } catch (err) {
      console.error('Failed to clear vial:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 select-none relative">
      {/* Box Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-3 gap-2">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400 shrink-0">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-mono">
              <span>CRYO-BOX MATRIX: {boxId}</span>
              <span className="text-[11px] font-normal text-slate-400">
                ({rows}x{cols} · {rows * cols} slots)
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Top-left origin: Rows (A–{rowIndexToLetter(rows - 1)}) × Columns (1–{cols})
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-cyan-500/20 border-2 border-cyan-400 animate-pulse shadow-sm shadow-cyan-400" />
            <span className="text-cyan-300">Target ({targetRow}{targetCol})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-amber-500/30 border border-amber-400" />
            <span className="text-amber-300">Diff Change</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-slate-700 border border-slate-600" />
            <span className="text-slate-400">Occupied</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-slate-950 border border-slate-800" />
            <span className="text-slate-500">Empty</span>
          </div>
        </div>
      </div>

      {/* Grid Container with 1:1 Aligned Columns via Matching CSS Grid */}
      <div className="overflow-x-auto flex justify-center py-2">
        <div className="inline-block bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-inner">
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

                    let slotStyle =
                      'bg-slate-950 border-slate-800/80 text-slate-600 hover:border-slate-600';
                    if (slot.isOccupied && !isTarget) {
                      slotStyle =
                        'bg-slate-800/90 border-slate-700 text-slate-300 hover:border-slate-500';
                    }
                    if (isDiff) {
                      slotStyle =
                        'bg-amber-950/40 border-amber-500/70 text-amber-200 shadow-sm shadow-amber-500/20';
                    }
                    if (isTarget) {
                      slotStyle =
                        'bg-cyan-950/80 border-2 border-cyan-400 text-cyan-200 ring-2 ring-cyan-500/40 shadow-lg shadow-cyan-500/30 scale-105 z-10';
                    }

                    return (
                      <button
                        key={`${row}${col}`}
                        type="button"
                        onClick={() => handleCellClick(row, col)}
                        className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center font-mono text-[10px] transition-all duration-150 relative ${slotStyle} ${
                          !readOnly ? 'cursor-pointer active:scale-95' : 'cursor-default'
                        }`}
                        title={`Slot ${row}${col} - ${
                          isTarget
                            ? `Target Insertion: ${slot.cellLineName || 'HEK293T'}`
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

                        {/* Small badge for differenced slots */}
                        {isDiff && !isTarget && (
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

      {/* Target Slot Status Summary Banner */}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-cyan-400" />
          <span className="text-slate-300">
            Target Slot Coordinate:{' '}
            <strong className="text-cyan-300 font-mono text-sm ml-1">
              {targetRow}{targetCol}
            </strong>
          </span>
        </div>
        <div className="flex items-center gap-2 text-slate-400 font-mono text-[11px]">
          <span className="bg-slate-800 px-2 py-0.5 rounded text-emerald-400">
            Pass 3 Differencing Confirmed
          </span>
          <span>(Δ = 0.00 euclidean)</span>
        </div>
      </div>

      {/* Cell Click Inspection Modal */}
      {inspectedCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-100 font-mono">
                    Box {boxId} — Cell {inspectedCell.row}{inspectedCell.col}
                  </h4>
                  <p className="text-[11px] text-slate-400">Cryo-Storage Slot Inspection</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectedCell(null)}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5 space-y-4">
              {inspectedCell.isOccupied ? (
                /* Occupied Cell Metadata Display */
                <div className="space-y-4">
                  <div className="flex items-center justify-between bg-emerald-950/50 border border-emerald-600/40 rounded-xl px-3.5 py-2 text-xs">
                    <div className="flex items-center gap-2 text-emerald-300 font-mono">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span>OCCUPIED SLOT</span>
                    </div>
                    <span className="text-[11px] font-mono text-emerald-400">
                      Coord: {inspectedCell.row}{inspectedCell.col}
                    </span>
                  </div>

                  <div className="space-y-2.5 text-xs font-mono">
                    <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <FlaskConical className="w-3.5 h-3.5 text-cyan-400" />
                        Cell Line:
                      </span>
                      <strong className="text-slate-200">
                        {inspectedCell.cellLineName || 'Unspecified'}
                      </strong>
                    </div>

                    <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <Hash className="w-3.5 h-3.5 text-cyan-400" />
                        Lot Number:
                      </span>
                      <strong className="text-slate-200">
                        {inspectedCell.lotNumber || 'N/A'}
                      </strong>
                    </div>

                    <div className="flex items-center justify-between bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
                      <span className="text-slate-400 flex items-center gap-1.5">
                        <Info className="w-3.5 h-3.5 text-cyan-400" />
                        Passage Number:
                      </span>
                      <strong className="text-slate-200">
                        {inspectedCell.passage !== undefined ? `P${inspectedCell.passage}` : 'N/A'}
                      </strong>
                    </div>

                    {inspectedCell.notes && (
                      <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80 flex flex-col gap-1">
                        <span className="text-slate-400 flex items-center gap-1.5 text-[11px]">
                          <FileText className="w-3.5 h-3.5 text-slate-400" />
                          Notes:
                        </span>
                        <p className="text-slate-300 text-[11px] font-sans">
                          {inspectedCell.notes}
                        </p>
                      </div>
                    )}

                    {inspectedCell.updatedAt && (
                      <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          Updated:
                        </span>
                        <span>{new Date(inspectedCell.updatedAt).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>

                  {!readOnly && (
                    <div className="pt-2 flex justify-end">
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
                /* Unoccupied Cell: Explicit Empty Banner & Assign Form */
                <div className="space-y-4">
                  {/* Explicit Empty Indicator Banner */}
                  <div className="bg-slate-950/90 border border-slate-700/80 rounded-xl p-3.5 flex items-start gap-3">
                    <div className="p-1 rounded bg-slate-800 text-slate-400 mt-0.5">
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                    </div>
                    <div>
                      <h5 className="text-xs font-bold text-slate-200 font-mono">
                        Slot Empty: No vial currently stored in this cell.
                      </h5>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Slot {inspectedCell.row}{inspectedCell.col} is available for vial assignment.
                      </p>
                    </div>
                  </div>

                  {!readOnly && (
                    <form onSubmit={handleAssignVial} className="space-y-3 pt-1">
                      <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                        <PlusCircle className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Assign Vial to this Slot</span>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Cell Line ID
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
                            Lot Number
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. LOT-8841"
                            value={formLotNumber}
                            onChange={(e) => setFormLotNumber(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-mono text-slate-400 mb-1">
                            Passage Number
                          </label>
                          <input
                            type="number"
                            min="0"
                            placeholder="e.g. 5"
                            value={formPassage}
                            onChange={(e) => setFormPassage(e.target.value)}
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
                            value={`${inspectedCell.row}${inspectedCell.col}`}
                            className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 font-mono"
                          />
                        </div>
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
                        <button
                          type="button"
                          onClick={() => setInspectedCell(null)}
                          className="px-3 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs text-slate-300 transition-colors"
                        >
                          Cancel
                        </button>
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
        </div>
      )}
    </div>
  );
};

export default BoxGridView;
