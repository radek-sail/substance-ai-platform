import fs from 'fs';
import path from 'path';
import os from 'os';
import { GoogleGenAI } from '@google/genai';
import {
  WorkflowClassificationSchema,
  WorkflowClassification,
  ActionSchema,
  Action,
  EventSchema,
  Event,
  RefinementSchema,
  Refinement,
} from '@sail/shared';
import { extractCandidateFrame } from './ffmpeg.service';
import { uploadToTenantStorage, getTenantGcsUri, downloadFromGcsUri } from './storage.service';

/**
 * Global GenAI client holder for runtime injection and mocking during tests.
 */
let customGenAIClient: any = null;

/**
 * Injects a custom/mock GoogleGenAI client (primarily used in unit & integration tests).
 */
export function setGenAIClient(client: any): void {
  customGenAIClient = client;
}

/**
 * Resets the custom GoogleGenAI client to default.
 */
export function resetGenAIClient(): void {
  customGenAIClient = null;
}

/**
 * Initializes and returns a GoogleGenAI client using process.env.GOOGLE_GENAI_API_KEY
 * or Application Default Credentials (ADC).
 */
export function getGenAIClient(): GoogleGenAI | any {
  if (customGenAIClient) {
    return customGenAIClient;
  }

  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (apiKey) {
    return new GoogleGenAI({ apiKey });
  }

  // Fallback to Application Default Credentials
  return new GoogleGenAI({});
}

export interface RegisteredGeminiVideo {
  fileRecord?: any;
  fileUri: string;
  localVideoPath?: string;
  cleanup: () => Promise<void>;
}

/**
 * Downloads/streams a video from GCS (or reads its local path), uploads and registers it
 * with the Gemini Files API (`ai.files.upload`), and polls `ai.files.get` until the file
 * transitions from `PROCESSING` to `ACTIVE`.
 *
 * Returns the registered `fileUri` (and `fileRecord`) along with a `cleanup` callback
 * that deletes the remote file via `ai.files.delete({ name: fileRecord.name })` and removes
 * any temporary downloaded file.
 */
