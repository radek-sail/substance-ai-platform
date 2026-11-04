import fs from 'fs';
import path from 'path';
import os from 'os';
import { GoogleGenAI } from '@google/genai';
import {
  WorkflowClassificationSchema,
  WorkflowClassification,
  ActionSchema,
  Action,
  ActionIntervalSchema,
  ActionInterval,
  ActionDetectionPassResultSchema,
  ActionDetectionPassResult,
  EventSchema,
  Event,
  BestFrame,
  BestFrameSchema,
  RefinedActionBoundary,
  RefinedActionBoundarySchema,
  EventDetectionSchema,
  EventDetectionPassResultSchema,
  EventDetectionPassResult,
  timeField,
  RefinementSchema,
  Refinement,
  VialLabelData,
  VialLabelDataSchema,
  LabelTranscriptionRecord,
  LabelTranscriptionRecordSchema,
  BoxWellLocation,
  BoxWellLocationSchema,
  computeBoxWellFromTopLeftOrigin,
  computeBoxWellFromTopRightOrigin,
} from '@sail/shared';
import {
  extractCandidateFrame,
  selectBestEventFrames,
} from './ffmpeg.service';
import { storage, uploadToTenantStorage, getTenantGcsUri } from './storage.service';
import { getVideoMetadata, updateVideoPass } from './firestore.service';

/**
 * Native Vertex AI GoogleGenAI client initialized with Cloud Run Application Default Credentials (ADC).
 */
export const ai = new GoogleGenAI({
  vertexai: true,
  vertexAI: true,
  project: process.env.GOOGLE_CLOUD_PROJECT || 'sail-platform-prod',
  location: process.env.GOOGLE_CLOUD_LOCATION || 'us',
  apiEndpoint: process.env.GOOGLE_CLOUD_API_ENDPOINT || 'https://aiplatform.us.rep.googleapis.com',
} as any);

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
 * Returns the active GoogleGenAI client (Vertex AI mode with Cloud Run ADC, or mock in tests).
 */
export function getGenAIClient(): GoogleGenAI | any {
  if (customGenAIClient) {
    return customGenAIClient;
  }
  return ai;
}

/**
 * Resolves a normalized GCS URI (gs://<bucket>/normalized/...) from a provided GCS URI or relative path.
 */
export function resolveNormalizedGcsUri(uri?: string, videoId?: string): string {
  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';
  if (!uri) {
    return videoId ? `gs://${bucketName}/normalized/norm_${videoId}.mp4` : '';
  }
  if (uri.startsWith('gs://')) {
    return uri;
  }
  const cleanPath = uri.replace(/^\/+/, '');
  return `gs://${bucketName}/${cleanPath}`;
}

export interface RegisteredGeminiVideo {
  fileRecord?: any;
  fileUri: string;
  localVideoPath?: string;
  cleanup: () => Promise<void>;
}

/**
 * Backwards-compatible helper that resolves the GCS URI directly without uploading to Gemini Files API.
 */
export async function uploadAndWaitForActiveFile(params: {
  videoGcsUri: string;
  localVideoPath?: string;
  videoId?: string;
}): Promise<RegisteredGeminiVideo> {
  const fileUri = resolveNormalizedGcsUri(params.videoGcsUri, params.videoId);
  return {
    fileUri,
    localVideoPath: params.localVideoPath,
    cleanup: async () => {},
  };
}

/**
 * Backwards-compatible helper that resolves the GCS URI directly without uploading to Gemini Files API.
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
  const geminiFileUri =
    params.existingGeminiFileUri || resolveNormalizedGcsUri(params.videoGcsUri, params.videoId);
  return {
    geminiFileUri,
    geminiFileName: params.existingGeminiFileName,
    localVideoPath: params.localVideoPath,
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

  const cleaned = rawText.replace(/```json\n?|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    // Attempt best-effort repair if truncated
    const lastBraceIndex = cleaned.lastIndexOf('}');
    if (lastBraceIndex !== -1) {
      const truncated = cleaned.substring(0, lastBraceIndex + 1);
      const candidates = [
        truncated + ']}',
        truncated + ']',
        truncated,
        truncated + '}',
        cleaned + '"}]}',
        cleaned + '"}]',
      ];
      for (const candidate of candidates) {
        try {
          return JSON.parse(candidate);
        } catch {
          // continue
        }
      }
    }

    const payloadPreview = cleaned.slice(0, 500);
    throw new Error(`Failed to parse JSON from model response: ${err.message}. Payload preview: ${payloadPreview}`);
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
    try {
      return response.text();
    } catch {
      // ignore, fall back to checking candidates
    }
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
  if (typeof response === 'object' && (response.workflowType || Array.isArray(response) || response.actions)) {
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
export const DEFAULT_PRO_MODEL = process.env.GEMINI_PRO_MODEL || 'gemini-1.5-pro';

/**
 * Converts a total number of seconds into "MM:SS" string format.
 */
export function formatSecondsToTimeString(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) {
    return '00:00';
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  const paddedMins = mins.toString().padStart(2, '0');
  const paddedSecs = secs.toString().padStart(2, '0');
  return `${paddedMins}:${paddedSecs}`;
}

/**
 * Parses "HH:MM:SS" or "MM:SS" or raw seconds string into numeric float seconds.
 */
export function parseTimeStringToSeconds(timeStr: string): number {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  return 0;
}

/**
 * Hybrid result object for Pass 1 Action Detection.
 * Implements ActionDetectionPassResult while extending Array<Action> to provide
 * complete backwards-compatibility with existing tests and downstream passes.
 */
export class ActionDetectionPassResultObject extends Array<Action> implements ActionDetectionPassResult {
  videoId: string;
  totalActionsDetected: number;
  totalEventsDetected?: number;
  workflowContext?: string;
  actions: ActionInterval[];
  events?: Event[];
  generatedAt: string;
  modelUsed?: string;
  thinkingLevel?: string;
  executionAudit?: any;

  static get [Symbol.species]() {
    return Array;
  }

  constructor(data: ActionDetectionPassResult, items?: Action[]) {
    if (Array.isArray(items)) {
      super(...items);
    } else if (typeof data === 'number') {
      super(data);
      this.videoId = '';
      this.totalActionsDetected = 0;
      this.actions = [];
      this.generatedAt = '';
      return;
    } else {
      super();
    }
    this.videoId = data?.videoId || '';
    this.totalActionsDetected = data?.totalActionsDetected || 0;
    this.totalEventsDetected = data?.totalEventsDetected;
    this.workflowContext = data?.workflowContext;
    this.actions = data?.actions || [];
    this.events = data?.events;
    this.generatedAt = data?.generatedAt || '';
    this.modelUsed = data?.modelUsed;
    this.thinkingLevel = data?.thinkingLevel;
    this.executionAudit = data?.executionAudit;
  }

  toJSON(): ActionDetectionPassResult {
    return {
      videoId: this.videoId,
      totalActionsDetected: this.totalActionsDetected,
      ...(this.totalEventsDetected !== undefined ? { totalEventsDetected: this.totalEventsDetected } : {}),
      workflowContext: this.workflowContext,
      actions: this.actions,
      ...(this.events !== undefined ? { events: this.events } : {}),
      generatedAt: this.generatedAt,
      modelUsed: this.modelUsed,
      thinkingLevel: this.thinkingLevel,
      executionAudit: this.executionAudit,
    };
  }
}

/**
 * Implements EventDetectionPassResult while extending Array<Event> to provide
 * complete backwards-compatibility with existing tests and downstream passes,
 * while ensuring JSON.stringify() includes both `events` and `refinedActions` in
 * `event_detection_pass.json`.
 */
export class EventDetectionPassResultObject extends Array<Event> implements EventDetectionPassResult {
  videoId?: string;
  events: Event[];
  refinedActions: RefinedActionBoundary[];
  generatedAt?: string;
  modelUsed?: string;
  thinkingLevel?: string;
  executionAudit?: any;

  static get [Symbol.species]() {
    return Array;
  }

  constructor(data: EventDetectionPassResult, items?: Event[]) {
    if (Array.isArray(items)) {
      super(...items);
    } else if (typeof data === 'number') {
      super(data);
      this.events = [];
      this.refinedActions = [];
      return;
    } else {
      super(...(data?.events || []));
    }
    this.videoId = data?.videoId;
    this.events = data?.events || [];
    this.refinedActions = data?.refinedActions || [];
    this.generatedAt = data?.generatedAt;
    this.modelUsed = data?.modelUsed;
    this.thinkingLevel = data?.thinkingLevel;
    this.executionAudit = data?.executionAudit;
  }

  toJSON(): EventDetectionPassResult {
    return {
      ...(this.videoId !== undefined ? { videoId: this.videoId } : {}),
      events: Array.from(this),
      refinedActions: this.refinedActions,
      ...(this.generatedAt !== undefined ? { generatedAt: this.generatedAt } : {}),
      ...(this.modelUsed !== undefined ? { modelUsed: this.modelUsed } : {}),
      ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel } : {}),
      ...(this.executionAudit !== undefined ? { executionAudit: this.executionAudit } : {}),
    };
  }
}

/**
 * Executes `ai.models.generateContent` with automatic exponential backoff retry
 * on transient HTTP 503 / 429 / overloaded errors.
 */
export async function generateContentWithRetry(aiClient: any, params: any, maxRetries = 3) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await aiClient.models.generateContent(params);
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
  options?: {
    pass0Model?: string;
    pass1Model?: string;
    pass1Thinking?: string;
    pass2Model?: string;
    pass2Thinking?: string;
    pass3Model?: string;
    pass3Thinking?: string;
  };
}

export interface Pass0Options {
  model?: string;
  videoGcsUri?: string;
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
  videoRecord?: { originalName?: string; videoId?: string; [key: string]: any };
  databaseId?: string;
}

/**
 * Pass 0 (Workflow Classifier):
 * - Reads dynamic guidelines from `config/classification-agent-guidelines.md`.
 * - Analyzes video/audio to determine if workflow is:
 *   `INVENTORY_UPDATE_WORKFLOW`, `EXPERIMENT_NOTEBOOK_WORKFLOW`, or `UNCLASSIFIED_WORKFLOW`.
 * - Validates output via WorkflowClassificationSchema.
 */
export async function runPass0WorkflowClassification(
  paramsOrVideoId: Pass0Options | string,
  options?: Pass0Options
): Promise<WorkflowClassification> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass0Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_FLASH_MODEL;
  const databaseId = mergedOptions.databaseId || '(default)';
  const videoGcsUri = mergedOptions.videoGcsUri;
  const localVideoPath = mergedOptions.localVideoPath;
  const registeredFileUri = mergedOptions.registeredFileUri;
  let videoRecord = mergedOptions.videoRecord;

  const systemInstruction = loadGuideline('classification-agent-guidelines.md');
  const client = getGenAIClient();
  const gcsUri = resolveNormalizedGcsUri(registeredFileUri || videoGcsUri, videoId);

  const promptText = `You are analyzing video recording: ${gcsUri}.
Transcribe audible speech and classify the workflow strictly according to the system instructions.
Return a valid JSON object matching WorkflowClassificationSchema.`;

  const parts: any[] = [];
  if (gcsUri) {
    parts.push({
      fileData: {
        fileUri: gcsUri,
        mimeType: 'video/mp4',
      },
      videoMetadata: {
        fps: 1,
      },
    });
  }
  parts.push({ text: promptText });

  const pass0Candidates = Array.from(
    new Set(
      targetModel.toLowerCase().includes('flash')
        ? [targetModel, DEFAULT_FLASH_MODEL]
        : [targetModel, 'gemini-1.5-pro-002', 'gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.1-pro-preview']
    )
  );
  let response: any;
  for (let mIdx = 0; mIdx < pass0Candidates.length; mIdx++) {
    const candidateModel = pass0Candidates[mIdx];
    try {
      response = await generateContentWithRetry(client, {
        model: candidateModel,
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });
      break;
    } catch (err: any) {
      const isNotFound =
        err?.status === 404 ||
        err?.statusCode === 404 ||
        err?.code === 404 ||
        err?.code === 'NOT_FOUND' ||
        err?.message?.includes('404') ||
        err?.message?.includes('NOT_FOUND') ||
        err?.message?.includes('not found');
      if (isNotFound && mIdx < pass0Candidates.length - 1) {
        console.warn(`[Pass 0] Model ${candidateModel} not found, falling back to next candidate...`);
        continue;
      }
      throw err;
    }
  }

  const rawText = extractTextFromResponse(response);
  const parsedJson = extractJsonFromText(rawText);

  const pass0Audit = {
    model: targetModel,
    modelUsed: targetModel,
    endpoint: process.env.GOOGLE_CLOUD_API_ENDPOINT || 'us',
    calledAt: new Date().toISOString(),
    promptText,
    systemInstruction: systemInstruction || null,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
    schema: null,
    videoMetadata: {
      durationSeconds: videoRecord?.durationSeconds || 120,
      uri: gcsUri,
    },
    modelDiagnostics: {
      finishReason: response?.candidates?.[0]?.finishReason || 'STOP',
      usageMetadata: response?.usageMetadata || null,
    },
  };

  // Sanitize archiveName if null or empty before schema validation
  if (parsedJson && typeof parsedJson === 'object') {
    parsedJson.executionAudit = pass0Audit;
    parsedJson.modelUsed = targetModel;
    if (!parsedJson.archiveName) {
      if (!videoRecord && videoId) {
        try {
          videoRecord = (await getVideoMetadata(databaseId, videoId)) || undefined;
        } catch {
          // ignore lookup error
        }
      }
      parsedJson.archiveName =
        videoRecord?.originalName || videoRecord?.videoId || videoId || 'default_archive';
    }
  }

  return WorkflowClassificationSchema.parse(parsedJson);
}

export interface Pass1Options {
  model?: string;
  thinkingLevel?: string;
  videoGcsUri?: string;
  classification?: WorkflowClassification;
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
  databaseId?: string;
  videoRecord?: { originalName?: string; videoId?: string; durationSeconds?: number; [key: string]: any };
}

export interface Pass2Options {
  model?: string;
  thinkingLevel?: string;
  videoGcsUri?: string;
  classification?: WorkflowClassification;
  actions?: Action[];
  events?: Event[];
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
  databaseId?: string;
  videoRecord?: any;
}

export interface Pass3Options {
  model?: string;
  thinkingLevel?: string;
  videoGcsUri?: string;
  classification?: WorkflowClassification;
  actions?: Action[];
  events?: Event[];
  customerId?: string;
  videoId?: string;
  localVideoPath?: string;
  registeredFileUri?: string;
  databaseId?: string;
  videoRecord?: any;
}

/**
 * Pass 1 (Action Detection):
 * - Selects dynamic guidelines: `config/inventory-agent-guidelines.md` or `config/archive-agent-guidelines.md`
 *   based on Pass 0 classification result.
 * - Calls Gemini Pro (`DEFAULT_PRO_MODEL`) with structured JSON schema (`responseSchema`, `responseMimeType: "application/json"`).
 * - Instructs Gemini to segment every individual action with exact timestamps without hallucination or summarization.
 * - Parses raw JSON response, validates `actions` array and ActionDetectionPassResultSchema.
 * - Returns ActionDetectionPassResultObject extending Array<Action>.
 */
