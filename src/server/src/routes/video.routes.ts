import { Router } from 'express';
import {
  uploadVideoHandler,
  uploadMiddleware,
  listVideosHandler,
  requestUploadUrlHandler,
  finalizeUploadHandler,
  associateInventoryHandler,
  associateArchiveHandler,
  getVideoFrameHandler,
  deleteVideoHandler,
  undoVideoCommitHandler,
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

// Manually associate video with an archive: POST /api/videos/:videoId/associate-archive
router.post('/:videoId/associate-archive', associateArchiveHandler);

// Serve extracted Pass 2 best-shot frame: GET /api/videos/:videoId/frames/:filename
router.get('/:videoId/frames/:filename', getVideoFrameHandler);

// Delete video record and analysis from database: DELETE /api/videos/:videoId
router.delete('/:videoId', deleteVideoHandler);

// Undo HITL sign-off and reset commit state for video: POST /api/videos/:videoId/undo-commit
router.post('/:videoId/undo-commit', undoVideoCommitHandler);

export default router;
