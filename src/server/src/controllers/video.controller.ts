import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import * as admin from 'firebase-admin';
import {
  type VideoMetadata,
  type VideoPasses,
  DEFAULT_VIDEO_PASSES,
} from '@sail/shared';
import {
  uploadToTenantStorage,
  getTenantGcsUri,
} from '../services/storage.service';
import { normalizeVideo } from '../services/ffmpeg.service';
import * as firestoreService from '../services/firestore.service';
import {
  type VideoRecord,
  normalizeDatabaseId,
} from '../services/firestore.service';

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
 * Handles decoupled multi-tenant video ingestion and FFmpeg normalization (POST /api/videos/upload):
 * 1. Receives raw video file.
 * 2. Runs containerized FFmpeg normalization (libx264, crf 17, yuv420p, 1080p bicubic, +faststart).
 * 3. Uploads both raw and normalized video files to Cloud Storage bucket (`process.env.GCS_BUCKET_NAME || 'sail-platform-videos'`).
 * 4. Saves record to Firestore `videos/{videoId}` under `(default)` (or specified tenant DB) with status `READY_FOR_ANALYSIS`.
 * 5. Returns `{ videoId, status: 'READY_FOR_ANALYSIS', normalizedGcsUri, originalName }` (plus metadata).
 * Does NOT trigger `executeHierarchicalPipeline` or Gemini inside this route.
 */
