import { Request, Response } from 'express';
import crypto from 'crypto';
import {
  type InventoryRecord,
  type InventoryBox,
  type InventoryCell,
  type CreateInventoryInput,
  CreateInventorySchema,
} from '@sail/shared';
import * as firestoreService from '../services/firestore.service';
import { db, getTenantFirestore, normalizeDatabaseId } from '../services/firestore.service';

/**
 * Generates all boxes and cells for an inventory given its dimensions.
 */
export function generateInventoryBoxes(
  towersCount: number,
  boxesPerTower: number,
  rowsPerBox: number,
  colsPerBox: number
): Record<string, InventoryBox> {
  const boxes: Record<string, InventoryBox> = {};

  for (let t = 0; t < towersCount; t++) {
    const towerLabel = String.fromCharCode(65 + t); // A, B, C...
    for (let b = 1; b <= boxesPerTower; b++) {
      const boxId = `${towerLabel}-${b}`;
      const cells: Record<string, InventoryCell> = {};

      for (let r = 0; r < rowsPerBox; r++) {
        const rowLetter = String.fromCharCode(65 + r);
        for (let c = 1; c <= colsPerBox; c++) {
          const cellCoord = `${rowLetter}${c}`;
          cells[cellCoord] = {
            row: rowLetter,
            col: c,
            cellCoordinate: cellCoord,
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

  return boxes;
}

/**
 * Builds the default 9x9 demo inventory.
 */
export function createDefaultDemoInventory(): InventoryRecord {
  const towersCount = 3;
  const boxesPerTower = 5;
  const rowsPerBox = 9;
  const colsPerBox = 9;
  const boxes = generateInventoryBoxes(towersCount, boxesPerTower, rowsPerBox, colsPerBox);

  // Pre-seed realistic sample vials in box A-1
  const defaultOccupied = [
    { coord: 'A1', cellLine: 'HEK293T', lot: 'LOT-9001', passage: 4 },
    { coord: 'A2', cellLine: 'HEK293T', lot: 'LOT-9001', passage: 4 },
    { coord: 'A5', cellLine: 'Jurkat-T', lot: 'LOT-8812', passage: 6 },
    { coord: 'B2', cellLine: 'CHO-K1', lot: 'LOT-7740', passage: 3 },
    { coord: 'B3', cellLine: 'CHO-K1', lot: 'LOT-7740', passage: 3 },
    { coord: 'C4', cellLine: 'HEK293T', lot: 'LOT-8841', passage: 5 },
    { coord: 'D4', cellLine: 'HeLa', lot: 'LOT-5510', passage: 12 },
    { coord: 'D5', cellLine: 'HeLa', lot: 'LOT-5510', passage: 12 },
    { coord: 'E8', cellLine: 'Vero-E6', lot: 'LOT-4419', passage: 8 },
    { coord: 'G2', cellLine: 'iPSC-3', lot: 'LOT-1102', passage: 2 },
  ];

  if (boxes['A-1']) {
    for (const item of defaultOccupied) {
      if (boxes['A-1'].cells[item.coord]) {
        boxes['A-1'].cells[item.coord] = {
          ...boxes['A-1'].cells[item.coord],
          occupied: true,
          vial: {
            cellLineIdentifier: item.cellLine,
            lotNumber: item.lot,
            passageNumber: item.passage,
            targetCoordinate: item.coord,
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

/**
 * GET /api/inventories
 * Fetches all inventory documents from Firestore `inventories` collection on `admin.firestore()`.
 * If empty, creates and returns the default 9x9 demo inventory.
 */
export const listInventoriesHandler = async (_req: Request, res: Response): Promise<Response | void> => {
  try {
    const inventoriesRef = db.collection('inventories');
    let snapshot;
    try {
      snapshot = await inventoriesRef.orderBy('createdAt', 'desc').get();
      if (!snapshot || snapshot.empty) {
        snapshot = await inventoriesRef.get();
      }
    } catch {
      snapshot = await inventoriesRef.get();
    }

    if (!snapshot || snapshot.empty) {
      // Create and persist the default demo inventory for instant onboarding
      const demoInventory = createDefaultDemoInventory();
      try {
        await inventoriesRef.doc(demoInventory.id).set(demoInventory);
      } catch (saveErr) {
        console.warn('[InventoryController] Could not persist default demo inventory:', saveErr);
      }
      return res.status(200).json({ inventories: [demoInventory] });
    }

    const inventories: InventoryRecord[] = snapshot.docs.map((doc: any) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
      };
    });

    return res.status(200).json({ inventories });
  } catch (error: any) {
    console.error('[InventoryController] Error listing inventories:', error);
    // Graceful fallback
    return res.status(200).json({ inventories: [] });
  }
};

/**
 * POST /api/inventories
 * Creates a new customizable inventory with initialized cell states.
 */
export const createInventoryHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const parseResult = CreateInventorySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid inventory configuration parameters',
        details: parseResult.error.flatten(),
      });
    }

    const { name, towersCount, boxesPerTower, rowsPerBox, colsPerBox } = parseResult.data;

    // Validate parameter constraints
    if (towersCount < 1 || towersCount > 26) {
      return res.status(400).json({
        error: 'towersCount must be between 1 and 26 (Towers A through Z)',
      });
    }
    if (boxesPerTower < 1 || rowsPerBox < 1 || colsPerBox < 1) {
      return res.status(400).json({
        error: 'boxesPerTower, rowsPerBox, and colsPerBox must be greater than or equal to 1',
      });
    }

    const inventoryId = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const boxes = generateInventoryBoxes(towersCount, boxesPerTower, rowsPerBox, colsPerBox);

    const inventoryRecord: InventoryRecord = {
      id: inventoryId,
      name: name.trim(),
      towersCount,
      boxesPerTower,
      rowsPerBox,
      colsPerBox,
      createdAt: new Date().toISOString(),
      boxes,
    };

    await db.collection('inventories').doc(inventoryId).set(inventoryRecord);

    return res.status(201).json(inventoryRecord);
  } catch (error: any) {
    console.error('[InventoryController] Error creating inventory:', error);
    return res.status(500).json({
      error: 'Failed to create inventory',
      message: error?.message || String(error),
    });
  }
};

/**
 * GET /api/inventories/:id
 * Fetches an inventory document by ID.
 */
export const getInventoryHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Inventory ID is required' });
    }

    const doc = await db.collection('inventories').doc(id).get();
    if (!doc || !doc.exists) {
      return res.status(404).json({ error: `Inventory with ID '${id}' not found` });
    }

    return res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (error: any) {
    console.error(`[InventoryController] Error fetching inventory ${req.params?.id}:`, error);
    return res.status(500).json({
      error: 'Failed to retrieve inventory',
      message: error?.message || String(error),
    });
  }
};

/**
 * PATCH /api/inventories/:id/cells
 * Updates a specific cell's occupancy and vial metadata in an inventory box.
 */
export const updateInventoryCellHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { id } = req.params;
    const { boxId, cellCoordinate, occupied, highlighted, lastActionType, vial } = req.body;

    if (!id || !boxId || !cellCoordinate) {
      return res.status(400).json({ error: 'id, boxId, and cellCoordinate are required' });
    }

    const docRef = db.collection('inventories').doc(id);
    const doc = await docRef.get();
    if (!doc || !doc.exists) {
      return res.status(404).json({ error: `Inventory '${id}' not found` });
    }

    const data = doc.data() as InventoryRecord;
    const box = data.boxes?.[boxId];
    if (!box) {
      return res.status(404).json({ error: `Box '${boxId}' not found in inventory '${id}'` });
    }

    const existingCell = box.cells?.[cellCoordinate] || {
      row: cellCoordinate[0],
      col: parseInt(cellCoordinate.slice(1), 10) || 1,
      cellCoordinate,
      occupied: false,
    };

    const resolvedOccupied = typeof occupied === 'boolean' ? occupied : true;

    const updatedCell: InventoryCell = {
      ...existingCell,
      occupied: resolvedOccupied,
      highlighted:
        typeof highlighted === 'boolean'
          ? highlighted
          : resolvedOccupied
          ? existingCell.highlighted ?? true
          : false,
      ...(lastActionType ? { lastActionType } : {}),
      vial: vial
        ? {
            ...existingCell.vial,
            ...vial,
            cellLineIdentifier: vial.cellLineIdentifier || vial.cellLineName || existingCell.vial?.cellLineIdentifier || 'Unknown',
            cellLineName: vial.cellLineName || vial.cellLineIdentifier || existingCell.vial?.cellLineName,
            targetCoordinate: cellCoordinate,
            updatedAt: new Date().toISOString(),
          }
        : existingCell.vial,
    };

    if (occupied === false) {
      delete updatedCell.vial;
    }

    box.cells[cellCoordinate] = updatedCell;
    data.boxes[boxId] = box;

    await docRef.set(data);

    return res.status(200).json({
      success: true,
      inventoryId: id,
      boxId,
      cell: updatedCell,
    });
  } catch (error: any) {
    console.error('[InventoryController] Error updating cell:', error);
    return res.status(500).json({
      error: 'Failed to update inventory cell',
      message: error?.message || String(error),
    });
  }
};

