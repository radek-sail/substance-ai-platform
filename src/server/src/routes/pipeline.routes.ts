import { Router } from 'express';
import {
  analyzePipelineHandler,
  analyzePassHandler,
  getVideoPassesHandler,
  inventorySignOffHandler,
  archiveSignOffHandler,
} from '../controllers/pipeline.controller';

const router: Router = Router();

// Pipeline analysis route: POST /api/pipeline/analyze
router.post('/analyze', analyzePipelineHandler);

// Single-pass & full execution route: POST /api/pipeline/analyze-pass
router.post('/analyze-pass', analyzePassHandler);

// Pass statuses & intermediate outputs route: GET /api/pipeline/passes/:videoId
router.get('/passes/:videoId', getVideoPassesHandler);

// Atomic sign-off routes: POST /api/pipeline/signoff/inventory & POST /api/pipeline/signoff/archive
router.post('/signoff/inventory', inventorySignOffHandler);
router.post('/signoff/archive', archiveSignOffHandler);

export default router;
