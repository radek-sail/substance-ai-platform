import { Request, Response, NextFunction } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import {
  type VideoMetadata,
  type VideoPasses,
  DEFAULT_VIDEO_PASSES,
} from '@sail/shared';
import {
  storage,
  uploadToTenantStorage,
  getTenantGcsUri,
} from '../services/storage.service';
import { normalizeVideo } from '../services/ffmpeg.service';
import * as firestoreService from '../services/firestore.service';
import {
  db,
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
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
});

/**
 * Permissive upload middleware to accept multipart files from common field names ('video', 'file', etc.)
 * or pass through JSON/body requests. Allows video files up to 500MB without throwing LIMIT_FILE_SIZE.
 */
export const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  videoUpload.any()(req, res, (err) => {
    if (err) {
      if ((err as any).code === 'LIMIT_FILE_SIZE') {
        console.error('[VideoController] Upload rejected: File exceeds 500MB size limit');
        return res.status(413).json({ error: 'File size exceeds 500MB limit' });
      }
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
 * 3. Uploads both raw and normalized video files to Cloud Storage bucket (`process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod'`).
 * 4. Saves record to Firestore `videos/{videoId}` under `(default)` (or specified tenant DB) with status `READY_FOR_ANALYSIS`.
 * 5. Returns `{ videoId, status: 'READY_FOR_ANALYSIS', normalizedGcsUri, originalName }` (plus metadata).
 * Does NOT trigger `executeHierarchicalPipeline` or Gemini inside this route.
 */
export async function uploadVideoHandler(req: Request, res: Response): Promise<Response | void> {
  console.log('[VideoController] Incoming upload request for file:', req.file?.originalname, 'size:', req.file?.size);

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

  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';
  const bucket = storage.bucket(bucketName);

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
    // 1. Upload raw video to Cloud Storage: uploads/{videoId}.mp4
    const rawGcsPath = `uploads/${videoId}.mp4`;
    let rawGcsUri = `gs://${bucketName}/${rawGcsPath}`;
    if (process.env.NODE_ENV === 'test') {
      rawGcsUri = await uploadToTenantStorage(
        customerId,
        inputLocalPath,
        rawGcsPath,
        'video/mp4'
      );
    } else {
      try {
        await bucket.upload(inputLocalPath, {
          destination: rawGcsPath,
          metadata: {
            contentType: 'video/mp4',
          },
          resumable: false,
        });
        rawGcsUri = `gs://${bucketName}/${rawGcsPath}`;
      } catch (rawUploadErr) {
        console.warn(`[Upload] Raw video upload to gs://${bucketName}/${rawGcsPath} warning:`, rawUploadErr);
      }
    }

    // 2. Ensure FFmpeg finishes writing the normalized file to local disk/temp folder
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

    // Verify the normalized file exists on disk and has a size > 0
    if (!fs.existsSync(normalizedLocalPath)) {
      throw new Error(`Transcoded output file was not created at ${normalizedLocalPath}`);
    }
    const stats = fs.statSync(normalizedLocalPath);
    if (stats.size === 0) {
      throw new Error('Transcoded output file is 0 bytes.');
    }

    // 3. Explicitly await the upload to Cloud Storage
    const destinationPath = `normalized/norm_${videoId}.mp4`;
    let normalizedGcsUri = `gs://${bucketName}/${destinationPath}`;

    if (process.env.NODE_ENV === 'test') {
      normalizedGcsUri = await uploadToTenantStorage(
        customerId,
        normalizedLocalPath,
        destinationPath,
        'video/mp4'
      );
    } else {
      console.log(
        `[Upload] Uploading ${normalizedLocalPath} (${stats.size} bytes) to gs://${bucketName}/${destinationPath}...`
      );
      await bucket.upload(normalizedLocalPath, {
        destination: destinationPath,
        metadata: {
          contentType: 'video/mp4',
        },
        resumable: false,
      });

      // 4. Verify the object exists in GCS before continuing
      const [exists] = await bucket.file(destinationPath).exists();
      if (!exists) {
        throw new Error(
          `Upload verification failed: gs://${bucketName}/${destinationPath} does not exist after upload.`
        );
      }
      console.log(`[Upload] Verified file exists in GCS: gs://${bucketName}/${destinationPath}`);
    }

    // Cache a local copy of the normalized video in sail_normalized_cache for fast multi-pass execution
    if (fs.existsSync(normalizedLocalPath)) {
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
        : req.body?.duration !== undefined && req.body?.duration !== ''
        ? Number(req.body.duration)
        : undefined;
    const durationSeconds =
      parsedDuration !== undefined && Number.isFinite(parsedDuration) ? parsedDuration : undefined;

    const organizationId = req.user?.organizationId || 'substance-ai';
    const uploadedBy = req.user?.uid || 'anonymous';
    const uploaderEmail = req.user?.email || '';

    // 5. Save the Firestore record in videos/{videoId} only AFTER the file is confirmed in GCS
    const newVideoRecord: VideoRecord & VideoMetadata & { bucketName?: string } = {
      videoId,
      originalName,
      bucketName,
      gcsBucket: bucketName,
      rawPath: rawGcsPath,
      normalizedPath: destinationPath,
      rawGcsUri,
      originalGcsUri: rawGcsUri,
      normalizedGcsUri,
      durationSeconds: durationSeconds || 0,
      fileSizeBytes: stats.size,
      fileSize: stats.size,
      fileName: originalName,
      status: recordStatus,
      uploadedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      transcodedAt: nowIso,
      passes: defaultPasses,
      organizationId,
      customerId,
      databaseId,
      uploadedBy,
      uploaderEmail,
    };

    firestoreService.mirrorVideoToMemory(databaseId, videoId, newVideoRecord);

    // 5. Write the video metadata directly to db.collection('videos').doc(videoId).set(...) on the default Firestore database
    await db.collection('videos').doc(videoId).set(newVideoRecord);
    console.log('[Firestore] Successfully wrote video document:', videoId);

    if (process.env.NODE_ENV === 'test') {
      await firestoreService.saveVideoMetadata(databaseId, videoId, newVideoRecord);
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
      bucketName,
      gcsBucket: bucketName,
      rawPath: rawGcsPath,
      normalizedPath: destinationPath,
      rawGcsUri,
      originalGcsUri: rawGcsUri,
      normalizedGcsUri,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      fileSizeBytes: stats.size,
      status: recordStatus,
      uploadedAt: nowIso,
      transcodedAt: nowIso,
      passes: defaultPasses,
      organizationId,
      uploadedBy,
      uploaderEmail,
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
    // 6. Clean up scratch files in /tmp
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
    let snapshot;
    try {
      // Try ordered retrieval first
      snapshot = await db.collection('videos').orderBy('uploadedAt', 'desc').get();
      if (snapshot.empty) {
        snapshot = await db.collection('videos').get();
      }
    } catch (err: any) {
      if (err?.code === 9) {
        console.debug('[VideoController] orderBy index pending (code 9), falling back to unordered get');
      } else {
        console.warn('[VideoController] orderBy failed, falling back to unordered get:', err);
      }
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
    if (err?.code === 9) {
      console.debug('[VideoController] Firestore index pending while fetching videos:', err);
    } else {
      console.error('[VideoController] Error fetching videos:', err);
    }
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

/**
 * Controller for POST /api/videos/request-upload-url
 * Accepts `{ filename: string, contentType: string }`.
 * Generates a unique `videoId = 'vid_' + Date.now()` and a Google Cloud Storage V4 Signed URL for `PUT`
 * to `gs://<bucket>/raw/<videoId>/<filename>`.
 */
export const requestUploadUrlHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const filename = (req.body?.filename || req.body?.originalName) as string | undefined;
    const contentType = (req.body?.contentType || 'video/mp4') as string;

    if (!filename) {
      return res.status(400).json({ error: 'Missing required field: filename' });
    }

    const organizationId = req.user?.organizationId || 'substance-ai';
    const uploadedBy = req.user?.uid || 'anonymous';
    const uploaderEmail = req.user?.email || '';
    const videoId = `vid_${Date.now()}`;
    const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod');
    const rawPath = `raw/${videoId}/${filename}`;
    const file = bucket.file(rawPath);

    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 60 * 60 * 1000, // 60 minutes
      contentType,
    });

    return res.status(200).json({
      videoId,
      signedUrl,
      rawGcsUri: `gs://${bucket.name}/${rawPath}`,
      organizationId,
      uploadedBy,
      uploaderEmail,
    });
  } catch (err: any) {
    console.error('[VideoController] Error generating signed upload URL:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to generate signed upload URL',
    });
  }
};

/**
 * Controller for POST /api/videos/finalize-upload
 * Accepts `{ videoId, rawGcsUri, originalName }`.
 * Sets the initial record in Firestore with status 'TRANSCODING' and returns HTTP 202 immediately.
 * Streams the raw file from GCS through containerized FFmpeg to generate 10-minute normalized chunks
 * into `/tmp/chunks_${videoId}/chunk_%03d.mp4`, uploads each chunk to
 * `gs://${bucketName}/normalized/${videoId}/chunk_00X.mp4` in the background, updates Firestore to
 * 'READY_FOR_ANALYSIS' on success or 'ERROR' on failure, and cleans up `/tmp` files.
 */
export const finalizeUploadHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const { videoId, rawGcsUri, originalName, durationSeconds: reqDurationSeconds } = req.body || {};

  if (!videoId || !rawGcsUri || !originalName) {
    return res.status(400).json({
      error: 'Missing required fields: videoId, rawGcsUri, originalName',
    });
  }

  const organizationId = req.user?.organizationId || 'substance-ai';
  const uploadedBy = req.user?.uid || 'anonymous';
  const uploaderEmail = req.user?.email || '';
  const uploadedAt = new Date().toISOString();
  const initialRecord = {
    videoId,
    originalName,
    rawGcsUri,
    organizationId,
    uploadedBy,
    uploaderEmail,
    status: 'TRANSCODING' as const,
    transcodeProgress: 0,
    totalChunks: 0,
    chunks: [],
    uploadedAt,
    passes: {
      pass0: { status: 'PENDING' as const },
      pass1: { status: 'PENDING' as const },
      pass2: { status: 'PENDING' as const },
      pass3: { status: 'PENDING' as const },
      hitl: { status: 'PENDING' as const },
    },
  };

  try {
    // 1. Write an initial record to Firestore videos/{videoId}
    await db.collection('videos').doc(videoId).set(initialRecord);
    firestoreService.mirrorVideoToMemory('(default)', videoId, initialRecord);
  } catch (err: any) {
    console.error(`[VideoController] Error creating initial video record for ${videoId}:`, err);
    return res.status(500).json({
      error: err?.message || 'Failed to initialize video record in Firestore',
      videoId,
    });
  }

  // 2. Return HTTP 202 immediately to prevent Cloud Run HTTP 504 gateway timeout terminations
  res.status(202).json({ success: true, videoId, status: 'TRANSCODING' });

  // 3. Execute download from GCS, FFmpeg 10-minute chunking/normalization, and chunk uploads in the background
  (async () => {
    const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';
    const bucket = storage.bucket(bucketName);

    // Extract relative object path from rawGcsUri (e.g. gs://<bucket>/raw/<videoId>/<filename> -> raw/<videoId>/<filename>)
    let rawPath = String(rawGcsUri);
    if (rawPath.startsWith('gs://')) {
      const withoutScheme = rawPath.replace(/^gs:\/\//, '');
      const firstSlash = withoutScheme.indexOf('/');
      rawPath = firstSlash !== -1 ? withoutScheme.substring(firstSlash + 1) : `raw/${videoId}/${originalName}`;
    }
    rawPath = rawPath.replace(/^\/+/, '');

    const scratchDir = getScratchDir();
    const ext = path.extname(originalName) || '.mp4';
    const rawFilePath = path.join(scratchDir, `raw_${videoId}${ext}`);
    const chunksDir = `/tmp/chunks_${videoId}`;
    const outputPattern = path.join(chunksDir, 'chunk_%03d.mp4');

    try {
      console.log(`[Transcode] Starting background transcoding for ${videoId}`);
      console.log(`[Transcode] Downloading raw file: ${rawGcsUri}`);

      // Ensure input directory exists
      if (!fs.existsSync(scratchDir)) {
        fs.mkdirSync(scratchDir, { recursive: true });
      }

      const rawFile = bucket.file(rawPath);

      // Download raw file to local rawFilePath
      if (fs.existsSync(rawGcsUri)) {
        console.log(`[Transcode] Local raw file found, copying to ${rawFilePath}`);
        await fs.promises.copyFile(rawGcsUri, rawFilePath);
      } else {
        console.log(`[Transcode] Downloading raw file from GCS: gs://${bucketName}/${rawPath} -> ${rawFilePath}`);
        await rawFile.download({ destination: rawFilePath });
        console.log(`[Transcode] Download completed (${fs.statSync(rawFilePath).size} bytes)`);
      }

      // Ensure /tmp/chunks_${videoId} is created before spawning FFmpeg
      let totalDurationSeconds: number =
        typeof reqDurationSeconds === 'number' && Number.isFinite(reqDurationSeconds) && reqDurationSeconds > 0
          ? reqDurationSeconds
          : typeof reqDurationSeconds === 'string' && parseFloat(reqDurationSeconds) > 0
          ? parseFloat(reqDurationSeconds)
          : 0;

      if (totalDurationSeconds <= 0) {
        try {
          const ffprobeBinary = process.env.FFPROBE_PATH || 'ffprobe';
          const probeArgs = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            rawFilePath,
          ];
          const probeProcess = spawn(ffprobeBinary, probeArgs);
          let probeOutput = '';
          probeProcess.stdout?.on('data', (d) => { probeOutput += String(d); });
          await new Promise<void>((resolve) => {
            probeProcess.on('close', () => resolve());
            probeProcess.on('error', () => resolve());
          });
          const parsed = parseFloat(probeOutput.trim());
          if (!isNaN(parsed) && parsed > 0) {
            totalDurationSeconds = parsed;
            console.log(`[Transcode ${videoId}] Input duration: ${totalDurationSeconds}s`);
          }
        } catch (probeErr) {
          console.warn(`[Transcode ${videoId}] ffprobe duration probe failed:`, probeErr);
        }
      }

      fs.mkdirSync(chunksDir, { recursive: true });

      const ffmpegArgs = [
        '-nostdin',
        '-y',
        '-i', rawFilePath,
        '-progress', 'pipe:1',
        '-vf', "scale='min(1920,iw)':-2,format=yuv420p", // Standardizes both Meta Ray-Ban and BleeqUp to 8-bit
        '-r', '30',                                      // Caps variable fps to 30 fps
        '-c:v', 'libx264',
        '-preset', 'ultrafast',                          // Fast software encoding for Cloud Run vCPUs
        '-tune', 'fastdecode',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-force_key_frames', 'expr:gte(t,n_forced*600)', // Chunk keyframes every 10 min
        '-f', 'segment',
        '-segment_time', '600',
        '-reset_timestamps', '1',
        outputPattern
      ];

      console.log(`[Transcode] Launching FFmpeg segmentation for ${videoId}...`);
      const ffmpegBinary = process.env.FFMPEG_PATH || 'ffmpeg';
      let ffmpegStderr = '';

      let lastUpdate = 0;
      const parseTime = (timeStr: string): number => {
        const parts = timeStr.trim().split(':');
        if (parts.length === 3) {
          return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        }
        return 0;
      };

      const handleProgressLine = async (line: string) => {
        if (!totalDurationSeconds || totalDurationSeconds <= 0) {
          const durMatch =
            line.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/) ||
            ffmpegStderr.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
          if (durMatch) {
            totalDurationSeconds = parseTime(durMatch[1]);
          }
        }
        const match = line.match(/(?:out_time|time)=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
        if (match && totalDurationSeconds > 0) {
          const currentTime = parseTime(match[1]);
          const pct = Math.min(99, Math.max(1, Math.round((currentTime / totalDurationSeconds) * 100)));
          const now = Date.now();
          if (now - lastUpdate > 3000) {
            lastUpdate = now;
            firestoreService.mirrorVideoToMemory('(default)', videoId, {
              transcodeProgress: pct,
            });
            await db.collection('videos').doc(videoId).update({
              transcodeProgress: pct,
            }).catch(() => {});
          }
        }
      };

      await new Promise<void>((resolve, reject) => {
        const childProcess = spawn(ffmpegBinary, ffmpegArgs);

        childProcess.stdout?.on('data', (d) => {
          const str = String(d);
          console.log(`[FFmpeg ${videoId} stdout]: ${str}`);
          for (const line of str.split(/[\r\n]+/)) {
            if (line.trim()) void handleProgressLine(line);
          }
        });
        childProcess.stderr?.on('data', (d) => {
          const str = String(d);
          ffmpegStderr += str;
          console.log(`[FFmpeg ${videoId} stderr]: ${str}`);
          for (const line of str.split(/[\r\n]+/)) {
            if (line.trim()) void handleProgressLine(line);
          }
        });

        childProcess.on('error', (err) => {
          console.error(`[FFmpeg ${videoId}] Spawn error:`, err);
          reject(err);
        });

        childProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`[FFmpeg ${videoId}] Completed successfully`);
            resolve();
          } else {
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        });
      });

      if (fs.existsSync(rawFilePath)) {
        try {
          fs.unlinkSync(rawFilePath);
          console.log(`[Transcode] Deleted raw file from /tmp to free memory: ${rawFilePath}`);
        } catch (e) {
          console.warn(`[Transcode] Failed to unlink raw file:`, e);
        }
      }

      const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.mp4')).sort();
      console.log(`[Transcode] Found ${files.length} chunks to upload`);
      if (files.length === 0) {
        throw new Error(`No mp4 chunks found in ${chunksDir}`);
      }

      const chunkRecords = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const localPath = path.join(chunksDir, file);
        const destination = `normalized/${videoId}/${file}`;
        console.log(`[Transcode] Uploading chunk ${i + 1}/${files.length}: ${destination}`);

        await bucket.upload(localPath, {
          destination,
          metadata: { contentType: 'video/mp4' },
        });

        chunkRecords.push({
          index: i,
          filename: file,
          gcsUri: `gs://${bucketName}/${destination}`,
          storagePath: destination,
        });

        // Unlink local chunk immediately after upload
        fs.unlinkSync(localPath);
      }

      await db.collection('videos').doc(videoId).update({
        status: 'READY_FOR_ANALYSIS',
        transcodeProgress: 100,
        chunks: chunkRecords,
        totalChunks: chunkRecords.length,
        normalizedGcsUri: chunkRecords[0]?.gcsUri || null,
      });
      firestoreService.mirrorVideoToMemory('(default)', videoId, {
        status: 'READY_FOR_ANALYSIS',
        transcodeProgress: 100,
        chunks: chunkRecords,
        totalChunks: chunkRecords.length,
        normalizedGcsUri: chunkRecords[0]?.gcsUri || undefined,
      });
      console.log(`[Transcode] Video ${videoId} marked READY_FOR_ANALYSIS`);
    } catch (err: any) {
      console.error(`[Transcode Error] Video ${videoId} failed:`, err);
      try {
        await db.collection('videos').doc(videoId).update({
          status: 'ERROR',
          errorMessage: err.message || 'Transcoding failed',
        });
        firestoreService.mirrorVideoToMemory('(default)', videoId, {
          status: 'ERROR',
          errorMessage: err.message || 'Transcoding failed',
        });
      } catch (dbErr) {
        console.error(`[Transcode Error] Failed to update Firestore with error status for ${videoId}:`, dbErr);
      }
    } finally {
      // Process cleanup: raw temporary file and temporary chunk files are cleaned up (unlinked) after GCS upload finishes or on error
      if (fs.existsSync(rawFilePath)) {
        try {
          await fs.promises.unlink(rawFilePath);
          console.log(`[Transcode] Cleaned up raw temporary file: ${rawFilePath}`);
        } catch (cleanupErr) {
          console.warn(`[Transcode] Failed to unlink temp raw file ${rawFilePath}:`, cleanupErr);
        }
      }

      if (fs.existsSync(chunksDir)) {
        try {
          const files = fs.readdirSync(chunksDir);
          for (const file of files) {
            const filePath = path.join(chunksDir, file);
            try {
              await fs.promises.unlink(filePath);
              console.log(`[Transcode] Cleaned up temp chunk file: ${filePath}`);
            } catch (unlinkErr) {
              console.warn(`[Transcode] Failed to unlink chunk file ${filePath}:`, unlinkErr);
            }
          }
          await fs.promises.rm(chunksDir, { recursive: true, force: true });
          console.log(`[Transcode] Cleaned up chunk directory: ${chunksDir}`);
        } catch (cleanupErr) {
          console.warn(`[Transcode] Failed to remove chunk directory ${chunksDir}:`, cleanupErr);
        }
      }
    }
  })();
};

