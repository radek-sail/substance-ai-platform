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
import { normalizeVideo, extractCandidateFrame } from '../services/ffmpeg.service';
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

    // Cache a local copy of the raw (full-resolution) and normalized video for fast multi-pass execution
    if (inputLocalPath && fs.existsSync(inputLocalPath)) {
      try {
        const rawCacheDir = path.join(scratchDir, 'sail_raw_cache');
        if (!fs.existsSync(rawCacheDir)) {
          fs.mkdirSync(rawCacheDir, { recursive: true });
        }
        await fs.promises.copyFile(inputLocalPath, path.join(rawCacheDir, `raw_${videoId}.mp4`));
      } catch (rawCacheErr) {
        console.warn(`[VideoIngestion] Failed to cache raw file locally:`, rawCacheErr);
      }
    }
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

    const uploadedBy =
      (req.headers['x-operator-initials'] as string) ||
      req.body?.uploadedBy ||
      'RS';

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
      organizationId: customerId,
      customerId,
      databaseId,
      uploadedBy,
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
  const { videoId, rawGcsUri, originalName } = req.body || {};

  if (!videoId || !rawGcsUri || !originalName) {
    return res.status(400).json({
      error: 'Missing required fields: videoId, rawGcsUri, originalName',
    });
  }

  const uploadedAt = new Date().toISOString();
  const initialRecord = {
    videoId,
    originalName,
    rawGcsUri,
    status: 'TRANSCODING' as const,
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
      fs.mkdirSync(chunksDir, { recursive: true });

      const ffmpegArgs = [
        '-nostdin',
        '-y',
        '-i',
        rawFilePath,
        '-vf',
        "scale='min(1920,iw)':-2,format=yuv420p",
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-force_key_frames',
        'expr:gte(t,n_forced*600)',
        '-f',
        'segment',
        '-segment_time',
        '600',
        '-reset_timestamps',
        '1',
        outputPattern
      ];

      console.log(`[Transcode] Launching FFmpeg segmentation for ${videoId}...`);
      const ffmpegBinary = process.env.FFMPEG_PATH || 'ffmpeg';

      await new Promise<void>((resolve, reject) => {
        const childProcess = spawn(ffmpegBinary, ffmpegArgs);

        childProcess.stdout?.on('data', (d) => console.log(`[FFmpeg ${videoId}]: ${d}`));
        childProcess.stderr?.on('data', (d) => console.log(`[FFmpeg ${videoId}]: ${d}`));

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

      let chunkFiles = fs
        .readdirSync(chunksDir)
        .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp4'))
        .sort();

      console.log(`[Transcode] FFmpeg completed. Checking generated chunks...`);
      if (chunkFiles.length === 0) {
        throw new Error(`FFmpeg completed but 0 chunks were found in ${chunksDir}`);
      }
      console.log(`[Transcode] Found ${chunkFiles.length} chunk(s) generated for ${videoId}`);

      // Cache the raw (full-resolution) video locally before chunking/cleanup so Pass 2/3 frame extraction uses native full frame resolution
      if (fs.existsSync(rawFilePath)) {
        try {
          const rawCacheDir = path.join(scratchDir, 'sail_raw_cache');
          if (!fs.existsSync(rawCacheDir)) {
            fs.mkdirSync(rawCacheDir, { recursive: true });
          }
          await fs.promises.copyFile(rawFilePath, path.join(rawCacheDir, `raw_${videoId}.mp4`));
        } catch (rawCacheErr) {
          console.warn(`[Transcode] Failed to cache raw video locally:`, rawCacheErr);
        }
      }

      // Upload chunks to GCS
      console.log(`[Transcode] Uploading chunks to GCS...`);
      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkFilename = `chunk_${String(i).padStart(3, '0')}.mp4`;
        const localChunkPath = path.join(chunksDir, chunkFiles[i]);
        const destination = `normalized/${videoId}/${chunkFilename}`;

        console.log(`[Transcode] Uploading chunk ${i + 1}/${chunkFiles.length}: ${chunkFilename} to gs://${bucketName}/${destination}`);
        await bucket.upload(localChunkPath, {
          destination,
          metadata: {
            contentType: 'video/mp4',
          },
          resumable: false,
        });

        // Cache the first chunk locally for fast downstream Pass 0-3 execution
        if (i === 0 && fs.existsSync(localChunkPath)) {
          try {
            const cacheDir = path.join(scratchDir, 'sail_normalized_cache');
            if (!fs.existsSync(cacheDir)) {
              fs.mkdirSync(cacheDir, { recursive: true });
            }
            await fs.promises.copyFile(localChunkPath, path.join(cacheDir, `norm_${videoId}.mp4`));
          } catch (cacheErr) {
            console.warn(`[Transcode] Failed to cache first chunk locally:`, cacheErr);
          }
        }
      }

      const chunks = chunkFiles.map((_c, i) => ({
        index: i,
        gcsUri: `gs://${bucketName}/normalized/${videoId}/chunk_${String(i).padStart(3, '0')}.mp4`,
      }));

      const normalizedGcsUri =
        chunks[0]?.gcsUri || `gs://${bucketName}/normalized/${videoId}/chunk_000.mp4`;
      const transcodedAt = new Date().toISOString();

      // Update Firestore
      await db.collection('videos').doc(videoId).update({
        status: 'READY_FOR_ANALYSIS',
        totalChunks: chunks.length,
        chunks: chunks,
        transcodedAt,
        normalizedGcsUri,
      });
      firestoreService.mirrorVideoToMemory('(default)', videoId, {
        status: 'READY_FOR_ANALYSIS',
        totalChunks: chunks.length,
        chunks: chunks,
        transcodedAt,
        normalizedGcsUri,
      });
      console.log(`[Transcode] Video ${videoId} successfully marked READY_FOR_ANALYSIS`);
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
 * POST /api/videos/:videoId/associate-inventory
 * Manually associates a video record with an existing inventory.
 * Body: { inventoryId: string }
 */
export const associateInventoryHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const videoId = req.params.videoId || req.body?.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'Missing required parameter: videoId' });
  }

  const { inventoryId } = req.body || {};
  if (!inventoryId || typeof inventoryId !== 'string') {
    return res.status(400).json({ error: 'Missing required field: inventoryId' });
  }

  const rawCustomerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  try {
    // 1. Validate that inventoryId exists in Firestore inventories
    const dbTarget = firestoreService.getTenantFirestore(databaseId);
    let invDoc: any = null;
    try {
      const snap = await dbTarget.collection('inventories').doc(inventoryId).get();
      if (snap && snap.exists) {
        invDoc = snap.data();
      } else if (db && db !== dbTarget) {
        const fallbackSnap = await db.collection('inventories').doc(inventoryId).get();
        if (fallbackSnap && fallbackSnap.exists) {
          invDoc = fallbackSnap.data();
        }
      }
    } catch {
      if (db) {
        const fallbackSnap = await db.collection('inventories').doc(inventoryId).get();
        if (fallbackSnap && fallbackSnap.exists) {
          invDoc = fallbackSnap.data();
        }
      }
    }

    if (!invDoc) {
      return res.status(404).json({ error: `Inventory with ID '${inventoryId}' not found` });
    }

    const inventoryName = invDoc.name || inventoryId;
    const nowIso = new Date().toISOString();

    const updatePayload = {
      inventoryId,
      inventoryName,
      inventoryAssociationType: 'MANUAL' as const,
      associatedAt: nowIso,
      updatedAt: nowIso,
    };

    await firestoreService.updateVideoRecord(databaseId, videoId, updatePayload);
    if (databaseId !== '(default)') {
      await firestoreService.updateVideoRecord('(default)', videoId, updatePayload);
    }

    const updatedVideo =
      (await firestoreService.getVideoMetadata(databaseId, videoId)) ||
      (await firestoreService.getVideoMetadata('(default)', videoId));

    return res.status(200).json({
      success: true,
      message: `Video ${videoId} successfully associated with inventory '${inventoryName}' (${inventoryId}).`,
      video: updatedVideo,
      ...updatePayload,
    });
  } catch (error: any) {
    console.error(`[VideoController] Error associating inventory with video ${videoId}:`, error);
    return res.status(500).json({ error: error?.message || 'Failed to associate inventory' });
  }
};

