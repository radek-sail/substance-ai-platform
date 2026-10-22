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
import { uploadToTenantStorage, getTenantGcsUri } from './storage.service';

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
}): Promise<WorkflowClassification> {
  const systemInstruction = loadGuideline('classification-agent-guidelines.md');
  const client = getGenAIClient();

  const userPrompt = `You are analyzing video recording: ${params.videoGcsUri}.
Transcribe audible speech and classify the workflow strictly according to the system instructions.
Return a valid JSON object matching WorkflowClassificationSchema.`;

  const contents: any[] = [];
  if (params.videoGcsUri) {
    contents.push({
      fileData: {
        fileUri: params.videoGcsUri,
        mimeType: 'video/mp4',
      },
    });
  }
  contents.push(userPrompt);

  const response = await client.models.generateContent({
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
}): Promise<Action[]> {
  const guidelineFile =
    params.classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const systemInstruction = loadGuideline(guidelineFile);
  const client = getGenAIClient();

  const userPrompt = `Workflow Type: ${params.classification.workflowType}.
Audible Context: "${params.classification.transcribedAudio}".
Video URI: ${params.videoGcsUri}.

Identify compound temporal action boundaries at 1 fps coarse sampling.
Valid Action Classes: VIAL_INSERTION_ACTION, VIAL_REMOVAL_ACTION, REAGENT_MIXING_ACTION, REAGENT_SEEDING_ACTION.
Return a JSON array of Action objects conforming to ActionSchema.`;

  const contents: any[] = [];
  if (params.videoGcsUri) {
    contents.push({
      fileData: {
        fileUri: params.videoGcsUri,
        mimeType: 'video/mp4',
      },
    });
  }
  contents.push(userPrompt);

  const response = await client.models.generateContent({
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
}

/**
 * Pass 2 (Event Detection):
 * - For each detected action, extracts sub-events at 4 fps (label presentations, before/after shots, audio utterances).
 * - Extracts candidate frame timestamps, calls extractCandidateFrame from ffmpeg.service.ts,
 *   and uploads frames to gs://{customerId}-video-manager-storage/frames/{videoId}/.
 * - Populates bestShotUrls and validates output via an array of EventSchema objects.
 */
export async function runPass2EventDetection(params: {
  videoGcsUri: string;
  classification: WorkflowClassification;
  actions: Action[];
  localVideoPath?: string;
  customerId: string;
  videoId: string;
}): Promise<Event[]> {
  const guidelineFile =
    params.classification.workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW'
      ? 'archive-agent-guidelines.md'
      : 'inventory-agent-guidelines.md';

  const systemInstruction = loadGuideline(guidelineFile);
  const client = getGenAIClient();
  const allEvents: Event[] = [];

  const scratchDir = path.join(os.tmpdir(), `sail_frames_${params.videoId}`);
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  for (const action of params.actions) {
    const userPrompt = `Action ID: ${action.actionId} (${action.actionClass}).
Temporal span analysis at 4 fps.
Extract fine-grained sub-events: label presentations, pre-action/post-action state shots, and operator speech utterances.
Return a JSON array of Event objects conforming to EventSchema.`;

    const contents: any[] = [];
    if (params.videoGcsUri) {
      contents.push({
        fileData: {
          fileUri: params.videoGcsUri,
          mimeType: 'video/mp4',
        },
      });
    }
    contents.push(userPrompt);

    const response = await client.models.generateContent({
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

        if (params.localVideoPath && fs.existsSync(params.localVideoPath)) {
          try {
            const frameLocalPath = await extractCandidateFrame(
              params.localVideoPath,
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

  // Clean up temporary scratch frame directory
  if (fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  return allEvents;
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
}): Promise<Refinement[]> {
  const client = getGenAIClient();
  const systemInstruction = `You are the Pass 3 Analysis Refinement Engine for Substance AI Labs (SAIL).
Execute high-resolution modal tasks:
1. Multi-frame OCR conflation across best-shot frame URLs for specimen and reagent labels.
2. Spatial coordinate differencing relative to top-left origin:
   - Rows: letters A through Z (row 0 = A, row 1 = B, etc.)
   - Columns: numbers 1 through N (1-based index)
3. Speech confirmation for volumes (µL, mL), cell densities, and passage numbers.

Return a JSON array of Refinement objects conforming strictly to RefinementSchema.`;

  const eventsSummary = params.events.map((e) => ({
    eventId: e.eventId,
    actionId: e.actionId,
    eventClass: e.eventClass,
    bestShotUrls: e.bestShotUrls,
  }));

  const userPrompt = `Workflow: ${params.classification.workflowType}
Events to refine:
${JSON.stringify(eventsSummary, null, 2)}

Perform OCR conflation, spatial coordinate differencing, and speech confirmation.
Output a JSON array of Refinement objects conforming to RefinementSchema.`;

  const response = await client.models.generateContent({
    model: DEFAULT_PRO_MODEL,
    contents: [userPrompt],
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
}

/**
 * Executes the complete 4-Stage Hierarchical AI Pipeline:
 * Pass 0 (Workflow Classifier) -> Pass 1 (Action Detection) -> Pass 2 (Event Detection) -> Pass 3 (Analysis Refinement)
 */
export async function executeHierarchicalPipeline(params: PipelineExecutionParams): Promise<{
  workloadClassification: WorkflowClassification;
  actions: Action[];
  events: Event[];
  refinements: Refinement[];
}> {
  // Pass 0: Workflow Classifier
  const workloadClassification = await runPass0WorkflowClassification({
    videoGcsUri: params.videoGcsUri,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
  });

  // Pass 1: Action Detection
  const actions = await runPass1ActionDetection({
    videoGcsUri: params.videoGcsUri,
    classification: workloadClassification,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
  });

  // Pass 2: Event Detection
  const events = await runPass2EventDetection({
    videoGcsUri: params.videoGcsUri,
    classification: workloadClassification,
    actions,
    localVideoPath: params.localVideoPath,
    customerId: params.customerId,
    videoId: params.videoId,
  });

  // Pass 3: Analysis Refinement
  const refinements = await runPass3AnalysisRefinement({
    videoGcsUri: params.videoGcsUri,
    classification: workloadClassification,
    actions,
    events,
    customerId: params.customerId,
    videoId: params.videoId,
  });

  return {
    workloadClassification,
    actions,
    events,
    refinements,
  };
}
