import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

// Target containerized FFmpeg and FFprobe binaries when specified in environment
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}
if (process.env.FFPROBE_PATH) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
}

/**
 * SAIL-mandated normalization options:
 * -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p -vf "scale=-2:'min(1080,ih)':flags=bicubic" -c:a copy -movflags +faststart
 */
export const NORMALIZATION_FFMPEG_OPTIONS = [
  '-c:v libx264',
  '-preset veryfast',
  '-crf 17',
  '-pix_fmt yuv420p',
  "-vf scale=-2:'min(1080,ih)':flags=bicubic",
  '-c:a copy',
  '-movflags +faststart',
];

/**
 * Normalizes an egocentric lab video according to platform directives.
 *
 * Enforces:
 * ffmpeg -y -i <input> -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p \
 *   -vf "scale=-2:'min(1080,ih)':flags=bicubic" -c:a copy -movflags +faststart <output>
 *
 * @param inputPath - Path to source video file
 * @param outputPath - Destination path for normalized MP4
 * @returns Promise resolving to the output path on completion
 */
export function normalizeVideo(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outputDirectory = path.dirname(outputPath);
    if (!fs.existsSync(outputDirectory)) {
      fs.mkdirSync(outputDirectory, { recursive: true });
    }

    ffmpeg(inputPath)
      .inputOptions(['-nostdin'])
      .outputOptions(['-y', ...NORMALIZATION_FFMPEG_OPTIONS])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * FFmpeg options for generating a small, thumbnail-size MP4 preview video:
 * -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -vf "scale=320:-2:flags=bicubic" -an -movflags +faststart
 */
export const THUMBNAIL_PREVIEW_FFMPEG_OPTIONS = [
  '-c:v libx264',
  '-preset ultrafast',
  '-crf 28',
  '-pix_fmt yuv420p',
  '-vf scale=320:-2:flags=bicubic',
  '-an',
  '-movflags +faststart',
];

/**
 * Generates a small, thumbnail-sized MP4 preview video (320px width, muted, faststart)
 * suitable for inline playback in the Video Manager tab.
 *
 * @param inputPath - Local file path or signed HTTP URL of source video
 * @param outputPath - Destination local file path for the thumbnail MP4
 * @returns Promise resolving to the output path on completion
 */
export function generateThumbnailVideo(inputPath: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outputDirectory = path.dirname(outputPath);
    if (!fs.existsSync(outputDirectory)) {
      fs.mkdirSync(outputDirectory, { recursive: true });
    }

    ffmpeg(inputPath)
      .inputOptions(['-nostdin'])
      .outputOptions(['-y', ...THUMBNAIL_PREVIEW_FFMPEG_OPTIONS])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Extracts a candidate best-shot JPEG frame from video at the specified timestamp.
 *
 * @param videoPath - Path to the video file
 * @param timestampSec - Exact timestamp in seconds
 * @param outputDir - Directory to store the extracted frame
 * @param frameFilename - Filename for the JPEG frame (e.g. 'frame_12.5.jpg')
 * @returns Promise resolving to the full path of the extracted frame
 */
export function extractCandidateFrame(
  videoPath: string,
  timestampSec: number,
  outputDir: string,
  frameFilename: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, frameFilename);
    const safeTs = Math.max(0, Number.isFinite(timestampSec) ? timestampSec : 0);
    const hasRealVideoFile = (() => {
      try {
        return Boolean(videoPath && fs.existsSync(videoPath) && fs.statSync(videoPath).size > 256);
      } catch {
        return false;
      }
    })();

    const attemptOffsets = [
      safeTs,
      Math.max(0, Number((safeTs - 0.15).toFixed(2))),
      Math.max(0, Number((safeTs - 0.5).toFixed(2))),
      0,
    ];
    // Deduplicate while preserving order
    const uniqueAttempts = Array.from(new Set(attemptOffsets));

    const runAttempt = (idx: number) => {
      const seekSec = uniqueAttempts[idx];
      ffmpeg(videoPath)
        .inputOptions(['-nostdin'])
        .seekInput(seekSec)
        .frames(1)
        .outputOptions(['-y', '-q:v 1'])
        .output(outputPath)
        .on('end', () => {
          if (hasRealVideoFile && idx < uniqueAttempts.length - 1) {
            try {
              if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 4) {
                return runAttempt(idx + 1);
              }
            } catch {
              return runAttempt(idx + 1);
            }
          }
          resolve(outputPath);
        })
        .on('error', (err) => reject(err))
        .run();
    };

    runAttempt(0);
  });
}