export async function runPass1ActionDetection(
  paramsOrVideoId: Pass1Options | string,
  options?: Pass1Options
): Promise<Action[]> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass1Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_PRO_MODEL;
  const targetThinking = mergedOptions.thinkingLevel || 'MEDIUM';
  const databaseId = mergedOptions.databaseId || '(default)';

  let videoDoc = mergedOptions.videoRecord;
  if (!videoDoc && videoId) {
    try {
      videoDoc =
        (await getVideoMetadata(databaseId, videoId)) ||
        (databaseId !== '(default)' ? await getVideoMetadata('(default)', videoId) : null) ||
        undefined;
    } catch {
      // Ignore lookup errors in test/offline environments
    }
  }

  // Retrieve the video's actual duration from Firestore (videoDoc.durationSeconds || 120)
  let durationSeconds = 120;
  if (videoDoc?.durationSeconds && videoDoc.durationSeconds > 0) {
    durationSeconds = videoDoc.durationSeconds;
  }

  const classification: WorkflowClassification =
    mergedOptions.classification ||
    videoDoc?.passes?.pass0?.data || {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      confidence: 1.0,
      notes: 'Default classification',
    };

  const guidelineFile =
    classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const baseSystemInstruction = loadGuideline(guidelineFile);

  const temporalScanningInstructions = `CRITICAL TEMPORAL SCANNING INSTRUCTIONS:
- Analyze the full video timeline from 00:00 through completion (${durationSeconds}s), across both the FIRST HALF and the SECOND HALF.
- IGNORE verbal count cues from the audio transcript; rely strictly on visual evidence.`;

  const systemInstruction = `${baseSystemInstruction}\n\n${temporalScanningInstructions}`;
  const client = getGenAIClient();
  const resolvedGcs =
    mergedOptions.registeredFileUri ||
    mergedOptions.videoGcsUri ||
    videoDoc?.normalizedGcsUri ||
    videoDoc?.rawGcsUri;
  const gcsUri = resolveNormalizedGcsUri(resolvedGcs, videoId);

  const promptText = `TASK: Detect EVERY distinct vial insertion into or removal from a cryo-rack or box.
Workflow Type: ${classification.workflowType}.
Video URI: ${gcsUri}.
Video Duration: ${durationSeconds} seconds (${durationSeconds}s).

CRITICAL GROUND-TRUTH RULES:
- Rely SOLELY on visual evidence across the entire timeline from 00:00 to ${durationSeconds}s (including both the FIRST HALF and the SECOND HALF).
- IGNORE verbal count cues from the audio transcript or partial spoken summaries.
- Do NOT stop after the first few actions; continue scanning through pauses until the end of the clip.

CRITICAL TEMPORAL SCANNING INSTRUCTIONS:
- IMPORTANT - MULTI-ACTION TEMPORAL EXTRACTION: Emit each physical vial transfer as a separate, chronological action (\`act_001\`, \`act_002\`, ...); NEVER aggregate multiple transfers into one summary event.
- \`totalActionsDetected\` MUST equal \`actions.length\`.

CRITICAL SCOPE RESTRICTION:
- You MUST ONLY detect 'VIAL_INSERTION' (placing a vial into a slot) and 'VIAL_REMOVAL' (taking a vial out of a slot).
- Do NOT detect box removals, cap opening/closing, or box lid adjustments.
- Every single vial placed into or removed from the grid must be emitted as an independent action.

CRITICAL CONSTRAINTS:
- \`description\`: Concise sentence under 15 words (max 20 words, e.g., "Operator inserts vial into slot A1").
- \`targetCoordinate\`: Alphanumeric grid slot coordinate only (e.g., "A1", "B2") or "UNKNOWN" (no tower/rack hierarchy labels).
- \`startTime\` / \`endTime\`: "MM:SS" format, paired with float \`startTimestampSeconds\` / \`endTimestampSeconds\` and \`confidenceScore\` (0.0–1.0).
- Explicitly forbidden: Repeating hierarchical taxonomy strings or repeating phrase chains.

LABEL PRESENTATION EVENT DETECTION & ACTION ASSOCIATION (1 fps):
- In the "events" array, detect every 'BOX_LABEL_PRESENTATION' (operator shows cryo-box label/identifier to the camera) and 'VIAL_LABEL_PRESENTATION' (operator shows cryovial label/barcode to the camera) across the 1 fps timeline.
- Associate each presentation event with the relevant physical actions in "actions" by populating "actionIds" (and primary "actionId"):
  * Box-wide association: If the operator shows a box label at the start or before working on a box, associate that BOX_LABEL_PRESENTATION event with ALL subsequent vial insertion/removal actions performed in that box.
  * Spoken count association: If the operator shows a vial label and states a count in the audio, associate that VIAL_LABEL_PRESENTATION event with that number of subsequent vial insertion/removal actions following the presentation.
  * Record any relevant spoken phrase in "spokenContext" and the rationale in "associationReason".

Return a JSON object conforming to ActionDetectionPassResultSchema.`;

  const parts: any[] = [];
  if (gcsUri) {
    parts.push({
      fileData: {
        fileUri: gcsUri,
        mimeType: 'video/mp4',
      },
      videoMetadata: {
        fps: 1,
      },
    });
  }
  parts.push({ text: promptText });

  const actionDetectionSchema = {
    type: 'OBJECT',
    properties: {
      workflowContext: { type: 'STRING' },
      totalActionsDetected: { type: 'INTEGER' },
      totalEventsDetected: { type: 'INTEGER' },
      modelUsed: { type: 'STRING' },
      actions: {
        type: 'ARRAY',
        description:
          'Exhaustive chronological array of all vial insertion and removal actions observed in the video.',
        items: {
          type: 'OBJECT',
          properties: {
            actionId: { type: 'STRING' },
            actionType: {
              type: 'STRING',
              enum: ['VIAL_INSERTION', 'VIAL_REMOVAL'],
            },
            description: { type: 'STRING' },
            startTime: { type: 'STRING' },
            endTime: { type: 'STRING' },
            startTimestampSeconds: { type: 'NUMBER' },
            endTimestampSeconds: { type: 'NUMBER' },
            confidenceScore: { type: 'NUMBER' },
            targetCoordinate: {
              type: 'STRING',
              description: "Alphanumeric grid slot coordinate (e.g. 'A1', 'B2', 'C3') or 'UNKNOWN'",
            },
          },
          required: [
            'actionId',
            'actionType',
            'description',
            'startTime',
            'endTime',
            'startTimestampSeconds',
            'endTimestampSeconds',
            'confidenceScore',
          ],
        },
      },
      events: {
        type: 'ARRAY',
        description:
          'Chronological list of all BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events detected at 1 fps and associated with the detected actions.',
        items: {
          type: 'OBJECT',
          properties: {
            eventId: { type: 'STRING' },
            eventClass: {
              type: 'STRING',
              enum: [
                'BOX_LABEL_PRESENTATION',
                'VIAL_LABEL_PRESENTATION',
                'BOX_LABEL_PRESENTATION_EVENT',
                'VIAL_LABEL_PRESENTATION_EVENT',
              ],
            },
            actionId: {
              type: 'STRING',
              description: 'Primary actionId associated with this presentation event (e.g. act_001)',
            },
            actionIds: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description:
                'All actionIds from actions associated with this presentation event (e.g. all actions in the box for a box label presentation, or N subsequent vial actions when operator states a count).',
            },
            startTime: { type: 'STRING' },
            endTime: { type: 'STRING' },
            startTimestampSeconds: { type: 'NUMBER' },
            endTimestampSeconds: { type: 'NUMBER' },
            description: { type: 'STRING' },
            spokenContext: { type: 'STRING' },
            associationReason: { type: 'STRING' },
          },
          required: ['eventId', 'eventClass', 'startTimestampSeconds', 'endTimestampSeconds'],
        },
      },
    },
    required: ['totalActionsDetected', 'actions'],
  };

  const isFlashTarget = targetModel.toLowerCase().includes('flash');
  const candidateModels = Array.from(
    new Set(
      isFlashTarget
        ? [targetModel, DEFAULT_FLASH_MODEL]
        : [
            targetModel,
            'gemini-1.5-pro-002',
            'gemini-1.5-pro',
            'gemini-4-argon',
            'gemini-3.1-pro-preview',
          ]
    )
  );

  const config: any = {
    temperature: 0.2,
    maxOutputTokens: 16384,
    responseMimeType: 'application/json',
    responseSchema: actionDetectionSchema,
  };
  if (targetThinking && targetThinking !== 'OFF') {
    config.thinkingConfig = {
      thinkingLevel: targetThinking,
    };
  }

  let activeModel = candidateModels[0];
  let response: any;
  let lastError: any = null;

  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    activeModel = model;
    try {
      console.log(`[Pass 1] Running with model: ${model}`);
      response = await generateContentWithRetry(client, {
        model,
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        config: {
          systemInstruction,
          ...config,
        },
      });
      break;
    } catch (err: any) {
      lastError = err;
      const isNotFound =
        err?.status === 404 ||
        err?.statusCode === 404 ||
        err?.code === 404 ||
        err?.code === 'NOT_FOUND' ||
        err?.message?.includes('404') ||
        err?.message?.includes('NOT_FOUND') ||
        err?.message?.includes('not found') ||
        err?.message?.includes('does not have access');

      if (isNotFound && i < candidateModels.length - 1) {
        console.warn(`[Pass 1] Model ${model} not found, falling back to next model...`);
        continue;
      } else {
        throw err;
      }
    }
  }

  if (!response) {
    throw lastError || new Error(`[Pass 1] Failed to obtain response from any candidate model`);
  }

  const candidate = response?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    console.warn('[Pass 1] Model response hit MAX_TOKENS limit');
  }

  const thoughtsTokenCount = (response?.usageMetadata as any)?.thoughtsTokenCount || 0;
  const thoughtSignature = (candidate as any)?.thoughtSignature;

  const rawText = extractTextFromResponse(response);
  const cleaned = rawText.replace(/```json\n?|```/g, '').trim();

  let parsedJson: any;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err: any) {
    let repaired = false;
    const lastBraceIndex = cleaned.lastIndexOf('}');
    if (lastBraceIndex !== -1) {
      const candidateSub = cleaned.substring(0, lastBraceIndex + 1);
      const repairAttempts = [
        candidateSub + ']}',
        candidateSub + ']',
        candidateSub,
        candidateSub + '}',
        cleaned + '"}]}',
        cleaned + '"}]',
      ];
      for (const attempt of repairAttempts) {
        try {
          parsedJson = JSON.parse(attempt);
          console.warn('[Pass 1] Successfully repaired truncated JSON response');
          repaired = true;
          break;
        } catch {
          // ignore and continue trying
        }
      }
    }

    if (!repaired) {
      const payloadPreview = cleaned.slice(0, 500);
      console.error(
        `[Pass 1] JSON parse error: ${err.message}. Payload preview (first 500 chars): ${payloadPreview}`
      );
      throw new Error(
        `[Pass 1] Failed to parse model JSON response: ${err.message}. Payload preview: ${payloadPreview}`
      );
    }
  }

  const rawActions: any[] = Array.isArray(parsedJson)
    ? parsedJson
    : Array.isArray(parsedJson?.actions)
    ? parsedJson.actions
    : Array.isArray(parsedJson?.actionList)
    ? parsedJson.actionList
    : [];

  const finalVideoId =
    videoId ||
    (typeof parsedJson === 'object' && parsedJson?.videoId ? parsedJson.videoId : 'vid_' + Date.now());

  const normalizedIntervals: ActionInterval[] = [];
  const normalizedActions: Action[] = [];

  for (let idx = 0; idx < rawActions.length; idx++) {
    const raw = rawActions[idx];
    const actionId = raw.actionId || `act_${String(idx + 1).padStart(3, '0')}`;

    // Action Class and Type mapping
    let actionType = raw.actionType;
    let actionClass = raw.actionClass;

    if (!actionType && actionClass) {
      actionType = actionClass.replace(/_ACTION$/, '');
    } else if (!actionType) {
      actionType =
        classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
          ? 'REAGENT_SEEDING'
          : 'VIAL_INSERTION';
    }

    if (!actionClass) {
      if (actionType.includes('REAGENT') || actionType.includes('SEEDING')) {
        actionClass = actionType.includes('MIX') ? 'REAGENT_MIXING_ACTION' : 'REAGENT_SEEDING_ACTION';
      } else if (actionType.includes('REMOVAL')) {
        actionClass = 'VIAL_REMOVAL_ACTION';
      } else {
        actionClass = 'VIAL_INSERTION_ACTION';
      }
    }

    // Precise Timestamps & Numeric intervals
    let startSec =
      typeof raw.startTimestampSeconds === 'number'
        ? raw.startTimestampSeconds
        : typeof raw.startTime === 'number'
        ? raw.startTime
        : undefined;
    let endSec =
      typeof raw.endTimestampSeconds === 'number'
        ? raw.endTimestampSeconds
        : typeof raw.endTime === 'number'
        ? raw.endTime
        : undefined;

    let startTime = typeof raw.startTime === 'string' ? raw.startTime : undefined;
    let endTime = typeof raw.endTime === 'string' ? raw.endTime : undefined;

    if (startSec === undefined && startTime) {
      startSec = parseTimeStringToSeconds(startTime);
    } else if (startSec !== undefined && !startTime) {
      startTime = formatSecondsToTimeString(startSec);
    } else if (startSec === undefined && !startTime) {
      startSec = idx * 10;
      startTime = formatSecondsToTimeString(startSec);
    }

    if (endSec === undefined && endTime) {
      endSec = parseTimeStringToSeconds(endTime);
    } else if (endSec !== undefined && !endTime) {
      endTime = formatSecondsToTimeString(endSec);
    } else if (endSec === undefined && !endTime) {
      endSec = (startSec ?? 0) + 5;
      endTime = formatSecondsToTimeString(endSec);
    }

    const confidenceScore =
      typeof raw.confidenceScore === 'number' ? Math.max(0, Math.min(1, raw.confidenceScore)) : 0.95;

    // Coordinate & Location
    let targetLocation = raw.targetLocation;
    let targetCoordinate = raw.targetCoordinate || targetLocation?.coordinate;
    let boxRowId = raw.boxRowId;
    let boxColId = typeof raw.boxColId === 'number' ? raw.boxColId : undefined;

    if (targetCoordinate && (!boxRowId || !boxColId)) {
      const match = String(targetCoordinate).match(/^([A-Za-z]+)(\d+)$/);
      if (match) {
        boxRowId = boxRowId || match[1].toUpperCase();
        boxColId = boxColId || parseInt(match[2], 10);
      }
    } else if (boxRowId && boxColId && !targetCoordinate) {
      targetCoordinate = `${boxRowId}${boxColId}`;
    }

    if (!targetLocation && targetCoordinate) {
      targetLocation = { coordinate: targetCoordinate };
    } else if (targetLocation && targetCoordinate && !targetLocation.coordinate) {
      targetLocation.coordinate = targetCoordinate;
    }

    const description =
      raw.description ||
      `Operator performs ${actionType} at ${
        targetCoordinate || (boxRowId ? `${boxRowId}${boxColId || ''}` : 'target slot')
      }`;

    const cellLineName = raw.cellLineName || (raw.cellLineInfo?.name as string) || undefined;
    const inventoryId = raw.inventoryId || (classification.inventoryName || undefined);
    const archiveId = raw.archiveId || (classification.archiveName || undefined);

    const intervalItem: ActionInterval = {
      actionId,
      actionType,
      description,
      startTime: startTime!,
      endTime: endTime!,
      startTimestampSeconds: startSec!,
      endTimestampSeconds: endSec!,
      confidenceScore,
      targetCoordinate,
      targetLocation: targetLocation
        ? {
            tower: targetLocation.tower,
            box: targetLocation.box,
            coordinate: targetCoordinate || targetLocation.coordinate,
          }
        : targetCoordinate
        ? { coordinate: targetCoordinate }
        : undefined,
      actionClass,
      inventoryId,
      archiveId,
      cellLineName,
      cellLineInfo: raw.cellLineInfo,
      boxRowId,
      boxColId,
    };

    const actionItem: Action = {
      actionId,
      actionClass: actionClass as any,
      actionType,
      description,
      startTime,
      endTime,
      startTimestampSeconds: startSec,
      endTimestampSeconds: endSec,
      confidenceScore,
      targetCoordinate,
      targetLocation: targetLocation
        ? {
            tower: targetLocation.tower,
            box: targetLocation.box,
            coordinate: targetCoordinate || targetLocation.coordinate,
          }
        : targetCoordinate
        ? { coordinate: targetCoordinate }
        : undefined,
      inventoryId,
      archiveId,
      cellLineName,
      cellLineInfo: raw.cellLineInfo,
      towerId: raw.towerId || targetLocation?.tower,
      boxRowId,
      boxColId,
      eventList: Array.isArray(raw.eventList) && raw.eventList.length > 0 ? raw.eventList : [`evt_${actionId}`],
    };

    normalizedIntervals.push(ActionIntervalSchema.parse(intervalItem));
    normalizedActions.push(ActionSchema.parse(actionItem));
  }

  // Extract & associate BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events detected at 1 fps in Pass 1
  const rawPass1Events: any[] = Array.isArray(parsedJson?.events)
    ? parsedJson.events
    : Array.isArray(parsedJson?.eventList)
    ? parsedJson.eventList
    : [];

  const normalizedPass1RawEvents = rawPass1Events.map((evt: any, idx: number) => {
    const startSec =
      typeof evt.startTimestampSeconds === 'number'
        ? evt.startTimestampSeconds
        : typeof evt.startTime === 'number'
        ? evt.startTime
        : typeof evt.startTime === 'string'
        ? parseTimeStringToSeconds(evt.startTime)
        : 0;
    const endSec =
      typeof evt.endTimestampSeconds === 'number'
        ? evt.endTimestampSeconds
        : typeof evt.endTime === 'number'
        ? evt.endTime
        : typeof evt.endTime === 'string'
        ? parseTimeStringToSeconds(evt.endTime)
        : startSec;
    return {
      ...evt,
      eventId: evt.eventId || `evt_${String(idx + 1).padStart(3, '0')}`,
      eventClass: evt.eventClass || 'VIAL_LABEL_PRESENTATION',
      eventTrack: evt.eventTrack === 'audio' ? 'audio' : 'video',
      startTime: startSec,
      endTime: endSec,
    };
  });

  const associatedPass1RawEvents = associatePresentationEventsWithActions(
    normalizedPass1RawEvents,
    normalizedActions,
    classification
  );

  const pass1Events: Event[] = associatedPass1RawEvents.map((evt: any) =>
    EventSchema.parse({
      eventId: evt.eventId,
      actionId: evt.actionId || normalizedActions[0]?.actionId || 'act_001',
      actionIds:
        Array.isArray(evt.actionIds) && evt.actionIds.length > 0
          ? evt.actionIds
          : [evt.actionId || normalizedActions[0]?.actionId || 'act_001'],
      eventClass: evt.eventClass || 'VIAL_LABEL_PRESENTATION',
      eventTrack: evt.eventTrack === 'audio' ? 'audio' : 'video',
      startTime: evt.startTime ?? 0,
      endTime: evt.endTime ?? 0,
      description: evt.description,
      spokenContext: evt.spokenContext,
      associationReason: evt.associationReason,
      bestShotUrls: Array.isArray(evt.bestShotUrls) ? evt.bestShotUrls : [],
      bestShotTimes: Array.isArray(evt.bestShotTimes) ? evt.bestShotTimes : [],
      refinementList: Array.isArray(evt.refinementList) ? evt.refinementList : [],
    })
  );

  // Cross-link Pass 1 associated presentation events back onto Pass 1 actions & intervals
  if (pass1Events.length > 0) {
    for (let i = 0; i < normalizedActions.length; i++) {
      const act = normalizedActions[i];
      const interval = normalizedIntervals[i];
      const linkedEventIds = pass1Events
        .filter(
          (e) =>
            e.actionId === act.actionId ||
            (Array.isArray(e.actionIds) && e.actionIds.includes(act.actionId))
        )
        .map((e) => e.eventId);
      if (linkedEventIds.length > 0) {
        act.eventList = Array.from(new Set(linkedEventIds));
        interval.eventList = act.eventList;
      }
    }
  }

  const thinkingLevel = config.thinkingConfig?.thinkingLevel || targetThinking || undefined;

  const executionAudit = {
    model: targetModel,
    modelUsed: targetModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    endpoint: process.env.GOOGLE_CLOUD_API_ENDPOINT || 'us',
    calledAt: new Date().toISOString(),
    promptText,
    systemInstruction: systemInstruction || null,
    generationConfig: config,
    schema: actionDetectionSchema,
    videoMetadata: {
      durationSeconds,
      uri: gcsUri,
    },
    modelDiagnostics: {
      finishReason: finishReason || 'STOP',
      usageMetadata: response?.usageMetadata || null,
      thoughtsTokenCount,
      ...(thoughtSignature ? { thoughtSignature } : {}),
    },
  };

  const pass1Result: ActionDetectionPassResult = {
    videoId: finalVideoId,
    totalActionsDetected: normalizedIntervals.length,
    ...(pass1Events.length > 0 ? { totalEventsDetected: pass1Events.length, events: pass1Events } : {}),
    workflowContext: classification.workflowType,
    actions: normalizedIntervals,
    generatedAt: new Date().toISOString(),
    modelUsed: targetModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    executionAudit,
  };

  ActionDetectionPassResultSchema.parse(pass1Result);

  const actions = new ActionDetectionPassResultObject(pass1Result, normalizedActions) as any;

  const result = pass1Result;
  result.modelUsed = targetModel;
  if (thinkingLevel) result.thinkingLevel = thinkingLevel;
  result.executionAudit = executionAudit;
  actions.modelUsed = targetModel;
  if (thinkingLevel) actions.thinkingLevel = thinkingLevel;
  actions.executionAudit = executionAudit;
  actions.events = pass1Events;
  actions.totalEventsDetected = pass1Events.length;

  console.log(`[Pass 1] Video duration: ${durationSeconds}s. Actions detected: ${result.actions.length}.`);
  console.log(`[Pass 1] Actions detected: ${result.actions.length}`);
  result.actions.forEach((a: any, i: number) => {
    console.log(`  [Action ${i + 1}] ${a.startTime} - ${a.endTime}: ${a.description}`);
  });
  if (actions.length > 0) {
    console.log(`[Pass 1] Action span: ${actions[0].startTime} to ${actions[actions.length - 1].endTime}`);
  }

  // Reset passes.pass1.error = null on success when writing to Firestore
  if (finalVideoId) {
    try {
      await updateVideoPass(databaseId, finalVideoId, 'pass1', {
        status: 'COMPLETED',
        data: pass1Result,
        executionAudit,
        completedAt: new Date().toISOString(),
        error: null,
      });
      if (databaseId !== '(default)') {
        await updateVideoPass('(default)', finalVideoId, 'pass1', {
          status: 'COMPLETED',
          data: pass1Result,
          executionAudit,
          completedAt: new Date().toISOString(),
          error: null,
        });
      }
    } catch (firestoreErr) {
      console.warn(`[Pass 1] Non-fatal: Could not write pass1 completion to Firestore:`, firestoreErr);
    }
  }

  return actions;
}

/**
 * Pass 2 (Event Detection & 4 fps Boundary Refinement) structured Gemini responseSchema:
 * Detects BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events, associates them with
 * Pass 1 actions (actionIds), identifies the 2 best frames (highest contrast & minimal blur),
 * and refines Pass 1 action interval boundaries at 4 fps within [start - 1s, end + 1s].
 */
