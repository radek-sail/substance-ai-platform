import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import videoRoutes from './routes/video.routes';
import { uploadMiddleware, uploadVideoHandler } from './controllers/video.controller';

// Load environment variables
dotenv.config();

const app: Express = express();

// Configure CORS and Body Parsers
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

// Video routes via router
app.use('/api/videos', videoRoutes);

// Direct route registration for POST /api/videos/upload
app.post('/api/videos/upload', uploadMiddleware, uploadVideoHandler);

const PORT = Number(process.env.PORT) || 8080;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[SAIL Server] Listening on port ${PORT}`);
  });
}

export { app };
export default app;