export async function uploadAndWaitForActiveFile(params: {
  videoGcsUri: string;
  localVideoPath?: string;
  videoId?: string;
}): Promise<RegisteredGeminiVideo> {
  const ai = getGenAIClient();

  // If the client is a test mock without `ai.files.upload`, or if the URI is already a registered Gemini File URI
  if (
    !ai?.files ||
    typeof ai.files.upload !== 'function' ||
    !params.videoGcsUri ||
    params.videoGcsUri.startsWith('https://generativelanguage.googleapis.com/') ||
    params.videoGcsUri.startsWith('files/')
  ) {
    return {
      fileUri: params.videoGcsUri,
      localVideoPath: params.localVideoPath,
      cleanup: async () => {},
    };
  }

  let localFilePath = params.localVideoPath;
  let downloadedTempPath: string | null = null;

  if (!localFilePath || !fs.existsSync(localFilePath)) {
    const safeVideoId = (params.videoId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cachedCandidates = safeVideoId
      ? [
          path.join('/tmp', 'sail_normalized_cache', `norm_${safeVideoId}.mp4`),
          path.join(os.tmpdir(), 'sail_normalized_cache', `norm_${safeVideoId}.mp4`),
        ]
      : [];
    const foundCached = cachedCandidates.find((p) => fs.existsSync(p));
    if (foundCached) {
      localFilePath = foundCached;
    } else if (!params.videoGcsUri.startsWith('gs://') && fs.existsSync(params.videoGcsUri)) {
      localFilePath = params.videoGcsUri;
    } else if (params.videoGcsUri.startsWith('gs://')) {
      const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
      const normalizedGcsUri = params.videoGcsUri.replace(/^gs:\/\/[^/]+\//, `gs://${bucketName}/`);
      const tempId = safeVideoId || `vid_${Date.now()}`;
      downloadedTempPath = path.join(
        os.tmpdir(),
        `sail_gemini_${tempId}_${Date.now()}.mp4`
      );
      await downloadFromGcsUri(normalizedGcsUri, downloadedTempPath);
      localFilePath = downloadedTempPath;
    } else {
      throw new Error(`Video file not found locally or in GCS: ${params.videoGcsUri}`);
    }
  }

  // Upload and register the video file with the Gemini Files API
  const uploadResult = await ai.files.upload({
    file: localFilePath,
    mimeType: 'video/mp4',
    config: {
      mimeType: 'video/mp4',
    },
  } as any);

  // Poll until file state transitions from PROCESSING to ACTIVE
  let file = await ai.files.get({ name: uploadResult.name });
  while (file.state === 'PROCESSING') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = await ai.files.get({ name: uploadResult.name });
  }

  if (file.state && file.state !== 'ACTIVE') {
    throw new Error(
      `Gemini file registration failed for ${uploadResult.name} with state: ${file.state}`
    );
  }
  if (file.state && !(file.state === 'ACTIVE')) {
    throw new Error(`Gemini file is not ACTIVE: ${file.state}`);
  }
  const fileRecord = file;

  const registeredUri = fileRecord.uri || uploadResult.uri;
  const registeredName = fileRecord.name || uploadResult.name;

  const cleanup = async () => {
    if (registeredName && ai?.files && typeof ai.files.delete === 'function') {
      try {
        await ai.files.delete({ name: registeredName });
      } catch (deleteErr) {
        console.warn(`[GeminiService] Failed to delete file ${registeredName} from Gemini Files API:`, deleteErr);
      }
    }
    if (downloadedTempPath && fs.existsSync(downloadedTempPath)) {
      try {
        await fs.promises.unlink(downloadedTempPath);
      } catch (unlinkErr) {
        console.warn(`[GeminiService] Failed to clean up temporary downloaded video ${downloadedTempPath}:`, unlinkErr);
      }
    }
  };

  return {
    fileRecord,
    fileUri: registeredUri,
    localVideoPath: localFilePath,
    cleanup,
  };
}

/**
 * Ensures the normalized video is registered with the Gemini Files API (`ai.files.upload`),
 * waits until `state === 'ACTIVE'`, and returns `{ geminiFileUri, geminiFileName, localVideoPath }`
 * without deleting the remote file so that subsequent individual passes can reuse `geminiFileUri`.
 */
export async function ensureGeminiFileRegistered(params: {
  videoId: string;
  videoGcsUri: string;
  localVideoPath?: string;
  existingGeminiFileUri?: string;
  existingGeminiFileName?: string;
}): Promise<{
  geminiFileUri: string;
  geminiFileName?: string;
  localVideoPath?: string;
}> {
  const safeVideoId = (params.videoId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cachedCandidates = safeVideoId
    ? [
        path.join('/tmp', 'sail_normalized_cache', `norm_${safeVideoId}.mp4`),
        path.join(os.tmpdir(), 'sail_normalized_cache', `norm_${safeVideoId}.mp4`),
      ]
    : [];
  const resolvedLocalPath =
    (params.localVideoPath && fs.existsSync(params.localVideoPath)
      ? params.localVideoPath
      : undefined) || cachedCandidates.find((p) => fs.existsSync(p));

  if (params.existingGeminiFileUri) {
    return {
      geminiFileUri: params.existingGeminiFileUri,
      geminiFileName: params.existingGeminiFileName,
      localVideoPath: resolvedLocalPath,
    };
  }

  const ai = getGenAIClient();
  if (
    !ai?.files ||
    typeof ai.files.upload !== 'function' ||
    !params.videoGcsUri ||
    params.videoGcsUri.startsWith('https://generativelanguage.googleapis.com/') ||
    params.videoGcsUri.startsWith('files/')
  ) {
    return {
      geminiFileUri: params.videoGcsUri,
      localVideoPath: resolvedLocalPath,
    };
  }

  let localFilePath = resolvedLocalPath;
  if (!localFilePath || !fs.existsSync(localFilePath)) {
    if (!params.videoGcsUri.startsWith('gs://') && fs.existsSync(params.videoGcsUri)) {
      localFilePath = params.videoGcsUri;
    } else if (params.videoGcsUri.startsWith('gs://')) {
      const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
      const normalizedGcsUri = params.videoGcsUri.replace(/^gs:\/\/[^/]+\//, `gs://${bucketName}/`);
      const cacheDir = path.join(os.tmpdir(), 'sail_normalized_cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const targetPath = path.join(cacheDir, `norm_${safeVideoId || Date.now()}.mp4`);
      await downloadFromGcsUri(normalizedGcsUri, targetPath);
      localFilePath = targetPath;
    } else {
      throw new Error(`Video file not found locally or in GCS: ${params.videoGcsUri}`);
    }
  }

  const uploadResult = await ai.files.upload({
    file: localFilePath,
    mimeType: 'video/mp4',
    config: {
      mimeType: 'video/mp4',
    },
  } as any);

  let file = await ai.files.get({ name: uploadResult.name });
  while (file.state === 'PROCESSING') {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = await ai.files.get({ name: uploadResult.name });
  }

  if (file.state && file.state !== 'ACTIVE') {
    throw new Error(
      `Gemini file registration failed for ${uploadResult.name} with state: ${file.state}`
    );
  }
  if (file.state && !(file.state === 'ACTIVE')) {
    throw new Error(`Gemini file is not ACTIVE: ${file.state}`);
  }
  const fileRecord = file;

  return {
    geminiFileUri: fileRecord.uri || uploadResult.uri,
    geminiFileName: fileRecord.name || uploadResult.name,
    localVideoPath: localFilePath,
  };
}

/**
 * Dynamically resolves and loads agent guideline markdown files from the `config/` directory.
 * Prompts must NOT be hardcoded in TypeScript files per SAIL architecture rules.
 *
 * @param filename - Guideline filename (e.g. 'classification-agent-guidelines.md')
 * @returns Raw text contents of the markdown guideline file
 */
export function loadGuideline(filename: string): string {
  const candidatePaths = [
    path.resolve(process.cwd(), 'config', filename),
    path.resolve(process.cwd(), '..', '..', 'config', filename),
    path.resolve(__dirname, '..', '..', '..', '..', 'config', filename),
    path.resolve(__dirname, '..', '..', '..', 'config', filename),
    path.resolve(__dirname, '..', '..', 'config', filename),
    path.resolve(__dirname, '..', 'config', filename),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }

  throw new Error(`Guideline file not found: ${filename}. Checked paths: ${candidatePaths.join(', ')}`);
}

/**
 * Extracts and cleans JSON from raw LLM text responses, handling optional markdown code fences.
 */
export function extractJsonFromText(rawText: string): any {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty or invalid model response text');
  }

  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonString = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    return JSON.parse(jsonString);
  } catch (err: any) {
    throw new Error(`Failed to parse JSON from model response: ${err.message}. Response was: ${trimmed}`);
  }
}

/**
 * Extracts text from various Google Gen AI response formats.
 */
export function extractTextFromResponse(response: any): string {
  if (!response) {
    throw new Error('Received null or undefined response from GenAI client');
  }

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response.text === 'function') {
    return response.text();
  }

  if (typeof response.text === 'string') {
    return response.text;
  }

  if (response.output_text && typeof response.output_text === 'string') {
    return response.output_text;
  }

  if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.candidates[0].content.parts[0].text;
  }

  // If response is already an object or array representation
  if (typeof response === 'object' && (response.workflowType || Array.isArray(response))) {
    return JSON.stringify(response);
  }

  throw new Error('Unable to extract text content from GenAI response object');
}