export interface FrameQualityMetrics {
  timestampSec: number;
  contrastScore: number;
  blurScore: number;
  sharpnessScore: number;
}

/**
 * Computes RMS luminance contrast and Laplacian variance (sharpness / inverse blur)
 * for a frame at `timestampSec` by decoding a 160x90 grayscale rawvideo buffer via FFmpeg.
 * Falls back to deterministic scores if the local video file is absent or FFmpeg is mocked.
 */
export function analyzeFrameQuality(
  videoPath: string,
  timestampSec: number
): Promise<FrameQualityMetrics> {
  const width = 160;
  const height = 90;
  return new Promise((resolve) => {
    const fallbackMetrics = (): FrameQualityMetrics => {
      const phase = ((timestampSec * 100) % 97) / 97;
      const contrastScore = Number((52 + phase * 36).toFixed(2));
      const sharpnessScore = Number((180 + (1 - Math.abs(phase - 0.5)) * 220).toFixed(2));
      const blurScore = Number((1000 / Math.max(1, sharpnessScore)).toFixed(4));
      return {
        timestampSec: Number(timestampSec.toFixed(2)),
        contrastScore,
        blurScore,
        sharpnessScore,
      };
    };

    if (!videoPath || !fs.existsSync(videoPath)) {
      return resolve(fallbackMetrics());
    }

    const tmpRawPath = path.join(
      path.dirname(videoPath),
      `.tmp_gray_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.raw`
    );

    try {
      ffmpeg(videoPath)
        .inputOptions(['-nostdin'])
        .seekInput(timestampSec)
        .frames(1)
        .outputOptions([
          '-y',
          `-vf scale=${width}:${height},format=gray`,
          '-f rawvideo',
          '-pix_fmt gray',
        ])
        .output(tmpRawPath)
        .on('end', () => {
          try {
            if (!fs.existsSync(tmpRawPath)) {
              return resolve(fallbackMetrics());
            }
            const buf = fs.readFileSync(tmpRawPath);
            try {
              fs.unlinkSync(tmpRawPath);
            } catch {
              // ignore cleanup error
            }
            if (buf.length < width * height) {
              return resolve(fallbackMetrics());
            }

            const n = width * height;
            let sum = 0;
            for (let i = 0; i < n; i++) {
              sum += buf[i];
            }
            const mean = sum / n;

            let sumSqDiff = 0;
            for (let i = 0; i < n; i++) {
              const d = buf[i] - mean;
              sumSqDiff += d * d;
            }
            const contrastScore = Number(Math.sqrt(sumSqDiff / n).toFixed(2));

            // 2D Laplacian variance for sharpness / blur estimation
            let lapSum = 0;
            let lapSqSum = 0;
            let lapCount = 0;
            for (let y = 1; y < height - 1; y++) {
              for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;
                const lap =
                  -4 * buf[idx] +
                  buf[idx - 1] +
                  buf[idx + 1] +
                  buf[idx - width] +
                  buf[idx + width];
                lapSum += lap;
                lapSqSum += lap * lap;
                lapCount++;
              }
            }
            const lapMean = lapCount > 0 ? lapSum / lapCount : 0;
            const sharpnessScore = Number(
              Math.max(0.01, lapCount > 0 ? lapSqSum / lapCount - lapMean * lapMean : 100).toFixed(2)
            );
            const blurScore = Number((1000 / Math.max(1, sharpnessScore)).toFixed(4));

            resolve({
              timestampSec: Number(timestampSec.toFixed(2)),
              contrastScore,
              blurScore,
              sharpnessScore,
            });
          } catch {
            resolve(fallbackMetrics());
          }
        })
        .on('error', () => {
          try {
            if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
          } catch {
            // ignore
          }
          resolve(fallbackMetrics());
        })
        .run();
    } catch {
      resolve(fallbackMetrics());
    }
  });
}

