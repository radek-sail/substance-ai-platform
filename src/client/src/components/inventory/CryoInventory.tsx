import React, { useEffect, useState, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { BoxGridView } from './BoxGridView';
import { type HumanEditedVialData } from './VialInspector';
import { InventorySidebar } from './InventorySidebar';
import { TowerOverview } from './TowerOverview';
import {
  apiService,
  type TenantConfig,
  type InventoryRecord,
  type CreateInventoryInput,
} from '../../services/api.service';
import type { Action, Event, Refinement, VideoAnalysisDoc } from '@sail/shared';

/**
 * Builds a local fallback demo inventory if backend is empty or offline.
 */
function buildLocalDemoInventory(): InventoryRecord {
  const towersCount = 3;
  const boxesPerTower = 5;
  const rowsPerBox = 9;
  const colsPerBox = 9;

  const boxes: Record<string, any> = {};
  for (let t = 0; t < towersCount; t++) {
    const towerLabel = String.fromCharCode(65 + t);
    for (let b = 1; b <= boxesPerTower; b++) {
      const boxId = `${towerLabel}-${b}`;
      const cells: Record<string, any> = {};
      for (let r = 0; r < rowsPerBox; r++) {
        const rowLetter = String.fromCharCode(65 + r);
        for (let c = 1; c <= colsPerBox; c++) {
          const coord = `${rowLetter}${c}`;
          cells[coord] = {
            row: rowLetter,
            col: c,
            cellCoordinate: coord,
            occupied: false,
          };
        }
      }
      boxes[boxId] = {
        boxId,
        towerLabel,
        boxNumber: b,
        rows: rowsPerBox,
        cols: colsPerBox,
        cells,
      };
    }
  }

  // Pre-seed some occupied cells in box A-1
  if (boxes['A-1']) {
    const samples = [
      { coord: 'A1', line: 'HEK293T', lot: 'LOT-9001', p: 4 },
      { coord: 'A2', line: 'HEK293T', lot: 'LOT-9001', p: 4 },
      { coord: 'A5', line: 'Jurkat-T', lot: 'LOT-8812', p: 6 },
      { coord: 'B2', line: 'CHO-K1', lot: 'LOT-7740', p: 3 },
      { coord: 'B3', line: 'CHO-K1', lot: 'LOT-7740', p: 3 },
      { coord: 'D4', line: 'HeLa', lot: 'LOT-5510', p: 12 },
      { coord: 'D5', line: 'HeLa', lot: 'LOT-5510', p: 12 },
      { coord: 'E8', line: 'Vero-E6', lot: 'LOT-4419', p: 8 },
      { coord: 'G2', line: 'iPSC-3', lot: 'LOT-1102', p: 2 },
    ];
    for (const s of samples) {
      if (boxes['A-1'].cells[s.coord]) {
        boxes['A-1'].cells[s.coord] = {
          ...boxes['A-1'].cells[s.coord],
          occupied: true,
          highlighted: Boolean((s as any).highlighted),
          lastActionType: (s as any).highlighted ? 'VIAL_INSERTION' : undefined,
          vial: {
            cellLineIdentifier: s.line,
            cellLineName: s.line,
            userInitials: (s as any).userInitials,
            operatorInitials: (s as any).userInitials,
            dateFrozen: (s as any).dateFrozen,
            fullText: (s as any).fullText || `${s.line} | P${s.p} | ${s.lot}`,
            lotNumber: s.lot,
            passageNumber: s.p,
            targetCoordinate: s.coord,
            notes: 'Biobank sample archived in primary cryo tank',
            updatedAt: new Date().toISOString(),
          },
        };
      }
    }
  }

  return {
    id: 'demo-inventory-01',
    name: 'Primary Cryo Tank (BioBank Alpha)',
    towersCount,
    boxesPerTower,
    rowsPerBox,
    colsPerBox,
    createdAt: new Date().toISOString(),
    boxes,
  };
}

export interface CryoInventoryProps {
  activeStream: string;
  tenant: TenantConfig;
  analysis: VideoAnalysisDoc | null;
  selectedAction?: Action;
  events: Event[];
  refinements: Refinement[];
  targetRow: string;
  targetCol: number;
  rawTargetRow: string;
  rawTargetCol: number;
  editedInventoryData: HumanEditedVialData;
  rawAiInventoryData: HumanEditedVialData;
  isSignedOff: boolean;
  signOffVersion?: number;
  onOpenSignOff?: () => void;
  onSelectGridSlot: (row: string, col: number) => void;
  onChangeField: (field: keyof HumanEditedVialData, value: any) => void;
  onResetField: (field: keyof HumanEditedVialData) => void;
  onAnalysisLoaded?: (videoId: string, doc: VideoAnalysisDoc) => void;
  initialInventoryId?: string | null;
  duration?: number;
  currentTime?: number;
  safeActions?: Action[];
  safeEvents?: Event[];
  selectedActionId?: string | null;
  selectedEventId?: string | null;
  onSeek?: (time: number) => void;
  onSelectAction?: (actionId: string) => void;
  onSelectEvent?: (eventId: string) => void;
}

export const CryoInventory: React.FC<CryoInventoryProps> = ({
  activeStream,
  tenant,
  analysis,
  targetRow,
  targetCol,
  rawTargetRow,
  rawTargetCol,
  editedInventoryData,
  isSignedOff,
  signOffVersion = 0,
  onSelectGridSlot,
  onAnalysisLoaded,
  initialInventoryId,
  safeActions,
}) => {
  const [verifiedStreamId, setVerifiedStreamId] = useState<string | null>(null);

  // Multi-Inventory State
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [activeInventoryId, setActiveInventoryId] = useState<string | null>(initialInventoryId || null);
  const [selectedBoxId, setSelectedBoxId] = useState<string>('A-1');
  const [isLoadingInventories, setIsLoadingInventories] = useState(false);

  // Selected Cell Coordinate State for the Right-Hand Cell Content Panel
  const [selectedCellCoord, setSelectedCellCoord] = useState<{ row: string; col: number }>({
    row: 'A',
    col: 1,
  });

  useEffect(() => {
    if (initialInventoryId) {
      setActiveInventoryId(initialInventoryId);
      const found = inventories.find((inv) => inv.id === initialInventoryId);
      if (found && found.boxes) {
        const firstBox = Object.keys(found.boxes)[0] || 'A-1';
        setSelectedBoxId(firstBox);
      }
    }
  }, [initialInventoryId, inventories]);

  // Load inventories on mount & whenever signOffVersion changes
  const loadInventories = async () => {
    setIsLoadingInventories(true);
    try {
      const list = await apiService.fetchInventories({
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });

      if (list && list.length > 0) {
        setInventories(list);
        const targetId =
          initialInventoryId && list.some((inv) => inv.id === initialInventoryId)
            ? initialInventoryId
            : (!activeInventoryId || !list.some((inv) => inv.id === activeInventoryId))
            ? list[0].id
            : activeInventoryId;
        setActiveInventoryId(targetId);
        const targetInv = list.find((inv) => inv.id === targetId) || list[0];
        const firstBox = Object.keys(targetInv.boxes || {})[0] || 'A-1';
        setSelectedBoxId((prev) => (targetInv.boxes?.[prev] ? prev : firstBox));
      } else {
        // Fallback demo inventory when no inventories exist
        const demo = buildLocalDemoInventory();
        setInventories([demo]);
        setActiveInventoryId(demo.id);
        setSelectedBoxId('A-1');
      }
    } catch (err) {
      console.warn('[CryoInventory] Failed to fetch inventories, using fallback demo:', err);
      const demo = buildLocalDemoInventory();
      setInventories([demo]);
      setActiveInventoryId(demo.id);
      setSelectedBoxId('A-1');
    } finally {
      setIsLoadingInventories(false);
    }
  };

  useEffect(() => {
    loadInventories();
  }, [tenant.customerId, tenant.databaseId, signOffVersion]);

  // Also sync committed editedInventoryData into local state when isSignedOff becomes true
  useEffect(() => {
    if (!isSignedOff) return;
    const coord =
      editedInventoryData.targetCoordinate ||
      `${targetRow || 'C'}${targetCol || 4}`;
    setInventories((prevList) =>
      prevList.map((inv) => {
        const boxKeys = Object.keys(inv.boxes || {});
        const boxKey = boxKeys.includes(selectedBoxId) ? selectedBoxId : boxKeys[0];
        if (!boxKey || !inv.boxes?.[boxKey]) return inv;
        const targetBox = inv.boxes[boxKey];
        const existingCell = targetBox.cells?.[coord] || {
          row: coord[0] || 'C',
          col: parseInt(coord.slice(1), 10) || 4,
          cellCoordinate: coord,
          occupied: false,
        };
        const isRemoval = editedInventoryData.actionType === 'VIAL_REMOVAL';
        return {
          ...inv,
          boxes: {
            ...inv.boxes,
            [boxKey]: {
              ...targetBox,
              cells: {
                ...targetBox.cells,
                [coord]: {
                  ...existingCell,
                  occupied: !isRemoval,
                  highlighted: !isRemoval,
                  lastActionType: isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION',
                  vial: !isRemoval
                    ? {
                        ...existingCell.vial,
                        cellLineIdentifier: editedInventoryData.cellLineName,
                        cellLineName: editedInventoryData.cellLineName,
                        userInitials:
                          editedInventoryData.userInitials ||
                          editedInventoryData.operatorInitials,
                        operatorInitials:
                          editedInventoryData.userInitials ||
                          editedInventoryData.operatorInitials,
                        dateFrozen: editedInventoryData.dateFrozen,
                        fullText:
                          editedInventoryData.fullText ||
                          `${editedInventoryData.cellLineName} | P${editedInventoryData.passage} | ${editedInventoryData.lotNumber}`,
                        lotNumber: editedInventoryData.lotNumber,
                        passageNumber: editedInventoryData.passage,
                        targetCoordinate: coord,
                        videoId: activeStream,
                        updatedAt: new Date().toISOString(),
                      }
                    : undefined,
                },
              },
            },
          },
        };
      })
    );
  }, [isSignedOff, signOffVersion, editedInventoryData, targetRow, targetCol]);

  // Handle inventory creation
  const handleCreateInventory = async (payload: CreateInventoryInput) => {
    try {
      const newInv = await apiService.createInventory(payload, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });

      setInventories((prev) => [newInv, ...prev]);
      setActiveInventoryId(newInv.id);
      const firstBox = Object.keys(newInv.boxes || {})[0] || 'A-1';
      setSelectedBoxId(firstBox);
    } catch (err) {
      console.error('[CryoInventory] Error creating inventory:', err);
      throw err;
    }
  };

  // Handle emptying all boxes and cells of an inventory
  const handleEmptyInventory = async (inventoryId: string) => {
    // Optimistically reset all cells in all boxes of this inventory to unoccupied
    setInventories((prevList) =>
      prevList.map((inv) => {
        if (inv.id !== inventoryId) return inv;
        const emptiedBoxes: Record<string, any> = {};
        for (const [bKey, box] of Object.entries(inv.boxes || {})) {
          const emptiedCells: Record<string, any> = {};
          for (const [coordKey, cell] of Object.entries(box.cells || {})) {
            emptiedCells[coordKey] = {
              row: cell.row,
              col: cell.col,
              cellCoordinate: cell.cellCoordinate || coordKey,
              occupied: false,
              highlighted: false,
            };
          }
          emptiedBoxes[bKey] = {
            ...box,
            cells: emptiedCells,
          };
        }
        return {
          ...inv,
          boxes: emptiedBoxes,
          updatedAt: new Date().toISOString(),
        };
      })
    );

    try {
      const updated = await apiService.emptyInventory(inventoryId, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
      });
      if (updated && updated.boxes) {
        setInventories((prevList) =>
          prevList.map((inv) => (inv.id === inventoryId ? updated : inv))
        );
      }
    } catch (err) {
      console.warn('[CryoInventory] Note: emptyInventory API call failed or running offline:', err);
    }
  };

  // Find currently active inventory object
  const activeInventory = useMemo(() => {
    return inventories.find((inv) => inv.id === activeInventoryId) || inventories[0] || null;
  }, [inventories, activeInventoryId]);

  // Find currently selected box inside active inventory
  const activeBox = useMemo(() => {
    if (!activeInventory || !activeInventory.boxes) return null;
    return activeInventory.boxes[selectedBoxId] || Object.values(activeInventory.boxes)[0] || null;
  }, [activeInventory, selectedBoxId]);

  // Compute highlighted coordinates from inserted vials in box
  const highlightedCoords = useMemo(() => {
    const coords = new Set<string>();
    if (activeBox?.cells) {
      Object.entries(activeBox.cells).forEach(([coordKey, cell]: [string, any]) => {
        if (
          cell?.highlighted ||
          (cell?.occupied &&
            (cell?.vial?.fullText ||
              cell?.vial?.dateFrozen ||
              cell?.vial?.userInitials ||
              cell?.vial?.videoId ||
              cell?.lastActionType === 'VIAL_INSERTION'))
        ) {
          coords.add(coordKey);
        }
      });
    }
    return Array.from(coords);
  }, [activeBox]);

  // Switch box selection
  const handleSelectBox = (boxId: string) => {
    setSelectedBoxId(boxId);
  };

  // Update cell within the selected box
  const handleUpdateCell = async (
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
  ) => {
    if (!activeInventory) return;

    // Update locally in memory
    setInventories((prevList) =>
      prevList.map((inv) => {
        if (inv.id !== activeInventory.id) return inv;
        const targetBox = inv.boxes?.[boxId];
        if (!targetBox) return inv;

        const existingCell = targetBox.cells?.[cellCoordinate] || {
          row: cellCoordinate[0],
          col: parseInt(cellCoordinate.slice(1), 10) || 1,
          cellCoordinate,
          occupied: false,
        };

        const updatedCell = {
          ...existingCell,
          occupied,
          highlighted: occupied,
          lastActionType: occupied ? 'VIAL_INSERTION' : 'VIAL_REMOVAL',
          vial: occupied
            ? {
                ...existingCell.vial,
                ...vial,
                cellLineName:
                  vial?.cellLineName || vial?.cellLineIdentifier || existingCell.vial?.cellLineName,
                targetCoordinate: cellCoordinate,
                updatedAt: new Date().toISOString(),
              }
            : undefined,
        };

        return {
          ...inv,
          boxes: {
            ...inv.boxes,
            [boxId]: {
              ...targetBox,
              cells: {
                ...targetBox.cells,
                [cellCoordinate]: updatedCell,
              },
            },
          },
        };
      })
    );

    // Persist to server if inventory is non-demo or registered
    try {
      await apiService.updateInventoryCell(activeInventory.id, {
        boxId,
        cellCoordinate,
        occupied,
        vial,
      });
    } catch (err) {
      console.warn(
        '[CryoInventory] Note: persistence to /api/inventories/:id/cells failed or running offline:',
        err
      );
    }
  };

  // Synchronize telemetry for active stream
  useEffect(() => {
    let cancelled = false;
    const isDemoStream =
      !activeStream ||
      activeStream === 'vid_cryo_demo_01' ||
      activeStream === 'vid_archive_demo_02';

    if (isDemoStream) {
      setVerifiedStreamId(activeStream);
      return;
    }

    const verifyAndLoadActiveStreamAnalysis = async () => {
      try {
        const passRes = await apiService.fetchVideoPasses(activeStream, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        const pass2Done = passRes.passes?.pass2?.status === 'COMPLETED';
        const pass3Done = passRes.passes?.pass3?.status === 'COMPLETED';

        if (
          (pass2Done || pass3Done || passRes.status === 'ANALYSIS_COMPLETE') &&
          (!analysis || analysis.videoId !== activeStream || verifiedStreamId !== activeStream)
        ) {
          const doc = await apiService.fetchVideoAnalysis(activeStream, {
            customerId: tenant.customerId,
            databaseId: tenant.databaseId,
          });
          if (!cancelled && doc && doc.videoId === activeStream) {
            setVerifiedStreamId(activeStream);
            onAnalysisLoaded?.(activeStream, doc);
          }
        }
      } catch {
        if (!analysis || analysis.videoId !== activeStream) {
          try {
            const doc = await apiService.fetchVideoAnalysis(activeStream, {
              customerId: tenant.customerId,
              databaseId: tenant.databaseId,
            });
            if (!cancelled && doc && doc.videoId === activeStream) {
              setVerifiedStreamId(activeStream);
              onAnalysisLoaded?.(activeStream, doc);
            }
          } catch {
            // Stream has not completed Pass 2 / Pass 3 yet
          }
        }
      }
    };

    verifyAndLoadActiveStreamAnalysis();

    return () => {
      cancelled = true;
    };
  }, [activeStream, tenant.customerId, tenant.databaseId]);

  const displayBoxId = activeBox?.boxId || selectedBoxId || 'A-1';
  const boxRows = activeBox?.rows || activeInventory?.rowsPerBox || 9;
  const boxCols = activeBox?.cols || activeInventory?.colsPerBox || 9;

  // Cell Line Search State & Matching Boxes/Wells Computation
  const [searchQuery, setSearchQuery] = useState<string>('');
  const normalizedSearch = searchQuery.trim().toLowerCase();

  const { matchingBoxIds, matchingBoxCounts, totalMatchingVials } = useMemo(() => {
    const ids: string[] = [];
    const counts: Record<string, number> = {};
    let total = 0;

    if (!normalizedSearch || !activeInventory?.boxes) {
      return { matchingBoxIds: ids, matchingBoxCounts: counts, totalMatchingVials: total };
    }

    for (const [boxId, box] of Object.entries(activeInventory.boxes)) {
      if (!box?.cells) continue;
      let boxMatchCount = 0;
      for (const cell of Object.values(box.cells) as any[]) {
        if (!cell?.occupied) continue;
        const name = (cell.vial?.cellLineName || cell.vial?.cellLineIdentifier || '').toLowerCase();
        if (name && name.includes(normalizedSearch)) {
          boxMatchCount++;
        }
      }
      if (boxMatchCount > 0) {
        ids.push(boxId);
        counts[boxId] = boxMatchCount;
        total += boxMatchCount;
      }
    }

    return { matchingBoxIds: ids, matchingBoxCounts: counts, totalMatchingVials: total };
  }, [activeInventory, normalizedSearch]);

  const searchMatchingCoords = useMemo(() => {
    const coords: string[] = [];
    if (!normalizedSearch || !activeBox?.cells) return coords;

    for (const [coordKey, cell] of Object.entries(activeBox.cells) as [string, any][]) {
      if (!cell?.occupied) continue;
      const name = (cell.vial?.cellLineName || cell.vial?.cellLineIdentifier || '').toLowerCase();
      if (name && name.includes(normalizedSearch)) {
        coords.push(coordKey);
      }
    }
    return coords;
  }, [activeBox, normalizedSearch]);

  const handleSelectSlot = (row: string, col: number) => {
    setSelectedCellCoord({ row, col });
    onSelectGridSlot(row, col);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* 1. Left Column (Narrower): Inventory Sidebar & Creation Panel */}
      <div className="w-full lg:col-span-4 xl:col-span-4">
        <InventorySidebar
          inventories={inventories}
          activeInventoryId={activeInventory?.id || null}
          isLoading={isLoadingInventories}
          onSelectInventory={(id) => {
            setActiveInventoryId(id);
            const found = inventories.find((i) => i.id === id);
            if (found && found.boxes) {
              const first = Object.keys(found.boxes)[0];
              if (first) setSelectedBoxId(first);
            }
          }}
          onCreateInventory={handleCreateInventory}
          onEmptyInventory={handleEmptyInventory}
        />
      </div>

      {/* 2. Center/Right Column (Wider): Search Bar, Tower & Box Architecture + Cryo-Box Matrix */}
      <div className="w-full lg:col-span-8 xl:col-span-8 space-y-6">
        {/* Top Search Bar: Search Vials by Cell Line Name */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-fuchsia-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search cell line vials in inventory by name (e.g. HEK293T, HeLa, Jurkat-T, CHO-K1)..."
              data-testid="cell-line-search-input"
              className="w-full bg-slate-950 border border-slate-700 focus:border-fuchsia-400 rounded-xl pl-10 pr-9 py-2 text-xs text-slate-100 placeholder:text-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-fuchsia-500/30 transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                data-testid="cell-line-search-clear"
                title="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {normalizedSearch && (
            <div
              className="flex flex-wrap items-center gap-2 text-xs font-mono shrink-0"
              data-testid="cell-line-search-results"
            >
              <span
                className={`px-3 py-1.5 rounded-xl border inline-flex items-center gap-2 ${
                  totalMatchingVials > 0
                    ? 'bg-fuchsia-950/80 border-fuchsia-500/50 text-fuchsia-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    totalMatchingVials > 0 ? 'bg-fuchsia-400 animate-pulse' : 'bg-slate-600'
                  }`}
                />
                {totalMatchingVials > 0
                  ? `${totalMatchingVials} matching ${
                      totalMatchingVials === 1 ? 'vial' : 'vials'
                    } in ${matchingBoxIds.length} ${
                      matchingBoxIds.length === 1 ? 'box' : 'boxes'
                    }`
                  : 'No matching vials found'}
              </span>
            </div>
          )}
        </div>

        <TowerOverview
          inventory={activeInventory}
          selectedBoxId={displayBoxId}
          onSelectBox={handleSelectBox}
          matchingBoxIds={matchingBoxIds}
          matchingBoxCounts={matchingBoxCounts}
          searchQuery={searchQuery}
        />

        <BoxGridView
          rows={boxRows}
          cols={boxCols}
          boxId={displayBoxId}
          inventoryId={activeInventory?.id}
          cells={activeBox?.cells}
          targetRow={selectedCellCoord.row}
          targetCol={selectedCellCoord.col}
          highlightedCoords={highlightedCoords}
          searchMatchingCoords={searchMatchingCoords}
          onSelectSlot={handleSelectSlot}
          onUpdateCell={handleUpdateCell}
          readOnly={false}
          showModalOnSelect={true}
        />
      </div>
    </div>
  );
};

export default CryoInventory;