/**
 * Spatial Coordinate Calculation Helpers:
 * Relates bounding boxes and spatial detections relative to the top-left origin:
 * Rows: A-Z
 * Columns: 1-N
 */

export function rowIndexToLetter(rowIndex: number): string {
  if (rowIndex < 0 || rowIndex > 25) {
    throw new RangeError(`Row index ${rowIndex} out of bounds (0-25)`);
  }
  return String.fromCharCode(65 + rowIndex);
}

export function letterToRowIndex(letter: string): number {
  if (!letter || typeof letter !== 'string') {
    throw new TypeError(`Invalid row letter: ${letter}`);
  }
  const code = letter.trim().toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) {
    throw new RangeError(`Invalid row letter: ${letter}`);
  }
  return code - 65;
}

/**
 * Computes grid coordinate (row A-Z, col 1-N) from normalized coordinates (0.0 - 1.0)
 * relative to the top-left origin.
 */
export function computeGridCoordinateFromNormalized(
  normX: number,
  normY: number,
  totalRows: number = 9,
  totalCols: number = 9
): { row: string; col: number } {
  const boundedX = Math.max(0, Math.min(0.9999, normX));
  const boundedY = Math.max(0, Math.min(0.9999, normY));

  const rowIndex = Math.floor(boundedY * totalRows);
  const colIndex = Math.floor(boundedX * totalCols) + 1;

  return {
    row: rowIndexToLetter(rowIndex),
    col: colIndex,
  };
}

