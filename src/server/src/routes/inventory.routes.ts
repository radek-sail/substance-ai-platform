import { Router } from 'express';
import {
  listInventoriesHandler,
  createInventoryHandler,
  getInventoryHandler,
  updateInventoryCellHandler,
} from '../controllers/inventory.controller';

const router: Router = Router();

// GET /api/inventories - List all inventories
router.get('/', listInventoriesHandler);

// POST /api/inventories - Create a new inventory
router.post('/', createInventoryHandler);

// GET /api/inventories/:id - Get a specific inventory
router.get('/:id', getInventoryHandler);

// PATCH /api/inventories/:id/cells - Update a specific cell
router.patch('/:id/cells', updateInventoryCellHandler);

export default router;
