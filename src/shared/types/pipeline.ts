import { z } from 'zod';

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

export const WorkflowClassificationSchema = z.object({
  workflowType: z.enum([
    'INVENTORY_UPDATE_WORKFLOW',
    'EXPERIMENT_NOTEBOOK_WORKFLOW',
    'UNCLASSIFIED_WORKFLOW',
  ]),
  inventoryName: z.string().nullable().optional(),
  archiveName: z.string().nullable().optional(),
  transcribedAudio: z.string(),
  modelUsed: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type WorkflowClassification = z.infer<typeof WorkflowClassificationSchema>;

export const ActionIntervalSchema = z.object({
  actionId: z.string(),
  actionType: z.string(), // "VIAL_INSERTION" | "VIAL_REMOVAL" | "CAP_REMOVAL" | "BOX_MANIPULATION" | string
  description: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  startTimestampSeconds: z.number(),
  endTimestampSeconds: z.number(),
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
  boxRowId: z.string().optional(),
  boxColId: z.number().optional(),
  eventList: z.array(z.string()).optional(),
});
export type ActionInterval = z.infer<typeof ActionIntervalSchema>;

export const ActionDetectionPassResultSchema = z.object({
  videoId: z.string(),
  totalActionsDetected: z.number(),
  workflowContext: z.string().optional(),
  actions: z.array(ActionIntervalSchema),
  generatedAt: z.string(),
  modelUsed: z.string().optional(),
  thinkingLevel: z.string().optional(),
  executionAudit: ExecutionAuditSchema.optional(),
});
export type ActionDetectionPassResult = z.infer<typeof ActionDetectionPassResultSchema>;

export const ActionSchema = z.object({
  actionId: z.string(),
  actionClass: z.enum([
    'VIAL_INSERTION_ACTION',
    'VIAL_REMOVAL_ACTION',
    'REAGENT_MIXING_ACTION',
    'REAGENT_SEEDING_ACTION',
  ]),
  actionType: z.string().optional(),
  description: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  startTimestampSeconds: z.number().optional(),
  endTimestampSeconds: z.number().optional(),
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
  boxRowId: z.string().optional(),
  boxColId: z.number().optional(),
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
  actionId: z.string(),
  eventClass: z.string().optional().default('VIAL_INSERTION'),
  eventTrack: z.enum(['video', 'audio']).default('video'),
  startTime: timeField,
  endTime: timeField,
  bestShotUrls: z.array(z.string()).default([]),
  bestShotTimes: z.array(z.number()).default([]),
  refinementList: z.array(z.string()).default([]),
});
export type Event = z.infer<typeof EventSchema>;

export const EventDetectionSchema = z.object({
  events: z.array(EventSchema),
});
export type EventDetection = z.infer<typeof EventDetectionSchema>;

export const RefinementSchema = z.object({
  refinementId: z.string(),
  eventId: z.string(),
  refinementClass: z.string(),
  transcriptionText: z.string().optional(),
  spatialResult: z
    .object({
      row: z.string(),
      col: z.number(),
    })
    .optional(),
  conflationMetadata: z
    .object({
      confidence: z.number(),
      framesEvaluated: z.number(),
      ocrEngine: z.string(),
    })
    .optional(),
});
export type Refinement = z.infer<typeof RefinementSchema>;

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
  totalChunks: z.number().optional(),
  chunks: z.array(VideoChunkSchema).optional(),
  geminiFileUri: z.string().optional(),
  geminiFileName: z.string().optional(),
  durationSeconds: z.number().optional(),
  fileSizeBytes: z.number().optional(),
  status: VideoStatusSchema,
  errorMessage: z.string().optional(),
  passes: VideoPassesSchema.optional(),
  analysisId: z.string().optional(),
  organizationId: z.string().optional(),
  inventoryId: z.string().nullable().optional(),
  inventoryName: z.string().nullable().optional(),
  unmatchedInventoryName: z.string().nullable().optional(),
  inventoryAssociationType: z.enum(['AUTOMATIC', 'MANUAL', 'UNMATCHED']).nullable().optional(),
  associatedAt: z.string().nullable().optional(),
  uploadedBy: z.string().optional(),
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
  totalChunks: z.number().optional(),
  chunks: z.array(VideoChunkSchema).optional(),
  geminiFileUri: z.string().optional(),
  geminiFileName: z.string().optional(),
  status: z.string(),
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
  associatedAt: z.string().nullable().optional(),
  uploadedBy: z.string().optional(),
  uploadedAt: z.any().optional(),
  transcodedAt: z.any().optional(),
  metadata: z.record(z.any()).optional(),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const BoxUpdateSchema = z.object({
  boxId: z.string().default('box_01'),
  row: z.string(),
  col: z.number(),
  cellLineName: z.string(),
  lotNumber: z.string().optional(),
  passage: z.number().optional(),
  operatorInitials: z.string().optional(),
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
  markdownDoc: z.string(),
  signedOffAt: z.string().optional(),
  operatorInitials: z.string().optional(),
});
export type ArchiveSignOffPayload = z.infer<typeof ArchiveSignOffPayloadSchema>;

export const VideoAnalysisDocSchema = z.object({
  videoId: z.string().optional(),
  workflowClassification: WorkflowClassificationSchema.optional(),
  workloadClassification: WorkflowClassificationSchema.optional(),
  actions: z.array(ActionSchema),
  events: z.array(EventSchema),
  refinements: z.array(RefinementSchema),
  isSignedOff: z.boolean().default(false),
  signedOffAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type VideoAnalysisDoc = z.infer<typeof VideoAnalysisDocSchema>;
