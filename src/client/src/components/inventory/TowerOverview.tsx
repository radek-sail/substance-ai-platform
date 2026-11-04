import React from 'react';
import { Layers, Server, Box } from 'lucide-react';
import type { InventoryRecord } from '@sail/shared';

interface TowerOverviewProps {
  inventory: InventoryRecord | null;
  selectedBoxId: string | null;
  onSelectBox: (boxId: string) => void;
  matchingBoxIds?: string[];
  matchingBoxCounts?: Record<string, number>;
  searchQuery?: string;
}

export const TowerOverview: React.FC<TowerOverviewProps> = ({
  inventory,
  selectedBoxId,
  onSelectBox,
  matchingBoxIds = [],
  matchingBoxCounts = {},
  searchQuery = '',
}) => {
  if (!inventory) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col items-center justify-center min-h-[260px] text-slate-400">
        <Server className="w-8 h-8 text-cyan-400/60 mb-2 animate-pulse" />
        <p className="text-xs font-mono">No inventory selected</p>
      </div>
    );
  }

  // Group boxes by tower label (A, B, C...)
  const towerMap: Record<string, string[]> = {};
  for (let t = 0; t < inventory.towersCount; t++) {
    const towerLabel = String.fromCharCode(65 + t);
    towerMap[towerLabel] = [];
    for (let b = 1; b <= inventory.boxesPerTower; b++) {
      towerMap[towerLabel].push(`${towerLabel}-${b}`);
    }
  }

  const towers = Object.keys(towerMap);
  const hasActiveSearch = Boolean(searchQuery.trim());

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 select-none">
      {/* Overview Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-3 gap-2">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400 shrink-0">
            <Server className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-mono">
              <span>RACK & TOWER OVERVIEW</span>
              <span className="text-[11px] font-normal text-cyan-400">
                [{inventory.name}]
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Interactive rack layout: Select a box tile to inspect and edit its grid matrix below
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          {hasActiveSearch && (
            <span className="inline-flex items-center gap-1.5 bg-fuchsia-950/80 px-2.5 py-1 rounded-lg border border-fuchsia-500/40 text-fuchsia-300">
              <span className="w-2.5 h-2.5 rounded-sm bg-fuchsia-500/40 border border-fuchsia-400 inline-block" />
              Search Match ({matchingBoxIds.length}{' '}
              {matchingBoxIds.length === 1 ? 'box' : 'boxes'})
            </span>
          )}
          <span className="bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800 text-slate-400">
            Selected Box:{' '}
            <strong className="text-cyan-300 font-bold ml-1">{selectedBoxId || 'None'}</strong>
          </span>
        </div>
      </div>

      {/* Horizontal Towers Rack Visualization */}
      <div className="overflow-x-auto pb-2">
        <div className="flex items-start gap-4 min-w-max py-1">
          {towers.map((towerLabel) => {
            const boxIds = towerMap[towerLabel];
            return (
              <div
                key={towerLabel}
                className="flex flex-col bg-slate-950/70 border border-slate-800/90 rounded-xl p-3 min-w-[140px] max-w-[170px] gap-2 shadow-inner"
              >
                {/* Tower Pillar Header */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold font-mono text-cyan-300">
                    <Layers className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Tower {towerLabel}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">
                    {boxIds.length} boxes
                  </span>
                </div>

                {/* Box Tiles in this Tower Column */}
                <div className="flex flex-col gap-1.5">
                  {boxIds.map((boxId) => {
                    const box = inventory.boxes?.[boxId];
                    const isSelected = boxId === selectedBoxId;
                    const matchCount = matchingBoxCounts[boxId] ?? 0;
                    const isSearchMatch =
                      hasActiveSearch && (matchingBoxIds.includes(boxId) || matchCount > 0);

                    // Calculate occupied count
                    let occupiedCount = 0;
                    const totalSlots =
                      (box?.rows || inventory.rowsPerBox) * (box?.cols || inventory.colsPerBox);
                    if (box && box.cells) {
                      for (const cell of Object.values(box.cells)) {
                        if (cell.occupied) occupiedCount++;
                      }
                    }

                    let tileStyle =
                      'bg-slate-900/80 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-800/70 hover:text-slate-100';
                    if (isSelected && isSearchMatch) {
                      tileStyle =
                        'bg-fuchsia-950/90 border-2 border-fuchsia-400 text-fuchsia-100 ring-2 ring-cyan-400/70 shadow-md shadow-fuchsia-950/70 scale-[1.02]';
                    } else if (isSearchMatch) {
                      tileStyle =
                        'bg-fuchsia-950/80 border-2 border-fuchsia-400 text-fuchsia-100 ring-2 ring-fuchsia-500/40 shadow-md shadow-fuchsia-950/60 hover:bg-fuchsia-900/80';
                    } else if (isSelected) {
                      tileStyle =
                        'bg-cyan-950/90 border-cyan-400 text-cyan-100 ring-2 ring-cyan-500/40 shadow-md shadow-cyan-950/60 scale-[1.02]';
                    }

                    return (
                      <button
                        key={boxId}
                        type="button"
                        data-testid={`tower-box-${boxId}`}
                        data-search-match={isSearchMatch ? 'true' : 'false'}
                        onClick={() => onSelectBox(boxId)}
                        className={`w-full text-left px-2.5 py-2 rounded-lg border font-mono text-xs transition-all duration-150 flex items-center justify-between group cursor-pointer relative ${tileStyle}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Box
                            className={`w-3.5 h-3.5 transition-colors ${
                              isSearchMatch
                                ? 'text-fuchsia-300'
                                : isSelected
                                ? 'text-cyan-300'
                                : 'text-slate-500 group-hover:text-cyan-400'
                            }`}
                          />
                          <span className="font-bold">{boxId}</span>
                        </div>

                        <div className="flex items-center gap-1">
                          {isSearchMatch && matchCount > 0 && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-600/40 border border-fuchsia-400/60 text-fuchsia-100 font-bold"
                              title={`${matchCount} matching cell line ${
                                matchCount === 1 ? 'vial' : 'vials'
                              } in box ${boxId}`}
                            >
                              {matchCount} match
                            </span>
                          )}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              occupiedCount > 0
                                ? isSearchMatch
                                  ? 'bg-fuchsia-900/60 text-fuchsia-200'
                                  : isSelected
                                  ? 'bg-cyan-800/60 text-cyan-200'
                                  : 'bg-slate-800 text-slate-400'
                                : 'text-slate-600'
                            }`}
                          >
                            {occupiedCount > 0 ? `${occupiedCount}/${totalSlots}` : 'empty'}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TowerOverview;
