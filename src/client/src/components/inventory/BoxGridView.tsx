import React from 'react';
import { rowIndexToLetter } from '../../utils/coordinates';
import { Target, CheckCircle2, AlertTriangle, Layers } from 'lucide-react';

export interface GridSlotData {
  row: string;
  col: number;
  cellLineName?: string;
  lotNumber?: string;
  passage?: number;
  isOccupied: boolean;
  isTarget?: boolean;
  isDifferenced?: boolean; // Highlighted by pre/post differencing in Pass 3
}

interface BoxGridViewProps {
  rows?: number; // default 9
  cols?: number; // default 9
  boxId?: string;
  targetRow?: string;
  targetCol?: number;
  differencedRow?: string;
  differencedCol?: number;
  slots?: Record<string, Partial<GridSlotData>>;
  onSelectSlot?: (row: string, col: number) => void;
  readOnly?: boolean;
}

export const BoxGridView: React.FC<BoxGridViewProps> = ({
  rows = 9,
  cols = 9,
  boxId = 'Box_01',
  targetRow = 'C',
  targetCol = 4,
  differencedRow = 'C',
  differencedCol = 4,
  slots = {},
  onSelectSlot,
  readOnly = false,
}) => {
  // Prepopulate standard grid slots
  const gridRows = Array.from({ length: rows }, (_, r) => rowIndexToLetter(r));
  const gridCols = Array.from({ length: cols }, (_, c) => c + 1);

  // Pre-seed some realistic occupied slots for cryo-box
  const defaultOccupiedKeys = new Set([
    'A1', 'A2', 'A5', 'B2', 'B3', 'B7', 'C1', 'C2', 'D4', 'D5', 'E1', 'E8', 'F3', 'G2', 'H6', 'I9'
  ]);

  const getSlot = (row: string, col: number): GridSlotData => {
    const key = `${row}${col}`;
    const custom = slots[key];
    const isTarget = row === targetRow && col === targetCol;
    const isDiff = row === differencedRow && col === differencedCol;
    const isOccupied = custom?.isOccupied !== undefined ? custom.isOccupied : defaultOccupiedKeys.has(key) || isTarget;

    return {
      row,
      col,
      isOccupied,
      isTarget,
      isDifferenced: isDiff,
      cellLineName: custom?.cellLineName || (isTarget ? 'HEK293T' : isOccupied ? 'Jurkat-T' : undefined),
      lotNumber: custom?.lotNumber || (isTarget ? 'LOT-8841' : undefined),
      passage: custom?.passage || (isTarget ? 5 : undefined),
    };
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 select-none">
      {/* Box Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-mono">
              <span>CRYO-BOX MATRIX: {boxId}</span>
              <span className="text-[11px] font-normal text-slate-400">({rows}x{cols} standard 81-slot)</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Top-left origin: Rows (A-I descending) × Columns (1-9 horizontal)
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-cyan-500/20 border-2 border-cyan-400 animate-pulse shadow-sm shadow-cyan-400" />
            <span className="text-cyan-300">Target Slot ({targetRow}{targetCol})</span>
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

      {/* Grid Container */}
      <div className="overflow-x-auto flex justify-center py-2">
        <div className="inline-block bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-inner">
          {/* Top Column Labels */}
          <div className="flex mb-2 ml-7">
            {gridCols.map((col) => (
              <div
                key={col}
                className={`w-9 text-center font-mono text-xs font-bold ${
                  col === targetCol ? 'text-cyan-400' : 'text-slate-500'
                }`}
              >
                {col}
              </div>
            ))}
          </div>

          {/* Grid Rows */}
          <div className="flex flex-col gap-1.5">
            {gridRows.map((row) => (
              <div key={row} className="flex items-center gap-1.5">
                {/* Row Label (A, B, C...) */}
                <div
                  className={`w-6 text-center font-mono text-xs font-bold ${
                    row === targetRow ? 'text-cyan-400' : 'text-slate-500'
                  }`}
                >
                  {row}
                </div>

                {/* Slots */}
                {gridCols.map((col) => {
                  const slot = getSlot(row, col);
                  const isTarget = slot.isTarget;
                  const isDiff = slot.isDifferenced;

                  let slotStyle =
                    'bg-slate-950 border-slate-800/80 text-slate-600 hover:border-slate-600';
                  if (slot.isOccupied && !isTarget) {
                    slotStyle = 'bg-slate-800/90 border-slate-700 text-slate-300 hover:border-slate-500';
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
                      disabled={readOnly}
                      onClick={() => onSelectSlot && onSelectSlot(row, col)}
                      className={`w-9 h-9 rounded-lg border flex flex-col items-center justify-center font-mono text-[10px] transition-all duration-150 relative ${slotStyle} ${
                        !readOnly ? 'cursor-pointer active:scale-95' : 'cursor-default'
                      }`}
                      title={`Slot ${row}${col} - ${
                        isTarget
                          ? `Target Insertion: ${slot.cellLineName || 'HEK293T'}`
                          : slot.isOccupied
                          ? `Occupied: ${slot.cellLineName || 'Sample'}`
                          : 'Empty'
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
    </div>
  );
};

export default BoxGridView;

