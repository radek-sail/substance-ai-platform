import { Router } from 'express';
import {
  listInventoriesHandler,
  createInventoryHandler,
  getInventoryHandler,
  updateInventoryCellHandler,
  emptyInventoryHandler,
} from '../controllers/inventory.controller';

const router: Router = Router();

// GET /api/inventories - List all inventories
router.get('/', listInventoriesHandler);

// POST /api/inventories - Create a new inventory
router.post('/', createInventoryHandler);

// GET /api/inventories/:id - Get a specific inventory
router.get('/:id', getInventoryHandler);

// POST /api/inventories/:id/empty - Empty all boxes and cells of an inventory
router.post('/:id/empty', emptyInventoryHandler);

// PATCH /api/inventories/:id/cells - Update a specific cell
router.patch('/:id/cells', updateInventoryCellHandler);

export default router;
