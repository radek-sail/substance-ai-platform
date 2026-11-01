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
  EventDetectionSchema,
  timeField,
  RefinementSchema,
  Refinement,
} from '@sail/shared';
import { extractCandidateFrame } from './ffmpeg.service';
import { uploadToTenantStorage, getTenantGcsUri } from './storage.service';
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
  workflowContext?: string;
  actions: ActionInterval[];
  generatedAt: string;
  modelUsed?: string;
  thinkingLevel?: string;
  executionAudit?: any;

  constructor(data: ActionDetectionPassResult, items: Action[]) {
    super(...items);
    this.videoId = data.videoId;
    this.totalActionsDetected = data.totalActionsDetected;
    this.workflowContext = data.workflowContext;
    this.actions = data.actions;
    this.generatedAt = data.generatedAt;
    this.modelUsed = data.modelUsed;
    this.thinkingLevel = data.thinkingLevel;
    this.executionAudit = data.executionAudit;
  }

  toJSON(): ActionDetectionPassResult {
    return {
      videoId: this.videoId,
      totalActionsDetected: this.totalActionsDetected,
      workflowContext: this.workflowContext,
      actions: this.actions,
      generatedAt: this.generatedAt,
      modelUsed: this.modelUsed,
      thinkingLevel: this.thinkingLevel,
      executionAudit: this.executionAudit,
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
    pass3Model?: string;
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
  videoGcsUri?: string;
  classification?: WorkflowClassification;
  actions?: Action[];
  localVideoPath?: string;
  customerId?: string;
  videoId?: string;
  registeredFileUri?: string;
  databaseId?: string;
  videoRecord?: any;
}

export interface Pass3Options {
  model?: string;
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

Return a JSON object conforming to ActionDetectionPassResultSchema.`;

  const parts: any[] = [];
  if (gcsUri) {
    parts.push({
      fileData: {
        fileUri: gcsUri,
        mimeType: 'video/mp4',
      },
    });
  }
  parts.push({ text: promptText });

  const actionDetectionSchema = {
    type: 'OBJECT',
    properties: {
      workflowContext: { type: 'STRING' },
      totalActionsDetected: { type: 'INTEGER' },
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

  const pass1Result = {
    videoId: finalVideoId,
    totalActionsDetected: normalizedIntervals.length,
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
 * Pass 2 (Event Detection) structured Gemini responseSchema:
 * Explicitly defines eventClass, startTime, endTime float seconds, and sub-event metadata.
 */
export const eventDetectionSchema = {
  type: 'OBJECT',
  properties: {
    events: {
      type: 'ARRAY',
      description: 'Chronological list of fine-grained sub-events detected at 4 fps.',
      items: {
        type: 'OBJECT',
        properties: {
          eventId: { type: 'STRING' },
          eventClass: {
            type: 'STRING',
            enum: ['VIAL_INSERTION', 'VIAL_REMOVAL', 'CAP_REMOVAL', 'LABEL_PRESENTATION', 'OTHER'],
            description: 'Explicit sub-event class',
          },
          eventTrack: {
            type: 'STRING',
            enum: ['video', 'audio'],
            description: 'Track modality for the event',
          },
          startTime: {
            type: 'NUMBER',
            description: 'Start time in elapsed seconds as float (e.g. 32.5)',
          },
          endTime: {
            type: 'NUMBER',
            description: 'End time in elapsed seconds as float (e.g. 36.0)',
          },
          bestShotTimes: {
            type: 'ARRAY',
            items: { type: 'NUMBER' },
            description: 'Candidate frame timestamps in elapsed seconds as float',
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
  },
  required: ['events'],
};

/**
 * Pass 2 (Event Detection):
 * - For each detected action, extracts sub-events at 4 fps (label presentations, before/after shots, audio utterances).
 * - Extracts candidate frame timestamps, calls extractCandidateFrame from ffmpeg.service.ts,
 *   and uploads frames to gs://${bucketName}/frames/{videoId}/.
 * - Populates bestShotUrls and validates output via an array of EventSchema objects.
 */
export async function runPass2EventDetection(
  paramsOrVideoId: Pass2Options | string,
  options?: Pass2Options
): Promise<Event[]> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass2Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_PRO_MODEL;
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
      confidence: 1.0,
      notes: 'Default classification',
    };

  const rawActions =
    mergedOptions.actions ||
    videoDoc?.passes?.pass1?.data?.actions ||
    videoDoc?.passes?.pass1?.data ||
    [];
  const actions: Action[] = Array.isArray(rawActions) ? rawActions : [];

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

  const scratchDir = path.join(os.tmpdir(), `sail_frames_${videoId || 'temp'}`);
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  try {
    for (const action of actions) {
      const promptText = `Action ID: ${action.actionId} (${action.actionClass || (action as any).actionType || 'ACTION'}).
Temporal span analysis at 4 fps.
Extract fine-grained sub-events: label presentations, pre-action/post-action state shots, and operator speech utterances.
Ensure every event explicitly includes eventClass (one of: "VIAL_INSERTION", "VIAL_REMOVAL", "CAP_REMOVAL", "LABEL_PRESENTATION", "OTHER").
Timestamps must be numeric elapsed seconds as float: startTime (e.g. 32.5) and endTime (e.g. 36.0).
Return a JSON object containing an "events" array conforming to the response schema.`;

      const parts: any[] = [];
      if (gcsUri) {
        parts.push({
          fileData: {
            fileUri: gcsUri,
            mimeType: 'video/mp4',
          },
        });
      }
      parts.push({ text: promptText });

      const pass2Candidates = Array.from(
        new Set(
          targetModel.toLowerCase().includes('flash')
            ? [targetModel, DEFAULT_FLASH_MODEL]
            : [targetModel, 'gemini-1.5-pro-002', 'gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.1-pro-preview']
        )
      );
      let response: any;
      for (let mIdx = 0; mIdx < pass2Candidates.length; mIdx++) {
        const candidateModel = pass2Candidates[mIdx];
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
              temperature: 0.1,
              responseMimeType: 'application/json',
              responseSchema: eventDetectionSchema,
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
          if (isNotFound && mIdx < pass2Candidates.length - 1) {
            console.warn(`[Pass 2] Model ${candidateModel} not found, falling back to next Pro candidate...`);
            continue;
          }
          throw err;
        }
      }

      const rawText = extractTextFromResponse(response);
      const parsedJson = extractJsonFromText(rawText);
      const rawResult: any = Array.isArray(parsedJson)
        ? { events: parsedJson }
        : parsedJson && typeof parsedJson === 'object'
        ? parsedJson
        : { events: [] };

      if (!Array.isArray(rawResult.events) && Array.isArray((rawResult as any).eventList)) {
        rawResult.events = (rawResult as any).eventList;
      }

      if (Array.isArray(rawResult.events)) {
        rawResult.events = rawResult.events.map((evt: any) => ({
          ...evt,
          eventClass: evt.eventClass || evt.actionType || 'VIAL_INSERTION',
          startTime:
            typeof evt.startTime === 'string' && evt.startTimestampSeconds !== undefined
              ? evt.startTimestampSeconds
              : evt.startTime !== undefined
              ? evt.startTime
              : evt.startTimestampSeconds !== undefined
              ? evt.startTimestampSeconds
              : 0,
          endTime:
            typeof evt.endTime === 'string' && evt.endTimestampSeconds !== undefined
              ? evt.endTimestampSeconds
              : evt.endTime !== undefined
              ? evt.endTime
              : evt.endTimestampSeconds !== undefined
              ? evt.endTimestampSeconds
              : 0,
        }));
      }

      const rawEvents: any[] = Array.isArray(rawResult.events) ? rawResult.events : [];

      for (let i = 0; i < rawEvents.length; i++) {
        const rawEvent = rawEvents[i];
        const bestShotTimes: number[] = Array.isArray(rawEvent.bestShotTimes)
          ? rawEvent.bestShotTimes.map((t: any) => Number(t)).filter((n: number) => !isNaN(n))
          : [];
        const bestShotUrls: string[] = [];

        for (const timestamp of bestShotTimes) {
          const frameFilename = `frame_${rawEvent.eventId || 'evt'}_${timestamp}.jpg`;
          const destinationGcsPath = `frames/${videoId || 'default'}/${frameFilename}`;

          if (mergedOptions.localVideoPath && fs.existsSync(mergedOptions.localVideoPath)) {
            try {
              const frameLocalPath = await extractCandidateFrame(
                mergedOptions.localVideoPath,
                timestamp,
                scratchDir,
                frameFilename
              );
              const uploadedGcsUri = await uploadToTenantStorage(
                customerId,
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
              bestShotUrls.push(getTenantGcsUri(customerId, destinationGcsPath));
            }
          } else {
            // Cloud-native URI mapping
            bestShotUrls.push(getTenantGcsUri(customerId, destinationGcsPath));
          }
        }

        const validatedEvent = EventSchema.parse({
          ...rawEvent,
          eventId: rawEvent.eventId || `evt_${action.actionId}_${i + 1}`,
          actionId: action.actionId,
          eventClass: rawEvent.eventClass || rawEvent.actionType || 'VIAL_INSERTION',
          eventTrack: rawEvent.eventTrack === 'audio' ? 'audio' : 'video',
          startTime: rawEvent.startTime !== undefined ? rawEvent.startTime : 0,
          endTime: rawEvent.endTime !== undefined ? rawEvent.endTime : 0,
          bestShotUrls,
          bestShotTimes,
          refinementList: Array.isArray(rawEvent.refinementList) ? rawEvent.refinementList : [],
        });

        allEvents.push(validatedEvent);
      }
    }

    (allEvents as any).modelUsed = targetModel;

    // Reset passes.pass2.error = null on success when writing to Firestore
    if (videoId) {
      try {
        await updateVideoPass(databaseId, videoId, 'pass2', {
          status: 'COMPLETED',
          data: allEvents,
          completedAt: new Date().toISOString(),
          error: null,
          modelUsed: targetModel,
        });
        if (databaseId !== '(default)') {
          await updateVideoPass('(default)', videoId, 'pass2', {
            status: 'COMPLETED',
            data: allEvents,
            completedAt: new Date().toISOString(),
            error: null,
            modelUsed: targetModel,
          });
        }
      } catch (firestoreErr) {
        console.warn(`[Pass 2] Non-fatal: Could not write pass2 completion to Firestore:`, firestoreErr);
      }
    }

    return allEvents;
  } finally {
    // Clean up temporary scratch frame directory
    if (fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
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
export async function runPass3AnalysisRefinement(
  paramsOrVideoId: Pass3Options | string,
  options?: Pass3Options
): Promise<Refinement[]> {
  const isString = typeof paramsOrVideoId === 'string';
  const videoId = isString ? paramsOrVideoId : paramsOrVideoId.videoId;
  const mergedOptions: Pass3Options = isString ? (options || {}) : { ...paramsOrVideoId, ...options };
  const targetModel = mergedOptions.model || DEFAULT_PRO_MODEL;
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

  const rawEvents =
    mergedOptions.events ||
    videoDoc?.passes?.pass2?.data ||
    [];
  const events: Event[] = Array.isArray(rawEvents) ? rawEvents : [];

  const client = getGenAIClient();
  const systemInstruction = loadGuideline('refinement-agent-guidelines.md');
  const resolvedGcs =
    mergedOptions.registeredFileUri ||
    mergedOptions.videoGcsUri ||
    videoDoc?.normalizedGcsUri ||
    videoDoc?.rawGcsUri;
  const gcsUri = resolveNormalizedGcsUri(resolvedGcs, videoId);

  const eventsSummary = events.map((e) => ({
    eventId: e.eventId,
    actionId: e.actionId,
    eventClass: e.eventClass,
    bestShotUrls: e.bestShotUrls,
  }));

  const promptText = `Workflow: ${classification.workflowType}
Video URI: ${gcsUri}
Events to refine:
${JSON.stringify(eventsSummary, null, 2)}

Perform OCR conflation, spatial coordinate differencing, and speech confirmation.
Output a JSON array of Refinement objects conforming to RefinementSchema.`;

  const parts: any[] = [];
  if (gcsUri) {
    parts.push({
      fileData: {
        fileUri: gcsUri,
        mimeType: 'video/mp4',
      },
    });
  }
  parts.push({ text: promptText });

  const pass3Candidates = Array.from(
    new Set(
      targetModel.toLowerCase().includes('flash')
        ? [targetModel, DEFAULT_FLASH_MODEL]
        : [targetModel, 'gemini-1.5-pro-002', 'gemini-1.5-pro', 'gemini-4-argon', 'gemini-3.1-pro-preview']
    )
  );
  let response: any;
  for (let mIdx = 0; mIdx < pass3Candidates.length; mIdx++) {
    const candidateModel = pass3Candidates[mIdx];
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
      if (isNotFound && mIdx < pass3Candidates.length - 1) {
        console.warn(`[Pass 3] Model ${candidateModel} not found, falling back to next Pro candidate...`);
        continue;
      }
      throw err;
    }
  }

  const rawText = extractTextFromResponse(response);
  const parsedJson = extractJsonFromText(rawText);

  const refinementsArray = Array.isArray(parsedJson)
    ? parsedJson
    : parsedJson.refinements || parsedJson.refinementList || [];

  const validated = RefinementSchema.array().parse(refinementsArray);
  (validated as any).modelUsed = targetModel;
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
  });

  return {
    workloadClassification,
    actions,
    events,
    refinements,
  };
}