/**
 * Calculates row distance and column distance between two spatial coordinates.
 */
export function calculateSpatialDistance(
  coordA: { row: string; col: number },
  coordB: { row: string; col: number }
): { rowDiff: number; colDiff: number; euclidean: number } {
  const rowA = letterToRowIndex(coordA.row);
  const rowB = letterToRowIndex(coordB.row);
  const rowDiff = rowB - rowA;
  const colDiff = coordB.col - coordA.col;
  const euclidean = Math.sqrt(rowDiff * rowDiff + colDiff * colDiff);

  return { rowDiff, colDiff, euclidean };
}

// Model configurations with environment overrides
export const DEFAULT_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || 'gemini-3.8-flash';
export const DEFAULT_PRO_MODEL = process.env.GEMINI_PRO_MODEL || 'gemini-4-argon';

/**
 * Executes `ai.models.generateContent` with automatic exponential backoff retry
 * on transient HTTP 503 / 429 / overloaded errors.
 */
export async function generateContentWithRetry(ai: any, params: any, maxRetries = 3) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      const isTransient =
        err.status === 503 ||
        err.status === 429 ||
        err.message?.includes('503') ||
        err.message?.includes('overloaded');
      if (isTransient && attempt < maxRetries) {
        console.warn(`[GeminiService] Attempt ${attempt} failed with ${err.status || err.message}. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

export interface PipelineExecutionParams {
  customerId: string;
  databaseId: string;
  videoId: string;
  videoGcsUri: string;
  localVideoPath?: string;
}

/**
 * Pass 0 (Workflow Classifier):
 * - Reads dynamic guidelines from `config/classification-agent-guidelines.md`.
 * - Analyzes video/audio to determine if workflow is:
 *   `INVENTORY_UPDATE_WORKFLOW`, `EXPERIMENT_NOTEBOOK_WORKFLOW`, or `UNCLASSIFIED_WORKFLOW`.
 * - Validates output via WorkflowClassificationSchema.
 */
export async function runPass0WorkflowClassification(params: {
  videoGcsUri: string;
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
}): Promise<WorkflowClassification> {
  const systemInstruction = loadGuideline('classification-agent-guidelines.md');
  const client = getGenAIClient();

  const needsRegistration = !params.registeredFileUri && params.videoGcsUri?.startsWith('gs://');
  const registered = needsRegistration
    ? await uploadAndWaitForActiveFile({
        videoGcsUri: params.videoGcsUri,
        localVideoPath: params.localVideoPath,
        videoId: params.videoId,
      })
    : null;

  const activeFileUri = params.registeredFileUri || registered?.fileUri || params.videoGcsUri;

  try {
    const userPrompt = `You are analyzing video recording: ${activeFileUri}.
Transcribe audible speech and classify the workflow strictly according to the system instructions.
Return a valid JSON object matching WorkflowClassificationSchema.`;

    const contents: any[] = [];
    if (activeFileUri) {
      contents.push({
        fileData: {
          fileUri: activeFileUri,
          mimeType: 'video/mp4',
        },
      });
    }
    contents.push(userPrompt);

    const response = await generateContentWithRetry(client, {
      model: DEFAULT_FLASH_MODEL,
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
      },
    });

    const rawText = extractTextFromResponse(response);
    const parsedJson = extractJsonFromText(rawText);

    return WorkflowClassificationSchema.parse(parsedJson);
  } finally {
    if (registered) {
      await registered.cleanup();
    }
  }
}

/**
 * Pass 1 (Action Detection):
 * - Selects dynamic guidelines: `config/inventory-agent-guidelines.md` or `config/archive-agent-guidelines.md`
 *   based on Pass 0 classification result.
 * - Calls Gemini Pro at coarse sampling (1 fps) to identify temporal action boundaries.
 * - Validates output via an array of ActionSchema objects.
 */
export async function runPass1ActionDetection(params: {
  videoGcsUri: string;
  classification: WorkflowClassification;
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
}): Promise<Action[]> {
  const guidelineFile =
    params.classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const systemInstruction = loadGuideline(guidelineFile);
  const client = getGenAIClient();

  const needsRegistration = !params.registeredFileUri && params.videoGcsUri?.startsWith('gs://');
  const registered = needsRegistration
    ? await uploadAndWaitForActiveFile({
        videoGcsUri: params.videoGcsUri,
        localVideoPath: params.localVideoPath,
        videoId: params.videoId,
      })
    : null;

  const activeFileUri = params.registeredFileUri || registered?.fileUri || params.videoGcsUri;

  try {
    const userPrompt = `Workflow Type: ${params.classification.workflowType}.
Audible Context: "${params.classification.transcribedAudio}".
Video URI: ${activeFileUri}.

Identify compound temporal action boundaries at 1 fps coarse sampling.
Valid Action Classes: VIAL_INSERTION_ACTION, VIAL_REMOVAL_ACTION, REAGENT_MIXING_ACTION, REAGENT_SEEDING_ACTION.
Return a JSON array of Action objects conforming to ActionSchema.`;

    const contents: any[] = [];
    if (activeFileUri) {
      contents.push({
        fileData: {
          fileUri: activeFileUri,
          mimeType: 'video/mp4',
        },
      });
    }
    contents.push(userPrompt);

    const response = await generateContentWithRetry(client, {
      model: DEFAULT_PRO_MODEL,
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
      },
    });

    const rawText = extractTextFromResponse(response);
    const parsedJson = extractJsonFromText(rawText);

    const actionsArray = Array.isArray(parsedJson)
      ? parsedJson
      : parsedJson.actions || parsedJson.actionList || [];

    return ActionSchema.array().parse(actionsArray);
  } finally {
    if (registered) {
      await registered.cleanup();
    }
  }
}

/**
 * Pass 2 (Event Detection):
 * - For each detected action, extracts sub-events at 4 fps (label presentations, before/after shots, audio utterances).
 * - Extracts candidate frame timestamps, calls extractCandidateFrame from ffmpeg.service.ts,
 *   and uploads frames to gs://${bucketName}/frames/{videoId}/.
 * - Populates bestShotUrls and validates output via an array of EventSchema objects.
 */
export async function runPass2EventDetection(params: {
  videoGcsUri: string;
  classification: WorkflowClassification;
  actions: Action[];
  localVideoPath?: string;
  customerId: string;
  videoId: string;
  registeredFileUri?: string;
}): Promise<Event[]> {
  const guidelineFile =
    params.classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const systemInstruction = loadGuideline(guidelineFile);
  const client = getGenAIClient();
  const allEvents: Event[] = [];

  const needsRegistration = !params.registeredFileUri && params.videoGcsUri?.startsWith('gs://');
  const registered = needsRegistration
    ? await uploadAndWaitForActiveFile({
        videoGcsUri: params.videoGcsUri,
        localVideoPath: params.localVideoPath,
        videoId: params.videoId,
      })
    : null;

  const activeFileUri = params.registeredFileUri || registered?.fileUri || params.videoGcsUri;
  const effectiveLocalVideoPath = params.localVideoPath || registered?.localVideoPath;

  const scratchDir = path.join(os.tmpdir(), `sail_frames_${params.videoId}`);
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  try {
    for (const action of params.actions) {
      const userPrompt = `Action ID: ${action.actionId} (${action.actionClass}).
Temporal span analysis at 4 fps.
Extract fine-grained sub-events: label presentations, pre-action/post-action state shots, and operator speech utterances.
Return a JSON array of Event objects conforming to EventSchema.`;

      const contents: any[] = [];
      if (activeFileUri) {
        contents.push({
          fileData: {
            fileUri: activeFileUri,
            mimeType: 'video/mp4',
          },
        });
      }
      contents.push(userPrompt);

      const response = await generateContentWithRetry(client, {
        model: DEFAULT_FLASH_MODEL,
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const rawText = extractTextFromResponse(response);
      const parsedJson = extractJsonFromText(rawText);
      const rawEvents: any[] = Array.isArray(parsedJson)
        ? parsedJson
        : parsedJson.events || parsedJson.eventList || [];

      for (const rawEvent of rawEvents) {
        const bestShotTimes: number[] = Array.isArray(rawEvent.bestShotTimes)
          ? rawEvent.bestShotTimes
          : [];
        const bestShotUrls: string[] = [];

        for (const timestamp of bestShotTimes) {
          const frameFilename = `frame_${rawEvent.eventId || 'evt'}_${timestamp}.jpg`;
          const destinationGcsPath = `frames/${params.videoId}/${frameFilename}`;

          if (effectiveLocalVideoPath && fs.existsSync(effectiveLocalVideoPath)) {
            try {
              const frameLocalPath = await extractCandidateFrame(
                effectiveLocalVideoPath,
                timestamp,
                scratchDir,
                frameFilename
              );
              const uploadedGcsUri = await uploadToTenantStorage(
                params.customerId,
                frameLocalPath,
                destinationGcsPath,
                'image/jpeg'
              );
              bestShotUrls.push(uploadedGcsUri);

              // Clean up local frame file
              if (fs.existsSync(frameLocalPath)) {
                await fs.promises.unlink(frameLocalPath).catch(() => {});
              }
            } catch (frameErr) {
              console.warn(`[Pass 2] Frame extraction failed at ${timestamp}s:`, frameErr);
              bestShotUrls.push(getTenantGcsUri(params.customerId, destinationGcsPath));
            }
          } else {
            // Cloud-native URI mapping
            bestShotUrls.push(getTenantGcsUri(params.customerId, destinationGcsPath));
          }
        }

        const validatedEvent = EventSchema.parse({
          ...rawEvent,
          actionId: action.actionId,
          bestShotUrls,
          bestShotTimes,
          refinementList: rawEvent.refinementList || [],
        });

        allEvents.push(validatedEvent);
      }
    }

    return allEvents;
  } finally {
    // Clean up temporary scratch frame directory
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    if (registered) {
      await registered.cleanup();
    }
  }
}

/**
 * Pass 3 (Analysis Refinement):
 * - Executes high-resolution modal reasoning:
 *   * Multi-frame OCR conflation for labels across best shots.
 *   * Spatial coordinate differencing (comparing before/after frames relative to top-left origin: rows A-Z, columns 1-N).
 *   * Speech confirmation for volumes/cell counts.
 * - Validates output via an array of RefinementSchema objects.
 */
export async function runPass3AnalysisRefinement(params: {
  videoGcsUri: string;
  classification: WorkflowClassification;
  actions: Action[];
  events: Event[];
  customerId: string;
  videoId: string;
  localVideoPath?: string;
  registeredFileUri?: string;
}): Promise<Refinement[]> {
  const client = getGenAIClient();
  const systemInstruction = loadGuideline('refinement-agent-guidelines.md');

  const needsRegistration = !params.registeredFileUri && params.videoGcsUri?.startsWith('gs://');
  const registered = needsRegistration
    ? await uploadAndWaitForActiveFile({
        videoGcsUri: params.videoGcsUri,
        localVideoPath: params.localVideoPath,
        videoId: params.videoId,
      })
    : null;

  const activeFileUri = params.registeredFileUri || registered?.fileUri || params.videoGcsUri;

  try {
    const eventsSummary = params.events.map((e) => ({
      eventId: e.eventId,
      actionId: e.actionId,
      eventClass: e.eventClass,
      bestShotUrls: e.bestShotUrls,
    }));

    const userPrompt = `Workflow: ${params.classification.workflowType}
Video URI: ${activeFileUri}
Events to refine:
${JSON.stringify(eventsSummary, null, 2)}

Perform OCR conflation, spatial coordinate differencing, and speech confirmation.
Output a JSON array of Refinement objects conforming to RefinementSchema.`;

    const contents: any[] = [];
    if (activeFileUri) {
      contents.push({
        fileData: {
          fileUri: activeFileUri,
          mimeType: 'video/mp4',
        },
      });
    }
    contents.push(userPrompt);

    const response = await generateContentWithRetry(client, {
      model: DEFAULT_PRO_MODEL,
      contents,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
      },
    });

    const rawText = extractTextFromResponse(response);
    const parsedJson = extractJsonFromText(rawText);

    const refinementsArray = Array.isArray(parsedJson)
      ? parsedJson
      : parsedJson.refinements || parsedJson.refinementList || [];

    return RefinementSchema.array().parse(refinementsArray);
  } finally {
    if (registered) {
      await registered.cleanup();
    }
  }
}

/**
 * Executes the complete 4-Stage Hierarchical AI Pipeline:
 * Pass 0 (Workflow Classifier) -> Pass 1 (Action Detection) -> Pass 2 (Event Detection) -> Pass 3 (Analysis Refinement)
 *
 * Pre-registers the video with the Gemini Files API (`ai.files.upload`) and waits for `ACTIVE` state
 * before executing Pass 0 through Pass 3, then cleans up the remote file (`ai.files.delete`) in `finally`.
 */
export async function executeHierarchicalPipeline(params: PipelineExecutionParams): Promise<{
  workloadClassification: WorkflowClassification;
  actions: Action[];
  events: Event[];
  refinements: Refinement[];
}> {
  const registeredVideo = await uploadAndWaitForActiveFile({
    videoGcsUri: params.videoGcsUri,
    localVideoPath: params.localVideoPath,
    videoId: params.videoId,
  });

  try {
    // Pass 0: Workflow Classifier
    const workloadClassification = await runPass0WorkflowClassification({
      videoGcsUri: registeredVideo.fileUri,
      registeredFileUri: registeredVideo.fileUri,
      localVideoPath: registeredVideo.localVideoPath,
      customerId: params.customerId,
      videoId: params.videoId,
    });

    // Pass 1: Action Detection
    const actions = await runPass1ActionDetection({
      videoGcsUri: registeredVideo.fileUri,
      registeredFileUri: registeredVideo.fileUri,
      classification: workloadClassification,
      localVideoPath: registeredVideo.localVideoPath,
      customerId: params.customerId,
      videoId: params.videoId,
    });

    // Pass 2: Event Detection
    const events = await runPass2EventDetection({
      videoGcsUri: registeredVideo.fileUri,
      registeredFileUri: registeredVideo.fileUri,
      classification: workloadClassification,
      actions,
      localVideoPath: registeredVideo.localVideoPath,
      customerId: params.customerId,
      videoId: params.videoId,
    });

    // Pass 3: Analysis Refinement
    const refinements = await runPass3AnalysisRefinement({
      videoGcsUri: registeredVideo.fileUri,
      registeredFileUri: registeredVideo.fileUri,
      classification: workloadClassification,
      actions,
      events,
      localVideoPath: registeredVideo.localVideoPath,
      customerId: params.customerId,
      videoId: params.videoId,
    });

    return {
      workloadClassification,
      actions,
      events,
      refinements,
    };
  } finally {
    await registeredVideo.cleanup();
  }
}
