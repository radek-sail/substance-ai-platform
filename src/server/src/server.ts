import path from 'path';
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import videoRoutes from './routes/video.routes';
import pipelineRoutes from './routes/pipeline.routes';
import {
  uploadMiddleware,
  uploadVideoHandler,
  listVideosHandler,
} from './controllers/video.controller';
import {
  analyzePipelineHandler,
  analyzePassHandler,
  getVideoPassesHandler,
  inventorySignOffHandler,
  archiveSignOffHandler,
  getVideoAnalysisHandler,
} from './controllers/pipeline.controller';

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

// Video routes via router (GET /api/videos, POST /api/videos/upload)
app.use('/api/videos', videoRoutes);

// Direct route registrations for video endpoints
app.get('/api/videos', listVideosHandler);
app.post('/api/videos/upload', uploadMiddleware, uploadVideoHandler);

// Pipeline analysis routes
app.use('/api/pipeline', pipelineRoutes);
app.post('/api/pipeline/analyze', analyzePipelineHandler);
app.post('/api/pipeline/analyze-pass', analyzePassHandler);
app.get('/api/pipeline/passes/:videoId', getVideoPassesHandler);

// Atomic Sign-Off endpoints
app.post('/api/signoff/inventory', inventorySignOffHandler);
app.post('/api/signoff/archive', archiveSignOffHandler);

// Multi-tenant document lookup endpoint
app.get('/databases/:databaseId/documents/video_analyses/:videoId', getVideoAnalysisHandler);

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

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[SAIL Server] Listening on port ${PORT}`);
  });
}

export { app };
export default app;