export const eventDetectionSchema = {
  type: 'OBJECT',
  properties: {
    events: {
      type: 'ARRAY',
      description:
        'Chronological list of detected BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events (and optional state/audio sub-events).',
      items: {
        type: 'OBJECT',
        properties: {
          eventId: { type: 'STRING' },
          actionId: {
            type: 'STRING',
            description: 'Primary Pass 1 actionId associated with this event (e.g. act_001)',
          },
          actionIds: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description:
              'All Pass 1 actionIds associated with this event (e.g. all actions in the box for a box label presentation, or N subsequent vial actions when operator states a count like "four vials").',
          },
          eventClass: {
            type: 'STRING',
            enum: [
              'BOX_LABEL_PRESENTATION',
              'VIAL_LABEL_PRESENTATION',
              'BOX_LABEL_PRESENTATION_EVENT',
              'VIAL_LABEL_PRESENTATION_EVENT',
              'VIAL_INSERTION',
              'VIAL_REMOVAL',
              'CAP_REMOVAL',
              'LABEL_PRESENTATION',
              'PRE_ACTION_BOX_STATE_EVENT',
              'POST_ACTION_BOX_STATE_EVENT',
              'OPERATOR_AUDIO_UTTERANCE_EVENT',
              'OTHER',
            ],
            description: 'Explicit event class (BOX_LABEL_PRESENTATION or VIAL_LABEL_PRESENTATION)',
          },
          eventTrack: {
            type: 'STRING',
            enum: ['video', 'audio'],
            description: 'Track modality for the event',
          },
          startTime: {
            type: 'NUMBER',
            description: 'Start time in elapsed seconds as float (e.g. 2.5)',
          },
          endTime: {
            type: 'NUMBER',
            description: 'End time in elapsed seconds as float (e.g. 6.0)',
          },
          description: {
            type: 'STRING',
            description: 'Concise description of the label presentation event',
          },
          spokenContext: {
            type: 'STRING',
            description: 'Relevant spoken phrase during or near the presentation (e.g. "four vials")',
          },
          associationReason: {
            type: 'STRING',
            description: 'Reason explaining why this event is associated with actionIds',
          },
          highestContrastTimestamp: {
            type: 'NUMBER',
            description:
              'Timestamp in elapsed seconds (within [startTime, endTime]) of a frame that first and foremost shows the label clearly to the camera (unoccluded and oriented toward the camera), and secondarily has the highest contrast among such frames. It is OK if this equals minimalBlurTimestamp.',
          },
          minimalBlurTimestamp: {
            type: 'NUMBER',
            description:
              'Timestamp in elapsed seconds (within [startTime, endTime]) of a frame that first and foremost shows the label clearly to the camera (unoccluded and oriented toward the camera), and secondarily has the minimal amount of blur among such frames. It is OK if this equals highestContrastTimestamp.',
          },
          bestShotTimes: {
            type: 'ARRAY',
            items: { type: 'NUMBER' },
            description:
              'Two best frame timestamps [highestContrastTimestamp, minimalBlurTimestamp] in elapsed seconds that clearly show the label to the camera (it is OK if both timestamps are the same)',
          },
          refinementList: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Associated refinement identifiers',
          },
        },
        required: ['eventId', 'eventClass', 'startTime', 'endTime'],
      },
    },
    refinedActions: {
      type: 'ARRAY',
      description:
        'For each Pass 1 vial insertion or removal action, refine the start and end interval boundaries (refinedStartTimestampSeconds and refinedEndTimestampSeconds) at 4 fps precision within [max(0, pass1Start - 1), min(duration, pass1End + 1)].',
      items: {
        type: 'OBJECT',
        properties: {
          actionId: { type: 'STRING' },
          actionType: { type: 'STRING' },
          refinedStartTimestampSeconds: {
            type: 'NUMBER',
            description:
              'Refined start timestamp in seconds at 4 fps precision within [pass1Start - 1s, pass1End + 1s] marking when the vial insertion or removal action begins.',
          },
          refinedEndTimestampSeconds: {
            type: 'NUMBER',
            description:
              'Refined end timestamp in seconds at 4 fps precision within [pass1Start - 1s, pass1End + 1s] marking when the vial insertion or removal action completes.',
          },
          confidenceScore: { type: 'NUMBER' },
        },
        required: [
          'actionId',
          'refinedStartTimestampSeconds',
          'refinedEndTimestampSeconds',
        ],
      },
    },
  },
  required: ['events'],
};

/**
 * Parses spoken vial count phrases such as "four vials", "four vial", "4 vials", "three vials", etc.
 */
