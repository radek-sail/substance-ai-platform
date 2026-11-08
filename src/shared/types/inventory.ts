import { z } from 'zod';

export const InventoryCellSchema = z.object({
  row: z.string(), // e.g., 'A', 'B', 'C'...
  col: z.number(), // e.g., 1, 2, 3...
  cellCoordinate: z.string(), // e.g., 'A1', 'C4'
  occupied: z.boolean(),
  highlighted: z.boolean().optional(),
  lastActionType: z.string().optional(),
  vial: z
    .object({
      cellLineIdentifier: z.string().optional(),
      cellLineName: z.string().optional(),
      userInitials: z.string().optional(),
      operatorInitials: z.string().optional(),
      dateFrozen: z.string().optional(),
      fullText: z.string().optional(),
      lotNumber: z.string().optional(),
      passageNumber: z.union([z.number(), z.string()]).optional(),
      targetCoordinate: z.string().optional(),
      videoId: z.string().optional(),
      actionId: z.string().optional(),
      notes: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .optional(),
});
export type InventoryCell = z.infer<typeof InventoryCellSchema>;

export const InventoryBoxSchema = z.object({
  boxId: z.string(), // e.g., "A-1", "B-3"
  towerLabel: z.string(), // e.g., "A"
  boxNumber: z.number(), // e.g., 1
  rows: z.number(),
  cols: z.number(),
  cells: z.record(z.string(), InventoryCellSchema), // key: "A1", "C4", etc.
});
export type InventoryBox = z.infer<typeof InventoryBoxSchema>;

export const InventoryRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string().optional(),
  towersCount: z.number(),
  boxesPerTower: z.number(),
  rowsPerBox: z.number(),
  colsPerBox: z.number(),
  createdAt: z.string(),
  boxes: z.record(z.string(), InventoryBoxSchema), // key: "A-1", "A-2", etc.
});
export type InventoryRecord = z.infer<typeof InventoryRecordSchema>;

export const CreateInventorySchema = z.object({
  name: z.string().min(1, 'Inventory name is required'),
  towersCount: z.number().int().min(1).max(26),
  boxesPerTower: z.number().int().min(1),
  rowsPerBox: z.number().int().min(1),
  colsPerBox: z.number().int().min(1),
});
export type CreateInventoryInput = z.infer<typeof CreateInventorySchema>;
