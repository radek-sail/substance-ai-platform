import { z } from 'zod';

export const WorkflowClassificationSchema = z.object({
  workflowType: z.enum([
    'INVENTORY_UPDATE_WORKFLOW',
    'EXPERIMENT_NOTEBOOK_WORKFLOW',
    'UNCLASSIFIED_WORKFLOW',
  ]),
  inventoryName: z.string().optional(),
  archiveName: z.string().optional(),
  transcribedAudio: z.string(),
});
export type WorkflowClassification = z.infer<typeof WorkflowClassificationSchema>;

export const ActionSchema = z.object({
  actionId: z.string(),
  actionClass: z.enum([
    'VIAL_INSERTION_ACTION',
    'VIAL_REMOVAL_ACTION',
    'REAGENT_MIXING_ACTION',
    'REAGENT_SEEDING_ACTION',
  ]),
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

export const EventSchema = z.object({
  eventId: z.string(),
  actionId: z.string(),
  eventClass: z.string(),
  eventTrack: z.enum(['video', 'audio']),
  startTime: z.number(),
  endTime: z.number(),
  bestShotUrls: z.array(z.string()),
  bestShotTimes: z.array(z.number()),
  refinementList: z.array(z.string()),
});
export type Event = z.infer<typeof EventSchema>;

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

export const VideoMetadataSchema = z.object({
  videoId: z.string(),
  customerId: z.string(),
  databaseId: z.string(),
  originalGcsUri: z.string(),
  normalizedGcsUri: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  durationSec: z.number().optional(),
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
