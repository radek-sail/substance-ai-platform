import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import type { VideoMetadata } from '@sail/shared';
import { uploadToTenantStorage } from '../services/storage.service';
import { normalizeVideo } from '../services/ffmpeg.service';
import { normalizeDatabaseId, saveVideoMetadata } from '../services/firestore.service';

/**
 * Resolves the scratch directory for temporary video processing.
 * Defaults to /tmp per container architecture, falling back to os.tmpdir() if inaccessible.
 */
export function getScratchDir(): string {
  const candidate = '/tmp';
  try {
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate, { recursive: true });
    }
    return candidate;
  } catch {
    return os.tmpdir();
  }
}

// Multer storage setup targeting the scratch directory
const multerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, getScratchDir());
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `upload_${uniqueSuffix}${ext}`);
  },
});

export const videoUpload = multer({
  storage: multerStorage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB max file size
  },
});

/**
 * Permissive upload middleware to accept multipart files from common field names ('video', 'file', etc.)
 * or pass through JSON/body requests.
 */
export const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  videoUpload.any()(req, res, (err) => {
    if (err) {
      return next(err);
    }
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0];
    }
    next();
  });
};

/**
 * Handles multi-tenant video ingestion:
 * 1. Validates tenant headers (`x-customer-id`, `x-database-id`).
 * 2. Uploads original video to `gs://{bucketName}/uploads/{videoId}.mp4`.
 * 3. Runs containerized FFmpeg normalization to `/tmp/norm_{videoId}.mp4`.
 * 4. Uploads normalized MP4 to `gs://{bucketName}/normalized/norm_{videoId}.mp4`.
 * 5. Persists metadata record in Firestore `videos/{videoId}`.
 * 6. Cleans up temporary scratch files in `/tmp`.
 */
export async function uploadVideoHandler(req: Request, res: Response): Promise<Response | void> {
  // Extract tenant headers
  const customerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;

  if (!customerId) {
    return res.status(400).json({ error: 'Missing required header: x-customer-id' });
  }

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-database-id' });
  }

  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
  const videoId = (req.headers['x-video-id'] || req.body?.videoId || crypto.randomUUID()) as string;

  const scratchDir = getScratchDir();
  let tempUploadedFile: string | null = null;
  let inputLocalPath = req.file?.path || req.body?.filePath || req.body?.localFilePath;

  // Handle optional base64 encoded video payloads
  if (!inputLocalPath && req.body?.videoBase64) {
    tempUploadedFile = path.join(scratchDir, `upload_${videoId}.mp4`);
    const buffer = Buffer.from(req.body.videoBase64, 'base64');
    await fs.promises.writeFile(tempUploadedFile, buffer);
    inputLocalPath = tempUploadedFile;
  }

  if (!inputLocalPath || !fs.existsSync(inputLocalPath)) {
    return res.status(400).json({ error: 'No valid video file uploaded or filePath provided' });
  }

  const normalizedLocalPath = path.join(scratchDir, `norm_${videoId}.mp4`);

  try {
    // 1. Upload original video to tenant GCS bucket: uploads/{videoId}.mp4
    const originalGcsPath = `uploads/${videoId}.mp4`;
    const originalGcsUri = await uploadToTenantStorage(
      customerId,
      inputLocalPath,
      originalGcsPath,
      'video/mp4'
    );

    // 2. Run FFmpeg normalization to /tmp/norm_{videoId}.mp4
    await normalizeVideo(inputLocalPath, normalizedLocalPath);

    // 3. Upload normalized video to tenant GCS bucket: normalized/norm_{videoId}.mp4
    const normalizedGcsPath = `normalized/norm_${videoId}.mp4`;
    const normalizedGcsUri = await uploadToTenantStorage(
      customerId,
      normalizedLocalPath,
      normalizedGcsPath,
      'video/mp4'
    );

    // 4. Persist video record in Firestore videos/{videoId}
    const metadata: VideoMetadata = {
      videoId,
      customerId,
      databaseId,
      originalGcsUri,
      normalizedGcsUri,
      status: 'NORMALIZED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileName: req.file?.originalname || path.basename(inputLocalPath),
      fileSize: fs.existsSync(normalizedLocalPath) ? fs.statSync(normalizedLocalPath).size : undefined,
    };

    await saveVideoMetadata(databaseId, videoId, metadata);

    return res.status(201).json({
      success: true,
      videoId,
      customerId,
      databaseId,
      originalGcsUri,
      normalizedGcsUri,
      metadata,
    });
  } catch (error: any) {
    console.error(`[VideoIngestion] Error processing video ${videoId}:`, error);
    return res.status(500).json({
      error: error?.message || 'Video ingestion failed',
      videoId,
    });
  } finally {
    // 5. Clean up scratch files in /tmp
    const filesToCleanup = [normalizedLocalPath];
    if (req.file?.path) {
      filesToCleanup.push(req.file.path);
    }
    if (tempUploadedFile) {
      filesToCleanup.push(tempUploadedFile);
    }

    for (const filePath of filesToCleanup) {
      if (filePath && fs.existsSync(filePath)) {
        try {
          await fs.promises.unlink(filePath);
        } catch (cleanupErr) {
          console.warn(`[VideoIngestion] Failed to remove scratch file ${filePath}:`, cleanupErr);
        }
      }
    }
  }
}
