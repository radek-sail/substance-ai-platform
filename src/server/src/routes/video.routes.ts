import { Router } from 'express';
import { uploadVideoHandler, uploadMiddleware } from '../controllers/video.controller';

const router: Router = Router();

// Ingestion route: POST /api/videos/upload
router.post('/upload', uploadMiddleware, uploadVideoHandler);

export default router;

