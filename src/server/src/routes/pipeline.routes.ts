import { Router } from 'express';
import {
  analyzePipelineHandler,
  inventorySignOffHandler,
  archiveSignOffHandler,
} from '../controllers/pipeline.controller';

const router: Router = Router();

// Pipeline analysis route: POST /api/pipeline/analyze
router.post('/analyze', analyzePipelineHandler);

// Atomic sign-off routes: POST /api/pipeline/signoff/inventory & POST /api/pipeline/signoff/archive
router.post('/signoff/inventory', inventorySignOffHandler);
router.post('/signoff/archive', archiveSignOffHandler);

export default router;