/**
 * POST /api/inventories/:id/empty
 * Empties all boxes and cells of the specified cryo-inventory, resetting all wells to unoccupied.
 */
export const emptyInventoryHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Missing required parameter: id' });
    }

    const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId || req.query?.databaseId) as
      | string
      | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const tenantDb = getTenantFirestore(databaseId);

    const docRef = db.collection('inventories').doc(id);
    let doc = await docRef.get();
    let data: InventoryRecord | undefined = doc && doc.exists ? (doc.data() as InventoryRecord) : undefined;

    if (!data && databaseId !== '(default)') {
      try {
        const tenantDoc = await tenantDb.collection('inventories').doc(id).get();
        if (tenantDoc && tenantDoc.exists) {
          data = tenantDoc.data() as InventoryRecord;
        }
      } catch {
        // Ignore tenant fallback error
      }
    }

    if (!data) {
      return res.status(404).json({ error: `Inventory '${id}' not found` });
    }

    const towersCount = data.towersCount || 3;
    const boxesPerTower = data.boxesPerTower || 5;
    const rowsPerBox = data.rowsPerBox || 9;
    const colsPerBox = data.colsPerBox || 9;

    const emptyBoxes = generateInventoryBoxes(towersCount, boxesPerTower, rowsPerBox, colsPerBox);
    const nowIso = new Date().toISOString();

    const updatedInventory: InventoryRecord & { updatedAt?: string } = {
      ...data,
      id: data.id || id,
      towersCount,
      boxesPerTower,
      rowsPerBox,
      colsPerBox,
      boxes: emptyBoxes,
      updatedAt: nowIso,
    };

    // Overwrite full inventory document (without merge so nested vial objects are completely removed)
    await docRef.set(updatedInventory);
    if (databaseId !== '(default)') {
      try {
        await tenantDb.collection('inventories').doc(id).set(updatedInventory);
      } catch {
        // Ignore if tenant DB mirrors default
      }
    }

    // Clear any subcollection contents/{boxId} documents so commit sanity checks see empty wells
    const clearContentsSubcollection = async (firestoreInstance: typeof db) => {
      try {
        const contentsCol = firestoreInstance.collection('inventories').doc(id).collection('contents');
        if (contentsCol && typeof contentsCol.get === 'function') {
          const snap = await contentsCol.get();
          if (snap && Array.isArray(snap.docs)) {
            for (const subDoc of snap.docs) {
              await contentsCol.doc(subDoc.id).set({
                inventoryId: id,
                boxId: subDoc.id,
                occupiedCells: {},
                cells: [],
                updatedAt: nowIso,
              });
            }
          }
        }
        for (const boxKey of Object.keys(emptyBoxes)) {
          if (contentsCol && typeof contentsCol.doc === 'function') {
            await contentsCol.doc(boxKey).set({
              inventoryId: id,
              boxId: boxKey,
              occupiedCells: {},
              cells: [],
              updatedAt: nowIso,
            });
          }
        }
      } catch {
        // Non-fatal if subcollection does not exist
      }
    };

    await clearContentsSubcollection(db);
    if (databaseId !== '(default)') {
      await clearContentsSubcollection(tenantDb);
    }

    // Reset HITL commit on any videos linked to this emptied inventory
    try {
      const allVideos = await firestoreService.listVideos(databaseId);
      for (const v of allVideos) {
        if (
          v.inventoryId === id ||
          (v.passes?.hitl as any)?.data?.inventoryId === id
        ) {
          await firestoreService.resetVideoHitlCommit(databaseId, v.videoId);
          if (databaseId !== '(default)') {
            await firestoreService.resetVideoHitlCommit('(default)', v.videoId);
          }
        }
      }
    } catch {
      // Ignore video reset scan error
    }

    return res.status(200).json({
      success: true,
      inventory: updatedInventory,
    });
  } catch (error: any) {
    console.error('[InventoryController] Error emptying inventory:', error);
    return res.status(500).json({
      error: 'Failed to empty inventory',
      message: error?.message || String(error),
    });
  }
};
