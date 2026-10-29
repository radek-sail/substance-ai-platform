import { Router } from 'express';
import {
  uploadVideoHandler,
  uploadMiddleware,
  listVideosHandler,
} from '../controllers/video.controller';

const router: Router = Router();

// List all uploaded/transcoded videos: GET /api/videos
router.get('/', listVideosHandler);

// Decoupled ingestion & FFmpeg normalization route: POST /api/videos/upload
router.post('/upload', uploadMiddleware, uploadVideoHandler);

export default router;
