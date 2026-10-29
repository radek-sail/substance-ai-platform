import { Router } from 'express';
import {
  uploadVideoHandler,
  uploadMiddleware,
  listVideosHandler,
  requestUploadUrlHandler,
  finalizeUploadHandler,
} from '../controllers/video.controller';

const router: Router = Router();

// List all uploaded/transcoded videos: GET /api/videos
router.get('/', listVideosHandler);

// Generate V4 Signed URL for direct-to-GCS raw video upload: POST /api/videos/request-upload-url
router.post('/request-upload-url', requestUploadUrlHandler);

// Stream raw video from GCS through FFmpeg to normalized 10-min chunks & save to Firestore: POST /api/videos/finalize-upload
router.post('/finalize-upload', finalizeUploadHandler);

// Decoupled ingestion & FFmpeg normalization route: POST /api/videos/upload
router.post('/upload', uploadMiddleware, uploadVideoHandler);

export default router;