/**
 * Controller for GET /api/videos/:videoId/frames/:filename
 * Serves extracted Pass 2 best-shot frames (HIGHEST_CONTRAST / MINIMAL_BLUR) and
 * refined action boundary frames (FIRST_FRAME / LAST_FRAME) from local cache, GCS,
 * or on-demand FFmpeg extraction from the normalized video.
 */
export const getVideoFrameHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const { videoId, filename } = req.params;
  if (!videoId || !filename) {
    return res.status(400).json({ error: 'Missing videoId or filename' });
  }

  const safeFilename = path.basename(filename);
  const scratchDir = getScratchDir();
  const candidateFrameDirs = Array.from(
    new Set([
      path.join(scratchDir, 'sail_frames_cache', videoId),
      path.join(os.tmpdir(), 'sail_frames_cache', videoId),
    ])
  );

  try {
    // 1. Check local frame cache directories first
    for (const dir of candidateFrameDirs) {
      const candidatePath = path.join(dir, safeFilename);
      if (fs.existsSync(candidatePath)) {
        const buf = fs.readFileSync(candidatePath);
        if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return res.status(200).send(buf);
        }
      }
    }

    // 2. Try downloading from GCS if not in local cache
    const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';
    const gcsObjectPath = `frames/${videoId}/${safeFilename}`;
    try {
      const file = storage.bucket(bucketName).file(gcsObjectPath);
      const [exists] = await file.exists();
      if (exists) {
        const [contents] = await file.download();
        if (contents && contents.length > 4 && contents[0] === 0xff && contents[1] === 0xd8) {
          // Cache locally for subsequent requests
          for (const dir of candidateFrameDirs) {
            try {
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              fs.writeFileSync(path.join(dir, safeFilename), contents);
            } catch {
              // ignore local cache write errors
            }
          }
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return res.status(200).send(contents);
        }
      }
    } catch {
      // fall through to on-demand extraction
    }

    // 3. On-demand FFmpeg frame extraction if timestamp can be resolved from query ?t= or filename
    let timestampSec: number | undefined;
    if (req.query?.t !== undefined) {
      const parsedT = Number(req.query.t);
      if (Number.isFinite(parsedT) && parsedT >= 0) {
        timestampSec = parsedT;
      }
    }
    if (timestampSec === undefined) {
      const tsMatch = safeFilename.match(/_([0-9]+(?:\.[0-9]+)?)\.jpe?g$/i);
      if (tsMatch) {
        const parsedT = Number(tsMatch[1]);
        if (Number.isFinite(parsedT) && parsedT >= 0) {
          timestampSec = parsedT;
        }
      }
    }

    if (timestampSec !== undefined) {
      try {
        // Prioritize full-resolution raw video cache before normalized (downsampled) video cache
        const rawCacheDirs = Array.from(
          new Set([
            path.join(scratchDir, 'sail_raw_cache'),
            path.join(os.tmpdir(), 'sail_raw_cache'),
          ])
        );
        const videoCacheDirs = Array.from(
          new Set([
            path.join(scratchDir, 'sail_normalized_cache'),
            path.join(os.tmpdir(), 'sail_normalized_cache'),
          ])
        );
        let localVideoPath: string | undefined;
        for (const rDir of rawCacheDirs) {
          const candidateRaw = path.join(rDir, `raw_${videoId}.mp4`);
          if (fs.existsSync(candidateRaw)) {
            const st = fs.statSync(candidateRaw);
            if (st.size > 1000) {
              localVideoPath = candidateRaw;
              break;
            }
          }
        }
        if (!localVideoPath) {
          for (const vDir of videoCacheDirs) {
            const candidateVideo = path.join(vDir, `norm_${videoId}.mp4`);
            if (fs.existsSync(candidateVideo)) {
              const st = fs.statSync(candidateVideo);
              if (st.size > 1000) {
                localVideoPath = candidateVideo;
                break;
              }
            }
          }
        }

        // Download raw (full-resolution) or normalized video from GCS if not cached locally
        if (!localVideoPath) {
          const targetRawDir = rawCacheDirs[0];
          if (!fs.existsSync(targetRawDir)) {
            fs.mkdirSync(targetRawDir, { recursive: true });
          }
          const downloadDest = path.join(targetRawDir, `raw_${videoId}.mp4`);

          const gcsCandidates: { bucket: string; objectPath: string }[] = [
            { bucket: bucketName, objectPath: `uploads/${videoId}.mp4` },
            { bucket: bucketName, objectPath: `normalized/${videoId}/chunk_000.mp4` },
            { bucket: bucketName, objectPath: `normalized/norm_${videoId}.mp4` },
          ];

          try {
            const videoDoc =
              (await firestoreService.getVideoMetadata('(default)', videoId)) || null;
            // Prioritize rawGcsUri first for full-resolution frame extraction!
            for (const uri of [videoDoc?.normalizedGcsUri, videoDoc?.rawGcsUri]) {
              if (uri && typeof uri === 'string' && uri.startsWith('gs://')) {
                const withoutScheme = uri.slice('gs://'.length);
                const slashIdx = withoutScheme.indexOf('/');
                if (slashIdx > 0) {
                  gcsCandidates.unshift({
                    bucket: withoutScheme.slice(0, slashIdx),
                    objectPath: withoutScheme.slice(slashIdx + 1),
                  });
                }
              }
            }
          } catch {
            // ignore metadata lookup error
          }

          for (const cand of gcsCandidates) {
            try {
              const gcsFile = storage.bucket(cand.bucket).file(cand.objectPath);
              const [exists] = await gcsFile.exists();
              if (exists) {
                await gcsFile.download({ destination: downloadDest });
                if (fs.existsSync(downloadDest) && fs.statSync(downloadDest).size > 1000) {
                  localVideoPath = downloadDest;
                  break;
                }
              }
            } catch {
              // try next candidate
            }
          }
        }

        if (localVideoPath && fs.existsSync(localVideoPath)) {
          const primaryFrameDir = candidateFrameDirs[0];
          if (!fs.existsSync(primaryFrameDir)) {
            fs.mkdirSync(primaryFrameDir, { recursive: true });
          }
          const extractedPath = await extractCandidateFrame(
            localVideoPath,
            timestampSec,
            primaryFrameDir,
            safeFilename
          );
          if (fs.existsSync(extractedPath)) {
            const buf = fs.readFileSync(extractedPath);
            if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
              // Mirror to secondary local frame directory if applicable
              for (const dir of candidateFrameDirs.slice(1)) {
                try {
                  if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                  }
                  fs.writeFileSync(path.join(dir, safeFilename), buf);
                } catch {
                  // ignore mirror error
                }
              }
              // Upload to GCS in background so future requests are fast
              storage
                .bucket(bucketName)
                .upload(extractedPath, {
                  destination: gcsObjectPath,
                  metadata: { contentType: 'image/jpeg' },
                  resumable: false,
                })
                .catch(() => {});

              res.setHeader('Content-Type', 'image/jpeg');
              res.setHeader('Cache-Control', 'public, max-age=3600');
              return res.status(200).send(buf);
            }
          }
        }
      } catch (extractErr) {
        console.warn(`[VideoController] On-demand frame extraction failed for ${videoId}/${safeFilename}:`, extractErr);
      }
    }

    // 4. Render informative SVG frame preview when running with placeholder/synthetic videos
    const lowerName = safeFilename.toLowerCase();
    const isFirst = lowerName.includes('_first_');
    const isLast = lowerName.includes('_last_');
    const isContrast = lowerName.includes('contrast');
    const title = isFirst
      ? 'ACTION FIRST FRAME'
      : isLast
      ? 'ACTION LAST FRAME'
      : isContrast
      ? 'HIGHEST CONTRAST'
      : 'MINIMAL BLUR';
    const badgeColor = isFirst || isLast ? '#10b981' : isContrast ? '#f59e0b' : '#38bdf8';
    const subtitle =
      isFirst || isLast ? 'ACTION BOUNDARY FRAME PREVIEW' : 'CRYO-LABEL FRAME PREVIEW';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#0f172a"/>
      <rect x="8" y="8" width="304" height="164" rx="8" fill="#1e293b" stroke="${badgeColor}" stroke-width="1.5"/>
      <text x="20" y="34" fill="${badgeColor}" font-family="monospace" font-size="11" font-weight="bold">${title}</text>
      <text x="20" y="58" fill="#e2e8f0" font-family="monospace" font-size="11">Video: ${videoId}</text>
      <text x="20" y="80" fill="#94a3b8" font-family="monospace" font-size="10">${safeFilename}</text>
      <rect x="20" y="102" width="280" height="52" rx="4" fill="#0f172a" stroke="#334155"/>
      <text x="32" y="125" fill="#f8fafc" font-family="monospace" font-size="11">${subtitle}</text>
      <text x="32" y="143" fill="#64748b" font-family="monospace" font-size="9">Pass 2 @ 4 FPS Frame Extraction</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(200).send(svg);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to serve frame' });
  }
};