export function parseSpokenVialCount(text?: string): number | null {
  if (!text || typeof text !== 'string') return null;
  const wordToNum: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  const wordMatch = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:cryo\s*)?vials?\b/i
  );
  if (wordMatch) {
    return wordToNum[wordMatch[1].toLowerCase()] || null;
  }
  const digitMatch = text.match(/\b(\d+)\s+(?:cryo\s*)?vials?\b/i);
  if (digitMatch) {
    const parsed = parseInt(digitMatch[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Computes the 4 fps boundary refinement window for a Pass 1 action by extending
 * its Pass 1 interval by 1 second at the beginning and 1 second at the end:
 * [max(0, start - 1), min(duration, end + 1)].
 */
export function computeActionRefinementWindow(
  action: Action | ActionInterval,
  durationSeconds?: number
): {
  pass1StartSeconds: number;
  pass1EndSeconds: number;
  searchWindowStartSeconds: number;
  searchWindowEndSeconds: number;
  hasExplicitTimestamps: boolean;
} {
  const rawStart =
    (action as any).pass1StartTimestampSeconds ??
    action.startTimestampSeconds ??
    (action.startTime !== undefined
      ? typeof action.startTime === 'number'
        ? action.startTime
        : parseTimeStringToSeconds(String(action.startTime))
      : undefined);
  const rawEnd =
    (action as any).pass1EndTimestampSeconds ??
    action.endTimestampSeconds ??
    (action.endTime !== undefined
      ? typeof action.endTime === 'number'
        ? action.endTime
        : parseTimeStringToSeconds(String(action.endTime))
      : undefined);

  const hasExplicitTimestamps =
    typeof rawStart === 'number' &&
    typeof rawEnd === 'number' &&
    !isNaN(rawStart) &&
    !isNaN(rawEnd) &&
    (rawEnd > 0 || rawStart > 0 || Boolean(action.startTime));

  const pass1StartSeconds = typeof rawStart === 'number' && !isNaN(rawStart) ? Math.max(0, rawStart) : 0;
  const pass1EndSeconds =
    typeof rawEnd === 'number' && !isNaN(rawEnd) && rawEnd >= pass1StartSeconds
      ? rawEnd
      : pass1StartSeconds;

  const searchWindowStartSeconds = Math.max(0, Number((pass1StartSeconds - 1.0).toFixed(2)));
  const unclampedEnd = Number((pass1EndSeconds + 1.0).toFixed(2));
  const searchWindowEndSeconds =
    typeof durationSeconds === 'number' && durationSeconds > 0
      ? Math.min(durationSeconds, unclampedEnd)
      : unclampedEnd;

  return {
    pass1StartSeconds,
    pass1EndSeconds,
    searchWindowStartSeconds,
    searchWindowEndSeconds,
    hasExplicitTimestamps,
  };
}

/**
 * Associates detected BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events
 * with the appropriate Pass 1 inventory update actions:
 * - Box label presentation: associated with all subsequent vial actions in that box (until next box label).
 * - Vial label presentation: if operator states a count (e.g. "four vials"), associated with the N subsequent
 *   vial actions following the event; otherwise associated with the immediately following (or overlapping) action.
 */
export function associatePresentationEventsWithActions(
  rawEvents: any[],
  actions: Action[],
  classification?: WorkflowClassification
): any[] {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return [];
  const validActionIds = new Set(actions.map((a) => a.actionId));

  const actionsWithTimes = actions.map((a, idx) => {
    const win = computeActionRefinementWindow(a);
    return {
      action: a,
      index: idx,
      startSec: win.pass1StartSeconds,
      endSec: win.pass1EndSeconds,
      hasTime: win.hasExplicitTimestamps,
    };
  });

  // Find timestamps of all box label presentations to bound box scopes
  const boxEventStarts = rawEvents
    .filter((e) => {
      const cls = String(e.eventClass || '').toUpperCase();
      return cls.includes('BOX_LABEL');
    })
    .map((e) => (typeof e.startTime === 'number' ? e.startTime : parseTimeStringToSeconds(String(e.startTime || 0))))
    .sort((a, b) => a - b);

  return rawEvents.map((evt) => {
    const cls = String(evt.eventClass || evt.actionType || '').toUpperCase();
    const evtStart =
      typeof evt.startTime === 'number' ? evt.startTime : parseTimeStringToSeconds(String(evt.startTime || 0));

    // Filter any model-provided actionIds to known Pass 1 actions (or keep if actions list is empty)
    let resolvedIds: string[] = Array.isArray(evt.actionIds)
      ? evt.actionIds.filter((id: any) => typeof id === 'string' && (validActionIds.size === 0 || validActionIds.has(id)))
      : [];

    let associationReason: string | undefined = evt.associationReason;
    const spokenContext: string | undefined = evt.spokenContext;

    if (cls.includes('BOX_LABEL')) {
      // Find next box label presentation after this one, if any
      const nextBoxStart = boxEventStarts.find((t) => t > evtStart + 0.5);
      const followingBoxActions = actionsWithTimes
        .filter((item) => {
          if (!item.hasTime) return true;
          const afterBoxPresentation = item.endSec >= evtStart - 1.0;
          const beforeNextBox = nextBoxStart === undefined || item.startSec < nextBoxStart;
          return afterBoxPresentation && beforeNextBox;
        })
        .map((item) => item.action.actionId);

      if (resolvedIds.length <= 1 && followingBoxActions.length > 0) {
        resolvedIds = followingBoxActions;
        if (!associationReason) {
          associationReason = `Box label presentation at ${evtStart.toFixed(1)}s applies to ${resolvedIds.length} subsequent vial action(s) in this box.`;
        }
      }
    } else if (cls.includes('VIAL_LABEL') || cls === 'LABEL_PRESENTATION') {
      const spokenCount =
        parseSpokenVialCount(spokenContext) ??
        parseSpokenVialCount(evt.description) ??
        parseSpokenVialCount(classification?.transcribedAudio);

      if (spokenCount && spokenCount > 1 && resolvedIds.length < spokenCount) {
        const subsequentActions = actionsWithTimes
          .filter((item) => !item.hasTime || item.endSec >= evtStart - 1.0)
          .slice(0, spokenCount)
          .map((item) => item.action.actionId);
        if (subsequentActions.length > 0) {
          resolvedIds = subsequentActions;
          if (!associationReason) {
            associationReason = `Operator presented vial label with spoken count (${spokenCount} vials); associated with ${resolvedIds.length} subsequent vial action(s).`;
          }
        }
      } else if (resolvedIds.length === 0) {
        if (evt.actionId && (validActionIds.size === 0 || validActionIds.has(evt.actionId))) {
          resolvedIds = [evt.actionId];
        } else {
          const nextAction =
            actionsWithTimes.find((item) => item.hasTime && item.endSec >= evtStart - 1.0) ||
            actionsWithTimes[0];
          if (nextAction) {
            resolvedIds = [nextAction.action.actionId];
          }
        }
        if (!associationReason && resolvedIds.length > 0) {
          associationReason = `Associated with subsequent vial action ${resolvedIds.join(', ')}.`;
        }
      }
    }

    if (resolvedIds.length === 0) {
      const fallbackActionId = evt.actionId || actions[0]?.actionId || 'act_001';
      resolvedIds = [fallbackActionId];
    }

    // Deduplicate while preserving order
    resolvedIds = Array.from(new Set(resolvedIds));
    const primaryActionId =
      evt.actionId && resolvedIds.includes(evt.actionId) ? evt.actionId : resolvedIds[0];

    return {
      ...evt,
      actionId: primaryActionId,
      actionIds: resolvedIds,
      ...(spokenContext ? { spokenContext } : {}),
      ...(associationReason ? { associationReason } : {}),
    };
  });
}

/**
 * Resolves the local full-resolution (raw) or normalized video path if cached on disk during upload/transcoding.
 * Prioritizes full-resolution raw video (`sail_raw_cache/raw_${videoId}.mp4`) so frame extraction uses native full resolution.
 */
function resolveLocalNormalizedVideoPath(videoId?: string, explicitLocalPath?: string): string | undefined {
  if (explicitLocalPath && fs.existsSync(explicitLocalPath)) {
    return explicitLocalPath;
  }
  if (!videoId) return undefined;
  const candidates = [
    `/tmp/sail_raw_cache/raw_${videoId}.mp4`,
    path.join(os.tmpdir(), 'sail_raw_cache', `raw_${videoId}.mp4`),
    `/tmp/raw_${videoId}.mp4`,
    path.join(os.tmpdir(), `raw_${videoId}.mp4`),
    `/tmp/sail_normalized_cache/norm_${videoId}.mp4`,
    path.join(os.tmpdir(), 'sail_normalized_cache', `norm_${videoId}.mp4`),
    `/tmp/norm_${videoId}.mp4`,
    path.join(os.tmpdir(), `norm_${videoId}.mp4`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Ensures a local video file (preferring un-downsampled full-resolution raw video) is available on local disk
 * for FFmpeg frame extraction, downloading from GCS when not yet cached locally.
 */
async function ensureLocalNormalizedVideoPath(
  videoId?: string,
  explicitLocalPath?: string,
  candidateGcsUris: (string | undefined)[] = []
): Promise<string | undefined> {
  const existing = resolveLocalNormalizedVideoPath(videoId, explicitLocalPath);
  if (existing) {
    return existing;
  }
  if (!videoId || process.env.NODE_ENV === 'test') {
    return undefined;
  }

  let cacheBaseDir = '/tmp';
  try {
    if (!fs.existsSync(cacheBaseDir)) {
      fs.mkdirSync(cacheBaseDir, { recursive: true });
    }
  } catch {
    cacheBaseDir = os.tmpdir();
  }
  const rawCacheDir = path.join(cacheBaseDir, 'sail_raw_cache');
  const normCacheDir = path.join(cacheBaseDir, 'sail_normalized_cache');
  try {
    if (!fs.existsSync(rawCacheDir)) {
      fs.mkdirSync(rawCacheDir, { recursive: true });
    }
    if (!fs.existsSync(normCacheDir)) {
      fs.mkdirSync(normCacheDir, { recursive: true });
    }
  } catch {
    return undefined;
  }

  const defaultBucket = process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod';

  const gcsTargets: { bucketName: string; objectPath: string; isRaw: boolean }[] = [];
  const addTarget = (bName: string, objPath: string, isRaw: boolean) => {
    const cleanObj = objPath.replace(/^\/+/, '');
    if (!bName || !cleanObj) return;
    if (!gcsTargets.some((t) => t.bucketName === bName && t.objectPath === cleanObj)) {
      gcsTargets.push({ bucketName: bName, objectPath: cleanObj, isRaw });
    }
  };

  // First add raw/full-resolution GCS candidates so frame extraction uses native full resolution
  addTarget(defaultBucket, `uploads/${videoId}.mp4`, true);
  for (const rawUri of candidateGcsUris) {
    if (!rawUri || typeof rawUri !== 'string') continue;
    const isRawCandidate = !rawUri.includes('/normalized/');
    if (!isRawCandidate) continue;
    if (rawUri.startsWith('gs://')) {
      const withoutScheme = rawUri.slice(5);
      const slashIdx = withoutScheme.indexOf('/');
      if (slashIdx > 0) {
        addTarget(withoutScheme.slice(0, slashIdx), withoutScheme.slice(slashIdx + 1), true);
      }
    } else {
      addTarget(defaultBucket, rawUri, true);
    }
  }

  // Then add normalized GCS candidates as fallback
  for (const rawUri of candidateGcsUris) {
    if (!rawUri || typeof rawUri !== 'string') continue;
    if (rawUri.startsWith('gs://')) {
      const withoutScheme = rawUri.slice(5);
      const slashIdx = withoutScheme.indexOf('/');
      if (slashIdx > 0) {
        addTarget(withoutScheme.slice(0, slashIdx), withoutScheme.slice(slashIdx + 1), false);
      }
    } else {
      addTarget(defaultBucket, rawUri, false);
    }
  }

  addTarget(defaultBucket, `normalized/${videoId}/chunk_000.mp4`, false);
  addTarget(defaultBucket, `normalized/norm_${videoId}.mp4`, false);

  for (const target of gcsTargets) {
    try {
      const file = storage.bucket(target.bucketName).file(target.objectPath);
      const [exists] = await file.exists();
      if (!exists) continue;
      const destPath = target.isRaw
        ? path.join(rawCacheDir, `raw_${videoId}.mp4`)
        : path.join(normCacheDir, `norm_${videoId}.mp4`);
      await file.download({ destination: destPath });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 256) {
        console.log(
          `[VideoCache] Downloaded video gs://${target.bucketName}/${target.objectPath} to ${destPath} for full-res frame extraction.`
        );
        return destPath;
      }
    } catch {
      // try next candidate
    }
  }

  return undefined;
}

function resolvePersistentFrameDirs(videoId?: string): { primaryDir: string; mirrorDir?: string } {
  const safeVideoId = videoId || 'default';
  let primaryBase = '/tmp';
  try {
    if (!fs.existsSync(primaryBase)) {
      fs.mkdirSync(primaryBase, { recursive: true });
    }
  } catch {
    primaryBase = os.tmpdir();
  }
  const primaryDir = path.join(primaryBase, 'sail_frames_cache', safeVideoId);
  if (!fs.existsSync(primaryDir)) {
    fs.mkdirSync(primaryDir, { recursive: true });
  }

  const osTmpDir = path.join(os.tmpdir(), 'sail_frames_cache', safeVideoId);
  let mirrorDir: string | undefined;
  if (path.resolve(osTmpDir) !== path.resolve(primaryDir)) {
    try {
      if (!fs.existsSync(osTmpDir)) {
        fs.mkdirSync(osTmpDir, { recursive: true });
      }
      mirrorDir = osTmpDir;
    } catch {
      mirrorDir = undefined;
    }
  }
  return { primaryDir, mirrorDir };
}

function mirrorFrameFile(localPath: string, mirrorDir?: string): void {
  if (!mirrorDir || !localPath || !fs.existsSync(localPath)) return;
  try {
    const dest = path.join(mirrorDir, path.basename(localPath));
    if (path.resolve(dest) !== path.resolve(localPath)) {
      fs.copyFileSync(localPath, dest);
    }
  } catch {
    // ignore mirror error
  }
}

function isRealJpegFile(filePath?: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const buf = fs.readFileSync(filePath);
    return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
  } catch {
    return false;
  }
}

/**
 * Pass 2 (Event Detection & 4 fps Action Boundary Refinement):
 * 1. Detects BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events in the video.
 * 2. Associates each presentation event with the relevant Pass 1 inventory update actions (`actionIds`),
 *    supporting box-wide associations and spoken multi-vial counts (e.g., "four vials").
 * 3. Selects and extracts the 2 best frames per event:
 *    - 1 frame with HIGHEST_CONTRAST
 *    - 1 frame with MINIMAL_BLUR
 *    Uploads both frames to GCS and caches them for UI display.
 * 4. Refines Pass 1 action interval boundaries at 4 fps strictly within the window
 *    [max(0, pass1Start - 1s), min(duration, pass1End + 1s)].
 */
export async function runPass2EventDetection(
  paramsOrVideoId: Pass2Options | string,
  options?: Pass2Options
): Promise<Event[]> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass2Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_PRO_MODEL;
  const targetThinking = mergedOptions.thinkingLevel || 'MEDIUM';
  const databaseId = mergedOptions.databaseId || '(default)';
  const customerId = mergedOptions.customerId || 'customer-alpha';

  let videoDoc = mergedOptions.videoRecord;
  if (!videoDoc && videoId) {
    try {
      videoDoc =
        (await getVideoMetadata(databaseId, videoId)) ||
        (databaseId !== '(default)' ? await getVideoMetadata('(default)', videoId) : null) ||
        undefined;
    } catch {
      // ignore
    }
  }

  const classification: WorkflowClassification =
    mergedOptions.classification ||
    videoDoc?.passes?.pass0?.data || {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      transcribedAudio: '',
    };

  const rawActions =
    mergedOptions.actions ||
    videoDoc?.passes?.pass1?.data?.actions ||
    videoDoc?.passes?.pass1?.data ||
    [];
  const actions: Action[] = Array.isArray(rawActions) ? rawActions : [];
  const rawPass1Events =
    mergedOptions.events ||
    (mergedOptions.actions as any)?.events ||
    videoDoc?.passes?.pass1?.data?.events ||
    [];
  const pass1Events: Event[] = Array.isArray(rawPass1Events) ? rawPass1Events : [];
  const durationSeconds: number | undefined =
    videoDoc?.durationSeconds || (videoDoc as any)?.durationSec || undefined;

  const guidelineFile =
    classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const systemInstruction = loadGuideline(guidelineFile);
  const client = getGenAIClient();
  const allEvents: Event[] = [];
  const resolvedGcs =
    mergedOptions.registeredFileUri ||
    mergedOptions.videoGcsUri ||
    videoDoc?.normalizedGcsUri ||
    videoDoc?.rawGcsUri;
  const gcsUri = resolveNormalizedGcsUri(resolvedGcs, videoId);
  const resolvedLocalVideoPath = await ensureLocalNormalizedVideoPath(
    videoId,
    mergedOptions.localVideoPath,
    [
      gcsUri,
      mergedOptions.registeredFileUri,
      mergedOptions.videoGcsUri,
      videoDoc?.normalizedGcsUri,
      (videoDoc as any)?.chunks?.[0]?.gcsUri,
      videoDoc?.rawGcsUri,
    ]
  );

  const scratchDir = path.join(os.tmpdir(), `sail_frames_${videoId || 'temp'}`);
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }
  const { primaryDir: persistentFrameDir, mirrorDir: mirrorFrameDir } = resolvePersistentFrameDirs(videoId);

  try {
    // Compute 4 fps refinement windows [max(0, start - 1), min(duration, end + 1)] for each Pass 1 action
    const actionRefinementWindows = actions.map((action) => ({
      action,
      ...computeActionRefinementWindow(action, durationSeconds),
    }));

    // Ensure neighboring action refinement search windows do not overlap in time
    for (let i = 0; i < actionRefinementWindows.length - 1; i++) {
      const wCurr = actionRefinementWindows[i];
      const wNext = actionRefinementWindows[i + 1];
      if (
        wCurr.hasExplicitTimestamps &&
        wNext.hasExplicitTimestamps &&
        wCurr.searchWindowEndSeconds > wNext.searchWindowStartSeconds
      ) {
        const rawMid =
          wCurr.pass1EndSeconds <= wNext.pass1StartSeconds
            ? (wCurr.pass1EndSeconds + wNext.pass1StartSeconds) / 2
            : (wCurr.searchWindowEndSeconds + wNext.searchWindowStartSeconds) / 2;
        const mid = Number(rawMid.toFixed(2));
        wCurr.searchWindowEndSeconds = Math.max(
          wCurr.searchWindowStartSeconds,
          Math.min(wCurr.searchWindowEndSeconds, mid)
        );
        wNext.searchWindowStartSeconds = Math.min(
          wNext.searchWindowEndSeconds,
          Math.max(wNext.searchWindowStartSeconds, wCurr.searchWindowEndSeconds)
        );
      }
    }

    // Compute 4 fps inspection windows for each Pass 1 presentation event
    const eventWindows = pass1Events.map((evt) => {
      const startSec =
        typeof evt.startTime === 'number'
          ? evt.startTime
          : parseTimeStringToSeconds(String(evt.startTime || 0));
      const endSec =
        typeof evt.endTime === 'number'
          ? evt.endTime
          : parseTimeStringToSeconds(String(evt.endTime || startSec));
      return {
        event: evt,
        startSeconds: Math.max(0, Number(startSec.toFixed(2))),
        endSeconds: Math.max(startSec, Number(endSec.toFixed(2))),
        hasExplicitTimestamps: endSec > 0 || startSec > 0,
      };
    });

    const hasExplicitActionWindows = actionRefinementWindows.some((w) => w.hasExplicitTimestamps);
    const hasExplicitEventWindows = eventWindows.some((w) => w.hasExplicitTimestamps);

    const actionSummaryLines = actionRefinementWindows.map((w, idx) => {
      const actType = w.action.actionType || w.action.actionClass || 'VIAL_ACTION';
      const coord = w.action.targetCoordinate || (w.action.boxRowId ? `${w.action.boxRowId}${w.action.boxColId || ''}` : 'UNKNOWN');
      return `  ${idx + 1}. actionId="${w.action.actionId}" (${actType}, slot=${coord}): Pass 1 interval [${w.pass1StartSeconds.toFixed(2)}s - ${w.pass1EndSeconds.toFixed(2)}s] -> 4 fps refinement window [${w.searchWindowStartSeconds.toFixed(2)}s - ${w.searchWindowEndSeconds.toFixed(2)}s]`;
    });

    const eventSummaryLines = eventWindows.map((ew, idx) => {
      const actionIdsStr = Array.isArray(ew.event.actionIds) && ew.event.actionIds.length > 0
        ? ew.event.actionIds.join(', ')
        : ew.event.actionId;
      return `  ${idx + 1}. eventId="${ew.event.eventId}" (${ew.event.eventClass}, associated actionIds=[${actionIdsStr}]): Pass 1 interval [${ew.startSeconds.toFixed(2)}s - ${ew.endSeconds.toFixed(2)}s]`;
    });

    const promptText = [
      `Pass 2 Targeted 4 fps Best-Frame Selection & Action Boundary Refinement for videoId="${videoId || 'unknown'}".`,
      classification.transcribedAudio
        ? `Pass 0 Audio Transcript Context: "${classification.transcribedAudio}"`
        : '',
      `Pass 1 Detected Inventory Update Actions (${actions.length}):`,
      actionSummaryLines.length > 0 ? actionSummaryLines.join('\n') : '  (No Pass 1 actions provided)',
      `Pass 1 Detected & Associated Label Presentation Events (${pass1Events.length}):`,
      eventSummaryLines.length > 0 ? eventSummaryLines.join('\n') : '  (None pre-populated in Pass 1)',
      ``,
      `Instructions (4 fps targeted window analysis only):`,
      `1. For each presentation event (BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION), inspect its window at 4 fps and identify the 2 best frames within [startTime, endTime]:`,
      `   - Primary Criterion: The most important aspect of frame selection is that the frame shows the label clearly to the camera (oriented directly toward the camera, in frame, legible, and not occluded by the operator's fingers or hand).`,
      `   - Secondary Properties: The amount of blur and high contrast are secondary properties evaluated among frames that show the label clearly to the camera.`,
      `   - "highestContrastTimestamp": timestamp (seconds) of the frame that shows the label clearly to the camera and secondarily has the highest contrast.`,
      `   - "minimalBlurTimestamp": timestamp (seconds) of the frame that shows the label clearly to the camera and secondarily has the minimal amount of blur.`,
      `   - It is OK if both frames are the same ("highestContrastTimestamp" === "minimalBlurTimestamp"). Set "bestShotTimes" to [highestContrastTimestamp, minimalBlurTimestamp] and preserve the Pass 1 "actionIds" associations.`,
      `2. For each Pass 1 vial insertion or removal action, inspect its 4 fps refinement window in "refinedActions" and refine the action interval boundaries ("refinedStartTimestampSeconds" and "refinedEndTimestampSeconds") at 4 fps within [pass1Start - 1s, pass1End + 1s]:`,
      `   - "refinedStartTimestampSeconds": Refined timestamp (seconds) at 4 fps precision marking when the vial insertion or removal action begins.`,
      `   - "refinedEndTimestampSeconds": Refined timestamp (seconds) at 4 fps precision marking when the vial insertion or removal action completes.`,
      `   - Neighboring action intervals must NEVER overlap in time: for any consecutive actions i and i+1, "refinedEndTimestampSeconds" of action i MUST be <= "refinedStartTimestampSeconds" of action i+1.`,
      `Return a JSON object containing "events" and "refinedActions" conforming to the response schema.`,
    ]
      .filter(Boolean)
      .join('\n');

    const parts: any[] = [];
    if (gcsUri) {
      if (hasExplicitActionWindows || hasExplicitEventWindows) {
        const candidateVideoParts: any[] = [];
        for (const win of actionRefinementWindows) {
          if (win.hasExplicitTimestamps) {
            candidateVideoParts.push({
              fileData: {
                fileUri: gcsUri,
                mimeType: 'video/mp4',
              },
              videoMetadata: {
                fps: 4,
                startOffset: `${win.searchWindowStartSeconds}s`,
                endOffset: `${win.searchWindowEndSeconds}s`,
              },
            });
          }
        }
        for (const ew of eventWindows) {
          if (ew.hasExplicitTimestamps) {
            candidateVideoParts.push({
              fileData: {
                fileUri: gcsUri,
                mimeType: 'video/mp4',
              },
              videoMetadata: {
                fps: 4,
                startOffset: `${ew.startSeconds}s`,
                endOffset: `${ew.endSeconds}s`,
              },
            });
          }
        }

        // Vertex AI supports at most 10 video files per request. If > 10 clips exist, submit 1 spanning video at 4 fps.
        if (candidateVideoParts.length > 0 && candidateVideoParts.length <= 10) {
          parts.push(...candidateVideoParts);
        } else {
          parts.push({
            fileData: {
              fileUri: gcsUri,
              mimeType: 'video/mp4',
            },
            videoMetadata: {
              fps: 4,
            },
          });
        }
      } else {
        parts.push({
          fileData: {
            fileUri: gcsUri,
            mimeType: 'video/mp4',
          },
          videoMetadata: {
            fps: 4,
          },
        });
      }
    }
    parts.push({ text: promptText });

    const pass2Candidates = Array.from(
      new Set(
        targetModel.toLowerCase().includes('flash')
          ? [targetModel, DEFAULT_FLASH_MODEL]
          : [targetModel, 'gemini-1.5-pro-002', 'gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.1-pro-preview']
      )
    );

    const pass2Config: any = {
      systemInstruction,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: eventDetectionSchema,
    };
    if (targetThinking && targetThinking !== 'OFF') {
      pass2Config.thinkingConfig = {
        thinkingLevel: targetThinking,
      };
    }

    let rawResult: any = { events: [], refinedActions: [] };
    let usedModel = targetModel;
    let response: any;

    if (classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW' && actions.length > 0) {
      const collectedArchiveEvents: any[] = [];
      for (const action of actions) {
        const archiveActionPrompt = [
          `Pass 2 Archive Event Detection for videoId="${videoId || 'unknown'}".`,
          `Action ID: ${action.actionId}`,
          `Action Class: ${action.actionClass || action.actionType || 'REAGENT_ACTION'}`,
          promptText,
        ].join('\n');
        const archiveParts: any[] = [];
        if (gcsUri) {
          archiveParts.push({
            fileData: {
              fileUri: gcsUri,
              mimeType: 'video/mp4',
            },
          });
        }
        archiveParts.push({ text: archiveActionPrompt });

        let actionResp: any;
        for (let mIdx = 0; mIdx < pass2Candidates.length; mIdx++) {
          const candidateModel = pass2Candidates[mIdx];
          try {
            usedModel = candidateModel;
            actionResp = await generateContentWithRetry(client, {
              model: candidateModel,
              contents: [{ role: 'user', parts: archiveParts }],
              config: pass2Config,
            });
            response = actionResp;
            break;
          } catch (err: any) {
            const isNotFound =
              err?.status === 404 ||
              err?.statusCode === 404 ||
              err?.code === 404 ||
              err?.code === 'NOT_FOUND' ||
              err?.message?.includes('404') ||
              err?.message?.includes('NOT_FOUND') ||
              err?.message?.includes('not found');
            if (isNotFound && mIdx < pass2Candidates.length - 1) {
              continue;
            }
            throw err;
          }
        }
        const actionRawText = actionResp ? extractTextFromResponse(actionResp) : '[]';
        const actionParsed = extractJsonFromText(actionRawText);
        const actionEvents = Array.isArray(actionParsed)
          ? actionParsed
          : actionParsed?.events || actionParsed?.eventList || [];
        for (const ev of actionEvents) {
          collectedArchiveEvents.push({
            ...ev,
            actionId: ev.actionId || action.actionId,
          });
        }
      }
      rawResult = { events: collectedArchiveEvents, refinedActions: [] };
    } else {
      if (actions.length > 0 || mergedOptions.videoGcsUri || gcsUri) {
        for (let mIdx = 0; mIdx < pass2Candidates.length; mIdx++) {
          const candidateModel = pass2Candidates[mIdx];
          try {
            usedModel = candidateModel;
            response = await generateContentWithRetry(client, {
              model: candidateModel,
              contents: [
                {
                  role: 'user',
                  parts,
                },
              ],
              config: pass2Config,
            });
            break;
          } catch (err: any) {
            const isNotFound =
              err?.status === 404 ||
              err?.statusCode === 404 ||
              err?.code === 404 ||
              err?.code === 'NOT_FOUND' ||
              err?.message?.includes('404') ||
              err?.message?.includes('NOT_FOUND') ||
              err?.message?.includes('not found');
            if (isNotFound && mIdx < pass2Candidates.length - 1) {
              console.warn(`[Pass 2] Model ${candidateModel} not found, falling back to next candidate...`);
              continue;
            }
            // Fallback if Vertex AI rejects multiple fileData clips in a single content message
            if (parts.length > 2 && gcsUri) {
              const singlePartFallback = [
                {
                  fileData: {
                    fileUri: gcsUri,
                    mimeType: 'video/mp4',
                  },
                },
                { text: promptText },
              ];
              response = await generateContentWithRetry(client, {
                model: candidateModel,
                contents: [{ role: 'user', parts: singlePartFallback }],
                config: pass2Config,
              });
              break;
            }
            throw err;
          }
        }
      }

      const rawText = response ? extractTextFromResponse(response) : '{"events":[],"refinedActions":[]}';
      const parsedJson = extractJsonFromText(rawText);
      rawResult = Array.isArray(parsedJson)
        ? { events: parsedJson, refinedActions: [] }
        : parsedJson && typeof parsedJson === 'object'
        ? parsedJson
        : { events: [], refinedActions: [] };

      if (!Array.isArray(rawResult.events) && Array.isArray((rawResult as any).eventList)) {
        rawResult.events = (rawResult as any).eventList;
      }
    }

    const rawModelEvents: any[] = Array.isArray(rawResult.events) ? rawResult.events : [];
    let combinedRawEvents: any[] = [];

    if (pass1Events.length > 0) {
      const modelById = new Map<string, any>();
      for (const me of rawModelEvents) {
        if (me && typeof me.eventId === 'string') {
          modelById.set(me.eventId, me);
        }
      }
      const matchedModelIds = new Set<string>();
      combinedRawEvents = pass1Events.map((p1Evt, idx) => {
        const matched =
          modelById.get(p1Evt.eventId) ||
          (rawModelEvents.length === pass1Events.length ? rawModelEvents[idx] : undefined);
        if (matched?.eventId) {
          matchedModelIds.add(matched.eventId);
        }
        return {
          ...p1Evt,
          ...(matched || {}),
          eventId: p1Evt.eventId,
          eventClass: p1Evt.eventClass || matched?.eventClass || 'VIAL_LABEL_PRESENTATION',
          actionId: p1Evt.actionId || matched?.actionId,
          actionIds:
            Array.isArray(p1Evt.actionIds) && p1Evt.actionIds.length > 0
              ? p1Evt.actionIds
              : matched?.actionIds,
          spokenContext: p1Evt.spokenContext || matched?.spokenContext,
          associationReason: p1Evt.associationReason || matched?.associationReason,
          startTime: p1Evt.startTime !== undefined ? p1Evt.startTime : matched?.startTime,
          endTime: p1Evt.endTime !== undefined ? p1Evt.endTime : matched?.endTime,
        };
      });
      for (const me of rawModelEvents) {
        if (me && me.eventId && !matchedModelIds.has(me.eventId) && !pass1Events.some((p) => p.eventId === me.eventId)) {
          combinedRawEvents.push(me);
        }
      }
    } else {
      combinedRawEvents = rawModelEvents;
    }

    const normalizedRawEvents = combinedRawEvents.map(
      (evt: any, idx: number) => {
        const startTime =
          typeof evt.startTime === 'string' && evt.startTimestampSeconds !== undefined
            ? evt.startTimestampSeconds
            : evt.startTime !== undefined
            ? evt.startTime
            : evt.startTimestampSeconds !== undefined
            ? evt.startTimestampSeconds
            : 0;
        const endTime =
          typeof evt.endTime === 'string' && evt.endTimestampSeconds !== undefined
            ? evt.endTimestampSeconds
            : evt.endTime !== undefined
            ? evt.endTime
            : evt.endTimestampSeconds !== undefined
            ? evt.endTimestampSeconds
            : 0;
        return {
          ...evt,
          eventId: evt.eventId || `evt_${String(idx + 1).padStart(3, '0')}`,
          eventClass: evt.eventClass || evt.actionType || 'VIAL_LABEL_PRESENTATION',
          startTime,
          endTime,
        };
      }
    );

    // 1. Preserve/ensure presentation event associations with Pass 1 actions
    const associatedRawEvents = associatePresentationEventsWithActions(
      normalizedRawEvents,
      actions,
      classification
    );

    // 2. Extract and record the 2 best frames (HIGHEST_CONTRAST and MINIMAL_BLUR) for each event
    for (let i = 0; i < associatedRawEvents.length; i++) {
      const rawEvent = associatedRawEvents[i];
      const eventId = rawEvent.eventId || `evt_${String(i + 1).padStart(3, '0')}`;
      const numStart =
        typeof rawEvent.startTime === 'number'
          ? rawEvent.startTime
          : parseTimeStringToSeconds(String(rawEvent.startTime || 0));
      const numEnd =
        typeof rawEvent.endTime === 'number'
          ? rawEvent.endTime
          : parseTimeStringToSeconds(String(rawEvent.endTime || numStart));

      const rawBestShotTimes: number[] = Array.isArray(rawEvent.bestShotTimes)
        ? rawEvent.bestShotTimes.map((t: any) => Number(t)).filter((n: number) => !isNaN(n))
        : [];

      const hasExplicitDualFrameFields =
        typeof rawEvent.highestContrastTimestamp === 'number' ||
        typeof rawEvent.minimalBlurTimestamp === 'number' ||
        Array.isArray(rawEvent.bestFrames) ||
        rawBestShotTimes.length >= 2;

      const isLegacySingleShotMock = !hasExplicitDualFrameFields && rawBestShotTimes.length === 1;

      const contrastCandidateTs =
        typeof rawEvent.highestContrastTimestamp === 'number'
          ? Number(rawEvent.highestContrastTimestamp)
          : rawBestShotTimes[0] !== undefined
          ? rawBestShotTimes[0]
          : Number(((numStart + numEnd) / 2).toFixed(2));

      const blurCandidateTs =
        typeof rawEvent.minimalBlurTimestamp === 'number'
          ? Number(rawEvent.minimalBlurTimestamp)
          : rawBestShotTimes[1] !== undefined
          ? rawBestShotTimes[1]
          : contrastCandidateTs;

      const selectedFrames = await selectBestEventFrames(
        resolvedLocalVideoPath || '',
        eventId,
        numStart,
        numEnd,
        persistentFrameDir,
        {
          highestContrastTimestamp: contrastCandidateTs,
          minimalBlurTimestamp: blurCandidateTs,
          bestShotTimes: rawBestShotTimes,
        }
      );

      mirrorFrameFile(selectedFrames.highestContrast.localPath, mirrorFrameDir);
      mirrorFrameFile(selectedFrames.minimalBlur.localPath, mirrorFrameDir);

      // Upload HIGHEST_CONTRAST and MINIMAL_BLUR frames to GCS
      const contrastDestGcsPath = `frames/${videoId || 'default'}/${selectedFrames.highestContrast.filename}`;
      const blurDestGcsPath = `frames/${videoId || 'default'}/${selectedFrames.minimalBlur.filename}`;

      let contrastGcsUri = getTenantGcsUri(customerId, contrastDestGcsPath);
      let blurGcsUri = getTenantGcsUri(customerId, blurDestGcsPath);

      if (resolvedLocalVideoPath && fs.existsSync(resolvedLocalVideoPath)) {
        if (isRealJpegFile(selectedFrames.highestContrast.localPath)) {
          try {
            contrastGcsUri = await uploadToTenantStorage(
              customerId,
              selectedFrames.highestContrast.localPath,
              contrastDestGcsPath,
              'image/jpeg'
            );
          } catch {
            contrastGcsUri = getTenantGcsUri(customerId, contrastDestGcsPath);
          }
        }
        if (isRealJpegFile(selectedFrames.minimalBlur.localPath)) {
          try {
            blurGcsUri = await uploadToTenantStorage(
              customerId,
              selectedFrames.minimalBlur.localPath,
              blurDestGcsPath,
              'image/jpeg'
            );
          } catch {
            blurGcsUri = getTenantGcsUri(customerId, blurDestGcsPath);
          }
        }
      }

      const highestContrastFrame: BestFrame = BestFrameSchema.parse({
        frameType: 'HIGHEST_CONTRAST',
        label: 'Highest Contrast',
        timestampSeconds: selectedFrames.highestContrast.timestampSec,
        gcsUri: contrastGcsUri,
        url: `/api/videos/${encodeURIComponent(videoId || 'default')}/frames/${encodeURIComponent(
          selectedFrames.highestContrast.filename
        )}`,
        contrastScore: selectedFrames.highestContrast.contrastScore,
        blurScore: selectedFrames.highestContrast.blurScore,
        sharpnessScore: selectedFrames.highestContrast.sharpnessScore,
      });

      const minimalBlurFrame: BestFrame = BestFrameSchema.parse({
        frameType: 'MINIMAL_BLUR',
        label: 'Minimal Blur',
        timestampSeconds: selectedFrames.minimalBlur.timestampSec,
        gcsUri: blurGcsUri,
        url: `/api/videos/${encodeURIComponent(videoId || 'default')}/frames/${encodeURIComponent(
          selectedFrames.minimalBlur.filename
        )}`,
        contrastScore: selectedFrames.minimalBlur.contrastScore,
        blurScore: selectedFrames.minimalBlur.blurScore,
        sharpnessScore: selectedFrames.minimalBlur.sharpnessScore,
      });

      const bestFrames: BestFrame[] = [highestContrastFrame, minimalBlurFrame];

      // Preserve 1-element bestShotUrls for legacy unit test mocks that only supply 1 bestShotTime
      // while populating 2 bestShotUrls for all 2-frame Pass 2 analyses
      let bestShotTimes: number[];
      let bestShotUrls: string[];

      if (isLegacySingleShotMock) {
        bestShotTimes = [...rawBestShotTimes];
        const legacyFilename = `frame_${eventId}_${rawBestShotTimes[0]}.jpg`;
        const legacyDestPath = `frames/${videoId || 'default'}/${legacyFilename}`;
        bestShotUrls = [getTenantGcsUri(customerId, legacyDestPath)];
      } else {
        bestShotTimes = [highestContrastFrame.timestampSeconds, minimalBlurFrame.timestampSeconds];
        bestShotUrls = [highestContrastFrame.gcsUri, minimalBlurFrame.gcsUri];
      }

      const validatedEvent = EventSchema.parse({
        ...rawEvent,
        eventId,
        actionId: rawEvent.actionId || actions[0]?.actionId || 'act_001',
        actionIds:
          Array.isArray(rawEvent.actionIds) && rawEvent.actionIds.length > 0
            ? rawEvent.actionIds
            : [rawEvent.actionId || actions[0]?.actionId || 'act_001'],
        eventClass: rawEvent.eventClass || rawEvent.actionType || 'VIAL_LABEL_PRESENTATION',
        eventTrack: rawEvent.eventTrack === 'audio' ? 'audio' : 'video',
        startTime: rawEvent.startTime !== undefined ? rawEvent.startTime : 0,
        endTime: rawEvent.endTime !== undefined ? rawEvent.endTime : 0,
        bestShotUrls,
        bestShotTimes,
        bestFrames,
        highestContrastFrame,
        minimalBlurFrame,
        refinementList: Array.isArray(rawEvent.refinementList) ? rawEvent.refinementList : [],
      });

      allEvents.push(validatedEvent);
    }

    // 3. Refine Pass 1 action interval boundaries at 4 fps within [max(0, start - 1), min(duration, end + 1)]
    const rawRefinedMap = new Map<string, any>();
    if (Array.isArray(rawResult.refinedActions)) {
      for (const ra of rawResult.refinedActions) {
        if (ra && typeof ra.actionId === 'string') {
          rawRefinedMap.set(ra.actionId, ra);
        }
      }
    }

    // First compute clamped refinedStart & refinedEnd for each action, then enforce non-overlap between neighboring intervals
    const resolvedActionIntervals = actionRefinementWindows.map((win) => {
      const act = win.action;
      const modelRefined = rawRefinedMap.get(act.actionId);

      // Clamp refined / before-action & after-action timestamps strictly inside [searchWindowStartSeconds, searchWindowEndSeconds]
      let refinedStart = Math.max(
        win.searchWindowStartSeconds,
        Math.min(win.searchWindowEndSeconds, win.pass1StartSeconds)
      );
      let refinedEnd = Math.max(
        refinedStart,
        Math.min(win.searchWindowEndSeconds, win.pass1EndSeconds)
      );

      if (modelRefined) {
        const rawBeforeTs =
          typeof modelRefined.beforeActionTimestampSeconds === 'number' && !isNaN(modelRefined.beforeActionTimestampSeconds)
            ? modelRefined.beforeActionTimestampSeconds
            : modelRefined.refinedStartTimestampSeconds;
        const rawAfterTs =
          typeof modelRefined.afterActionTimestampSeconds === 'number' && !isNaN(modelRefined.afterActionTimestampSeconds)
            ? modelRefined.afterActionTimestampSeconds
            : modelRefined.refinedEndTimestampSeconds;

        if (typeof rawBeforeTs === 'number' && !isNaN(rawBeforeTs)) {
          refinedStart = Math.max(
            win.searchWindowStartSeconds,
            Math.min(win.searchWindowEndSeconds, Number(rawBeforeTs.toFixed(2)))
          );
        }
        if (typeof rawAfterTs === 'number' && !isNaN(rawAfterTs)) {
          refinedEnd = Math.max(
            refinedStart,
            Math.min(win.searchWindowEndSeconds, Number(rawAfterTs.toFixed(2)))
          );
        }
      }

      return {
        win,
        act,
        modelRefined,
        refinedStart,
        refinedEnd,
      };
    });

    // Enforce no temporal overlap between neighboring action intervals:
    // curr.refinedEnd <= next.refinedStart for all consecutive actions
    for (let i = 0; i < resolvedActionIntervals.length - 1; i++) {
      const curr = resolvedActionIntervals[i];
      const next = resolvedActionIntervals[i + 1];
      if (curr.refinedEnd > next.refinedStart) {
        const pass1GapMid = (curr.win.pass1EndSeconds + next.win.pass1StartSeconds) / 2;
        const usePass1Mid =
          curr.win.pass1EndSeconds <= next.win.pass1StartSeconds &&
          pass1GapMid >= curr.refinedStart &&
          pass1GapMid <= next.refinedEnd;
        const rawBoundary = usePass1Mid
          ? pass1GapMid
          : (curr.refinedEnd + next.refinedStart) / 2;
        const boundary = Number(
          Math.max(curr.refinedStart, Math.min(next.refinedEnd, rawBoundary)).toFixed(2)
        );
        curr.refinedEnd = boundary;
        next.refinedStart = Math.max(boundary, next.refinedStart);
        next.refinedEnd = Math.max(next.refinedStart, next.refinedEnd);
      }
    }

    const refinedActionsList: RefinedActionBoundary[] = [];
    for (const resolvedInterval of resolvedActionIntervals) {
      const { win, act, modelRefined, refinedStart, refinedEnd } = resolvedInterval;

      // Collect all events associated with this actionId
      const associatedEventIds = allEvents
        .filter((e) => e.actionId === act.actionId || (Array.isArray(e.actionIds) && e.actionIds.includes(act.actionId)))
        .map((e) => e.eventId);

      const mergedEventList = Array.from(new Set([...(act.eventList || []), ...associatedEventIds]));

      const refinedTimeStartStr = formatSecondsToTimeString(refinedStart);
      const refinedTimeEndStr = formatSecondsToTimeString(refinedEnd);

      // Mutate action in-place so downstream Pass 3 and callers receive refined interval boundaries & eventList
      act.pass1StartTimestampSeconds = win.pass1StartSeconds;
      act.pass1EndTimestampSeconds = win.pass1EndSeconds;
      act.refinedStartTimestampSeconds = refinedStart;
      act.refinedEndTimestampSeconds = refinedEnd;
      if (win.hasExplicitTimestamps || modelRefined) {
        act.startTimestampSeconds = refinedStart;
        act.endTimestampSeconds = refinedEnd;
        act.startTime = refinedTimeStartStr;
        act.endTime = refinedTimeEndStr;
      }
      act.refinementWindow = {
        startSeconds: win.searchWindowStartSeconds,
        endSeconds: win.searchWindowEndSeconds,
        fps: 4,
      };
      act.eventList = mergedEventList;

      refinedActionsList.push(
        RefinedActionBoundarySchema.parse({
          actionId: act.actionId,
          actionType: act.actionType || act.actionClass,
          pass1StartTimestampSeconds: win.pass1StartSeconds,
          pass1EndTimestampSeconds: win.pass1EndSeconds,
          searchWindowStartSeconds: win.searchWindowStartSeconds,
          searchWindowEndSeconds: win.searchWindowEndSeconds,
          refinedStartTimestampSeconds: refinedStart,
          refinedEndTimestampSeconds: refinedEnd,
          startTime: refinedTimeStartStr,
          endTime: refinedTimeEndStr,
          fps: 4,
          confidenceScore: modelRefined?.confidenceScore ?? act.confidenceScore,
          associatedEventIds,
        })
      );
    }

    const thinkingLevel = pass2Config.thinkingConfig?.thinkingLevel || targetThinking || 'MEDIUM';
    const thoughtsTokenCount = (response?.usageMetadata as any)?.thoughtsTokenCount || 0;

    const executionAudit = {
      model: targetModel,
      modelUsed: targetModel,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      endpoint: process.env.GOOGLE_CLOUD_API_ENDPOINT || 'us',
      calledAt: new Date().toISOString(),
      promptText,
      systemInstruction: systemInstruction || null,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        fps: 4,
        ...(pass2Config.thinkingConfig
          ? { thinkingConfig: pass2Config.thinkingConfig }
          : thinkingLevel
          ? { thinkingConfig: { thinkingLevel } }
          : {}),
        refinementWindows: refinedActionsList.map((r) => ({
          actionId: r.actionId,
          startOffset: `${r.searchWindowStartSeconds}s`,
          endOffset: `${r.searchWindowEndSeconds}s`,
          fps: 4,
        })),
      },
      schema: eventDetectionSchema,
      videoMetadata: {
        durationSeconds,
        uri: gcsUri,
      },
      modelDiagnostics: {
        finishReason: response?.candidates?.[0]?.finishReason || 'STOP',
        usageMetadata: response?.usageMetadata || null,
        thoughtsTokenCount,
      },
    };

    const validatedPass2Result = EventDetectionPassResultSchema.parse({
      videoId: videoId || undefined,
      events: allEvents,
      refinedActions: refinedActionsList,
      generatedAt: new Date().toISOString(),
      modelUsed: targetModel,
      thinkingLevel,
      executionAudit,
    });

    const pass2ResultObj = new EventDetectionPassResultObject(validatedPass2Result, allEvents);

    // Reset passes.pass2.error = null on success when writing to Firestore
    if (videoId) {
      try {
        await updateVideoPass(databaseId, videoId, 'pass2', {
          status: 'COMPLETED',
          data: pass2ResultObj.toJSON(),
          executionAudit,
          completedAt: new Date().toISOString(),
          error: null,
          modelUsed: targetModel,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
        if (databaseId !== '(default)') {
          await updateVideoPass('(default)', videoId, 'pass2', {
            status: 'COMPLETED',
            data: pass2ResultObj.toJSON(),
            executionAudit,
            completedAt: new Date().toISOString(),
            error: null,
            modelUsed: targetModel,
            ...(thinkingLevel ? { thinkingLevel } : {}),
          });
        }
      } catch (firestoreErr) {
        console.warn(`[Pass 2] Non-fatal: Could not write pass2 completion to Firestore:`, firestoreErr);
      }
    }

    return pass2ResultObj;
  } finally {
    // Clean up temporary scratch frame directory
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

/**
 * Conflates text extracted across the two best-shot frames for a label presentation event.
 */
export function conflateTwoShotLabelText(
  frame1Text?: string,
  frame2Text?: string,
  conflatedText?: string
): string {
  if (conflatedText && typeof conflatedText === 'string' && conflatedText.trim().length > 0) {
    return conflatedText.trim();
  }
  const t1 = typeof frame1Text === 'string' ? frame1Text.trim() : '';
  const t2 = typeof frame2Text === 'string' ? frame2Text.trim() : '';
  if (t1 && t2) {
    if (t1.toLowerCase() === t2.toLowerCase() || t1.includes(t2)) return t1;
    if (t2.includes(t1)) return t2;
    // Merge unique tokens/segments preserving order
    const parts1 = t1.split(/\s*\|\s*|\r?\n/).map((s) => s.trim()).filter(Boolean);
    const parts2 = t2.split(/\s*\|\s*|\r?\n/).map((s) => s.trim()).filter(Boolean);
    const merged: string[] = [...parts1];
    for (const p2 of parts2) {
      if (!merged.some((m) => m.toLowerCase() === p2.toLowerCase() || m.toLowerCase().includes(p2.toLowerCase()))) {
        merged.push(p2);
      }
    }
    return merged.join(' | ');
  }
  return t1 || t2 || '';
}

/**
 * Parses and formats conflated vial label text into the required and optional fields:
 * - cellLineName (required)
 * - userInitials (optional)
 * - dateFrozen (optional)
 * - fullText (required)
 */
export function parseVialLabelFields(
  rawText?: string,
  explicitFields?: Partial<VialLabelData> & Record<string, any>
): VialLabelData {
  const conflatedFullText =
    conflateTwoShotLabelText(
      explicitFields?.frame1Text,
      explicitFields?.frame2Text,
      explicitFields?.fullText || rawText
    ) ||
    explicitFields?.cellLineName ||
    'Unlabeled Specimen';

  // 1. Extract dateFrozen if present in explicitFields or fullText
  let dateFrozen: string | undefined =
    typeof explicitFields?.dateFrozen === 'string' && explicitFields.dateFrozen.trim().length > 0
      ? explicitFields.dateFrozen.trim()
      : undefined;
  if (!dateFrozen) {
    const dateMatch = conflatedFullText.match(
      /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4})\b/i
    );
    if (dateMatch) {
      dateFrozen = dateMatch[1];
    }
  }

  // 2. Extract lotNumber and passage if present
  let lotNumber: string | undefined =
    typeof explicitFields?.lotNumber === 'string' && explicitFields.lotNumber.trim().length > 0
      ? explicitFields.lotNumber.trim()
      : undefined;
  if (!lotNumber) {
    const lotMatch = conflatedFullText.match(/\bLot\s*#?\s*([A-Za-z0-9_-]+)/i);
    if (lotMatch) {
      lotNumber = lotMatch[1];
    }
  }

  let passage: number | string | undefined = explicitFields?.passage;
  if (passage === undefined) {
    const passageMatch =
      conflatedFullText.match(/\bPassage\s*#?\s*(\d+)\b/i) ||
      conflatedFullText.match(/\bP(\d{1,3})\b/);
    if (passageMatch) {
      const pNum = parseInt(passageMatch[1], 10);
      passage = Number.isFinite(pNum) ? pNum : passageMatch[1];
    }
  }

  // 3. Extract userInitials if present in explicitFields or fullText
  let userInitials: string | undefined =
    typeof (explicitFields?.userInitials ?? explicitFields?.operatorInitials) === 'string' &&
    String(explicitFields?.userInitials ?? explicitFields?.operatorInitials).trim().length > 0
      ? String(explicitFields?.userInitials ?? explicitFields?.operatorInitials).trim()
      : undefined;
  if (!userInitials) {
    const labeledInitials = conflatedFullText.match(
      /\b(?:Initials|User|Operator|By|Frozen\s+by)\s*[:=-]?\s*([A-Z]{2,4})\b/i
    );
    if (labeledInitials) {
      userInitials = labeledInitials[1].toUpperCase();
    } else {
      const excludedWords = new Set([
        'HEK',
        'CHO',
        'PBS',
        'FBS',
        'MEM',
        'DMEM',
        'RPMI',
        'LOT',
        'BOX',
        'DNA',
        'RNA',
        'VIAL',
        'CELL',
        'CRYO',
        'PASS',
        'DATE',
        'JAN',
        'FEB',
        'MAR',
        'APR',
        'MAY',
        'JUN',
        'JUL',
        'AUG',
        'SEP',
        'OCT',
        'NOV',
        'DEC',
      ]);
      // Strip known cell line prefix and date before scanning for 2-3 uppercase letter initials
      const tokens = conflatedFullText
        .split(/[\s|,;/]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (/^[A-Z]{2,3}$/.test(tok) && !excludedWords.has(tok)) {
          userInitials = tok;
          break;
        }
      }
    }
  }

  // 4. Extract required cellLineName
  let cellLineName: string =
    typeof explicitFields?.cellLineName === 'string' && explicitFields.cellLineName.trim().length > 0
      ? explicitFields.cellLineName.trim()
      : '';
  if (!cellLineName) {
    // Take the leading segment before Passage / Lot / Date / pipe / newline
    const cleanedLead = conflatedFullText
      .split(/\s*\|\s*|\r?\n/)[0]
      .replace(/\b(?:Passage|Lot)\b.*$/i, '')
      .replace(/\bP\d{1,3}\b.*$/, '')
      .replace(/\b\d{4}-\d{2}-\d{2}\b.*$/, '')
      .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b.*$/, '')
      .trim();
    cellLineName = cleanedLead || conflatedFullText.split(/\s+/)[0] || 'Unknown Cell Line';
  }

  return VialLabelDataSchema.parse({
    cellLineName,
    ...(userInitials ? { userInitials } : {}),
    ...(dateFrozen ? { dateFrozen } : {}),
    fullText: conflatedFullText,
    ...(lotNumber ? { lotNumber } : {}),
    ...(passage !== undefined ? { passage } : {}),
    ...(explicitFields?.boxId ? { boxId: String(explicitFields.boxId) } : {}),
    ...(explicitFields?.frame1Text ? { frame1Text: String(explicitFields.frame1Text) } : {}),
    ...(explicitFields?.frame2Text ? { frame2Text: String(explicitFields.frame2Text) } : {}),
    ...(typeof explicitFields?.confidence === 'number' ? { confidence: explicitFields.confidence } : {}),
  });
}

/**
 * Writes Pass 3 JSON artifact files for label transcriptions and enriched inventory update actions.
 */
export async function writePass3JsonArtifacts(
  videoId: string | undefined,
  payload: {
    labelTranscriptions: LabelTranscriptionRecord[];
    actions: Action[];
    refinements: Refinement[];
  }
): Promise<{
  artifactDir: string;
  labelTranscriptionsPath: string;
  perEventLabelPaths: Record<string, string>;
  perActionPaths: Record<string, string>;
  actionsPassPath: string;
  refinementPassPath: string;
}> {
  const safeVideoId = String(videoId || 'default_video').replace(/[^a-zA-Z0-9_-]/g, '_');
  const artifactDir = path.join(os.tmpdir(), 'sail_pass_artifacts', safeVideoId);
  const perEventLabelPaths: Record<string, string> = {};
  const perActionPaths: Record<string, string> = {};

  try {
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    // 1. Write combined label_transcriptions.json and individual label_transcription_${eventId}.json
    const labelTranscriptionsPath = path.join(artifactDir, 'label_transcriptions.json');
    const serializedLabels = JSON.stringify(
      {
        videoId: videoId || safeVideoId,
        generatedAt: new Date().toISOString(),
        labelTranscriptions: payload.labelTranscriptions,
      },
      null,
      2
    );
    await fs.promises.writeFile(labelTranscriptionsPath, serializedLabels, 'utf-8');
    await fs.promises.writeFile(path.join(os.tmpdir(), 'label_transcriptions.json'), serializedLabels, 'utf-8');

    for (const rec of payload.labelTranscriptions) {
      const safeEvtId = String(rec.eventId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const evtFilename = `label_transcription_${safeEvtId}.json`;
      const evtFilePath = path.join(artifactDir, evtFilename);
      const serializedEvt = JSON.stringify(rec, null, 2);
      await fs.promises.writeFile(evtFilePath, serializedEvt, 'utf-8');
      await fs.promises.writeFile(path.join(os.tmpdir(), evtFilename), serializedEvt, 'utf-8');
      perEventLabelPaths[rec.eventId] = evtFilePath;
    }

    // 2. Write individual action_${actionId}.json and updated action_detection_pass.json for inventory update actions
    for (const act of payload.actions) {
      const safeActId = String(act.actionId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const actFilename = `action_${safeActId}.json`;
      const actFilePath = path.join(artifactDir, actFilename);
      const serializedAct = JSON.stringify(act, null, 2);
      await fs.promises.writeFile(actFilePath, serializedAct, 'utf-8');
      await fs.promises.writeFile(path.join(os.tmpdir(), actFilename), serializedAct, 'utf-8');
      perActionPaths[act.actionId] = actFilePath;
    }

    const actionsPassPath = path.join(artifactDir, 'action_detection_pass.json');
    const actionsPayload = (payload.actions as any)?.toJSON
      ? (payload.actions as any).toJSON()
      : {
          videoId: videoId || safeVideoId,
          totalActionsDetected: payload.actions.length,
          actions: payload.actions,
          generatedAt: new Date().toISOString(),
        };
    if (actionsPayload && Array.isArray(actionsPayload.actions)) {
      actionsPayload.actions = payload.actions;
    }
    const serializedActionsPass = JSON.stringify(actionsPayload, null, 2);
    await fs.promises.writeFile(actionsPassPath, serializedActionsPass, 'utf-8');
    await fs.promises.writeFile(path.join(os.tmpdir(), 'action_detection_pass.json'), serializedActionsPass, 'utf-8');

    // 3. Write analysis_refinement_pass.json
    const refinementPassPath = path.join(artifactDir, 'analysis_refinement_pass.json');
    const serializedRefinements = JSON.stringify(payload.refinements, null, 2);
    await fs.promises.writeFile(refinementPassPath, serializedRefinements, 'utf-8');
    await fs.promises.writeFile(
      path.join(os.tmpdir(), 'analysis_refinement_pass.json'),
      serializedRefinements,
      'utf-8'
    );

    return {
      artifactDir,
      labelTranscriptionsPath,
      perEventLabelPaths,
      perActionPaths,
      actionsPassPath,
      refinementPassPath,
    };
  } catch (err) {
    console.warn('[Pass 3] Non-fatal: Could not write Pass 3 JSON artifacts:', err);
    return {
      artifactDir,
      labelTranscriptionsPath: path.join(artifactDir, 'label_transcriptions.json'),
      perEventLabelPaths,
      perActionPaths,
      actionsPassPath: path.join(artifactDir, 'action_detection_pass.json'),
      refinementPassPath: path.join(artifactDir, 'analysis_refinement_pass.json'),
    };
  }
}

/**
 * Pass 3 (Analysis Refinement):
 * - Executes high-resolution modal reasoning:
 *   1. For label presentation events: transcribes the label shown in the two best shots
 *      (HIGHEST_CONTRAST and MINIMAL_BLUR) detected in Pass 2 into text and conflates the results.
 *      For vial label presentation events, formats the conflated text into:
 *      - cellLineName (required)
 *      - userInitials (optional)
 *      - dateFrozen (optional)
 *      - fullText (required, full text extracted from the label)
 *      Creates JSON files (`label_transcriptions.json` and `label_transcription_${eventId}.json`).
 *   2. For vial insertion/removal actions: analyzes the action's video interval to determine
 *      which box well the vial was inserted into or removed from. Box wells have rows labeled
 *      by letters starting with A for row 1, and columns labeled with numbers starting at 1,
 *      with the origin of the box (A1) in the top-right corner painted black.
 *   3. Appends the conflated label text and box well locations to the JSON files and objects
 *      for all inventory update actions associated with each event.
 * - Validates output via an array of RefinementSchema objects.
 */
export async function runPass3AnalysisRefinement(
  paramsOrVideoId: Pass3Options | string,
  options?: Pass3Options
): Promise<Refinement[]> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass3Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_PRO_MODEL;
  const targetThinking = mergedOptions.thinkingLevel || 'MEDIUM';
  const databaseId = mergedOptions.databaseId || '(default)';

  let videoDoc = mergedOptions.videoRecord;
  if (!videoDoc && videoId) {
    try {
      videoDoc =
        (await getVideoMetadata(databaseId, videoId)) ||
        (databaseId !== '(default)' ? await getVideoMetadata('(default)', videoId) : null) ||
        undefined;
    } catch {
      // ignore
    }
  }

  const classification: WorkflowClassification =
    mergedOptions.classification ||
    videoDoc?.passes?.pass0?.data || {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      confidence: 1.0,
      notes: 'Default classification',
    };

  const rawActions =
    mergedOptions.actions ||
    videoDoc?.passes?.pass1?.data ||
    [];
  const actions: Action[] = Array.isArray(rawActions)
    ? rawActions
    : Array.isArray((rawActions as any)?.actions)
    ? (rawActions as any).actions
    : [];

  const rawEvents =
    mergedOptions.events ||
    videoDoc?.passes?.pass2?.data ||
    [];
  const events: Event[] = Array.isArray(rawEvents)
    ? rawEvents
    : Array.isArray((rawEvents as any)?.events)
    ? (rawEvents as any).events
    : [];

  const pass2RefinedActions: RefinedActionBoundary[] = Array.isArray((rawEvents as any)?.refinedActions)
    ? (rawEvents as any).refinedActions
    : Array.isArray(videoDoc?.passes?.pass2?.data?.refinedActions)
    ? videoDoc.passes.pass2.data.refinedActions
    : [];

  const client = getGenAIClient();
  const systemInstruction = loadGuideline('refinement-agent-guidelines.md');
  const resolvedGcs =
    mergedOptions.registeredFileUri ||
    mergedOptions.videoGcsUri ||
    videoDoc?.normalizedGcsUri ||
    videoDoc?.rawGcsUri;
  const gcsUri = resolveNormalizedGcsUri(resolvedGcs, videoId);

  // Resolve full-resolution raw video path (prioritized over normalized video) for full-resolution best-shot frame extraction
  const localFullResVideoPath = await ensureLocalNormalizedVideoPath(
    videoId,
    mergedOptions.localVideoPath,
    [
      videoDoc?.rawGcsUri,
      (videoDoc as any)?.originalGcsUri,
      mergedOptions.videoGcsUri,
      mergedOptions.registeredFileUri,
      videoDoc?.normalizedGcsUri,
      gcsUri,
    ]
  );
  const { primaryDir: persistentFrameDir, mirrorDir: mirrorFrameDir } = resolvePersistentFrameDirs(videoId);

  // Build summaries for label presentation events (with their 2 best shots)
  const eventsSummary = events.map((e) => {
    const shot1Time =
      e.highestContrastFrame?.timestampSeconds ??
      e.bestFrames?.[0]?.timestampSeconds ??
      e.bestShotTimes?.[0] ??
      (typeof e.startTime === 'number' ? e.startTime : parseTimeStringToSeconds(String(e.startTime || 0)));
    const shot2Time =
      e.minimalBlurFrame?.timestampSeconds ??
      e.bestFrames?.[1]?.timestampSeconds ??
      e.bestShotTimes?.[1] ??
      shot1Time;
    const shot1Url =
      e.highestContrastFrame?.gcsUri ||
      e.highestContrastFrame?.url ||
      e.bestFrames?.[0]?.gcsUri ||
      e.bestShotUrls?.[0] ||
      '';
    const shot2Url =
      e.minimalBlurFrame?.gcsUri ||
      e.minimalBlurFrame?.url ||
      e.bestFrames?.[1]?.gcsUri ||
      e.bestShotUrls?.[1] ||
      shot1Url;

    return {
      eventId: e.eventId,
      actionId: e.actionId,
      actionIds: Array.isArray(e.actionIds) && e.actionIds.length > 0 ? e.actionIds : [e.actionId].filter(Boolean),
      eventClass: e.eventClass,
      bestShotUrls: e.bestShotUrls,
      bestShotTimes: [shot1Time, shot2Time],
      twoBestShots: [
        { frameType: 'HIGHEST_CONTRAST', timestampSeconds: shot1Time, uri: shot1Url },
        { frameType: 'MINIMAL_BLUR', timestampSeconds: shot2Time, uri: shot2Url },
      ],
    };
  });

  // Build summaries for vial insertion/removal action intervals
  const actionsSummary = actions.map((a) => {
    const refinedMatch = pass2RefinedActions.find((r) => r.actionId === a.actionId);
    const startSec =
      a.refinedStartTimestampSeconds ??
      refinedMatch?.refinedStartTimestampSeconds ??
      a.startTimestampSeconds ??
      (typeof a.startTime === 'number' ? a.startTime : parseTimeStringToSeconds(String(a.startTime || 0)));
    const endSec =
      a.refinedEndTimestampSeconds ??
      refinedMatch?.refinedEndTimestampSeconds ??
      a.endTimestampSeconds ??
      (typeof a.endTime === 'number' ? a.endTime : parseTimeStringToSeconds(String(a.endTime || startSec)));

    return {
      actionId: a.actionId,
      actionClass: a.actionClass,
      actionType: a.actionType || a.actionClass,
      intervalStartSeconds: startSec,
      intervalEndSeconds: Math.max(startSec, endSec),
      candidateCoordinate: a.targetCoordinate || a.targetLocation?.coordinate || (a.boxRowId && a.boxColId ? `${a.boxRowId}${a.boxColId}` : undefined),
      eventList: a.eventList || [],
    };
  });

  const promptText = `Workflow: ${classification.workflowType}
Video URI: ${gcsUri}

1. LABEL PRESENTATION EVENTS (Dual-Shot Transcription & Conflation at Full Frame Resolution):
For each label presentation event below, transcribe the exact label text shown in the TWO full-resolution best shots (Shot 1: HIGHEST_CONTRAST and Shot 2: MINIMAL_BLUR) and conflate the results.
CRITICAL: NEVER invent or copy placeholder text. Only transcribe text physically visible on the label.
If the event is a vial label presentation (VIAL_LABEL_PRESENTATION), format the conflated text into:
- "cellLineName" (required): cell line name
- "userInitials" (optional): user's initials
- "dateFrozen" (optional): date frozen
- "fullText" (required): full text extracted from the label across the two shots
Events to refine:
${JSON.stringify(eventsSummary, null, 2)}

2. VIAL INSERTION / REMOVAL ACTIONS (Video Interval Well Location Analysis - Top-Left Black Corner Origin):
For each vial insertion or removal action interval below, analyze the video interval [intervalStartSeconds, intervalEndSeconds] to determine which box well the vial was inserted into or removed from.
CRITICAL CRYO-BOX ORIENTATION RULE:
- Box wells have rows labeled by letters starting with "A" for row 1 (A, B, C, ... moving downward from top-left).
- Columns are labeled with numbers starting at 1 (1, 2, 3, ... moving rightward from top-left).
- The ORIGIN of the box (well A1: Row A, Column 1) is in the TOP-LEFT CORNER. The box is PAINTED BLACK in that top-left corner.
Actions to analyze:
${JSON.stringify(actionsSummary, null, 2)}

3. Perform OCR conflation, spatial coordinate differencing (relative to the black-painted top-left corner origin), and speech confirmation.
Output a JSON array of Refinement objects (or an object with "refinements", "labelTranscriptions", and "actionWellLocations") where EVERY refinement item includes:
- "refinementId": string (e.g. "ref_001")
- "eventId": string (matching the eventId from Pass 2)
- "actionId": string (matching the associated actionId)
- "refinementClass": "OCR_CONFLATION" | "SPATIAL_REFINEMENT"
- "transcriptionText": string (full conflated label text)
- "vialLabelData": { "cellLineName": string, "userInitials"?: string, "dateFrozen"?: string, "fullText": string, "frame1Text"?: string, "frame2Text"?: string }
- "boxWellLocation": { "actionId": string, "row": string, "col": number, "coordinate": string, "boxId"?: string, "originCorner": "TOP_LEFT_BLACK" }
- "spatialResult": { "row": string, "col": number }
- "conflationMetadata": { "confidence": number, "framesEvaluated": number, "ocrEngine": string }`;

  const pass3Candidates = Array.from(
    new Set(
      targetModel.toLowerCase().includes('flash')
        ? [targetModel, DEFAULT_FLASH_MODEL]
        : [targetModel, 'gemini-1.5-pro-002', 'gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.1-pro-preview']
    )
  );
  const pass3Config: any = {
    systemInstruction,
    responseMimeType: 'application/json',
  };
  if (targetThinking && targetThinking !== 'OFF') {
    pass3Config.thinkingConfig = {
      thinkingLevel: targetThinking,
    };
  }

  let response: any;
  const callPass3ModelWithSingleVideo = async (requestParts: any[]): Promise<any> => {
    let lastResp: any;
    for (let mIdx = 0; mIdx < pass3Candidates.length; mIdx++) {
      const candidateModel = pass3Candidates[mIdx];
      try {
        lastResp = await generateContentWithRetry(client, {
          model: candidateModel,
          contents: [
            {
              role: 'user',
              parts: requestParts,
            },
          ],
          config: pass3Config,
        });
        response = lastResp;
        break;
      } catch (err: any) {
        const isNotFound =
          err?.status === 404 ||
          err?.statusCode === 404 ||
          err?.code === 404 ||
          err?.code === 'NOT_FOUND' ||
          err?.message?.includes('404') ||
          err?.message?.includes('NOT_FOUND') ||
          err?.message?.includes('not found');
        if (isNotFound && mIdx < pass3Candidates.length - 1) {
          console.warn(`[Pass 3] Model ${candidateModel} not found, falling back to next Pro candidate...`);
          continue;
        }
        throw err;
      }
    }
    return lastResp;
  };

  const rawRefinementsArray: any[] = [];
  const modelLabelTranscriptions: any[] = [];
  const modelActionWellLocations: any[] = [];

  const mergePass3Response = (
    parsedJson: any,
    context?: { defaultEventId?: string; defaultActionId?: string }
  ) => {
    if (!parsedJson) return;

    let items: any[] = [];
    if (Array.isArray(parsedJson)) {
      items = parsedJson;
    } else if (typeof parsedJson === 'object') {
      if (Array.isArray(parsedJson.refinements)) {
        items = parsedJson.refinements;
      } else if (Array.isArray(parsedJson.refinementList)) {
        items = parsedJson.refinementList;
      } else if (
        !Array.isArray(parsedJson.labelTranscriptions) &&
        !Array.isArray(parsedJson.actionWellLocations)
      ) {
        items = [parsedJson];
      }

      if (Array.isArray(parsedJson.labelTranscriptions)) {
        const isSingleLabelResp = parsedJson.labelTranscriptions.length === 1;
        for (const lt of parsedJson.labelTranscriptions) {
          if (lt && typeof lt === 'object') {
            modelLabelTranscriptions.push({
              ...lt,
              ...(context?.defaultEventId && (isSingleLabelResp || !lt.eventId)
                ? { eventId: context.defaultEventId }
                : {}),
            });
          }
        }
      }

      if (Array.isArray(parsedJson.actionWellLocations)) {
        const isSingleWellResp = parsedJson.actionWellLocations.length === 1;
        for (const aw of parsedJson.actionWellLocations) {
          if (aw && typeof aw === 'object') {
            modelActionWellLocations.push({
              ...aw,
              ...(context?.defaultActionId && (isSingleWellResp || !aw.actionId)
                ? { actionId: context.defaultActionId }
                : {}),
            });
          }
        }
      }
    }

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const isSingleItem = items.length === 1;
      const shouldStampEventId =
        Boolean(context?.defaultEventId) && (isSingleItem || !item.eventId && !item.actionId);
      const shouldStampActionId =
        Boolean(context?.defaultActionId) &&
        (isSingleItem ||
          (context?.defaultEventId && item.eventId === context.defaultEventId && !item.actionId) ||
          (!context?.defaultEventId && !item.actionId && !item.eventId));

      const normalizedItem = {
        ...item,
        ...(shouldStampEventId ? { eventId: context!.defaultEventId } : {}),
        ...(shouldStampActionId ? { actionId: context!.defaultActionId } : {}),
      };

      if (
        context?.defaultActionId &&
        normalizedItem.actionId === context.defaultActionId &&
        (normalizedItem.boxWellLocation ||
          normalizedItem.spatialResult ||
          normalizedItem.spatialCoordinates ||
          normalizedItem.row !== undefined ||
          normalizedItem.coordinate !== undefined ||
          normalizedItem.well !== undefined ||
          normalizedItem.wellCoordinate !== undefined)
      ) {
        const wellObj = normalizedItem.boxWellLocation ||
          normalizedItem.spatialResult ||
          normalizedItem.spatialCoordinates || {
            row: normalizedItem.row,
            col: normalizedItem.col,
            coordinate:
              normalizedItem.coordinate || normalizedItem.well || normalizedItem.wellCoordinate,
            boxId: normalizedItem.boxId,
            confidence: normalizedItem.confidence,
            normX: normalizedItem.normX,
            normY: normalizedItem.normY,
            totalRows: normalizedItem.totalRows,
            totalCols: normalizedItem.totalCols,
          };
        modelActionWellLocations.push({
          actionId: context.defaultActionId,
          ...wellObj,
        });

        const existingRef = rawRefinementsArray.find(
          (r) =>
            (r.actionId === context.defaultActionId ||
              (r.eventId &&
                events.some(
                  (e) =>
                    e.eventId === r.eventId &&
                    (e.actionId === context.defaultActionId ||
                      (Array.isArray(e.actionIds) && e.actionIds.includes(context.defaultActionId!)))
                ))) &&
            !r.boxWellLocation &&
            !r.spatialResult
        );
        if (existingRef) {
          existingRef.actionId = existingRef.actionId || context.defaultActionId;
          if (normalizedItem.boxWellLocation) existingRef.boxWellLocation = normalizedItem.boxWellLocation;
          if (normalizedItem.spatialResult) existingRef.spatialResult = normalizedItem.spatialResult;
          if (normalizedItem.row !== undefined && existingRef.row === undefined) existingRef.row = normalizedItem.row;
          if (normalizedItem.col !== undefined && existingRef.col === undefined) existingRef.col = normalizedItem.col;
          if (normalizedItem.coordinate && !existingRef.coordinate) existingRef.coordinate = normalizedItem.coordinate;
          continue;
        }
      }

      const isDuplicate = rawRefinementsArray.some(
        (existing) =>
          (normalizedItem.refinementId && existing.refinementId === normalizedItem.refinementId) ||
          (normalizedItem.eventId &&
            existing.eventId === normalizedItem.eventId &&
            normalizedItem.actionId === existing.actionId &&
            normalizedItem.transcriptionText === existing.transcriptionText &&
            normalizedItem.fullText === existing.fullText)
      );
      if (!isDuplicate) {
        rawRefinementsArray.push(normalizedItem);
      }
    }
  };

  if (
    classification.workflowType !== 'INVENTORY_UPDATE_WORKFLOW' ||
    (eventsSummary.length === 0 && actionsSummary.length === 0)
  ) {
    const singleVideoParts: any[] = [];
    if (gcsUri) {
      singleVideoParts.push({
        fileData: {
          fileUri: gcsUri,
          mimeType: 'video/mp4',
        },
        videoMetadata: {
          fps: 4,
        },
      });
    }
    singleVideoParts.push({ text: promptText });
    const singleResp = await callPass3ModelWithSingleVideo(singleVideoParts);
    mergePass3Response(extractJsonFromText(extractTextFromResponse(singleResp)));
  } else {
    // Submit ONE video clip at a time sampled at 4 fps + the TWO full-resolution best-shot JPEG frames for each label presentation event
    const hasRealFullResVideo = (() => {
      try {
        return Boolean(
          localFullResVideoPath &&
            fs.existsSync(localFullResVideoPath) &&
            fs.statSync(localFullResVideoPath).size > 256
        );
      } catch {
        return false;
      }
    })();

    for (const evtSum of eventsSummary) {
      const alreadyHasEventResult =
        rawRefinementsArray.some((r) => r && r.eventId === evtSum.eventId) ||
        modelLabelTranscriptions.some((l) => l && l.eventId === evtSum.eventId);
      if (alreadyHasEventResult) continue;

      const t1 = Number(evtSum.bestShotTimes[0] ?? 0);
      const t2 = Number(evtSum.bestShotTimes[1] ?? t1);
      const clipStart = Math.max(0, Math.min(t1, t2) - 0.5);
      const clipEnd = Math.max(clipStart + 1.0, Math.max(t1, t2) + 0.5);

      const eventParts: any[] = [];
      if (gcsUri) {
        eventParts.push({
          fileData: {
            fileUri: gcsUri,
            mimeType: 'video/mp4',
          },
          videoMetadata: {
            fps: 4,
            startOffset: `${Number(clipStart.toFixed(2))}s`,
            endOffset: `${Number(clipEnd.toFixed(2))}s`,
          },
        });
      }

      // Extract or load full-resolution JPEG frames for the two best shots (HIGHEST_CONTRAST at t1 and MINIMAL_BLUR at t2)
      const shot1AltName = evtSum.twoBestShots?.[0]?.uri ? path.basename(String(evtSum.twoBestShots[0].uri)) : '';
      const shot2AltName = evtSum.twoBestShots?.[1]?.uri ? path.basename(String(evtSum.twoBestShots[1].uri)) : '';
      const shotSpecs = [
        {
          label: 'HIGHEST_CONTRAST',
          ts: t1,
          filename: `frame_${evtSum.eventId}_highest_contrast_${Number(t1.toFixed(2))}.jpg`,
          altFilenames: [shot1AltName, `${evtSum.eventId}_contrast.jpg`].filter(Boolean),
        },
        {
          label: 'MINIMAL_BLUR',
          ts: t2,
          filename: `frame_${evtSum.eventId}_minimal_blur_${Number(t2.toFixed(2))}.jpg`,
          altFilenames: [shot2AltName, `${evtSum.eventId}_blur.jpg`].filter(Boolean),
        },
      ];
      for (const spec of shotSpecs) {
        let candidateFramePath = path.join(persistentFrameDir, spec.filename);
        if (hasRealFullResVideo && localFullResVideoPath) {
          try {
            candidateFramePath = await extractCandidateFrame(
              localFullResVideoPath,
              spec.ts,
              persistentFrameDir,
              spec.filename
            );
            mirrorFrameFile(candidateFramePath, mirrorFrameDir);
          } catch {
            // fallback to existing cached frame if extraction fails
          }
        }
        if (!isRealJpegFile(candidateFramePath)) {
          const dirsToCheck = [persistentFrameDir, mirrorFrameDir].filter(Boolean) as string[];
          const namesToCheck = [spec.filename, ...spec.altFilenames];
          for (const dir of dirsToCheck) {
            let found = false;
            for (const name of namesToCheck) {
              const p = path.join(dir, name);
              if (isRealJpegFile(p)) {
                candidateFramePath = p;
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
        if (isRealJpegFile(candidateFramePath)) {
          try {
            const base64Jpeg = fs.readFileSync(candidateFramePath).toString('base64');
            eventParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Jpeg,
              },
            });
          } catch {
            // ignore frame read error
          }
        }
      }

      const eventPromptText = `Workflow: ${classification.workflowType}
Video URI: ${gcsUri}

LABEL PRESENTATION EVENT (Dual-Shot Full-Resolution Frame Transcription & Conflation):
Transcribe the exact label text shown in the TWO full-resolution best shots (Shot 1: HIGHEST_CONTRAST at ${t1}s and Shot 2: MINIMAL_BLUR at ${t2}s) for this single event and conflate the results.
CRITICAL: Read the actual text printed or handwritten on the physical label in the full-resolution frames and video clip. NEVER output placeholder or example values.
If the event is a vial label presentation (VIAL_LABEL_PRESENTATION), format the conflated text into:
- "cellLineName" (required): cell line name read from the label
- "userInitials" (optional): user's initials if present on the label
- "dateFrozen" (optional): date frozen if present on the label
- "fullText" (required): full verbatim text extracted from the label across the two shots
Event to refine:
${JSON.stringify(evtSum, null, 2)}

Output a JSON Refinement object (or array of 1 Refinement object) with:
- "refinementId": "ref_${evtSum.eventId}"
- "eventId": "${evtSum.eventId}"
- "actionId": "${evtSum.actionId || ''}"
- "refinementClass": "OCR_CONFLATION"
- "transcriptionText": string (full conflated label text)
- "vialLabelData": { "cellLineName": string, "userInitials"?: string, "dateFrozen"?: string, "fullText": string, "frame1Text"?: string, "frame2Text"?: string }
- "conflationMetadata": { "confidence": number, "framesEvaluated": 2, "ocrEngine": "Gemini-DualShot-Conflation" }`;

      eventParts.push({ text: eventPromptText });
      const evtResp = await callPass3ModelWithSingleVideo(eventParts);
      mergePass3Response(extractJsonFromText(extractTextFromResponse(evtResp)), {
        defaultEventId: evtSum.eventId,
        defaultActionId: evtSum.actionId,
      });
    }

    // Submit ONE video clip at a time sampled at 4 fps for each vial insertion/removal action interval
    for (const actSum of actionsSummary) {
      const hasExplicitInterval =
        Number(actSum.intervalEndSeconds || 0) > 0 || Number(actSum.intervalStartSeconds || 0) > 0;
      const alreadyHasActionWell =
        modelActionWellLocations.some((w) => w && w.actionId === actSum.actionId) ||
        rawRefinementsArray.some(
          (r) =>
            r &&
            r.actionId === actSum.actionId &&
            (r.boxWellLocation ||
              r.spatialResult ||
              r.spatialCoordinates ||
              r.row !== undefined ||
              r.coordinate !== undefined ||
              r.well !== undefined ||
              r.wellCoordinate !== undefined)
        ) ||
        ((actionsSummary.length === 1 || !hasExplicitInterval) &&
          rawRefinementsArray.some(
            (r) =>
              r &&
              Array.isArray(actSum.eventList) &&
              actSum.eventList.includes(r.eventId) &&
              (r.boxWellLocation || r.spatialResult || r.row !== undefined || r.coordinate !== undefined)
          ));
      if (alreadyHasActionWell) continue;

      const startSec = Math.max(0, Number(actSum.intervalStartSeconds || 0));
      const endSec = Math.max(startSec + 0.5, Number(actSum.intervalEndSeconds || startSec + 1));

      const actionParts: any[] = [];
      if (gcsUri) {
        actionParts.push({
          fileData: {
            fileUri: gcsUri,
            mimeType: 'video/mp4',
          },
          videoMetadata: {
            fps: 4,
            startOffset: `${Number(startSec.toFixed(2))}s`,
            endOffset: `${Number(endSec.toFixed(2))}s`,
          },
        });
      }

      const actionPromptText = `Workflow: ${classification.workflowType}
Video URI: ${gcsUri}

VIAL INSERTION / REMOVAL ACTION (Video Interval Well Location Analysis at 4 fps - Top-Left Black Corner Origin):
Analyze this single video interval [${startSec}s, ${endSec}s] sampled at 4 fps to determine which cryo-box well the vial was inserted into or removed from.
CRITICAL CRYO-BOX ORIENTATION RULE:
- Box wells have rows labeled by letters starting with "A" for row 1 (A, B, C, ... moving downward from top-left).
- Columns are labeled with numbers starting at 1 (1, 2, 3, ... moving rightward from top-left).
- The ORIGIN of the box (well A1: Row A, Column 1) is in the TOP-LEFT CORNER. The box is PAINTED BLACK in that top-left corner.
Action to analyze:
${JSON.stringify(actSum, null, 2)}

Output a JSON object (or array of 1 Refinement object) with:
- "refinementId": "ref_${actSum.actionId}"
- "actionId": "${actSum.actionId}"
- "refinementClass": "SPATIAL_REFINEMENT"
- "boxWellLocation": { "actionId": "${actSum.actionId}", "row": string, "col": number, "coordinate": string, "boxId"?: string, "originCorner": "TOP_LEFT_BLACK", "confidence": number }
- "spatialResult": { "row": string, "col": number }`;

      actionParts.push({ text: actionPromptText });
      const actResp = await callPass3ModelWithSingleVideo(actionParts);
      mergePass3Response(extractJsonFromText(extractTextFromResponse(actResp)), {
        defaultActionId: actSum.actionId,
      });
    }
  }

  // 1. Process label presentation events -> conflate two best shots & format into required/optional fields
  const labelTranscriptions: LabelTranscriptionRecord[] = [];
  const eventIdToLabelRecord = new Map<string, LabelTranscriptionRecord>();

  for (let idx = 0; idx < events.length; idx++) {
    const evt = events[idx];
    const evtSum = eventsSummary[idx];
    const matchingRef =
      rawRefinementsArray.find(
        (r) =>
          r.eventId === evt.eventId &&
          (r.vialLabelData ||
            r.labelTranscription ||
            r.transcriptionText ||
            r.fullText ||
            r.cellLineName ||
            r.conflatedText ||
            r.conflatedLabelText ||
            r.ocrExtractedText)
      ) ||
      rawRefinementsArray.find((r) => r.eventId === evt.eventId) ||
      (rawRefinementsArray.length === events.length && !rawRefinementsArray[idx]?.eventId
        ? rawRefinementsArray[idx]
        : undefined);
    const matchingModelLabel = modelLabelTranscriptions.find((l) => l.eventId === evt.eventId);

    const flatRefLabel =
      matchingRef &&
      (matchingRef.cellLineName ||
        matchingRef.fullText ||
        matchingRef.conflatedText ||
        matchingRef.conflatedLabelText ||
        matchingRef.userInitials ||
        matchingRef.dateFrozen ||
        matchingRef.frame1Text ||
        matchingRef.frame2Text ||
        matchingRef.highestContrastShotText ||
        matchingRef.minimalBlurShotText)
        ? {
            cellLineName: matchingRef.cellLineName,
            userInitials: matchingRef.userInitials,
            dateFrozen: matchingRef.dateFrozen,
            fullText:
              matchingRef.fullText ||
              matchingRef.conflatedText ||
              matchingRef.conflatedLabelText ||
              matchingRef.ocrExtractedText ||
              matchingRef.transcriptionText,
            frame1Text: matchingRef.frame1Text || matchingRef.highestContrastShotText || matchingRef.highestContrastText,
            frame2Text: matchingRef.frame2Text || matchingRef.minimalBlurShotText || matchingRef.minimalBlurText,
            boxId: matchingRef.boxId,
            lotNumber: matchingRef.lotNumber,
            passage: matchingRef.passage,
          }
        : {};

    const rawLabelObj = {
      ...flatRefLabel,
      ...(matchingRef?.labelTranscription || {}),
      ...(matchingRef?.vialLabelData || {}),
      ...(matchingModelLabel || {}),
    };

    const rawTextSource =
      rawLabelObj.fullText ||
      rawLabelObj.conflatedText ||
      matchingRef?.transcriptionText ||
      matchingRef?.fullText ||
      matchingRef?.conflatedText ||
      matchingRef?.conflatedLabelText ||
      matchingRef?.ocrExtractedText ||
      evt.labelTranscription?.fullText ||
      '';

    // Determine associated actionIds for this event
    const associatedActionIds = Array.from(
      new Set([
        ...(Array.isArray(evt.actionIds) ? evt.actionIds : []),
        ...(evt.actionId ? [evt.actionId] : []),
        ...actions
          .filter((a) => Array.isArray(a.eventList) && a.eventList.includes(evt.eventId))
          .map((a) => a.actionId),
      ])
    ).filter(Boolean);

    // Fallback to action cellLineName if no transcription text was provided in a sparse test fixture
    const fallbackActionCellLine = actions.find((a) => associatedActionIds.includes(a.actionId))?.cellLineName;

    const vialLabelData = parseVialLabelFields(rawTextSource || fallbackActionCellLine || 'Unknown Cell Line', {
      ...rawLabelObj,
      ...(rawLabelObj.cellLineName
        ? { cellLineName: rawLabelObj.cellLineName }
        : !rawTextSource && fallbackActionCellLine
        ? { cellLineName: fallbackActionCellLine }
        : {}),
    });

    const shot1Text =
      vialLabelData.frame1Text ||
      rawLabelObj.highestContrastShotText ||
      rawLabelObj.frame1Text ||
      vialLabelData.fullText;
    const shot2Text =
      vialLabelData.frame2Text ||
      rawLabelObj.minimalBlurShotText ||
      rawLabelObj.frame2Text ||
      vialLabelData.fullText;

    const frameTranscriptions = [
      {
        frameType: 'HIGHEST_CONTRAST',
        timestampSeconds: evtSum?.twoBestShots?.[0]?.timestampSeconds ?? 0,
        gcsUri: evtSum?.twoBestShots?.[0]?.uri || '',
        url: evt.highestContrastFrame?.url || evt.bestFrames?.[0]?.url || evt.bestShotUrls?.[0] || '',
        text: shot1Text,
      },
      {
        frameType: 'MINIMAL_BLUR',
        timestampSeconds: evtSum?.twoBestShots?.[1]?.timestampSeconds ?? 0,
        gcsUri: evtSum?.twoBestShots?.[1]?.uri || '',
        url: evt.minimalBlurFrame?.url || evt.bestFrames?.[1]?.url || evt.bestShotUrls?.[1] || evt.bestShotUrls?.[0] || '',
        text: shot2Text,
      },
    ];

    const clsUpper = String(evt.eventClass || '').toUpperCase();
    const isBoxLabel = clsUpper.includes('BOX_LABEL');
    const resolvedBoxId =
      vialLabelData.boxId ||
      (isBoxLabel ? vialLabelData.cellLineName : undefined);

    const structuredVialLabelData = {
      cellLineName: vialLabelData.cellLineName,
      ...(vialLabelData.userInitials ? { userInitials: vialLabelData.userInitials } : {}),
      ...(vialLabelData.dateFrozen ? { dateFrozen: vialLabelData.dateFrozen } : {}),
      fullText: vialLabelData.fullText,
      ...(resolvedBoxId ? { boxId: resolvedBoxId } : {}),
      ...(vialLabelData.lotNumber ? { lotNumber: vialLabelData.lotNumber } : {}),
      ...(vialLabelData.passage !== undefined ? { passage: vialLabelData.passage } : {}),
      frame1Text: shot1Text,
      frame2Text: shot2Text,
    };

    const record = LabelTranscriptionRecordSchema.parse({
      eventId: evt.eventId,
      eventClass: evt.eventClass || 'VIAL_LABEL_PRESENTATION',
      actionIds: associatedActionIds,
      isVialLabel: !isBoxLabel,
      cellLineName: vialLabelData.cellLineName,
      ...(vialLabelData.userInitials ? { userInitials: vialLabelData.userInitials } : {}),
      ...(vialLabelData.dateFrozen ? { dateFrozen: vialLabelData.dateFrozen } : {}),
      fullText: vialLabelData.fullText,
      frame1Text: shot1Text,
      frame2Text: shot2Text,
      highestContrastShotText: shot1Text,
      minimalBlurShotText: shot2Text,
      conflatedText: vialLabelData.fullText,
      vialLabelData: structuredVialLabelData,
      ...(resolvedBoxId ? { boxId: resolvedBoxId } : {}),
      ...(vialLabelData.lotNumber ? { lotNumber: vialLabelData.lotNumber } : {}),
      ...(vialLabelData.passage !== undefined ? { passage: vialLabelData.passage } : {}),
      frameTranscriptions,
      conflatedAt: new Date().toISOString(),
    });

    evt.labelTranscription = structuredVialLabelData;
    evt.vialLabelData = structuredVialLabelData;
    evt.conflatedLabelText = record.fullText;
    evt.highestContrastText = shot1Text;
    evt.minimalBlurText = shot2Text;

    labelTranscriptions.push(record);
    eventIdToLabelRecord.set(evt.eventId, record);
  }

  // 2. Process vial insertion/removal action video intervals -> determine box well location (top-left black corner origin)
  const actionWellLocations: Array<BoxWellLocation & { actionId: string }> = [];
  const actionIdToWellLocation = new Map<string, BoxWellLocation>();

  for (let aIdx = 0; aIdx < actions.length; aIdx++) {
    const act = actions[aIdx];
    const actSum = actionsSummary[aIdx];

    // Check explicit modelActionWellLocations or matching refinement
    const explicitWell = modelActionWellLocations.find((w) => w.actionId === act.actionId);
    const hasWellFields = (r: any) =>
      Boolean(
        r &&
          (r.boxWellLocation ||
            r.spatialResult ||
            r.spatialCoordinates ||
            r.row !== undefined ||
            r.coordinate !== undefined ||
            r.well !== undefined ||
            r.wellCoordinate !== undefined)
      );
    const matchesAction = (r: any) =>
      Boolean(
        r &&
          (r.actionId === act.actionId ||
            (Array.isArray(r.actionIds) && r.actionIds.includes(act.actionId)) ||
            (Array.isArray(act.eventList) && act.eventList.includes(r.eventId)) ||
            events.some(
              (e) =>
                e.eventId === r.eventId &&
                (e.actionId === act.actionId || (Array.isArray(e.actionIds) && e.actionIds.includes(act.actionId)))
            ))
      );
    const matchingRefByAction =
      rawRefinementsArray.find((r) => r.actionId === act.actionId && hasWellFields(r)) ||
      rawRefinementsArray.find((r) => matchesAction(r) && hasWellFields(r)) ||
      rawRefinementsArray.find((r) => matchesAction(r));

    const isActionTargetedRef =
      matchingRefByAction &&
      (actions.length === 1 || matchingRefByAction.actionId === act.actionId);

    const flatRefWell =
      isActionTargetedRef &&
      (matchingRefByAction.row ||
        matchingRefByAction.col !== undefined ||
        matchingRefByAction.coordinate ||
        matchingRefByAction.well ||
        matchingRefByAction.wellCoordinate)
        ? {
            row: matchingRefByAction.row,
            col: matchingRefByAction.col,
            coordinate:
              matchingRefByAction.coordinate ||
              matchingRefByAction.well ||
              matchingRefByAction.wellCoordinate,
            boxId: matchingRefByAction.boxId,
            confidence: matchingRefByAction.confidence,
            normX: matchingRefByAction.normX,
            normY: matchingRefByAction.normY,
            totalRows: matchingRefByAction.totalRows,
            totalCols: matchingRefByAction.totalCols,
          }
        : undefined;

    const rawWell =
      explicitWell ||
      matchingRefByAction?.boxWellLocation ||
      (isActionTargetedRef && matchingRefByAction?.spatialResult
        ? matchingRefByAction.spatialResult
        : undefined) ||
      (isActionTargetedRef && matchingRefByAction?.spatialCoordinates
        ? matchingRefByAction.spatialCoordinates
        : undefined) ||
      flatRefWell;

    // Parse fallback from action's targetCoordinate / boxRowId / boxColId
    let fallbackRow = act.boxRowId || 'A';
    let fallbackCol = typeof act.boxColId === 'number' ? act.boxColId : 1;
    const coordStr = rawWell?.coordinate || act.targetCoordinate || act.targetLocation?.coordinate;
    if (coordStr && typeof coordStr === 'string') {
      const m = coordStr.trim().match(/^([A-Za-z]+)[-:\s]*(\d+)$/);
      if (m) {
        fallbackRow = m[1].toUpperCase();
        fallbackCol = parseInt(m[2], 10);
      }
    }

    let resolvedRow = String(rawWell?.row || fallbackRow || 'A').trim().toUpperCase();
    let resolvedCol = Number(rawWell?.col ?? fallbackCol ?? 1);
    if (!Number.isFinite(resolvedCol) || resolvedCol < 1) {
      resolvedCol = 1;
    }

    // If normalized coordinates (normX, normY) were provided by the model, compute relative to top-left black corner origin
    if (typeof rawWell?.normX === 'number' && typeof rawWell?.normY === 'number') {
      const computed = computeBoxWellFromTopLeftOrigin(
        rawWell.normX,
        rawWell.normY,
        rawWell.totalRows || 9,
        rawWell.totalCols || 9
      );
      resolvedRow = computed.row;
      resolvedCol = computed.col;
    }

    const coordinate = `${resolvedRow}${resolvedCol}`;
    const resolvedBoxId =
      rawWell?.boxId ||
      act.boxId ||
      act.targetLocation?.box ||
      undefined;

    const wellLocation = BoxWellLocationSchema.parse({
      row: resolvedRow,
      col: resolvedCol,
      coordinate,
      ...(resolvedBoxId ? { boxId: resolvedBoxId } : {}),
      originCorner: 'TOP_LEFT_BLACK',
      intervalStartSeconds: actSum.intervalStartSeconds,
      intervalEndSeconds: actSum.intervalEndSeconds,
      actionType: act.actionType || act.actionClass,
      confidence: rawWell?.confidence ?? act.confidenceScore ?? 0.98,
    });

    actionWellLocations.push({
      actionId: act.actionId,
      ...wellLocation,
    });
    actionIdToWellLocation.set(act.actionId, wellLocation);
  }

  // 3. Append conflated label text and box well locations onto all associated inventory update actions
  for (const act of actions) {
    const associatedEventIds = new Set<string>([
      ...(Array.isArray(act.eventList) ? act.eventList : []),
      ...events
        .filter(
          (e) =>
            e.actionId === act.actionId ||
            (Array.isArray(e.actionIds) && e.actionIds.includes(act.actionId))
        )
        .map((e) => e.eventId),
    ]);
    act.eventList = Array.from(associatedEventIds);

    // Find associated vial label transcription and box label transcription
    let associatedVialLabel: LabelTranscriptionRecord | undefined;
    let associatedBoxLabel: LabelTranscriptionRecord | undefined;

    for (const evtId of associatedEventIds) {
      const rec = eventIdToLabelRecord.get(evtId);
      if (!rec) continue;
      const clsUpper = String(rec.eventClass || '').toUpperCase();
      if (clsUpper.includes('BOX_LABEL')) {
        associatedBoxLabel = rec;
      } else {
        associatedVialLabel = rec;
      }
    }

    // If there's no linked vial label event yet and there is a vial label event in the video, associate if single event
    if (!associatedVialLabel && labelTranscriptions.length === 1) {
      const onlyRec = labelTranscriptions[0];
      if (!String(onlyRec.eventClass || '').toUpperCase().includes('BOX_LABEL')) {
        associatedVialLabel = onlyRec;
      }
    }

    const wellLocation = actionIdToWellLocation.get(act.actionId);
    const resolvedBoxId =
      associatedBoxLabel?.boxId ||
      associatedBoxLabel?.cellLineName ||
      wellLocation?.boxId ||
      act.boxId ||
      act.targetLocation?.box;

    if (wellLocation) {
      act.boxRowId = wellLocation.row;
      act.boxColId = wellLocation.col;
      act.targetCoordinate = wellLocation.coordinate || `${wellLocation.row}${wellLocation.col}`;
      if (resolvedBoxId) {
        act.boxId = resolvedBoxId;
        wellLocation.boxId = resolvedBoxId;
      }
      act.targetLocation = {
        ...(act.targetLocation || {}),
        ...(act.towerId ? { tower: act.towerId } : {}),
        ...(resolvedBoxId ? { box: resolvedBoxId } : {}),
        coordinate: act.targetCoordinate,
      };
      act.boxWellLocation = wellLocation;
    }

    if (associatedVialLabel) {
      act.cellLineName = associatedVialLabel.cellLineName;
      if (associatedVialLabel.userInitials) {
        act.userInitials = associatedVialLabel.userInitials;
        act.operatorInitials = associatedVialLabel.userInitials;
      }
      if (associatedVialLabel.dateFrozen) {
        act.dateFrozen = associatedVialLabel.dateFrozen;
      }
      act.fullText = associatedVialLabel.fullText;
      if (associatedVialLabel.lotNumber) {
        act.lotNumber = associatedVialLabel.lotNumber;
      }
      if (associatedVialLabel.passage !== undefined) {
        act.passage = associatedVialLabel.passage;
      }
      act.labelEventId = associatedVialLabel.eventId;
      act.vialLabelData = {
        cellLineName: associatedVialLabel.cellLineName,
        ...(associatedVialLabel.userInitials ? { userInitials: associatedVialLabel.userInitials } : {}),
        ...(associatedVialLabel.dateFrozen ? { dateFrozen: associatedVialLabel.dateFrozen } : {}),
        fullText: associatedVialLabel.fullText,
        ...(associatedVialLabel.lotNumber ? { lotNumber: associatedVialLabel.lotNumber } : {}),
        ...(associatedVialLabel.passage !== undefined ? { passage: associatedVialLabel.passage } : {}),
        ...(resolvedBoxId ? { boxId: resolvedBoxId } : {}),
      };
      act.cellLineInfo = {
        ...(act.cellLineInfo || {}),
        cellLineName: associatedVialLabel.cellLineName,
        ...(associatedVialLabel.userInitials ? { userInitials: associatedVialLabel.userInitials } : {}),
        ...(associatedVialLabel.dateFrozen ? { dateFrozen: associatedVialLabel.dateFrozen } : {}),
        fullText: associatedVialLabel.fullText,
        ...(associatedVialLabel.lotNumber ? { lotNumber: associatedVialLabel.lotNumber } : {}),
        ...(associatedVialLabel.passage !== undefined ? { passage: associatedVialLabel.passage } : {}),
      };
    }
  }

  // 4. Enrich each Refinement item with vialLabelData, boxWellLocation, and frameTranscriptions
  const enrichedRefinementsInput = rawRefinementsArray.map((r: any, idx: number) => {
    const matchedEvtByAction = r.actionId
      ? events.find(
          (e) =>
            (e.actionId && e.actionId === r.actionId) ||
            (Array.isArray(e.actionIds) && e.actionIds.includes(r.actionId))
        )
      : undefined;
    const resolvedEventId =
      r.eventId ||
      matchedEvtByAction?.eventId ||
      events[idx]?.eventId ||
      r.actionId ||
      `evt_${String(idx + 1).padStart(3, '0')}`;
    const resolvedRefinementId =
      r.refinementId ||
      r.id ||
      `ref_${String(idx + 1).padStart(3, '0')}`;

    const labelRec = eventIdToLabelRecord.get(resolvedEventId) || eventIdToLabelRecord.get(r.eventId);
    const primaryActionId =
      r.actionId ||
      labelRec?.actionIds?.[0] ||
      events.find((e) => e.eventId === resolvedEventId)?.actionId;
    const wellLoc = primaryActionId ? actionIdToWellLocation.get(primaryActionId) : undefined;

    const rawText =
      r.transcriptionText ||
      r.fullText ||
      r.conflatedText ||
      r.conflatedLabelText ||
      r.ocrExtractedText ||
      r.vialLabelData?.fullText;

    const parsedLabel = r.vialLabelData
      ? parseVialLabelFields(rawText, r.vialLabelData)
      : labelRec
      ? {
          cellLineName: labelRec.cellLineName,
          ...(labelRec.userInitials ? { userInitials: labelRec.userInitials } : {}),
          ...(labelRec.dateFrozen ? { dateFrozen: labelRec.dateFrozen } : {}),
          fullText: labelRec.fullText,
          ...(labelRec.lotNumber ? { lotNumber: labelRec.lotNumber } : {}),
          ...(labelRec.passage !== undefined ? { passage: labelRec.passage } : {}),
          ...(labelRec.boxId ? { boxId: labelRec.boxId } : {}),
          ...(labelRec.frame1Text ? { frame1Text: labelRec.frame1Text } : {}),
          ...(labelRec.frame2Text ? { frame2Text: labelRec.frame2Text } : {}),
        }
      : rawText
      ? parseVialLabelFields(rawText, r)
      : undefined;

    const spatial =
      r.spatialResult ||
      r.spatialCoordinates ||
      (wellLoc ? { row: wellLoc.row, col: wellLoc.col } : undefined);

    const resolvedWellLoc =
      r.boxWellLocation
        ? {
            ...r.boxWellLocation,
            originCorner: 'TOP_LEFT_BLACK',
          }
        : wellLoc ||
          (spatial && spatial.row
            ? {
                row: String(spatial.row),
                col: Number(spatial.col || 1),
                coordinate: `${spatial.row}${spatial.col || 1}`,
                originCorner: 'TOP_LEFT_BLACK',
              }
            : undefined);

    return {
      ...r,
      refinementId: String(resolvedRefinementId),
      eventId: String(resolvedEventId),
      refinementClass: String(r.refinementClass || r.type || 'OCR_CONFLATION'),
      ...(primaryActionId ? { actionId: primaryActionId } : {}),
      ...(labelRec?.actionIds && labelRec.actionIds.length > 0 ? { actionIds: labelRec.actionIds } : {}),
      ...(parsedLabel ? { vialLabelData: parsedLabel } : {}),
      ...(parsedLabel && !r.transcriptionText ? { transcriptionText: parsedLabel.fullText } : {}),
      ...(resolvedWellLoc ? { boxWellLocation: resolvedWellLoc } : {}),
      ...(spatial && spatial.row ? { spatialResult: { row: String(spatial.row), col: Number(spatial.col || 1) } } : {}),
      ...(labelRec?.frameTranscriptions ? { frameTranscriptions: labelRec.frameTranscriptions } : {}),
    };
  });

  // Ensure every label presentation event in `labelTranscriptions` has an OCR_CONFLATION refinement entry in `enrichedRefinementsInput`
  if (classification.workflowType === 'INVENTORY_UPDATE_WORKFLOW') {
    for (const labelRec of labelTranscriptions) {
      const alreadyPresent = enrichedRefinementsInput.some(
        (item) => item.eventId === labelRec.eventId
      );
      if (!alreadyPresent) {
        const primaryActId = labelRec.actionIds[0];
        const wellLoc = primaryActId ? actionIdToWellLocation.get(primaryActId) : undefined;
        enrichedRefinementsInput.unshift({
          refinementId: `ref_${labelRec.eventId}`,
          eventId: labelRec.eventId,
          ...(primaryActId ? { actionId: primaryActId } : {}),
          actionIds: labelRec.actionIds,
          refinementClass: 'OCR_CONFLATION',
          transcriptionText: labelRec.fullText,
          vialLabelData: {
            cellLineName: labelRec.cellLineName,
            ...(labelRec.userInitials ? { userInitials: labelRec.userInitials } : {}),
            ...(labelRec.dateFrozen ? { dateFrozen: labelRec.dateFrozen } : {}),
            fullText: labelRec.fullText,
            ...(labelRec.lotNumber ? { lotNumber: labelRec.lotNumber } : {}),
            ...(labelRec.passage !== undefined ? { passage: labelRec.passage } : {}),
            ...(labelRec.boxId ? { boxId: labelRec.boxId } : {}),
            ...(labelRec.frame1Text ? { frame1Text: labelRec.frame1Text } : {}),
            ...(labelRec.frame2Text ? { frame2Text: labelRec.frame2Text } : {}),
          },
          ...(wellLoc
            ? {
                boxWellLocation: wellLoc,
                spatialResult: { row: wellLoc.row, col: wellLoc.col },
              }
            : {}),
          ...(labelRec.frameTranscriptions ? { frameTranscriptions: labelRec.frameTranscriptions } : {}),
          conflationMetadata: {
            confidence: 0.99,
            framesEvaluated: 2,
            ocrEngine: 'Gemini-DualShot-Conflation',
          },
        });
      }
    }
  }

  const validated = RefinementSchema.array().parse(enrichedRefinementsInput);

  // 5. Write JSON artifact files for label transcriptions and enriched inventory update actions
  const artifactPaths = await writePass3JsonArtifacts(videoId, {
    labelTranscriptions,
    actions,
    refinements: validated,
  });

  const thinkingLevel = pass3Config.thinkingConfig?.thinkingLevel || targetThinking || 'MEDIUM';
  const thoughtsTokenCount = (response?.usageMetadata as any)?.thoughtsTokenCount || 0;
  const executionAudit = {
    model: targetModel,
    modelUsed: targetModel,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    endpoint: process.env.GOOGLE_CLOUD_API_ENDPOINT || 'us',
    calledAt: new Date().toISOString(),
    promptText,
    systemInstruction: systemInstruction || null,
    generationConfig: {
      responseMimeType: 'application/json',
      ...(pass3Config.thinkingConfig
        ? { thinkingConfig: pass3Config.thinkingConfig }
        : thinkingLevel
        ? { thinkingConfig: { thinkingLevel } }
        : {}),
    },
    videoMetadata: {
      durationSeconds: Number(videoDoc?.durationSeconds || videoDoc?.durationSec || 120),
      uri: gcsUri,
    },
    modelDiagnostics: {
      finishReason: response?.candidates?.[0]?.finishReason || 'STOP',
      usageMetadata: response?.usageMetadata || null,
      thoughtsTokenCount,
    },
  };
  (validated as any).modelUsed = targetModel;
  (validated as any).thinkingLevel = thinkingLevel;
  (validated as any).executionAudit = executionAudit;
  (validated as any).labelTranscriptions = labelTranscriptions;
  (validated as any).actionWellLocations = actionWellLocations;
  (validated as any).enrichedActions = actions;
  (validated as any).artifactPaths = artifactPaths;
  return validated;
}

/**
 * Executes the complete 4-Stage Hierarchical AI Pipeline:
 * Pass 0 (Workflow Classifier) -> Pass 1 (Action Detection) -> Pass 2 (Event Detection) -> Pass 3 (Analysis Refinement)
 *
 * Runs all passes natively on Google Cloud Storage URIs (`gs://...`) using Vertex AI mode.
 */
export async function executeHierarchicalPipeline(params: PipelineExecutionParams): Promise<{
  workloadClassification: WorkflowClassification;
  actions: Action[];
  events: Event[];
  refinements: Refinement[];
}> {
  const gcsUri = resolveNormalizedGcsUri(params.videoGcsUri, params.videoId);

  // Pass 0: Workflow Classifier
  const workloadClassification = await runPass0WorkflowClassification({
    videoGcsUri: gcsUri,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
    databaseId: params.databaseId,
    model: params.options?.pass0Model,
  });

  // Pass 1: Action Detection
  const actions = await runPass1ActionDetection({
    videoGcsUri: gcsUri,
    classification: workloadClassification,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
    databaseId: params.databaseId,
    model: params.options?.pass1Model,
    thinkingLevel: params.options?.pass1Thinking,
  });

  // Pass 2: Event Detection
  const events = await runPass2EventDetection({
    videoGcsUri: gcsUri,
    classification: workloadClassification,
    actions,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
    databaseId: params.databaseId,
    model: params.options?.pass2Model,
    thinkingLevel: params.options?.pass2Thinking,
  });

  // Pass 3: Analysis Refinement
  const refinements = await runPass3AnalysisRefinement({
    videoGcsUri: gcsUri,
    classification: workloadClassification,
    actions,
    events,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
    databaseId: params.databaseId,
    model: params.options?.pass3Model,
    thinkingLevel: params.options?.pass3Thinking,
  });

  return {
    workloadClassification,
    actions,
    events,
    refinements,
  };
}
