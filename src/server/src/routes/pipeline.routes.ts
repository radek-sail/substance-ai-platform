import { Router } from 'express';
import { analyzePipelineHandler } from '../controllers/pipeline.controller';

const router: Router = Router();

// Pipeline analysis route: POST /api/pipeline/analyze
router.post('/analyze', analyzePipelineHandler);

export default router;
