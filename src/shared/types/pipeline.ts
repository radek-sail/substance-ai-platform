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
export type Refinement = z.infer<typeof RefinementSchema>;