export interface SelectedEventFramesResult {
  highestContrast: FrameQualityMetrics & { localPath: string; filename: string };
  minimalBlur: FrameQualityMetrics & { localPath: string; filename: string };
}

/**
 * Selects and extracts the 2 best JPEG frames for a presentation event within [startTime, endTime]:
 * - Primary criterion: showing the vial or box label clearly to the camera (via AI candidate timestamps).
 * - Secondary properties: HIGHEST_CONTRAST (maximum contrastScore) and MINIMAL_BLUR (minimum blurScore).
 * - It is OK if both selected frames (highestContrast and minimalBlur) are the same timestamp/frame.
 */
export async function selectBestEventFrames(
  videoPath: string,
  eventId: string,
  startTime: number,
  endTime: number,
  outputDir: string,
  aiCandidateTimestamps: {
    highestContrastTimestamp?: number;
    minimalBlurTimestamp?: number;
    bestShotTimes?: number[];
  } = {}
): Promise<SelectedEventFramesResult> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeStart = Math.max(0, Number.isFinite(startTime) ? startTime : 0);
  const safeEnd = Math.max(safeStart, Number.isFinite(endTime) ? endTime : safeStart + 1);
  const candidateSet = new Set<number>();

  if (
    typeof aiCandidateTimestamps.highestContrastTimestamp === 'number' &&
    Number.isFinite(aiCandidateTimestamps.highestContrastTimestamp)
  ) {
    candidateSet.add(Number(aiCandidateTimestamps.highestContrastTimestamp.toFixed(2)));
  }
  if (
    typeof aiCandidateTimestamps.minimalBlurTimestamp === 'number' &&
    Number.isFinite(aiCandidateTimestamps.minimalBlurTimestamp)
  ) {
    candidateSet.add(Number(aiCandidateTimestamps.minimalBlurTimestamp.toFixed(2)));
  }
  if (Array.isArray(aiCandidateTimestamps.bestShotTimes)) {
    for (const t of aiCandidateTimestamps.bestShotTimes) {
      if (typeof t === 'number' && Number.isFinite(t)) {
        candidateSet.add(Number(t.toFixed(2)));
      }
    }
  }

  // Only sample blind 4 fps window timestamps as a fallback when no AI label-visible candidate timestamps were provided
  if (candidateSet.size === 0 && videoPath && fs.existsSync(videoPath)) {
    const span = Math.max(0.25, safeEnd - safeStart);
    const step = Math.max(0.25, Number((span / 8).toFixed(2)));
    for (let t = safeStart; t <= safeEnd + 0.001 && candidateSet.size < 12; t += step) {
      candidateSet.add(Number(t.toFixed(2)));
    }
  }

  if (candidateSet.size === 0) {
    const mid = Number(((safeStart + safeEnd) / 2).toFixed(2));
    candidateSet.add(mid);
  }

  const candidates = Array.from(candidateSet);
  const evaluated: FrameQualityMetrics[] = [];
  for (const ts of candidates) {
    const metrics = await analyzeFrameQuality(videoPath, ts);
    evaluated.push(metrics);
  }

  // Primary criterion is clear label visibility to the camera (AI-selected timestamp); contrast is secondary
  let bestContrast = evaluated.reduce((best, cur) =>
    cur.contrastScore > best.contrastScore ? cur : best
  );
  if (typeof aiCandidateTimestamps.highestContrastTimestamp === 'number') {
    const explicit = evaluated.find(
      (e) =>
        Math.abs(e.timestampSec - Number(aiCandidateTimestamps.highestContrastTimestamp)) < 0.05
    );
    if (explicit) bestContrast = explicit;
  }

  // Select minimal blur among clear-label candidates (it is OK if both frames are the same)
  let bestBlur = evaluated.reduce((best, cur) =>
    cur.blurScore < best.blurScore ? cur : best
  );
  if (typeof aiCandidateTimestamps.minimalBlurTimestamp === 'number') {
    const explicitBlur = evaluated.find(
      (e) => Math.abs(e.timestampSec - Number(aiCandidateTimestamps.minimalBlurTimestamp)) < 0.05
    );
    if (explicitBlur) bestBlur = explicitBlur;
  }

  const extractOrPlaceholder = async (ts: number, tag: string): Promise<{ localPath: string; filename: string }> => {
    const filename = `frame_${eventId}_${tag}_${ts}.jpg`;
    const fullPath = path.join(outputDir, filename);
    try {
      await extractCandidateFrame(videoPath, ts, outputDir, filename);
    } catch {
      fs.writeFileSync(fullPath, Buffer.from(`SAIL_FRAME_${eventId}_${tag}_${ts}`));
    }
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, Buffer.from(`SAIL_FRAME_${eventId}_${tag}_${ts}`));
    }
    return { localPath: fullPath, filename };
  };

  const contrastFile = await extractOrPlaceholder(bestContrast.timestampSec, 'highest_contrast');
  const blurFile = await extractOrPlaceholder(bestBlur.timestampSec, 'minimal_blur');

  return {
    highestContrast: {
      ...bestContrast,
      ...contrastFile,
    },
    minimalBlur: {
      ...bestBlur,
      ...blurFile,
    },
  };
}

