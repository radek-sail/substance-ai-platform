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

    ffmpeg(videoPath)
      .inputOptions(['-nostdin'])
      .seekInput(timestampSec)
      .frames(1)
      .outputOptions(['-y', '-q:v 2'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
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

export { ffmpeg };

