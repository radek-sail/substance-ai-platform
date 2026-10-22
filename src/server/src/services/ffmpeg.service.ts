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
      .outputOptions(NORMALIZATION_FFMPEG_OPTIONS)
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
      .seekInput(timestampSec)
      .frames(1)
      .outputOptions(['-q:v 2'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

export { ffmpeg };