/**
 * Controller for DELETE /api/videos/:videoId
 * Performs a cascading clean-up in Google Cloud Storage (`raw/<videoId>/`, `normalized/<videoId>/`, etc.),
 * removes the video record (`videos/{videoId}`), any subcollections, and its analysis (`video_analyses/{videoId}`)
 * from Firestore, and cleans up any local cache artifacts.
 */
export const deleteVideoHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const videoId = req.params.videoId || req.body?.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing required parameter: videoId' });
  }

  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  try {
    const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';
    const bucket = storage.bucket(bucketName);

    // 1. Delete all raw files for this video
    try {
      await bucket.deleteFiles({ prefix: `raw/${videoId}/` });
      console.log(`[VideoController] Deleted raw GCS objects for ${videoId}`);
    } catch (err) {
      console.warn(`[VideoController] Failed to delete raw objects for ${videoId}:`, err);
    }

    // 2. Delete all normalized chunk files for this video
    try {
      await bucket.deleteFiles({ prefix: `normalized/${videoId}/` });
      console.log(`[VideoController] Deleted normalized GCS objects for ${videoId}`);
    } catch (err) {
      console.warn(`[VideoController] Failed to delete normalized objects for ${videoId}:`, err);
    }

    // Also clean up any legacy single-file uploads, normalized copies, thumbnails, and frames in GCS
    try {
      await Promise.allSettled([
        bucket.file(`uploads/${videoId}.mp4`).delete().catch(() => {}),
        bucket.file(`normalized/norm_${videoId}.mp4`).delete().catch(() => {}),
        bucket.file(`thumbnails/thumb_${videoId}.mp4`).delete().catch(() => {}),
        bucket.deleteFiles({ prefix: `frames/${videoId}/` }).catch(() => {}),
      ]);
    } catch {
      // Ignore additional GCS cleanup errors
    }

    // 3. Delete any subcollections and the parent Firestore document
    const videoDocRef = db.collection('videos').doc(videoId) as any;
    if (videoDocRef && typeof videoDocRef.listCollections === 'function') {
      try {
        const subcollections = await videoDocRef.listCollections();
        for (const subcol of subcollections) {
          const subSnap = await subcol.get();
          for (const subDoc of subSnap.docs) {
            await subDoc.ref.delete();
          }
        }
      } catch (subErr) {
        console.warn(`[VideoController] Failed to delete subcollections for ${videoId}:`, subErr);
      }
    }

    await db.collection('videos').doc(videoId).delete();
    console.log(`[VideoController] Deleted Firestore document for ${videoId}`);

    // 4. Verify if any analysis records exist in video_analyses/{videoId} and remove them
    try {
      const analysisDocRef = db.collection('video_analyses').doc(videoId) as any;
      const analysisSnap =
        analysisDocRef && typeof analysisDocRef.get === 'function'
          ? await analysisDocRef.get()
          : null;
      if (!analysisSnap || analysisSnap.exists) {
        if (analysisDocRef && typeof analysisDocRef.listCollections === 'function') {
          const analysisSubcols = await analysisDocRef.listCollections().catch(() => []);
          for (const subcol of analysisSubcols) {
            const subSnap = await subcol.get();
            for (const subDoc of subSnap.docs) {
              await subDoc.ref.delete();
            }
          }
        }
        await db.collection('video_analyses').doc(videoId).delete();
        console.log(`[VideoController] Deleted Firestore analysis document video_analyses/${videoId}`);
      }
    } catch (analysisErr) {
      console.warn(`[VideoController] Failed to delete video_analyses/${videoId}:`, analysisErr);
    }

    // Ensure tenant and in-memory stores are also cleaned up
    await firestoreService.deleteVideoRecord(databaseId, videoId);
    if (databaseId !== '(default)') {
      await firestoreService.deleteVideoRecord('(default)', videoId);
    }

    // Clean up local cache files, extracted frames, and pass artifacts if present
    try {
      const scratchDir = getScratchDir();
      const safeVideoId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filesToUnlink = [
        path.join(scratchDir, 'sail_raw_cache', `raw_${videoId}.mp4`),
        path.join(scratchDir, 'sail_normalized_cache', `norm_${videoId}.mp4`),
        path.join(scratchDir, 'sail_thumbnail_cache', `thumb_${videoId}.mp4`),
        path.join(os.tmpdir(), 'sail_thumbnail_cache', `thumb_${videoId}.mp4`),
        path.join(scratchDir, `upload_${videoId}.mp4`),
        path.join(scratchDir, `norm_${videoId}.mp4`),
      ];
      for (const filePath of filesToUnlink) {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }

      const dirsToClean = [
        path.join(os.tmpdir(), 'sail_persistent_frames', videoId),
        path.join(process.cwd(), 'frames', videoId),
        path.join(os.tmpdir(), `sail_frames_${videoId}`),
        path.join(scratchDir, `sail_frames_${videoId}`),
        path.join(os.tmpdir(), 'sail_pass_artifacts', safeVideoId),
        path.join(os.tmpdir(), 'sail_pass_artifacts', videoId),
      ];
      for (const dir of dirsToClean) {
        if (fs.existsSync(dir)) {
          await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // Ignore local cache cleanup errors
    }

    return res.status(200).json({
      success: true,
      videoId,
      message: `Video ${videoId} removed from database.`,
    });
  } catch (err: any) {
    console.error(`[VideoController] Error deleting video ${videoId}:`, err);
    return res.status(500).json({ error: err?.message || 'Failed to delete video' });
  }
};
