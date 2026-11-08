import path from 'path';
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import videoRoutes from './routes/video.routes';
import pipelineRoutes from './routes/pipeline.routes';
import inventoryRoutes from './routes/inventory.routes';
import archiveRoutes from './routes/archive.routes';
import {
  uploadMiddleware,
  uploadVideoHandler,
  listVideosHandler,
  associateInventoryHandler,
  associateArchiveHandler,
  getVideoFrameHandler,
  deleteVideoHandler,
} from './controllers/video.controller';
import {
  analyzePipelineHandler,
  analyzePassHandler,
  getVideoPassesHandler,
  inventorySignOffHandler,
  archiveSignOffHandler,
  getVideoAnalysisHandler,
} from './controllers/pipeline.controller';
import {
  listInventoriesHandler,
  createInventoryHandler,
  getInventoryHandler,
  emptyInventoryHandler,
} from './controllers/inventory.controller';
import {
  listArchivesHandler,
  createArchiveHandler,
  getArchiveHandler,
} from './controllers/archive.controller';
import {
  backfillLegacyVideos,
  backfillVideosHandler,
} from './controllers/admin.controller';
import { authMiddleware, getMeHandler } from './middleware/auth.middleware';

// Load environment variables
dotenv.config();

const app: Express = express();

// Configure CORS and Body Parsers
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Health Check endpoints
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: '@sail/server',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: '@sail/server',
    timestamp: new Date().toISOString(),
  });
});

// Authenticated user profile endpoint
app.get('/api/auth/me', authMiddleware, getMeHandler);

// Admin migration & backfill endpoints
app.post('/api/admin/backfill-videos', authMiddleware, backfillVideosHandler);

// Video routes via router (GET /api/videos, POST /api/videos/upload)
app.use('/api/videos', authMiddleware, videoRoutes);

// Direct route registrations for video endpoints
app.get('/api/videos', authMiddleware, listVideosHandler);
app.post('/api/videos/upload', authMiddleware, uploadMiddleware, uploadVideoHandler);
app.delete('/api/videos/:videoId', authMiddleware, deleteVideoHandler);
app.post('/api/videos/:videoId/associate-inventory', authMiddleware, associateInventoryHandler);
app.post('/api/videos/:videoId/associate-archive', authMiddleware, associateArchiveHandler);
app.get('/api/videos/:videoId/frames/:filename', authMiddleware, getVideoFrameHandler);

// Pipeline analysis routes
app.use('/api/pipeline', authMiddleware, pipelineRoutes);
app.post('/api/pipeline/analyze', authMiddleware, analyzePipelineHandler);
app.post('/api/pipeline/analyze-pass', authMiddleware, analyzePassHandler);
app.get('/api/pipeline/passes/:videoId', authMiddleware, getVideoPassesHandler);

// Atomic Sign-Off endpoints
app.post('/api/signoff/inventory', authMiddleware, inventorySignOffHandler);
app.post('/api/signoff/archive', authMiddleware, archiveSignOffHandler);

// Multi-tenant document lookup endpoint
app.get('/databases/:databaseId/documents/video_analyses/:videoId', authMiddleware, getVideoAnalysisHandler);

// Multi-inventory management routes
app.use('/api/inventories', authMiddleware, inventoryRoutes);
app.get('/api/inventories', authMiddleware, listInventoriesHandler);
app.post('/api/inventories', authMiddleware, createInventoryHandler);
app.get('/api/inventories/:id', authMiddleware, getInventoryHandler);
app.post('/api/inventories/:id/empty', authMiddleware, emptyInventoryHandler);

// Experiment archive management routes
app.use('/api/archives', authMiddleware, archiveRoutes);
app.get('/api/archives', authMiddleware, listArchivesHandler);
app.post('/api/archives', authMiddleware, createArchiveHandler);
app.get('/api/archives/:id', authMiddleware, getArchiveHandler);

// ----------------------------------------------------
// Serve Vite frontend static assets
// ----------------------------------------------------
// From /app/src/server/dist -> ../../client/dist -> /app/src/client/dist
const clientDistPath = path.resolve(__dirname, '../../client/dist');

app.use(express.static(clientDistPath));

// For all non-API GET requests, return index.html for React SPA client-side routing
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

const PORT = Number(process.env.PORT) || 8080;

if (process.env.AUTO_BACKFILL_ORGS === 'true') {
  backfillLegacyVideos('substance-ai').catch((err) => {
    console.error('[Migration] Auto-backfill on startup failed:', err);
  });
}

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[SAIL Server] Listening on port ${PORT}`);
  });
}

export { app, backfillLegacyVideos, backfillVideosHandler };
export default app;
