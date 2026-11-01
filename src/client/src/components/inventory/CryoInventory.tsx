import React, { useEffect, useState, useMemo } from 'react';
import { BoxGridView } from './BoxGridView';
import { VialInspector, type HumanEditedVialData } from './VialInspector';
import { InventorySidebar } from './InventorySidebar';
import { TowerOverview } from './TowerOverview';
import { TimelineViewer } from '../timeline/TimelineViewer';
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
      { coord: 'C4', line: 'HEK293T', lot: 'LOT-8841', p: 5 },
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
          vial: {
            cellLineIdentifier: s.line,
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
  onSelectGridSlot: (row: string, col: number) => void;
  onChangeField: (field: keyof HumanEditedVialData, value: any) => void;
  onResetField: (field: keyof HumanEditedVialData) => void;
  onAnalysisLoaded?: (videoId: string, doc: VideoAnalysisDoc) => void;
  initialInventoryId?: string | null;
  // Optional Timeline props to support top-right Synchronized Timeline
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
  selectedAction,
  events,
  refinements,
  targetRow,
  targetCol,
  rawTargetRow,
  rawTargetCol,
  editedInventoryData,
  rawAiInventoryData,
  isSignedOff,
  onSelectGridSlot,
  onChangeField,
  onResetField,
  onAnalysisLoaded,
  initialInventoryId,
  duration = 0,
  currentTime = 0,
  safeActions,
  safeEvents,
  selectedActionId,
  selectedEventId,
  onSeek,
  onSelectAction,
  onSelectEvent,
}) => {
  const [verifiedStreamId, setVerifiedStreamId] = useState<string | null>(null);

  // Multi-Inventory State
  const [inventories, setInventories] = useState<InventoryRecord[]>([]);
  const [activeInventoryId, setActiveInventoryId] = useState<string | null>(initialInventoryId || null);
  const [selectedBoxId, setSelectedBoxId] = useState<string>('A-1');
  const [isLoadingInventories, setIsLoadingInventories] = useState(false);

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

  // Load inventories on mount & select initial inventory
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
        setSelectedBoxId(firstBox);
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
  }, [tenant.customerId, tenant.databaseId]);

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

  // Find currently active inventory object
  const activeInventory = useMemo(() => {
    return inventories.find((inv) => inv.id === activeInventoryId) || inventories[0] || null;
  }, [inventories, activeInventoryId]);

  // Find currently selected box inside active inventory
  const activeBox = useMemo(() => {
    if (!activeInventory || !activeInventory.boxes) return null;
    return activeInventory.boxes[selectedBoxId] || Object.values(activeInventory.boxes)[0] || null;
  }, [activeInventory, selectedBoxId]);

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
          vial: occupied
            ? {
                ...existingCell.vial,
                ...vial,
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
      console.warn('[CryoInventory] Note: persistence to /api/inventories/:id/cells failed or running offline:', err);
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

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      {/* 1. Left Inventory Sidebar & Creation Panel */}
      <div className="w-full lg:w-72 shrink-0">
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
        />
      </div>

      {/* Main Multi-Inventory Content */}
      <div className="flex-1 w-full space-y-6">
        {/* Top Row: Tower & Box Architecture (replacing Mock Video Player) + Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Top-Left: Dynamic Tower & Box Layout Visualization */}
          <div className="lg:col-span-6">
            <TowerOverview
              inventory={activeInventory}
              selectedBoxId={displayBoxId}
              onSelectBox={handleSelectBox}
            />
          </div>

          {/* Top-Right: Synchronized Multi-Track Timeline */}
          <div className="lg:col-span-6">
            {onSeek && onSelectAction && onSelectEvent ? (
              <TimelineViewer
                duration={duration}
                currentTime={currentTime}
                actions={safeActions || (analysis?.actions ?? [])}
                events={safeEvents || events}
                selectedActionId={selectedActionId}
                selectedEventId={selectedEventId}
                onSeek={onSeek}
                onSelectAction={onSelectAction}
                onSelectEvent={onSelectEvent}
              />
            ) : (
              <TimelineViewer
                duration={duration || 120}
                currentTime={currentTime}
                actions={safeActions || (analysis?.actions ?? [])}
                events={safeEvents || events}
                selectedActionId={selectedActionId}
                selectedEventId={selectedEventId}
                onSeek={() => {}}
                onSelectAction={() => {}}
                onSelectEvent={() => {}}
              />
            )}
          </div>
        </div>

        {/* Bottom Row: Cryo-Box Matrix & Multi-Pass Extraction Vial Inspector */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Bottom-Left: Selected Box Matrix with 1:1 Aligned Columns & Cell Click Modal */}
          <div className="lg:col-span-6">
            <BoxGridView
              rows={boxRows}
              cols={boxCols}
              boxId={displayBoxId}
              inventoryId={activeInventory?.id}
              cells={activeBox?.cells}
              targetRow={targetRow}
              targetCol={targetCol}
              differencedRow={rawTargetRow}
              differencedCol={rawTargetCol}
              onSelectSlot={onSelectGridSlot}
              onUpdateCell={handleUpdateCell}
              readOnly={isSignedOff}
            />
          </div>

          {/* Bottom-Right: Multi-Pass Extraction Vial Inspector */}
          <div className="lg:col-span-6">
            <VialInspector
              action={selectedAction}
              events={events}
              refinements={refinements}
              editedData={editedInventoryData}
              rawAiData={rawAiInventoryData}
              onChange={onChangeField}
              onResetField={onResetField}
              readOnly={isSignedOff}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default CryoInventory;
