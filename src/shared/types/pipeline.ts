import { z } from 'zod';
import {
  ArchiveReagent,
  ArchiveReagentSchema,
  MixReagentsActionDataSchema,
  SeedReagentsActionDataSchema,
  IncubateCellsActionDataSchema,
  IncubatorSettingsDataSchema,
  HemocytometerLoadingActionDataSchema,
  HemocytometerLoadDataSchema,
  ArchiveWorkStepSchema,
  areSameReagent,
  mergeArchiveReagents,
  parseReagentLabelFields,
  parseIncubatorSettingsFields,
  parseHemocytometerLoadingFields,
  isLikelyReagentAcronym,
  type IncubateCellsActionData,
  type IncubatorSettingsData,
  type HemocytometerLoadingActionData,
  type HemocytometerLoadData,
} from './archive';

export {
  IncubateCellsActionDataSchema,
  IncubatorSettingsDataSchema,
  HemocytometerLoadingActionDataSchema,
  HemocytometerLoadDataSchema,
  parseIncubatorSettingsFields,
  parseHemocytometerLoadingFields,
  type IncubateCellsActionData,
  type IncubatorSettingsData,
  type HemocytometerLoadingActionData,
  type HemocytometerLoadData,
};

export const ExecutionAuditSchema = z
  .object({
    model: z.string().optional(),
    modelUsed: z.string().optional(),
    thinkingLevel: z.string().optional(),
    endpoint: z.string().optional(),
    calledAt: z.string().optional(),
    promptText: z.string().optional(),
    systemInstruction: z.string().nullable().optional(),
    generationConfig: z.record(z.any()).optional(),
    schema: z.record(z.any()).nullable().optional(),
    videoMetadata: z
      .object({
        durationSeconds: z.number().optional(),
        uri: z.string().optional(),
      })
      .optional(),
    modelDiagnostics: z
      .object({
        finishReason: z.string().optional(),
        usageMetadata: z.record(z.any()).nullable().optional(),
        thoughtsTokenCount: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ExecutionAudit = z.infer<typeof ExecutionAuditSchema>;

export const IdentificationEventClassSchema = z.preprocess(
  (val) => {
    if (typeof val === 'string') {
      const upper = val.trim().toUpperCase();
      if (upper === 'ARCHIVE_IDENTIFICATION_EVENT') return 'ARCHIVE_IDENTIFICATION';
      if (upper === 'INVENTORY_IDENTIFICATION_EVENT') return 'INVENTORY_IDENTIFICATION';
      return upper;
    }
    return val;
  },
  z.enum([
    'INVENTORY_IDENTIFICATION',
    'ARCHIVE_IDENTIFICATION',
    'INVENTORY_IDENTIFICATION_EVENT',
    'ARCHIVE_IDENTIFICATION_EVENT',
  ])
);

export const IdentificationEventSchema = z.object({
  eventId: z.string().default('evt_id_001'),
  eventClass: IdentificationEventClassSchema,
  eventTrack: z.enum(['video', 'audio']).default('audio'),
  startTime: z.union([z.number(), z.string()]).default(0),
  endTime: z.union([z.number(), z.string()]).default(0),
  startTimestampSeconds: z.number().optional(),
  endTimestampSeconds: z.number().optional(),
  description: z.string().optional(),
  spokenContext: z.string().optional(),
  purpose: z.string().nullable().optional(),
});
export type IdentificationEvent = z.infer<typeof IdentificationEventSchema>;

export const WorkflowClassificationSchema = z.object({
  workflowType: z.enum([
    'INVENTORY_UPDATE_WORKFLOW',
    'EXPERIMENT_NOTEBOOK_WORKFLOW',
    'UNCLASSIFIED_WORKFLOW',
  ]),
  inventoryName: z.string().nullable().optional(),
  archiveName: z.string().nullable().optional(),
  creatorName: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  archivePurpose: z.string().nullable().optional(),
  archiveIntent: z.enum(['CREATE', 'APPEND']).nullable().optional(),
  isAppending: z.boolean().nullable().optional(),
  identificationEvent: IdentificationEventSchema.nullable().optional(),
  events: z.array(IdentificationEventSchema).optional(),
  transcribedAudio: z.string(),
  modelUsed: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type WorkflowClassification = z.infer<typeof WorkflowClassificationSchema>;

export const ActionRefinementWindowSchema = z.object({
  startSeconds: z.number(),
  endSeconds: z.number(),
  fps: z.number().default(4),
});
export type ActionRefinementWindow = z.infer<typeof ActionRefinementWindowSchema>;

export const BestFrameTypeSchema = z.enum([
  'HIGHEST_CONTRAST',
  'MINIMAL_BLUR',
  'BEFORE_ACTION',
  'AFTER_ACTION',
  'FIRST_FRAME',
  'LAST_FRAME',
]);
export type BestFrameType = z.infer<typeof BestFrameTypeSchema>;

export const BestFrameSchema = z.object({
  frameType: BestFrameTypeSchema,
  label: z.string().optional(),
  timestampSeconds: z.number(),
  timestamp: z.number().optional(),
  gcsUri: z.string(),
  url: z.string().optional(),
  contrastScore: z.number().optional(),
  blurScore: z.number().optional(),
  sharpnessScore: z.number().optional(),
});
export type BestFrame = z.infer<typeof BestFrameSchema>;

export const VialLabelDataSchema = z.object({
  cellLineName: z.string().default(''),
  userInitials: z.string().optional(),
  dateFrozen: z.string().optional(),
  fullText: z.string().default(''),
  lotNumber: z.string().optional(),
  passage: z.union([z.number(), z.string()]).optional(),
  boxId: z.string().optional(),
  frame1Text: z.string().optional(),
  frame2Text: z.string().optional(),
  confidence: z.number().optional(),
});
export type VialLabelData = z.infer<typeof VialLabelDataSchema>;

export const LabelTranscriptionRecordSchema = z.object({
  eventId: z.string(),
  eventClass: z.string().default('VIAL_LABEL_PRESENTATION_EVENT'),
  eventType: z.string().optional(),
  actionIds: z.array(z.string()).default([]),
  isVialLabel: z.boolean().optional(),
  isReagentLabel: z.boolean().optional(),
  cellLineName: z.string().default(''),
  userInitials: z.string().optional(),
  dateFrozen: z.string().optional(),
  fullText: z.string().default(''),
  frame1Text: z.string().optional(),
  frame2Text: z.string().optional(),
  highestContrastShotText: z.string().optional(),
  minimalBlurShotText: z.string().optional(),
  conflatedText: z.string().optional(),
  vialLabelData: VialLabelDataSchema.optional(),
  reagentData: ArchiveReagentSchema.optional(),
  incubatorSettings: IncubateCellsActionDataSchema.optional(),
  hemocytometerLoadingData: HemocytometerLoadingActionDataSchema.optional(),
  hemocytometerLoad: HemocytometerLoadDataSchema.optional(),
  substanceLoaded: z.string().optional(),
  temperature: z.string().optional(),
  co2Level: z.string().optional(),
  reagentName: z.string().optional(),
  reagentAcronym: z.string().optional(),
  manufacturer: z.string().optional(),
  catalogNumber: z.string().optional(),
  confidence: z.number().optional(),
  boxId: z.string().optional(),
  lotNumber: z.string().optional(),
  passage: z.union([z.number(), z.string()]).optional(),
  frameTranscriptions: z
    .array(
      z.object({
        frameType: z.string().optional(),
        timestampSeconds: z.number().optional(),
        url: z.string().optional(),
        gcsUri: z.string().optional(),
        text: z.string(),
      })
    )
    .optional(),
  conflatedAt: z.string().optional(),
});
export type LabelTranscriptionRecord = z.infer<typeof LabelTranscriptionRecordSchema>;

export const BoxWellLocationSchema = z.object({
  actionId: z.string().optional(),
  row: z.string().default('A'),
  col: z.coerce.number().default(1),
  coordinate: z.string().optional(),
  boxId: z.string().optional(),
  originCorner: z.string().optional().default('TOP_LEFT_BLACK'),
  intervalStartSeconds: z.coerce.number().optional(),
  intervalEndSeconds: z.coerce.number().optional(),
  actionType: z.string().optional(),
  confidence: z.coerce.number().optional(),
});
export type BoxWellLocation = z.infer<typeof BoxWellLocationSchema>;

export const ActionIntervalSchema = z.object({
  actionId: z.string(),
  actionType: z.string(), // "VIAL_INSERTION" | "VIAL_REMOVAL" | "CAP_REMOVAL" | "BOX_MANIPULATION" | string
  description: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  startTimestampSeconds: z.number(),
  endTimestampSeconds: z.number(),
  pass1StartTimestampSeconds: z.number().optional(),
  pass1EndTimestampSeconds: z.number().optional(),
  refinedStartTimestampSeconds: z.number().optional(),
  refinedEndTimestampSeconds: z.number().optional(),
  beforeActionTimestampSeconds: z.number().optional(),
  afterActionTimestampSeconds: z.number().optional(),
  refinementWindow: ActionRefinementWindowSchema.optional(),
  beforeActionFrame: BestFrameSchema.optional(),
  afterActionFrame: BestFrameSchema.optional(),
  beforeActionFrameUrl: z.string().optional(),
  afterActionFrameUrl: z.string().optional(),
  beforeActionFrameGcsUri: z.string().optional(),
  afterActionFrameGcsUri: z.string().optional(),
  firstFrame: BestFrameSchema.optional(),
  lastFrame: BestFrameSchema.optional(),
  firstFrameUrl: z.string().optional(),
  lastFrameUrl: z.string().optional(),
  firstFrameGcsUri: z.string().optional(),
  lastFrameGcsUri: z.string().optional(),
  confidenceScore: z.number(),
  targetLocation: z
    .object({
      tower: z.string().optional(),
      box: z.string().optional(),
      coordinate: z.string().optional(),
    })
    .optional(),
  targetCoordinate: z.string().optional(),
  actionClass: z.string().optional(),
  inventoryId: z.string().optional(),
  archiveId: z.string().optional(),
  cellLineName: z.string().optional(),
  cellLineInfo: z.record(z.any()).optional(),
  towerId: z.string().optional(),
  boxId: z.string().optional(),
  boxRowId: z.string().optional(),
  boxColId: z.number().optional(),
  userInitials: z.string().optional(),
  operatorInitials: z.string().optional(),
  dateFrozen: z.string().optional(),
  fullText: z.string().optional(),
  lotNumber: z.string().optional(),
  passage: z.union([z.number(), z.string()]).optional(),
  vialLabelData: VialLabelDataSchema.optional(),
  boxWellLocation: BoxWellLocationSchema.optional(),
  mixReagentsData: MixReagentsActionDataSchema.optional(),
  seedReagentsData: SeedReagentsActionDataSchema.optional(),
  incubateCellsData: IncubateCellsActionDataSchema.optional(),
  incubatorSettings: IncubateCellsActionDataSchema.optional(),
  hemocytometerLoadingData: HemocytometerLoadingActionDataSchema.optional(),
  hemocytometerLoad: HemocytometerLoadDataSchema.optional(),
  substanceLoaded: z.string().optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  labelEventId: z.string().optional(),
  eventList: z.array(z.string()).optional(),
});
export type ActionInterval = z.infer<typeof ActionIntervalSchema>;

export const ActionDetectionPassResultSchema = z.object({
  videoId: z.string(),
  totalActionsDetected: z.number(),
  totalEventsDetected: z.number().optional(),
  workflowContext: z.string().optional(),
  actions: z.array(ActionIntervalSchema),
  events: z.lazy(() => z.array(EventSchema)).optional(),
  generatedAt: z.string(),
  modelUsed: z.string().optional(),
  thinkingLevel: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type ActionDetectionPassResult = z.infer<typeof ActionDetectionPassResultSchema>;

const ACTION_CLASS_ALIAS_MAP: Record<string, string> = {
  MIX_REAGENTS: 'REAGENT_MIXING_ACTION',
  REAGENT_MIXING: 'REAGENT_MIXING_ACTION',
  MIXING_REAGENTS: 'REAGENT_MIXING_ACTION',
  SEED_REAGENTS: 'REAGENT_SEEDING_ACTION',
  REAGENT_SEEDING: 'REAGENT_SEEDING_ACTION',
  SEEDING_REAGENTS: 'REAGENT_SEEDING_ACTION',
  INCUBATING_CELLS: 'INCUBATE_CELLS',
  CELL_INCUBATION: 'INCUBATE_CELLS',
  INCUBATION_ACTION: 'INCUBATE_CELLS_ACTION',
  ASPIRATING_MEDIA: 'ASPIRATE_MEDIA',
  ASPRIRATING_MEDIA: 'ASPRIRATE_MEDIA',
  MEDIA_ASPIRATION: 'ASPIRATE_MEDIA',
  HEMOCYTOMETER_LOADING: 'HEMOCYTOMETER_LOADING',
  HEMOCYTOMETER_LOADING_ACTION: 'HEMOCYTOMETER_LOADING',
  LOADING_HEMOCYTOMETER: 'HEMOCYTOMETER_LOADING',
  LOAD_HEMOCYTOMETER: 'HEMOCYTOMETER_LOADING',
  VIAL_INSERTION: 'VIAL_INSERTION_ACTION',
  VIAL_REMOVAL: 'VIAL_REMOVAL_ACTION',
};

export const ActionClassSchema = z.preprocess(
  (val) => {
    if (typeof val === 'string') {
      const upper = val.trim().toUpperCase();
      return ACTION_CLASS_ALIAS_MAP[upper] || upper;
    }
    return val;
  },
  z.enum([
    'VIAL_INSERTION_ACTION',
    'VIAL_REMOVAL_ACTION',
    'REAGENT_MIXING_ACTION',
    'REAGENT_SEEDING_ACTION',
    'INCUBATE_CELLS',
    'INCUBATE_CELLS_ACTION',
    'ASPIRATE_MEDIA',
    'ASPRIRATE_MEDIA',
    'ASPIRATE_MEDIA_ACTION',
    'ASPRIRATE_MEDIA_ACTION',
    'HEMOCYTOMETER_LOADING',
    'HEMOCYTOMETER_LOADING_ACTION',
    'hemocytometer_loading',
  ])
);

export const ActionSchema = z.object({
  actionId: z.string(),
  actionClass: ActionClassSchema,
  actionType: z.string().optional(),
  description: z.string().optional(),
  startTime: z.union([z.number(), z.string()]).optional(),
  endTime: z.union([z.number(), z.string()]).optional(),
  originalStartTime: z.number().optional(),
  originalEndTime: z.number().optional(),
  refinedFps: z.number().optional(),
  startTimestampSeconds: z.number().optional(),
  endTimestampSeconds: z.number().optional(),
  pass1StartTimestampSeconds: z.number().optional(),
  pass1EndTimestampSeconds: z.number().optional(),
  refinedStartTimestampSeconds: z.number().optional(),
  refinedEndTimestampSeconds: z.number().optional(),
  refinementWindow: ActionRefinementWindowSchema.optional(),
  confidenceScore: z.number().optional(),
  targetLocation: z
    .object({
      tower: z.string().optional(),
      box: z.string().optional(),
      coordinate: z.string().optional(),
    })
    .optional(),
  targetCoordinate: z.string().optional(),
  inventoryId: z.string().optional(),
  archiveId: z.string().optional(),
  cellLineName: z.string().optional(),
  cellLineInfo: z.record(z.any()).optional(),
  towerId: z.string().optional(),
  boxId: z.string().optional(),
  boxRowId: z.string().optional(),
  boxColId: z.number().optional(),
  targetRow: z.string().optional(),
  targetCol: z.number().optional(),
  userInitials: z.string().optional(),
  operatorInitials: z.string().optional(),
  dateFrozen: z.string().optional(),
  fullText: z.string().optional(),
  conflatedLabelText: z.string().optional(),
  lotNumber: z.string().optional(),
  passage: z.union([z.number(), z.string()]).optional(),
  vialLabelData: VialLabelDataSchema.optional(),
  boxWellLocation: BoxWellLocationSchema.optional(),
  mixReagentsData: MixReagentsActionDataSchema.optional(),
  seedReagentsData: SeedReagentsActionDataSchema.optional(),
  incubateCellsData: IncubateCellsActionDataSchema.optional(),
  incubatorSettings: IncubateCellsActionDataSchema.optional(),
  hemocytometerLoadingData: HemocytometerLoadingActionDataSchema.optional(),
  hemocytometerLoad: HemocytometerLoadDataSchema.optional(),
  substanceLoaded: z.string().optional(),
  seededColumns: z.array(z.number().int().min(1).max(12)).optional(),
  seededWells: z.array(z.string()).optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  labelEventId: z.string().optional(),
  eventList: z.array(z.string()),
});
export type Action = z.infer<typeof ActionSchema>;

export const timeField = z.union([
  z.number(),
  z.string().transform((val) => {
    if (val.includes(':')) {
      const parts = val.split(':').map(Number);
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    const num = Number(val);
    return isNaN(num) ? 0 : num;
  }),
]);

export const EventSchema = z.object({
  eventId: z.string(),
  actionId: z.string().default(''),
  actionIds: z.array(z.string()).optional(),
  eventClass: z.string().optional().default('VIAL_INSERTION'),
  eventTrack: z.enum(['video', 'audio']).default('video'),
  startTime: timeField,
  endTime: timeField,
  description: z.string().optional(),
  spokenContext: z.string().optional(),
  associationReason: z.string().optional(),
  bestShotUrls: z.array(z.string()).default([]),
  bestShotTimes: z.array(z.number()).default([]),
  bestFrames: z.array(BestFrameSchema).optional(),
  highestContrastFrame: BestFrameSchema.optional(),
  minimalBlurFrame: BestFrameSchema.optional(),
  highestContrastText: z.string().optional(),
  minimalBlurText: z.string().optional(),
  conflatedLabelText: z.string().optional(),
  vialLabelData: VialLabelDataSchema.optional(),
  labelTranscription: VialLabelDataSchema.optional(),
  reagentName: z.string().optional(),
  reagentAcronym: z.string().optional(),
  manufacturer: z.string().optional(),
  catalogNumber: z.string().optional(),
  lotNumber: z.string().optional(),
  mixingAmount: z.string().optional(),
  plateType: z.string().optional(),
  pipetteType: z.string().optional(),
  cellsSeeded: z.string().optional(),
  cellsPerWell: z.string().optional(),
  seedingEventsCount: z.number().optional(),
  expectedSeedingEventsCount: z.number().optional(),
  isSeedingCountCorrect: z.boolean().optional(),
  seededColumn: z.number().int().min(1).max(12).optional(),
  seededColumns: z.array(z.number().int().min(1).max(12)).optional(),
  seededWells: z.array(z.string()).optional(),
  temperature: z.string().optional(),
  co2Level: z.string().optional(),
  incubatorSettings: IncubateCellsActionDataSchema.optional(),
  incubateCellsData: IncubateCellsActionDataSchema.optional(),
  hemocytometerLoadingData: HemocytometerLoadingActionDataSchema.optional(),
  hemocytometerLoad: HemocytometerLoadDataSchema.optional(),
  substanceLoaded: z.string().optional(),
  purpose: z.string().nullable().optional(),
  reagentData: ArchiveReagentSchema.optional(),
  mixReagentsData: MixReagentsActionDataSchema.optional(),
  seedReagentsData: SeedReagentsActionDataSchema.optional(),
  refinementList: z.array(z.string()).default([]),
  visibilityScore: z.number().optional(),
  labelVisibilityScore: z.number().optional(),
  isOccluded: z.boolean().optional(),
  occlusionScore: z.number().optional(),
  cameraCloseness: z.enum(['CLOSE', 'MEDIUM', 'FAR']).optional(),
  closenessScore: z.number().optional(),
});
export type Event = z.infer<typeof EventSchema>;

/**
 * Computes a visibility and camera-closeness quality score for a presentation event.
 * Higher score indicates better label visibility: closer to camera, unoccluded by foreground objects,
 * sharp focus, high contrast, minimal blur, and complete label attributes.
 */
export function computeLabelVisibilityScore(event: Partial<Event>): number {
  let score = 50;

  // 1. Explicit boolean or numeric flags
  if (event.isOccluded === true || (event as any).occluded === true) {
    score -= 100;
  } else if (event.isOccluded === false || (event as any).occluded === false) {
    score += 25;
  }

  if (typeof event.occlusionScore === 'number' && Number.isFinite(event.occlusionScore)) {
    score -= (event.occlusionScore > 1 ? event.occlusionScore / 100 : event.occlusionScore) * 80;
  }

  if (typeof event.visibilityScore === 'number' && Number.isFinite(event.visibilityScore)) {
    score += (event.visibilityScore > 1 ? event.visibilityScore / 100 : event.visibilityScore) * 50;
  }

  if (typeof event.labelVisibilityScore === 'number' && Number.isFinite(event.labelVisibilityScore)) {
    score += (event.labelVisibilityScore > 1 ? event.labelVisibilityScore / 100 : event.labelVisibilityScore) * 50;
  }

  if (event.cameraCloseness === 'CLOSE') {
    score += 50;
  } else if (event.cameraCloseness === 'MEDIUM') {
    score += 15;
  } else if (event.cameraCloseness === 'FAR') {
    score -= 40;
  }

  if (typeof event.closenessScore === 'number' && Number.isFinite(event.closenessScore)) {
    score += (event.closenessScore > 1 ? event.closenessScore / 100 : event.closenessScore) * 50;
  }

  // 2. Textual cues across description, associationReason, spokenContext
  const combinedText = [
    event.description,
    event.associationReason,
    event.spokenContext,
    (event as any).rawLabelText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (combinedText) {
    // Closeness cues
    if (
      /\b(closest\s+to(\s+the)?\s+camera|close(r)?\s+to(\s+the)?\s+camera|held\s+close|close-up|near(\s+the)?\s+camera|large\s+in\s+frame|front\s+and\s+center|filling\s+the\s+frame)\b/i.test(
        combinedText
      )
    ) {
      score += 50;
    }
    if (
      /\b(far\s+from(\s+the)?\s+camera|distant|in\s+the\s+background|held\s+far|small\s+in\s+frame|held\s+back)\b/i.test(
        combinedText
      )
    ) {
      score -= 40;
    }

    // Occlusion cues
    if (
      /\b(not\s+occluded|unoccluded|unobstructed|no\s+occlusion|without\s+occlusion|clear\s+of\s+(any\s+)?obstruction)\b/i.test(
        combinedText
      )
    ) {
      score += 40;
    }
    if (
      /\b(occluded|occlusion|blocked|obstructed|covering|covered\s+by|finger(s)?\s+(blocking|covering|obscuring)|hand(s)?\s+(blocking|covering|obscuring)|foreground\s+object|behind\s+(a\s+|the\s+)?(pipette|tube|bottle|vessel|rack|plate))\b/i.test(
        combinedText
      )
    ) {
      score -= 60;
    }

    // Visibility / Clarity cues
    if (
      /\b(best\s+visible|most\s+visible|clearly\s+visible|clear\s+view|maximum\s+visibility|high\s+visibility|sharp\s+view|fully\s+legible)\b/i.test(
        combinedText
      )
    ) {
      score += 30;
    }
    if (
      /\b(poorly\s+visible|barely\s+visible|hard\s+to\s+read|illegible|blurry\s+label|heavy\s+glare)\b/i.test(
        combinedText
      )
    ) {
      score -= 30;
    }
  }

  // 3. Frame quality metrics (highestContrastFrame, minimalBlurFrame, bestFrames)
  const candidateFrames = [
    event.highestContrastFrame,
    event.minimalBlurFrame,
    ...(Array.isArray(event.bestFrames) ? event.bestFrames : []),
  ].filter(Boolean);

  if (candidateFrames.length > 0) {
    const avgSharpness =
      candidateFrames.reduce((acc, f) => acc + (f?.sharpnessScore || 0), 0) / candidateFrames.length;
    const avgContrast =
      candidateFrames.reduce((acc, f) => acc + (f?.contrastScore || 0), 0) / candidateFrames.length;
    const avgBlur =
      candidateFrames.reduce((acc, f) => acc + (f?.blurScore || 0), 0) / candidateFrames.length;

    score += Math.min(30, Math.max(0, avgSharpness * 0.1));
    score += Math.min(20, Math.max(0, avgContrast * 0.2));
    score -= Math.min(25, Math.max(0, avgBlur * 3));
  }

  // 4. Field completeness
  if (event.manufacturer && event.manufacturer !== 'N/A') score += 5;
  if (event.catalogNumber && event.catalogNumber !== 'N/A') score += 5;
  if (event.lotNumber && event.lotNumber !== 'N/A') score += 5;
  if (event.reagentName && event.reagentName !== 'N/A' && !isLikelyReagentAcronym(event.reagentName)) score += 5;
  if (event.conflatedLabelText || (event as any).rawLabelText) score += 5;

  // 5. Presentation duration
  const numStart = typeof event.startTime === 'number' ? event.startTime : 0;
  const numEnd = typeof event.endTime === 'number' ? event.endTime : numStart;
  if (numEnd - numStart >= 1.0) {
    score += 5;
  }

  return score;
}

/**
 * Checks whether an event represents a reagent label presentation.
 */
export function isReagentLabelPresentationEvent(event: Partial<Event>): boolean {
  const cls = String(event.eventClass || (event as any).actionType || '').toUpperCase();
  if (
    cls.includes('REAGENT_LABEL') ||
    cls === 'REAGENT_LABEL_PRESENTATION' ||
    cls === 'REAGENT_LABEL_PRESENTATION_EVENT'
  ) {
    return true;
  }
  if ((event as any).isReagentLabel === true) {
    return true;
  }
  if (
    event.eventTrack === 'video' &&
    ((event.reagentName && event.reagentName !== 'N/A') ||
      (event.reagentAcronym && event.reagentAcronym !== 'N/A') ||
      (event.reagentData &&
        (event.reagentData.reagentName !== 'N/A' || event.reagentData.reagentAcronym !== 'N/A')))
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts a normalized ArchiveReagent identity from an Event.
 */
export function extractReagentIdentityFromEvent(event: Partial<Event>): Partial<ArchiveReagent> {
  const result: Partial<ArchiveReagent> = {};
  if (event.reagentData) {
    if (event.reagentData.reagentName && event.reagentData.reagentName !== 'N/A') {
      result.reagentName = event.reagentData.reagentName;
    }
    if (event.reagentData.reagentAcronym && event.reagentData.reagentAcronym !== 'N/A') {
      result.reagentAcronym = event.reagentData.reagentAcronym;
    }
    if (event.reagentData.manufacturer && event.reagentData.manufacturer !== 'N/A') {
      result.manufacturer = event.reagentData.manufacturer;
    }
    if (event.reagentData.catalogNumber && event.reagentData.catalogNumber !== 'N/A') {
      result.catalogNumber = event.reagentData.catalogNumber;
    }
    if (event.reagentData.lotNumber && event.reagentData.lotNumber !== 'N/A') {
      result.lotNumber = event.reagentData.lotNumber;
    }
  }

  if (event.reagentName && event.reagentName !== 'N/A') result.reagentName = event.reagentName;
  if (event.reagentAcronym && event.reagentAcronym !== 'N/A') result.reagentAcronym = event.reagentAcronym;
  if (event.manufacturer && event.manufacturer !== 'N/A') result.manufacturer = event.manufacturer;
  if (event.catalogNumber && event.catalogNumber !== 'N/A') result.catalogNumber = event.catalogNumber;
  if (event.lotNumber && event.lotNumber !== 'N/A') result.lotNumber = event.lotNumber;

  if (!result.reagentName && !result.reagentAcronym) {
    const rawText = [
      event.conflatedLabelText,
      (event as any).rawLabelText,
      event.description,
      event.spokenContext,
    ]
      .filter(Boolean)
      .join(' ');
    if (rawText) {
      const parsed = parseReagentLabelFields(rawText, result);
      if (parsed.reagentName !== 'N/A') result.reagentName = parsed.reagentName;
      if (parsed.reagentAcronym !== 'N/A') result.reagentAcronym = parsed.reagentAcronym;
      if (parsed.manufacturer !== 'N/A') result.manufacturer = parsed.manufacturer;
      if (parsed.catalogNumber !== 'N/A') result.catalogNumber = parsed.catalogNumber;
      if (parsed.lotNumber !== 'N/A') result.lotNumber = parsed.lotNumber;
    }
  }

  return result;
}

/**
 * Deduplicates reagent label presentation events for the same reagent.
 * Enforces:
 * 1. There should only be one event for each distinct reagent.
 * 2. The selected event is the one where the label is best visible (closest to camera, not occluded by foreground objects).
 * 3. Associates all parent actionIds with the selected event and updates any action eventLists.
 */
export function deduplicateReagentLabelPresentationEvents(
  events: Event[],
  actions?: Action[]
): {
  deduplicatedEvents: Event[];
  droppedEventIds: string[];
  replacementMap: Map<string, string>;
} {
  const replacementMap = new Map<string, string>();
  const droppedEventIds: string[] = [];

  const nonReagentEvents: Event[] = [];
  const reagentEvents: Event[] = [];

  for (const evt of events) {
    if (isReagentLabelPresentationEvent(evt)) {
      reagentEvents.push(evt);
    } else {
      nonReagentEvents.push(evt);
    }
  }

  if (reagentEvents.length <= 1) {
    return {
      deduplicatedEvents: [...events],
      droppedEventIds: [],
      replacementMap,
    };
  }

  type ReagentGroup = {
    canonicalIdentity: ArchiveReagent;
    events: Event[];
  };

  const groups: ReagentGroup[] = [];

  for (const evt of reagentEvents) {
    const identity = extractReagentIdentityFromEvent(evt);
    let matchedGroup: ReagentGroup | undefined;

    if (identity.reagentName || identity.reagentAcronym) {
      for (const grp of groups) {
        if (areSameReagent(grp.canonicalIdentity, identity)) {
          matchedGroup = grp;
          break;
        }
      }
    }

    if (matchedGroup) {
      matchedGroup.events.push(evt);
      matchedGroup.canonicalIdentity = mergeArchiveReagents(
        matchedGroup.canonicalIdentity,
        identity
      );
    } else {
      groups.push({
        canonicalIdentity: {
          reagentName: identity.reagentName || 'N/A',
          reagentAcronym: identity.reagentAcronym || 'N/A',
          manufacturer: identity.manufacturer || 'N/A',
          catalogNumber: identity.catalogNumber || 'N/A',
          lotNumber: identity.lotNumber || 'N/A',
          rawLabelText: identity.rawLabelText,
          eventId: identity.eventId,
          actionIds: identity.actionIds,
        },
        events: [evt],
      });
    }
  }

  const selectedReagentEvents: Event[] = [];

  for (const grp of groups) {
    if (grp.events.length === 1) {
      selectedReagentEvents.push(grp.events[0]);
      continue;
    }

    const scored = grp.events.map((evt) => ({
      evt,
      score: computeLabelVisibilityScore(evt),
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aFields = [a.evt.manufacturer, a.evt.catalogNumber, a.evt.lotNumber].filter(
        (f) => f && f !== 'N/A'
      ).length;
      const bFields = [b.evt.manufacturer, b.evt.catalogNumber, b.evt.lotNumber].filter(
        (f) => f && f !== 'N/A'
      ).length;
      if (bFields !== aFields) return bFields - aFields;
      const aTime = typeof a.evt.startTime === 'number' ? a.evt.startTime : 0;
      const bTime = typeof b.evt.startTime === 'number' ? b.evt.startTime : 0;
      return aTime - bTime;
    });

    const selected = scored[0].evt;
    const dropped = scored.slice(1).map((s) => s.evt);

    const allActionIds = new Set<string>();
    if (selected.actionId) allActionIds.add(selected.actionId);
    if (Array.isArray(selected.actionIds)) {
      for (const id of selected.actionIds) if (id) allActionIds.add(id);
    }

    for (const d of dropped) {
      droppedEventIds.push(d.eventId);
      replacementMap.set(d.eventId, selected.eventId);

      if (d.actionId) allActionIds.add(d.actionId);
      if (Array.isArray(d.actionIds)) {
        for (const id of d.actionIds) if (id) allActionIds.add(id);
      }

      const dIdentity = extractReagentIdentityFromEvent(d);
      if ((!selected.manufacturer || selected.manufacturer === 'N/A') && dIdentity.manufacturer && dIdentity.manufacturer !== 'N/A') {
        selected.manufacturer = dIdentity.manufacturer;
      }
      if ((!selected.catalogNumber || selected.catalogNumber === 'N/A') && dIdentity.catalogNumber && dIdentity.catalogNumber !== 'N/A') {
        selected.catalogNumber = dIdentity.catalogNumber;
      }
      if ((!selected.lotNumber || selected.lotNumber === 'N/A') && dIdentity.lotNumber && dIdentity.lotNumber !== 'N/A') {
        selected.lotNumber = dIdentity.lotNumber;
      }
      if ((!selected.reagentName || selected.reagentName === 'N/A') && dIdentity.reagentName && dIdentity.reagentName !== 'N/A') {
        selected.reagentName = dIdentity.reagentName;
      }
      if ((!selected.reagentAcronym || selected.reagentAcronym === 'N/A') && dIdentity.reagentAcronym && dIdentity.reagentAcronym !== 'N/A') {
        selected.reagentAcronym = dIdentity.reagentAcronym;
      }

      if (Array.isArray(d.refinementList) && d.refinementList.length > 0) {
        selected.refinementList = Array.from(new Set([...(selected.refinementList || []), ...d.refinementList]));
      }

      if (!selected.spokenContext && d.spokenContext) {
        selected.spokenContext = d.spokenContext;
      }
    }

    selected.actionIds = Array.from(allActionIds);
    if (!selected.actionId && selected.actionIds.length > 0) {
      selected.actionId = selected.actionIds[0];
    }

    selectedReagentEvents.push(selected);
  }

  if (Array.isArray(actions) && replacementMap.size > 0) {
    for (const act of actions) {
      if (Array.isArray(act.eventList)) {
        const updatedList: string[] = [];
        for (const eid of act.eventList) {
          const repl = replacementMap.get(eid);
          const targetId = repl || eid;
          if (!updatedList.includes(targetId)) {
            updatedList.push(targetId);
          }
        }
        act.eventList = updatedList;
      }
    }
  }

  const deduplicatedEvents = [...nonReagentEvents, ...selectedReagentEvents];
  deduplicatedEvents.sort((a, b) => {
    const aTime = typeof a.startTime === 'number' ? a.startTime : 0;
    const bTime = typeof b.startTime === 'number' ? b.startTime : 0;
    return aTime - bTime;
  });

  return {
    deduplicatedEvents,
    droppedEventIds,
    replacementMap,
  };
}

export const RefinedActionBoundarySchema = z.object({
  actionId: z.string(),
  actionType: z.string().optional(),
  pass1StartTimestampSeconds: z.number(),
  pass1EndTimestampSeconds: z.number(),
  searchWindowStartSeconds: z.number(),
  searchWindowEndSeconds: z.number(),
  refinedStartTimestampSeconds: z.number(),
  refinedEndTimestampSeconds: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  fps: z.number().default(4),
  confidenceScore: z.number().optional(),
  associatedEventIds: z.array(z.string()).default([]),
});
export type RefinedActionBoundary = z.infer<typeof RefinedActionBoundarySchema>;

export const EventDetectionSchema = z.object({
  events: z.array(EventSchema),
  refinedActions: z.array(RefinedActionBoundarySchema).optional().default([]),
});
export type EventDetection = z.infer<typeof EventDetectionSchema>;

export const EventDetectionPassResultSchema = z.object({
  videoId: z.string().optional(),
  events: z.array(EventSchema),
  refinedActions: z.array(RefinedActionBoundarySchema).default([]),
  generatedAt: z.string().optional(),
  modelUsed: z.string().optional(),
  thinkingLevel: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type EventDetectionPassResult = z.infer<typeof EventDetectionPassResultSchema>;

export const RefinementSchema = z.object({
  refinementId: z.string().default('ref_001'),
  eventId: z.string().default('evt_001'),
  actionId: z.string().optional(),
  actionIds: z.array(z.string()).optional(),
  refinementClass: z.string().default('OCR_CONFLATION'),
  transcriptionText: z.string().optional(),
  vialLabelData: VialLabelDataSchema.optional(),
  boxWellLocation: BoxWellLocationSchema.optional(),
  reagentData: ArchiveReagentSchema.optional(),
  mixReagentsData: MixReagentsActionDataSchema.optional(),
  seedReagentsData: SeedReagentsActionDataSchema.optional(),
  incubateCellsData: IncubateCellsActionDataSchema.optional(),
  incubatorSettings: IncubateCellsActionDataSchema.optional(),
  hemocytometerLoadingData: HemocytometerLoadingActionDataSchema.optional(),
  hemocytometerLoad: HemocytometerLoadDataSchema.optional(),
  substanceLoaded: z.string().optional(),
  frameTranscriptions: z.array(z.any()).optional(),
  spatialResult: z
    .object({
      row: z.string().default('A'),
      col: z.coerce.number().default(1),
    })
    .optional(),
  conflationMetadata: z
    .object({
      confidence: z.coerce.number().default(0.95),
      framesEvaluated: z.coerce.number().default(2),
      ocrEngine: z.string().default('Gemini-DualShot-Conflation'),
    })
    .optional(),
});
export type Refinement = z.infer<typeof RefinementSchema>;

export const AnalysisRefinementPassResultSchema = z.object({
  videoId: z.string().optional(),
  refinements: z.array(RefinementSchema),
  labelTranscriptions: z.array(LabelTranscriptionRecordSchema).default([]),
  actionWellLocations: z
    .array(
      BoxWellLocationSchema.extend({
        actionId: z.string(),
      })
    )
    .default([]),
  enrichedActions: z.array(ActionSchema).optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  workSteps: z.array(ArchiveWorkStepSchema).optional(),
  generatedAt: z.string().optional(),
  modelUsed: z.string().optional(),
  thinkingLevel: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type AnalysisRefinementPassResult = z.infer<typeof AnalysisRefinementPassResultSchema>;

export const VideoStatusSchema = z.enum([
  'UPLOADING',
  'TRANSCODING',
  'READY_FOR_ANALYSIS',
  'ANALYZING',
  'ANALYSIS_COMPLETE',
  'FAILED',
  'ERROR',
]);
export type VideoStatus = z.infer<typeof VideoStatusSchema>;

export const PassStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'ERROR']);
export type PassStatus = z.infer<typeof PassStatusSchema>;

export const PassStepStateSchema = z.object({
  status: PassStatusSchema.default('PENDING'),
  data: z.any().optional(),
  labelTranscriptions: z.array(LabelTranscriptionRecordSchema).optional(),
  actionWellLocations: z.array(BoxWellLocationSchema).optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  workSteps: z.array(ArchiveWorkStepSchema).optional(),
  executionAudit: ExecutionAuditSchema.optional(),
  modelUsed: z.string().optional(),
  thinkingLevel: z.string().optional(),
  error: z.string().nullable().optional(),
  startedAt: z.any().optional(),
  completedAt: z.any().optional(),
  updatedAt: z.any().optional(),
});
export type PassStepState = z.infer<typeof PassStepStateSchema>;

export const VideoPassesSchema = z.object({
  pass0: PassStepStateSchema.default({ status: 'PENDING' }),
  pass1: PassStepStateSchema.default({ status: 'PENDING' }),
  pass2: PassStepStateSchema.default({ status: 'PENDING' }),
  pass3: PassStepStateSchema.default({ status: 'PENDING' }),
  hitl: PassStepStateSchema.default({ status: 'PENDING' }),
});
export type VideoPasses = z.infer<typeof VideoPassesSchema>;

export const DEFAULT_VIDEO_PASSES: VideoPasses = {
  pass0: { status: 'PENDING' },
  pass1: { status: 'PENDING' },
  pass2: { status: 'PENDING' },
  pass3: { status: 'PENDING' },
  hitl: { status: 'PENDING' },
};

export const AnalyzePassRequestSchema = z.object({
  videoId: z.string(),
  pass: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal('all'),
    z.literal('0'),
    z.literal('1'),
    z.literal('2'),
    z.literal('3'),
  ]),
  videoGcsUri: z.string().optional(),
  localFilePath: z.string().optional(),
  customerId: z.string().optional(),
  databaseId: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
});
export type AnalyzePassRequest = z.infer<typeof AnalyzePassRequestSchema>;

export const VideoChunkSchema = z.object({
  index: z.number(),
  gcsUri: z.string(),
});
export type VideoChunk = z.infer<typeof VideoChunkSchema>;

export const VideoRecordSchema = z.object({
  videoId: z.string(),
  originalName: z.string(),
  bucketName: z.string().optional(),
  gcsBucket: z.string().optional(),
  rawPath: z.string().optional(),
  normalizedPath: z.string().optional(),
  rawGcsUri: z.string(),
  normalizedGcsUri: z.string().optional(),
  thumbnailGcsUri: z.string().optional(),
  totalChunks: z.number().optional(),
  chunks: z.array(VideoChunkSchema).optional(),
  geminiFileUri: z.string().optional(),
  geminiFileName: z.string().optional(),
  durationSeconds: z.number().optional(),
  fileSizeBytes: z.number().optional(),
  status: VideoStatusSchema,
  transcodeProgress: z.number().optional(),
  errorMessage: z.string().optional(),
  passes: VideoPassesSchema.optional(),
  analysisId: z.string().optional(),
  organizationId: z.string().optional(),
  inventoryId: z.string().nullable().optional(),
  inventoryName: z.string().nullable().optional(),
  unmatchedInventoryName: z.string().nullable().optional(),
  inventoryAssociationType: z.enum(['AUTOMATIC', 'MANUAL', 'UNMATCHED']).nullable().optional(),
  archiveId: z.string().nullable().optional(),
  archiveName: z.string().nullable().optional(),
  archiveCreatorName: z.string().nullable().optional(),
  archiveCreationDate: z.string().nullable().optional(),
  archivePurpose: z.string().nullable().optional(),
  archiveIntent: z.enum(['CREATE', 'APPEND']).nullable().optional(),
  unmatchedArchiveName: z.string().nullable().optional(),
  archiveAssociationType: z
    .enum(['AUTOMATIC', 'MANUAL', 'UNMATCHED', 'PENDING_CONFIRMATION'])
    .nullable()
    .optional(),
  associatedAt: z.string().nullable().optional(),
  uploadedBy: z.string().optional(),
  uploaderEmail: z.string().optional(),
  capturedAt: z.any().optional(),
  uploadedAt: z.any(),
  transcodedAt: z.any().optional(),
});
export type VideoRecord = z.infer<typeof VideoRecordSchema>;

export const VideoMetadataSchema = z.object({
  videoId: z.string(),
  customerId: z.string().optional(),
  databaseId: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: z.string().optional(),
  originalName: z.string().optional(),
  bucketName: z.string().optional(),
  gcsBucket: z.string().optional(),
  rawPath: z.string().optional(),
  normalizedPath: z.string().optional(),
  rawGcsUri: z.string().optional(),
  originalGcsUri: z.string().optional(),
  normalizedGcsUri: z.string().optional(),
  thumbnailGcsUri: z.string().optional(),
  totalChunks: z.number().optional(),
  chunks: z.array(VideoChunkSchema).optional(),
  geminiFileUri: z.string().optional(),
  geminiFileName: z.string().optional(),
  status: z.string(),
  transcodeProgress: z.number().optional(),
  errorMessage: z.string().optional(),
  passes: VideoPassesSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  fileSizeBytes: z.number().optional(),
  durationSec: z.number().optional(),
  durationSeconds: z.number().optional(),
  analysisId: z.string().optional(),
  organizationId: z.string().optional(),
  inventoryId: z.string().nullable().optional(),
  inventoryName: z.string().nullable().optional(),
  unmatchedInventoryName: z.string().nullable().optional(),
  inventoryAssociationType: z.enum(['AUTOMATIC', 'MANUAL', 'UNMATCHED']).nullable().optional(),
  archiveId: z.string().nullable().optional(),
  archiveName: z.string().nullable().optional(),
  archiveCreatorName: z.string().nullable().optional(),
  archiveCreationDate: z.string().nullable().optional(),
  archivePurpose: z.string().nullable().optional(),
  archiveIntent: z.enum(['CREATE', 'APPEND']).nullable().optional(),
  unmatchedArchiveName: z.string().nullable().optional(),
  archiveAssociationType: z
    .enum(['AUTOMATIC', 'MANUAL', 'UNMATCHED', 'PENDING_CONFIRMATION'])
    .nullable()
    .optional(),
  associatedAt: z.string().nullable().optional(),
  uploadedBy: z.string().optional(),
  uploaderEmail: z.string().optional(),
  capturedAt: z.any().optional(),
  uploadedAt: z.any().optional(),
  transcodedAt: z.any().optional(),
  metadata: z.record(z.any()).optional(),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const BoxUpdateSchema = z.object({
  boxId: z.string().default('box_01'),
  row: z.string(),
  col: z.number(),
  cellLineName: z.string().default(''),
  userInitials: z.string().optional(),
  dateFrozen: z.string().optional(),
  fullText: z.string().optional(),
  lotNumber: z.string().optional(),
  passage: z.number().optional(),
  operatorInitials: z.string().optional(),
  actionId: z.string().optional(),
  actionType: z.string().optional(),
  highlighted: z.boolean().optional(),
  status: z.enum(['OCCUPIED', 'EMPTY', 'RESERVED']).default('OCCUPIED'),
  updatedAt: z.string().optional(),
});
export type BoxUpdate = z.infer<typeof BoxUpdateSchema>;

export const InventorySignOffPayloadSchema = z.object({
  databaseId: z.string(),
  videoId: z.string(),
  inventoryId: z.string(),
  boxUpdates: z.array(BoxUpdateSchema),
  signedOffAt: z.string().optional(),
  operatorInitials: z.string().optional(),
});
export type InventorySignOffPayload = z.infer<typeof InventorySignOffPayloadSchema>;

export const ArchiveSignOffPayloadSchema = z.object({
  databaseId: z.string(),
  videoId: z.string(),
  archiveId: z.string(),
  markdownDoc: z.string().min(1),
  archiveName: z.string().optional(),
  creatorName: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  labelTranscriptions: z.array(z.string()).optional(),
  workSteps: z.array(ArchiveWorkStepSchema).optional(),
  signedOffAt: z.string().optional(),
  operatorInitials: z.string().optional(),
  replaceArchiveContent: z.boolean().optional(),
});
export type ArchiveSignOffPayload = z.infer<typeof ArchiveSignOffPayloadSchema>;

export const VideoAnalysisDocSchema = z.object({
  videoId: z.string().optional(),
  archiveId: z.string().nullable().optional(),
  archiveName: z.string().nullable().optional(),
  creatorName: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  archivePurpose: z.string().nullable().optional(),
  inventoryId: z.string().nullable().optional(),
  workflowClassification: WorkflowClassificationSchema.optional(),
  workloadClassification: WorkflowClassificationSchema.optional(),
  actions: z.array(ActionSchema),
  events: z.array(EventSchema),
  refinements: z.array(RefinementSchema),
  labelTranscriptions: z.array(LabelTranscriptionRecordSchema).optional(),
  actionWellLocations: z.array(BoxWellLocationSchema).optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  workSteps: z.array(ArchiveWorkStepSchema).optional(),
  isSignedOff: z.boolean().default(false),
  signedOffAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type VideoAnalysisDoc = z.infer<typeof VideoAnalysisDocSchema>;
