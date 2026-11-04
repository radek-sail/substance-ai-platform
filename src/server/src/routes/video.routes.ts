import { Router } from 'express';
import {
  uploadVideoHandler,
  uploadMiddleware,
  listVideosHandler,
  requestUploadUrlHandler,
  finalizeUploadHandler,
  associateInventoryHandler,
  getVideoFrameHandler,
  deleteVideoHandler,
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

// Manually associate video with an inventory: POST /api/videos/:videoId/associate-inventory
router.post('/:videoId/associate-inventory', associateInventoryHandler);

// Serve extracted Pass 2 best-shot frame: GET /api/videos/:videoId/frames/:filename
router.get('/:videoId/frames/:filename', getVideoFrameHandler);

// Delete video record and analysis from database: DELETE /api/videos/:videoId
router.delete('/:videoId', deleteVideoHandler);

export default router;