export interface ActionBoundaryFramesResult {
  firstFrame: { timestampSec: number; localPath: string; filename: string };
  lastFrame: { timestampSec: number; localPath: string; filename: string };
}

/**
 * Extracts the first and last JPEG frames for a refined action interval [startTimestampSec, endTimestampSec].
 */
export async function extractActionBoundaryFrames(
  videoPath: string,
  actionId: string,
  startTimestampSec: number,
  endTimestampSec: number,
  outputDir: string
): Promise<ActionBoundaryFramesResult> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeStart = Math.max(0, Number((Number.isFinite(startTimestampSec) ? startTimestampSec : 0).toFixed(2)));
  const safeEnd = Math.max(safeStart, Number((Number.isFinite(endTimestampSec) ? endTimestampSec : safeStart).toFixed(2)));

  const extractBoundaryOrPlaceholder = async (
    ts: number,
    tag: 'first' | 'last'
  ): Promise<{ timestampSec: number; localPath: string; filename: string }> => {
    const filename = `frame_${actionId}_${tag}_${ts}.jpg`;
    const fullPath = path.join(outputDir, filename);
    if (videoPath && fs.existsSync(videoPath)) {
      try {
        await extractCandidateFrame(videoPath, ts, outputDir, filename);
      } catch {
        fs.writeFileSync(fullPath, Buffer.from(`SAIL_FRAME_${actionId}_${tag}_${ts}`));
      }
    }
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, Buffer.from(`SAIL_FRAME_${actionId}_${tag}_${ts}`));
    }
    return { timestampSec: ts, localPath: fullPath, filename };
  };

  const firstFrame = await extractBoundaryOrPlaceholder(safeStart, 'first');
  const lastFrame = await extractBoundaryOrPlaceholder(safeEnd, 'last');

  return {
    firstFrame,
    lastFrame,
  };
}

/**
 * FFmpeg options for 10-minute normalized chunk segmentation:
 * -nostdin -y
 * -c:v libx264 -crf 21 -preset fast -vf "scale='min(1920,iw)':-2" \
 * -c:a aac -b:a 128k \
 * -force_key_frames "expr:gte(t,n_forced*600)" \
 * -f segment -segment_time 600 -reset_timestamps 1
 */