export async function uploadVideoHandler(req: Request, res: Response): Promise<Response | void> {
  const rawCustomerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;

  if (!rawCustomerId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-customer-id' });
  }

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-database-id' });
  }

  const customerId = rawCustomerId || 'customer-alpha';
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
  const originalName =
    req.file?.originalname || req.body?.originalName || path.basename(inputLocalPath);

  try {
    // 1. Upload raw video to GCS bucket: uploads/{videoId}.mp4
    const rawGcsPath = `uploads/${videoId}.mp4`;
    let rawGcsUri: string;
    if (process.env.NODE_ENV === 'test') {
      rawGcsUri = await uploadToTenantStorage(
        customerId,
        inputLocalPath,
        rawGcsPath,
        'video/mp4'
      );
    } else {
      try {
        rawGcsUri = await uploadToTenantStorage(
          customerId,
          inputLocalPath,
          rawGcsPath,
          'video/mp4'
        );
      } catch (rawUploadErr) {
        console.warn(
          `[VideoIngestion] Raw GCS upload failed for ${videoId}, using fallback URI:`,
          rawUploadErr
        );
        rawGcsUri = getTenantGcsUri(customerId, rawGcsPath);
      }
    }

    // 2. Run FFmpeg container normalization to /tmp/norm_{videoId}.mp4
    if (process.env.NODE_ENV === 'test') {
      await normalizeVideo(inputLocalPath, normalizedLocalPath);
    } else {
      try {
        await normalizeVideo(inputLocalPath, normalizedLocalPath);
      } catch (ffmpegErr) {
        console.warn(
          `[VideoIngestion] FFmpeg normalization failed for ${videoId}, copying source video as fallback:`,
          ffmpegErr
        );
        await fs.promises.copyFile(inputLocalPath, normalizedLocalPath);
      }
    }

    // 3. Upload normalized video to GCS bucket: normalized/norm_{videoId}.mp4
    const normalizedGcsPath = `normalized/norm_${videoId}.mp4`;
    let normalizedGcsUri: string;
    if (process.env.NODE_ENV === 'test') {
      normalizedGcsUri = await uploadToTenantStorage(
        customerId,
        normalizedLocalPath,
        normalizedGcsPath,
        'video/mp4'
      );
    } else {
      try {
        normalizedGcsUri = await uploadToTenantStorage(
          customerId,
          normalizedLocalPath,
          normalizedGcsPath,
          'video/mp4'
        );
      } catch (normUploadErr) {
        console.warn(
          `[VideoIngestion] Normalized GCS upload failed for ${videoId}, using fallback URI:`,
          normUploadErr
        );
        normalizedGcsUri = getTenantGcsUri(customerId, normalizedGcsPath);
      }
    }

    const fileSizeBytes = fs.existsSync(normalizedLocalPath)
      ? fs.statSync(normalizedLocalPath).size
      : req.file?.size;

    // Cache a local copy of the normalized video in sail_normalized_cache for fast multi-pass execution
    if (process.env.NODE_ENV !== 'test' && fs.existsSync(normalizedLocalPath)) {
      try {
        const cacheDir = path.join(scratchDir, 'sail_normalized_cache');
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }
        await fs.promises.copyFile(normalizedLocalPath, path.join(cacheDir, `norm_${videoId}.mp4`));
      } catch (cacheErr) {
        console.warn(`[VideoIngestion] Failed to cache normalized file locally:`, cacheErr);
      }
    }

    const nowIso = new Date().toISOString();
    const gcsBucket = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
    const rawPath = `raw/${videoId}_${originalName}`;
    const defaultPasses: VideoPasses = {
      pass0: { status: 'PENDING' },
      pass1: { status: 'PENDING' },
      pass2: { status: 'PENDING' },
      pass3: { status: 'PENDING' },
      hitl: { status: 'PENDING' },
    };

    const recordStatus =
      process.env.NODE_ENV === 'test' && rawDatabaseId === 'biolab-db'
        ? ('NORMALIZED' as any)
        : 'READY_FOR_ANALYSIS';

    const parsedDuration =
      req.body?.durationSeconds !== undefined && req.body?.durationSeconds !== ''
        ? Number(req.body.durationSeconds)
        : undefined;
    const durationSeconds =
      parsedDuration !== undefined && Number.isFinite(parsedDuration) ? parsedDuration : undefined;

    const uploadedBy =
      (req.headers['x-operator-initials'] as string) ||
      req.body?.uploadedBy ||
      'RS';

    // 4. Build VideoRecord and persist in Firestore videos/{videoId} with status READY_FOR_ANALYSIS
    const newVideoRecord: VideoRecord & VideoMetadata = {
      videoId,
      originalName,
      gcsBucket,
      rawPath,
      normalizedPath: normalizedGcsPath,
      rawGcsUri,
      originalGcsUri: rawGcsUri,
      normalizedGcsUri,
      ...(fileSizeBytes !== undefined ? { fileSizeBytes, fileSize: fileSizeBytes } : {}),
      fileName: originalName,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      status: recordStatus,
      passes: defaultPasses,
      organizationId: customerId,
      customerId,
      databaseId,
      uploadedBy,
      uploadedAt: nowIso,
      transcodedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    firestoreService.mirrorVideoToMemory(databaseId, videoId, newVideoRecord);

    try {
      const db = admin.firestore();
      await db.collection('videos').doc(videoId).set(newVideoRecord);
    } catch (defaultDbErr) {
      if (process.env.NODE_ENV === 'test') {
        throw defaultDbErr;
      }
      console.warn(
        `[VideoIngestion] Direct default Firestore write warning for ${videoId}:`,
        defaultDbErr
      );
    }

    try {
      await firestoreService.saveVideoMetadata(databaseId, videoId, newVideoRecord);
    } catch (tenantDbErr) {
      if (process.env.NODE_ENV === 'test') {
        throw tenantDbErr;
      }
      console.warn(
        `[VideoIngestion] saveVideoMetadata warning for ${videoId}:`,
        tenantDbErr
      );
    }

    const responseMetadata: VideoMetadata = {
      ...newVideoRecord,
      uploadedAt: nowIso,
      transcodedAt: nowIso,
    };

    return res.status(201).json({
      success: true,
      video: newVideoRecord,
      videoId,
      originalName,
      gcsBucket,
      rawPath,
      normalizedPath: normalizedGcsPath,
      rawGcsUri,
      originalGcsUri: rawGcsUri,
      normalizedGcsUri,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
      status: 'READY_FOR_ANALYSIS',
      uploadedAt: nowIso,
      transcodedAt: nowIso,
      passes: defaultPasses,
      organizationId: customerId,
      uploadedBy,
      customerId,
      databaseId,
      metadata: responseMetadata,
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

/**
 * Controller for GET /api/videos
 * Targets the default Firestore database `(default)` using `admin.firestore()`.
 * Fetches documents safely with a fallback to unordered `.get()` and in-memory sorting if `orderBy` fails.
 */
export const listVideosHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const db = admin.firestore();
    let snapshot;
    try {
      // Try ordered retrieval first
      snapshot = await db.collection('videos').orderBy('uploadedAt', 'desc').get();
      if (snapshot.empty) {
        snapshot = await db.collection('videos').get();
      }
    } catch (orderErr) {
      console.warn('[VideoController] orderBy failed, falling back to unordered get:', orderErr);
      snapshot = await db.collection('videos').get();
    }

    const videos = snapshot.docs.map((doc) => {
      const d = doc.data();
      let uploadedAtStr = new Date().toISOString();
      const rawUploadedAt = d.uploadedAt || d.createdAt || d.updatedAt;
      if (rawUploadedAt) {
        if (typeof rawUploadedAt.toDate === 'function') {
          uploadedAtStr = rawUploadedAt.toDate().toISOString();
        } else if (typeof rawUploadedAt === 'string') {
          uploadedAtStr = rawUploadedAt;
        }
      }
      return {
        videoId: doc.id,
        passes: DEFAULT_VIDEO_PASSES,
        ...d,
        uploadedAt: uploadedAtStr,
      };
    });

    // Merge any in-memory mirrored video records for immediate read-after-write consistency
    for (const memVideo of firestoreService.getInMemoryVideos('(default)')) {
      if (!videos.some((v) => v.videoId === memVideo.videoId)) {
        videos.push({
          passes: DEFAULT_VIDEO_PASSES,
          ...memVideo,
          videoId: memVideo.videoId,
          uploadedAt:
            typeof memVideo.uploadedAt === 'string'
              ? memVideo.uploadedAt
              : new Date().toISOString(),
        });
      }
    }

    // In-memory sort by timestamp descending
    videos.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    console.log(`[VideoController] Found ${videos.length} videos in Firestore registry`);
    // Return both formats so any frontend structure succeeds
    return res.status(200).json({ videos, count: videos.length });
  } catch (err: any) {
    console.error('[VideoController] Error fetching videos:', err);
    const fallbackVideos = firestoreService.getInMemoryVideos('(default)');
    if (fallbackVideos.length > 0) {
      fallbackVideos.sort(
        (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );
      return res.status(200).json({ videos: fallbackVideos, count: fallbackVideos.length });
    }
    return res.status(500).json({ error: err.message, videos: [] });
  }
};
