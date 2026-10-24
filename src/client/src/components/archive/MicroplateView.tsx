import React from 'react';
import { rowIndexToLetter } from '../../utils/coordinates';
import { Pipette, CheckCircle2, Circle, AlertCircle, Droplets } from 'lucide-react';

interface MicroplateViewProps {
  seededColumns?: number[]; // e.g. [1, 2, 3, 4, 5, 6]
  volumePerWellUls?: number; // e.g. 100 uL
  onToggleColumn?: (columnNumber: number) => void;
  onToggleWell?: (row: string, col: number) => void;
  readOnly?: boolean;
}

export const MicroplateView: React.FC<MicroplateViewProps> = ({
  seededColumns = [1, 2, 3, 4, 5, 6],
  volumePerWellUls = 100,
  onToggleColumn,
  onToggleWell,
  readOnly = false,
}) => {
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const cols = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  const isColumnSeeded = (col: number) => seededColumns.includes(col);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 select-none">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-400">
            <Droplets className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-mono">
              <span>96-WELL MICROPLATE MATRIX</span>
              <span className="text-[11px] font-normal text-slate-400">(8 Rows A–H × 12 Columns 1–12)</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Visual confirmation of 8-channel multichannel pipette aspiration and seeding
            </p>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-[11px] font-mono">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-emerald-500/20 border-2 border-emerald-400 shadow-sm shadow-emerald-500/30" />
            <span className="text-emerald-300">Seeded ({volumePerWellUls} µL)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full bg-slate-950 border border-slate-800" />
            <span className="text-slate-500">Unseeded Well</span>
          </div>
        </div>
      </div>

      {/* 96-well Matrix Grid */}
      <div className="overflow-x-auto flex justify-center py-2">
        <div className="inline-block bg-slate-950 p-4 rounded-xl border border-slate-800 shadow-inner">
          {/* 8-Channel Pipette Column Controls Header */}
          <div className="flex mb-2 ml-7 gap-1.5">
            {cols.map((col) => {
              const seeded = isColumnSeeded(col);
              return (
                <button
                  key={col}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onToggleColumn && onToggleColumn(col)}
                  className={`w-7 py-1 rounded flex flex-col items-center justify-center font-mono text-[10px] transition-all border ${
                    seeded
                      ? 'bg-emerald-950/80 border-emerald-500/80 text-emerald-300 shadow-sm shadow-emerald-950'
                      : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-600'
                  } ${!readOnly ? 'cursor-pointer hover:scale-105' : 'cursor-default'}`}
                  title={`Click to toggle 8-channel seeding for Column ${col}`}
                >
                  <Pipette className="w-2.5 h-2.5 mb-0.5" />
                  <span>{col}</span>
                </button>
              );
            })}
          </div>

          {/* Plate Rows */}
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div key={row} className="flex items-center gap-1.5">
                {/* Row Letter Header (A-H) */}
                <div className="w-6 text-center font-mono text-xs font-bold text-slate-400">
                  {row}
                </div>

                {/* Wells in Row */}
                {cols.map((col) => {
                  const seeded = isColumnSeeded(col);
                  return (
                    <button
                      key={`${row}${col}`}
                      type="button"
                      disabled={readOnly}
                      onClick={() => onToggleWell && onToggleWell(row, col)}
                      className={`w-7 h-7 rounded-full border flex items-center justify-center font-mono text-[9px] transition-all duration-150 ${
                        seeded
                          ? 'bg-emerald-950/90 border-2 border-emerald-400 text-emerald-200 shadow-sm shadow-emerald-500/20'
                          : 'bg-slate-950 border-slate-800/90 text-slate-600 hover:border-slate-600'
                      } ${!readOnly ? 'cursor-pointer active:scale-90' : 'cursor-default'}`}
                      title={`Well ${row}${col} - ${
                        seeded ? `Seeded (${volumePerWellUls} µL)` : 'Empty'
                      }`}
                    >
                      {seeded ? (
                        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      ) : (
                        <span className="text-[8px] opacity-40">{col}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Multichannel Seeding Status Summary */}
      <div className="bg-slate-950/70 border border-slate-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span className="text-slate-300">
            8-Way Pipette Seeding:{' '}
            <strong className="text-emerald-300 font-mono ml-1">
              Columns {seededColumns.join(', ')} ({seededColumns.length * 8} Wells Confirmed)
            </strong>
          </span>
        </div>
        <div className="flex items-center gap-2 text-slate-400 font-mono text-[11px]">
          <span className="bg-slate-800 px-2 py-0.5 rounded text-cyan-400">
            Aspiration: {volumePerWellUls} µL / Channel
          </span>
        </div>
      </div>
    </div>
  );
};

export default MicroplateView;