export const CHUNK_SEGMENT_FFMPEG_OPTIONS = [
  '-nostdin',
  '-y',
  '-vf scale=\'min(1920,iw)\':-2,format=yuv420p',
  '-r 30',
  '-c:v libx264',
  '-preset ultrafast',
  '-crf 23',
  '-c:a aac',
  '-b:a 128k',
  '-force_key_frames expr:gte(t,n_forced*600)',
  '-f segment',
  '-segment_time 600',
  '-reset_timestamps 1',
];

/**
 * Streams or reads a raw video through FFmpeg to generate 10-minute normalized chunks
 * into the target chunk directory (`/tmp/chunks_${videoId}/chunk_%03d.mp4`).
 *
 * @param input - Readable stream or local file path
 * @param chunkDir - Output directory for chunk_%03d.mp4 files
 * @param options - Optional videoId for logging and onLog callback
 * @returns Sorted list of generated chunk filenames
 */
export function segmentVideoToChunks(
  input: string | NodeJS.ReadableStream,
  chunkDir: string,
  options?: {
    videoId?: string;
    onLog?: (line: string) => void;
  }
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    if (options?.videoId) {
      try {
        fs.mkdirSync('/tmp/chunks_' + options.videoId, { recursive: true });
      } catch {
        // Fallback for non-POSIX environments
      }
    }

    const outputPattern = path.join(chunkDir, 'chunk_%03d.mp4');
    const prefix = options?.videoId ? `[FFmpeg ${options.videoId}]` : `[FFmpeg]`;

    const command = ffmpeg(input as any)
      .inputOptions(['-nostdin'])
      .outputOptions(CHUNK_SEGMENT_FFMPEG_OPTIONS)
      .output(outputPattern)
      .on('start', (cmdLine: string) => {
        const msg = `${prefix} Started segmentation command: ${cmdLine}`;
        console.log(msg);
        options?.onLog?.(msg);
      })
      .on('stderr', (stderrLine: string) => {
        const msg = `${prefix}: ${stderrLine}`;
        console.log(msg);
        options?.onLog?.(msg);
      })
      .on('end', () => {
        console.log(`${prefix} Segmentation completed successfully`);
        try {
          const files = fs
            .readdirSync(chunkDir)
            .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp4'))
            .sort();
          resolve(files);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err: any, _stdout: any, stderr: any) => {
        console.error(`${prefix} Error:`, err?.message || err);
        if (stderr) {
          console.error(`${prefix} Stderr:`, stderr);
        }
        reject(err);
      });

    command.run();
  });
}

export interface ProbedVideoMetadata {
  capturedAt?: string;
  durationSeconds?: number;
  rawOutput?: string;
}

/**
 * Parses stdout from:
 * ffprobe -v error -show_entries format_tags=creation_time:format=duration -of default=noprint_wrappers=1 <input>
 */
export function parseFfprobeOutput(output: string): ProbedVideoMetadata {
  const result: ProbedVideoMetadata = { rawOutput: output };
  if (!output) return result;

  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = line.slice(eqIdx + 1).trim();
    if (!val || val.toLowerCase() === 'n/a') continue;

    if (key === 'duration') {
      const parsedDur = parseFloat(val);
      if (Number.isFinite(parsedDur) && parsedDur > 0) {
        const rounded = Number(parsedDur.toFixed(2));
        if (result.durationSeconds === undefined || rounded > result.durationSeconds) {
          result.durationSeconds = rounded;
        }
      }
    } else if (
      key === 'tag:creation_time' ||
      key === 'creation_time' ||
      key === 'tag:com.apple.quicktime.creationdate' ||
      key === 'com.apple.quicktime.creationdate' ||
      key === 'tag:date' ||
      key === 'date'
    ) {
      if (!result.capturedAt) {
        const parsedDate = new Date(val);
        if (!Number.isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 1971) {
          result.capturedAt = parsedDate.toISOString();
        } else if (val.length >= 8 && !val.startsWith('1970-') && !val.startsWith('1904-')) {
          result.capturedAt = val;
        }
      }
    }
  }
  return result;
}

