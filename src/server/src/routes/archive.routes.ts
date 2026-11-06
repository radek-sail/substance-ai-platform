import { Router } from 'express';
import {
  listArchivesHandler,
  createArchiveHandler,
  getArchiveHandler,
  emptyArchiveHandler,
  deleteArchiveHandler,
} from '../controllers/archive.controller';

const router: Router = Router();

// GET /api/archives - List all experiment archives
router.get('/', listArchivesHandler);

// POST /api/archives - Create a new experiment archive
router.post('/', createArchiveHandler);

// GET /api/archives/:id - Fetch a single experiment archive
router.get('/:id', getArchiveHandler);

// POST /api/archives/:id/empty & /api/archives/:id/erase - Erase notebook content of an archive
router.post('/:id/empty', emptyArchiveHandler);
router.post('/:id/erase', emptyArchiveHandler);

// DELETE /api/archives/:id - Delete an experiment archive
router.delete('/:id', deleteArchiveHandler);

export default router;