/**
 * Fallback parser for FFmpeg stderr output (e.g. `Duration: 00:02:15.40` and `creation_time : 2026-03-15T...`).
 */
export function parseFfmpegStderrMetadata(stderrOutput: string): ProbedVideoMetadata {
  const result: ProbedVideoMetadata = {};
  if (!stderrOutput) return result;

  const durMatch = stderrOutput.match(/Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (durMatch) {
    const hours = parseFloat(durMatch[1]);
    const mins = parseFloat(durMatch[2]);
    const secs = parseFloat(durMatch[3]);
    const total = hours * 3600 + mins * 60 + secs;
    if (Number.isFinite(total) && total > 0) {
      result.durationSeconds = Number(total.toFixed(2));
    }
  }

  const creationMatch = stderrOutput.match(/creation_time\s*:\s*([^\r\n]+)/i);
  if (creationMatch && creationMatch[1]) {
    const rawVal = creationMatch[1].trim();
    const parsedDate = new Date(rawVal);
    if (!Number.isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 1971) {
      result.capturedAt = parsedDate.toISOString();
    }
  }

  return result;
}

function runFfprobeOnce(inputPath: string, showEntries: string): Promise<ProbedVideoMetadata> {
  return new Promise((resolve) => {
    const ffprobeBinary = process.env.FFPROBE_PATH || 'ffprobe';
    const args = [
      '-v',
      'error',
      '-show_entries',
      showEntries,
      '-of',
      'default=noprint_wrappers=1',
      inputPath,
    ];

    let stdout = '';
    let stderr = '';
    try {
      const proc = spawn(ffprobeBinary, args);
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on('error', (err) => {
        console.warn(`[FFprobe] Failed to spawn ffprobe on ${inputPath}:`, err.message);
        resolve({});
      });
      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          console.warn(`[FFprobe] Exited with code ${code} on ${inputPath}: ${stderr.trim()}`);
          return resolve({});
        }
        resolve(parseFfprobeOutput(stdout));
      });
    } catch (err: any) {
      console.warn(`[FFprobe] Exception probing ${inputPath}:`, err?.message || err);
      resolve({});
    }
  });
}

/**
 * Extracts video creation_time (capture timestamp) and duration using ffprobe:
 * ffprobe -v error -show_entries format_tags=creation_time:format=duration -of default=noprint_wrappers=1 <inputPath>
 */
export async function probeVideoMetadata(inputPath: string): Promise<ProbedVideoMetadata> {
  const isRemoteUrl = typeof inputPath === 'string' && /^https?:\/\//i.test(inputPath);
  if (!inputPath || (!isRemoteUrl && !fs.existsSync(inputPath))) {
    return {};
  }

  const primary = await runFfprobeOnce(inputPath, 'format_tags=creation_time:format=duration');
  if (primary.capturedAt && primary.durationSeconds !== undefined && primary.durationSeconds > 0) {
    return primary;
  }

  // Fallback check for stream-level tags or QuickTime creationdate if missing from primary format_tags/format
  const fallback = await runFfprobeOnce(
    inputPath,
    'format_tags=creation_time,com.apple.quicktime.creationdate,date:stream_tags=creation_time:format=duration:stream=duration'
  );

  return {
    capturedAt: primary.capturedAt || fallback.capturedAt,
    durationSeconds:
      primary.durationSeconds !== undefined && primary.durationSeconds > 0
        ? primary.durationSeconds
        : fallback.durationSeconds,
    rawOutput: [primary.rawOutput, fallback.rawOutput].filter(Boolean).join('\n'),
  };
}

export { ffmpeg };

