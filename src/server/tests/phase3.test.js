const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  loadGuideline,
  extractJsonFromText,
  rowIndexToLetter,
  letterToRowIndex,
  computeGridCoordinateFromNormalized,
  calculateSpatialDistance,
  setGenAIClient,
  resetGenAIClient,
  runPass0WorkflowClassification,
  runPass1ActionDetection,
  runPass2EventDetection,
  runPass3AnalysisRefinement,
  executeHierarchicalPipeline,
  DEFAULT_PRO_MODEL,
} = require('../dist/services/gemini.service');

const {
  getTenantFirestore,
  saveVideoAnalysis,
  getVideoAnalysis,
  getVideoPasses,
  clearDatabaseCache,
} = require('../dist/services/firestore.service');

const {
  WorkflowClassificationSchema,
  ActionSchema,
  EventSchema,
  RefinementSchema,
} = require('@sail/shared');

const storageService = require('../dist/services/storage.service');
const ffmpegService = require('../dist/services/ffmpeg.service');
const { app } = require('../dist/server');

describe('Phase 3: The 4-Stage Hierarchical AI Pipeline Service', () => {
  beforeEach(() => {
    clearDatabaseCache();
    resetGenAIClient();
  });

  afterEach(() => {
    resetGenAIClient();
  });

  describe('1. Dynamic Agent Guideline Loading (config/*.md)', () => {
    it('should dynamically read classification guidelines from config/classification-agent-guidelines.md', () => {
      const content = loadGuideline('classification-agent-guidelines.md');
      assert.ok(content.length > 50, 'Guideline file content must not be empty');
      assert.ok(
        content.includes('INVENTORY_UPDATE_WORKFLOW'),
        'Must specify INVENTORY_UPDATE_WORKFLOW'
      );
      assert.ok(
        content.includes('EXPERIMENT_NOTEBOOK_WORKFLOW'),
        'Must specify EXPERIMENT_NOTEBOOK_WORKFLOW'
      );
      assert.ok(
        content.includes('UNCLASSIFIED_WORKFLOW'),
        'Must specify UNCLASSIFIED_WORKFLOW'
      );
      assert.ok(
        content.includes('WorkflowClassificationSchema'),
        'Must reference schema contract'
      );
    });

    it('should dynamically read inventory guidelines from config/inventory-agent-guidelines.md', () => {
      const content = loadGuideline('inventory-agent-guidelines.md');
      assert.ok(content.length > 50, 'Guideline file content must not be empty');
      assert.ok(
        content.includes('VIAL_INSERTION_ACTION'),
        'Must specify VIAL_INSERTION_ACTION'
      );
      assert.ok(
        content.includes('VIAL_REMOVAL_ACTION'),
        'Must specify VIAL_REMOVAL_ACTION'
      );
      assert.ok(
        content.includes('VIAL_LABEL_PRESENTATION_EVENT'),
        'Must specify label presentation sub-event'
      );
      assert.ok(
        content.includes('ActionSchema'),
        'Must reference ActionSchema'
      );
    });

    it('should dynamically read archive guidelines from config/archive-agent-guidelines.md', () => {
      const content = loadGuideline('archive-agent-guidelines.md');
      assert.ok(content.length > 50, 'Guideline file content must not be empty');
      assert.ok(
        content.includes('REAGENT_MIXING_ACTION'),
        'Must specify REAGENT_MIXING_ACTION'
      );
      assert.ok(
        content.includes('REAGENT_SEEDING_ACTION'),
        'Must specify REAGENT_SEEDING_ACTION'
      );
      assert.ok(
        content.includes('EventSchema'),
        'Must reference EventSchema'
      );
    });

    it('should throw an informative error when a non-existent guideline file is requested', () => {
      assert.throws(
        () => loadGuideline('unknown-agent-guidelines.md'),
        /Guideline file not found/
      );
    });
  });

  describe('2. Spatial Coordinate Calculation & Grid Differencing', () => {
    it('should accurately convert zero-based row indices to uppercase letters (A-Z)', () => {
      assert.strictEqual(rowIndexToLetter(0), 'A');
      assert.strictEqual(rowIndexToLetter(1), 'B');
      assert.strictEqual(rowIndexToLetter(2), 'C');
      assert.strictEqual(rowIndexToLetter(8), 'I');
      assert.strictEqual(rowIndexToLetter(25), 'Z');
      assert.throws(() => rowIndexToLetter(-1), RangeError);
      assert.throws(() => rowIndexToLetter(26), RangeError);
    });

    it('should accurately convert row letters (A-Z) to zero-based row indices', () => {
      assert.strictEqual(letterToRowIndex('A'), 0);
      assert.strictEqual(letterToRowIndex('b'), 1);
      assert.strictEqual(letterToRowIndex('I'), 8);
      assert.strictEqual(letterToRowIndex('Z'), 25);
      assert.throws(() => letterToRowIndex('1'), RangeError);
      assert.throws(() => letterToRowIndex('!'), RangeError);
    });

    it('should map normalized box coordinates to grid coordinates relative to top-left origin', () => {
      // 9x9 cryo-box:
      // (0.05, 0.05) -> Row A (0), Col 1
      const topLeft = computeGridCoordinateFromNormalized(0.05, 0.05, 9, 9);
      assert.strictEqual(topLeft.row, 'A');
      assert.strictEqual(topLeft.col, 1);

      // (0.95, 0.95) -> Row I (8), Col 9
      const bottomRight = computeGridCoordinateFromNormalized(0.95, 0.95, 9, 9);
      assert.strictEqual(bottomRight.row, 'I');
      assert.strictEqual(bottomRight.col, 9);

      // Center (0.5, 0.5) -> Row E (4), Col 5
      const center = computeGridCoordinateFromNormalized(0.5, 0.5, 9, 9);
      assert.strictEqual(center.row, 'E');
      assert.strictEqual(center.col, 5);

      // 8x12 96-well plate (8 rows A-H, 12 cols 1-12):
      // Row 2 (C), Col 4: normalized approx (3.5 / 12, 2.5 / 8) = (0.291, 0.312)
      const wellC4 = computeGridCoordinateFromNormalized(0.291, 0.312, 8, 12);
      assert.strictEqual(wellC4.row, 'C');
      assert.strictEqual(wellC4.col, 4);
    });

    it('should compute spatial distance and differencing correctly', () => {
      const coordA = { row: 'A', col: 1 };
      const coordB = { row: 'C', col: 4 }; // Row A->C (+2), Col 1->4 (+3)
      const diff = calculateSpatialDistance(coordA, coordB);
      assert.strictEqual(diff.rowDiff, 2);
      assert.strictEqual(diff.colDiff, 3);
      assert.strictEqual(diff.euclidean, Math.sqrt(4 + 9));
    });
  });

  describe('3. Zod Schema Contracts Verification', () => {
    it('should validate conforming WorkflowClassificationSchema data', () => {
      const valid = {
        workflowType: 'INVENTORY_UPDATE_WORKFLOW',
        inventoryName: 'CryoTank-Alpha',
        transcribedAudio: 'Opening Tank Alpha and accessing Tower 2',
      };
      const parsed = WorkflowClassificationSchema.parse(valid);
      assert.strictEqual(parsed.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
      assert.strictEqual(parsed.inventoryName, 'CryoTank-Alpha');
    });

    it('should validate WorkflowClassificationSchema when archiveName is null, undefined, or empty', () => {
      const withNull = {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: null,
        transcribedAudio: 'Testing protocol without explicit archive name',
      };
      const parsedNull = WorkflowClassificationSchema.parse(withNull);
      assert.strictEqual(parsedNull.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(parsedNull.archiveName, null);

      const withUndefined = {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        transcribedAudio: 'Testing protocol without archive name field',
      };
      const parsedUndefined = WorkflowClassificationSchema.parse(withUndefined);
      assert.strictEqual(parsedUndefined.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(parsedUndefined.archiveName, undefined);
    });

    it('should reject invalid workflowType in WorkflowClassificationSchema', () => {
      const invalid = {
        workflowType: 'INVALID_WORKFLOW_TYPE',
        transcribedAudio: 'test',
      };
      assert.throws(() => WorkflowClassificationSchema.parse(invalid));
    });

    it('should validate conforming ActionSchema data', () => {
      const valid = {
        actionId: 'act_001',
        actionClass: 'VIAL_INSERTION_ACTION',
        inventoryId: 'tank_1',
        cellLineName: 'HEK293T',
        towerId: 'tower_02',
        boxRowId: 'C',
        boxColId: 4,
        eventList: ['evt_001', 'evt_002'],
      };
      const parsed = ActionSchema.parse(valid);
      assert.strictEqual(parsed.actionClass, 'VIAL_INSERTION_ACTION');
      assert.strictEqual(parsed.boxRowId, 'C');
      assert.strictEqual(parsed.boxColId, 4);
    });

    it('should validate conforming EventSchema data with bestShotUrls', () => {
      const valid = {
        eventId: 'evt_001',
        actionId: 'act_001',
        eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
        eventTrack: 'video',
        startTime: 12.0,
        endTime: 16.5,
        bestShotUrls: ['gs://biolab-video-manager-storage/frames/vid_1/frame_evt_001_14.0.jpg'],
        bestShotTimes: [14.0],
        refinementList: ['ref_001'],
      };
      const parsed = EventSchema.parse(valid);
      assert.strictEqual(parsed.eventId, 'evt_001');
      assert.strictEqual(parsed.bestShotUrls.length, 1);
      assert.strictEqual(parsed.bestShotTimes[0], 14.0);
    });

    it('should validate conforming RefinementSchema data with spatial results and conflation', () => {
      const valid = {
        refinementId: 'ref_001',
        eventId: 'evt_001',
        refinementClass: 'OCR_CONFLATION',
        transcriptionText: 'HEK293T Passage 5 Lot #8841',
        spatialResult: {
          row: 'C',
          col: 4,
        },
        conflationMetadata: {
          confidence: 0.985,
          framesEvaluated: 4,
          ocrEngine: 'Tesseract-MultiFrame',
        },
      };
      const parsed = RefinementSchema.parse(valid);
      assert.strictEqual(parsed.spatialResult.row, 'C');
      assert.strictEqual(parsed.spatialResult.col, 4);
      assert.strictEqual(parsed.conflationMetadata.confidence, 0.985);
    });
  });

  describe('4. Pass Execution with Mocked @google/genai Client', () => {
    it('Pass 0: should call Gemini Flash with classification guidelines and parse result', async () => {
      let passedSystemInstruction = null;
      let passedModel = null;

      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSystemInstruction = params.config?.systemInstruction;
            passedModel = params.model;
            return {
              text: JSON.stringify({
                workflowType: 'INVENTORY_UPDATE_WORKFLOW',
                inventoryName: 'Tank-Gamma',
                transcribedAudio: 'Placing cryo vial in tank gamma slot D3',
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const result = await runPass0WorkflowClassification({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
      });

      assert.strictEqual(result.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
      assert.strictEqual(result.inventoryName, 'Tank-Gamma');
      assert.ok(
        passedSystemInstruction.includes('INVENTORY_UPDATE_WORKFLOW'),
        'System instruction must match classification guidelines'
      );
      assert.ok(passedModel.includes('flash'), 'Pass 0 must utilize Gemini Flash');
    });

    it('Pass 0: should retry with exponential backoff on HTTP 503 / 429 transient errors', async () => {
      let attempts = 0;

      const mockClient = {
        models: {
          generateContent: async () => {
            attempts++;
            if (attempts === 1) {
              const err = new Error('503 Service Unavailable: The model is overloaded.');
              err.status = 503;
              throw err;
            }
            return {
              text: JSON.stringify({
                workflowType: 'INVENTORY_UPDATE_WORKFLOW',
                inventoryName: 'Tank-Retry',
                transcribedAudio: 'Recovered from 503 on attempt 2',
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const result = await runPass0WorkflowClassification({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_retry.mp4',
      });

      assert.strictEqual(attempts, 2, 'Should have retried after 503 error');
      assert.strictEqual(result.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
      assert.strictEqual(result.inventoryName, 'Tank-Retry');
    });

    it('Pass 0: should sanitize null or empty archiveName using videoRecord metadata', async () => {
      const mockClient = {
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
              archiveName: null,
              inventoryName: null,
              transcribedAudio: 'Seeding 96-well plate with HEK293T cells',
            }),
          }),
        },
      };

      setGenAIClient(mockClient);

      const result = await runPass0WorkflowClassification({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_01.mp4',
        videoId: 'vid_archive_01',
        videoRecord: {
          videoId: 'vid_archive_01',
          originalName: 'CellSeeding_Run1.mp4',
        },
      });

      assert.strictEqual(result.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(result.archiveName, 'CellSeeding_Run1.mp4');
    });

    it('Pass 0: should fallback to videoId or default_archive when videoRecord has no originalName', async () => {
      const mockClient = {
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
              archiveName: null,
              transcribedAudio: 'Running experiment procedure',
            }),
          }),
        },
      };

      setGenAIClient(mockClient);

      const result = await runPass0WorkflowClassification({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_02.mp4',
        videoId: 'vid_archive_02',
      });

      assert.strictEqual(result.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(result.archiveName, 'vid_archive_02');
    });

    it('Pass 1: should select inventory guidelines for INVENTORY_UPDATE_WORKFLOW and return ActionSchema array', async () => {
      let passedSystemInstruction = null;

      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSystemInstruction = params.config?.systemInstruction;
            return {
              text: JSON.stringify([
                {
                  actionId: 'act_101',
                  actionClass: 'VIAL_INSERTION_ACTION',
                  inventoryId: 'tank_1',
                  cellLineName: 'iPSC-Clone-9',
                  towerId: 'Tower-A',
                  boxRowId: 'B',
                  boxColId: 3,
                  eventList: ['evt_101'],
                },
              ]),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Inserting iPSC Clone 9 into B3',
        },
      });

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].actionClass, 'VIAL_INSERTION_ACTION');
      assert.strictEqual(actions[0].cellLineName, 'iPSC-Clone-9');
      assert.ok(
        passedSystemInstruction.includes('Cell Line Cryo-Inventory'),
        'Pass 1 must select inventory guidelines for inventory workflow'
      );
    });

    it('Pass 1: should select archive guidelines for EXPERIMENT_NOTEBOOK_WORKFLOW', async () => {
      let passedSystemInstruction = null;

      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSystemInstruction = params.config?.systemInstruction;
            return {
              text: JSON.stringify([
                {
                  actionId: 'act_201',
                  actionClass: 'REAGENT_SEEDING_ACTION',
                  archiveId: 'exp_042',
                  cellLineName: 'HeLa',
                  boxRowId: 'D',
                  boxColId: 6,
                  eventList: ['evt_201'],
                },
              ]),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
        classification: {
          workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
          archiveName: 'Experiment-042',
          transcribedAudio: 'Seeding HeLa cells across well D6',
        },
      });

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].actionClass, 'REAGENT_SEEDING_ACTION');
      assert.ok(
        passedSystemInstruction.includes('Experiment Archive'),
        'Pass 1 must select archive guidelines for notebook workflow'
      );
    });

    it('Pass 1: should enforce generation config (temperature 0.2, maxOutputTokens 16384) and brevity constraints', async () => {
      let passedConfig = null;
      let passedPrompt = null;

      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedConfig = params.config;
            passedPrompt = params.contents?.[0]?.parts?.find((p) => p.text)?.text;
            return {
              text: JSON.stringify({
                actions: [
                  {
                    actionId: 'act_001',
                    actionType: 'VIAL_INSERTION',
                    actionClass: 'VIAL_INSERTION_ACTION',
                    description: 'Operator places vial in slot A1',
                    startTime: '00:10',
                    endTime: '00:15',
                    startTimestampSeconds: 10.0,
                    endTimestampSeconds: 15.0,
                    confidenceScore: 0.98,
                    targetLocation: {
                      tower: 'Tower-A',
                      box: 'CryoBox-A1',
                      coordinate: 'A1',
                    },
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Inserting into A1',
        },
      });

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(passedConfig.temperature, 0.2);
      assert.strictEqual(passedConfig.maxOutputTokens, 16384);
      assert.strictEqual(passedConfig.responseMimeType, 'application/json');
      assert.deepStrictEqual(passedConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });
      assert.ok(passedPrompt.includes('CRITICAL TEMPORAL SCANNING INSTRUCTIONS:'));
      assert.ok(passedPrompt.includes('IMPORTANT - MULTI-ACTION TEMPORAL EXTRACTION:'));
      assert.ok(passedPrompt.includes('CRITICAL CONSTRAINTS:'));
      assert.ok(passedPrompt.includes('Explicitly forbidden: Repeating hierarchical taxonomy strings'));
      assert.ok(passedPrompt.includes('max 20 words'));
    });

    it('Pass 1: should retrieve durationSeconds from Firestore videoDoc and incorporate into temporal scanning instructions', async () => {
      let passedPrompt = '';
      let passedSystemInstruction = '';
      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedPrompt = params.contents?.[0]?.parts?.find((p) => p.text)?.text || '';
            passedSystemInstruction = params.config?.systemInstruction || '';
            return {
              text: JSON.stringify({
                videoId: 'vid_duration_test',
                actions: [
                  {
                    actionId: 'act_001',
                    actionType: 'VIAL_INSERTION',
                    description: 'Operator places vial in slot A1',
                    startTime: '00:05',
                    endTime: '00:10',
                    startTimestampSeconds: 5.0,
                    endTimestampSeconds: 10.0,
                    confidenceScore: 0.95,
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_duration_test.mp4',
        videoId: 'vid_duration_test',
        videoRecord: {
          durationSeconds: 240,
        },
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Four vials. Four vials.',
        },
      });

      assert.strictEqual(actions.length, 1);
      assert.ok(passedPrompt.includes('240s'));
      assert.ok(passedPrompt.includes('IGNORE verbal count cues from the audio transcript'));
      assert.ok(passedPrompt.includes('FIRST HALF and the SECOND HALF'));
      assert.ok(passedSystemInstruction.includes('240s'));
      assert.ok(passedSystemInstruction.includes('CRITICAL TEMPORAL SCANNING INSTRUCTIONS:'));
    });

    it('Pass 1: should warn on MAX_TOKENS finishReason and repair truncated JSON response', async () => {
      const warnedMessages = [];
      const originalWarn = console.warn;
      console.warn = (...args) => {
        warnedMessages.push(args.join(' '));
        originalWarn(...args);
      };

      try {
        const mockClient = {
          models: {
            generateContent: async () => {
              return {
                candidates: [
                  {
                    finishReason: 'MAX_TOKENS',
                  },
                ],
                text: '{\n  "videoId": "vid_test",\n  "actions": [\n    {\n      "actionId": "act_001",\n      "actionType": "VIAL_INSERTION",\n      "actionClass": "VIAL_INSERTION_ACTION",\n      "description": "Operator inserts vial into slot A1",\n      "startTime": "00:05",\n      "endTime": "00:10",\n      "startTimestampSeconds": 5.0,\n      "endTimestampSeconds": 10.0,\n      "confidenceScore": 0.95,\n      "targetLocation": { "tower": "Tower-A", "box": "CryoBox-A1", "coordinate": "A1" }\n    },\n    {\n      "actionId": "act_002",\n      "actionType": "VIAL_INSERTION",\n      "description": "Operator inserting into B',
              };
            },
          },
        };

        setGenAIClient(mockClient);

        const actions = await runPass1ActionDetection({
          videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
          classification: {
            workflowType: 'INVENTORY_UPDATE_WORKFLOW',
            transcribedAudio: 'Inserting vials',
          },
        });

        assert.strictEqual(actions.length, 1);
        assert.strictEqual(actions[0].actionId, 'act_001');
        assert.ok(warnedMessages.some((m) => m.includes('MAX_TOKENS')));
      } finally {
        console.warn = originalWarn;
      }
    });

    it('Pass 1: should throw descriptive error logging first 500 characters when unrepairable', async () => {
      const mockClient = {
        models: {
          generateContent: async () => {
            return {
              text: 'Not a valid JSON at all: ' + 'x'.repeat(600),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      await assert.rejects(
        async () => {
          await runPass1ActionDetection({
            videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_123.mp4',
            classification: {
              workflowType: 'INVENTORY_UPDATE_WORKFLOW',
              transcribedAudio: 'Testing invalid output',
            },
          });
        },
        (err) => {
          assert.ok(err.message.includes('[Pass 1] Failed to parse model JSON response'));
          assert.ok(err.message.includes('Payload preview:'));
          return true;
        }
      );
    });

    it('Pass 1: should support simplified targetCoordinate and reset passes.pass1.error to null', async () => {
      let passedSchema = null;
      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSchema = params.config?.responseSchema;
            return {
              text: JSON.stringify({
                workflowContext: 'INVENTORY_UPDATE_WORKFLOW',
                totalActionsDetected: 1,
                actions: [
                  {
                    actionId: 'act_001',
                    actionType: 'VIAL_INSERTION',
                    description: 'Operator transfers cryovial into slot A1',
                    startTime: '00:05',
                    endTime: '00:10',
                    startTimestampSeconds: 5.0,
                    endTimestampSeconds: 10.0,
                    confidenceScore: 0.98,
                    targetCoordinate: 'A1',
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_coord_test.mp4',
        videoId: 'vid_coord_test',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Inserting into A1',
        },
      });

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].targetCoordinate, 'A1');
      assert.strictEqual(actions[0].targetLocation?.coordinate, 'A1');
      assert.strictEqual(actions[0].boxRowId, 'A');
      assert.strictEqual(actions[0].boxColId, 1);
      assert.strictEqual(passedSchema?.properties?.actions?.items?.properties?.targetCoordinate?.type, 'STRING');
      assert.strictEqual(passedSchema?.properties?.actions?.items?.properties?.targetLocation, undefined);
    });

    it('Pass 1: should enforce strict scope restriction (VIAL_INSERTION & VIAL_REMOVAL) and include modelUsed metadata', async () => {
      let passedSchema = null;
      let passedPrompt = '';
      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSchema = params.config?.responseSchema;
            passedPrompt = params.contents?.[0]?.parts?.find((p) => p.text)?.text || '';
            return {
              text: JSON.stringify({
                workflowContext: 'INVENTORY_UPDATE_WORKFLOW',
                totalActionsDetected: 2,
                actions: [
                  {
                    actionId: 'act_001',
                    actionType: 'VIAL_INSERTION',
                    description: 'Operator inserts vial into slot A1',
                    startTime: '00:05',
                    endTime: '00:10',
                    startTimestampSeconds: 5.0,
                    endTimestampSeconds: 10.0,
                    confidenceScore: 0.98,
                    targetCoordinate: 'A1',
                  },
                  {
                    actionId: 'act_002',
                    actionType: 'VIAL_REMOVAL',
                    description: 'Operator removes vial from slot B2',
                    startTime: '00:15',
                    endTime: '00:20',
                    startTimestampSeconds: 15.0,
                    endTimestampSeconds: 20.0,
                    confidenceScore: 0.95,
                    targetCoordinate: 'B2',
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_scope_test.mp4',
        videoId: 'vid_scope_test',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Placing vial A1, removing vial B2',
        },
      });

      assert.strictEqual(actions.length, 2);
      assert.strictEqual(actions[0].actionType, 'VIAL_INSERTION');
      assert.strictEqual(actions[1].actionType, 'VIAL_REMOVAL');
      assert.strictEqual(actions.modelUsed, DEFAULT_PRO_MODEL);
      const pass1Json = actions.toJSON();
      assert.strictEqual(pass1Json.modelUsed, DEFAULT_PRO_MODEL);

      // Verify schema restrictions
      assert.deepStrictEqual(
        passedSchema?.properties?.actions?.items?.properties?.actionType?.enum,
        ['VIAL_INSERTION', 'VIAL_REMOVAL']
      );
      assert.strictEqual(passedSchema?.properties?.modelUsed?.type, 'STRING');

      // Verify prompt critical scope restriction
      assert.ok(passedPrompt.includes('CRITICAL SCOPE RESTRICTION:'));
      assert.ok(passedPrompt.includes("You MUST ONLY detect 'VIAL_INSERTION' (placing a vial into a slot) and 'VIAL_REMOVAL' (taking a vial out of a slot)."));
      assert.ok(passedPrompt.includes('Do NOT detect box removals, cap opening/closing, or box lid adjustments.'));
      assert.ok(passedPrompt.includes('Every single vial placed into or removed from the grid must be emitted as an independent action.'));
    });

    it('Pass 1: should eliminate count bias, unanchor schema minItems, exclude audio cues, and persist executionAudit', async () => {
      let passedSchema = null;
      let passedPrompt = '';
      const mockClient = {
        models: {
          generateContent: async (params) => {
            passedSchema = params.config?.responseSchema;
            passedPrompt = params.contents?.[0]?.parts?.find((p) => p.text)?.text || '';
            return {
              candidates: [
                {
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 120,
                candidatesTokenCount: 45,
                totalTokenCount: 165,
              },
              text: JSON.stringify({
                workflowContext: 'INVENTORY_UPDATE_WORKFLOW',
                totalActionsDetected: 1,
                actions: [
                  {
                    actionId: 'act_001',
                    actionType: 'VIAL_INSERTION',
                    description: 'Operator inserts vial into slot A1',
                    startTime: '00:05',
                    endTime: '00:10',
                    startTimestampSeconds: 5.0,
                    endTimestampSeconds: 10.0,
                    confidenceScore: 0.98,
                    targetCoordinate: 'A1',
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_audit_test.mp4',
        videoId: 'vid_audit_test',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Four vials placed here, wait maybe five',
        },
      });

      // 1. Schema assertions: minItems undefined, description verified
      assert.strictEqual(passedSchema?.properties?.actions?.minItems, undefined);
      assert.strictEqual(
        passedSchema?.properties?.actions?.description,
        'Exhaustive chronological array of all vial insertion and removal actions observed in the video.'
      );

      // 2. Prompt assertions: contains ground truth rules, no audio bias
      assert.ok(passedPrompt.includes('TASK: Detect EVERY distinct vial insertion into or removal from a cryo-rack or box.'));
      assert.ok(passedPrompt.includes('CRITICAL GROUND-TRUTH RULES:'));
      assert.strictEqual(passedPrompt.includes('Audible Context:'), false);
      assert.strictEqual(passedPrompt.includes('Four vials'), false);

      // 3. ExecutionAudit assertions on actions result object and JSON
      assert.ok(actions.executionAudit, 'actions object should have executionAudit');
      assert.strictEqual(actions.executionAudit.model, DEFAULT_PRO_MODEL);
      assert.ok(actions.executionAudit.promptText.includes('CRITICAL GROUND-TRUTH RULES:'));
      assert.deepStrictEqual(actions.executionAudit.generationConfig, {
        temperature: 0.2,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
        responseSchema: passedSchema,
        thinkingConfig: { thinkingLevel: 'MEDIUM' },
      });
      assert.deepStrictEqual(actions.executionAudit.modelDiagnostics, {
        finishReason: 'STOP',
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 45,
          totalTokenCount: 165,
        },
        thoughtsTokenCount: 0,
      });
      assert.ok(actions.executionAudit.videoMetadata.uri.includes('vid_audit_test.mp4'));

      // Check toJSON output
      const pass1Json = actions.toJSON();
      assert.ok(pass1Json.executionAudit, 'toJSON should include executionAudit');
      assert.strictEqual(pass1Json.executionAudit.model, DEFAULT_PRO_MODEL);

      // 4. Verify Firestore pass state contains executionAudit
      const videoPasses = await getVideoPasses('(default)', 'vid_audit_test');
      assert.ok(videoPasses?.passes?.pass1?.executionAudit, 'Firestore pass1 must contain executionAudit');
      assert.strictEqual(videoPasses.passes.pass1.executionAudit.model, DEFAULT_PRO_MODEL);
      assert.strictEqual(videoPasses.passes.pass1.status, 'COMPLETED');
    });

    it('Pass 1: should gracefully fallback to next candidate model when DEFAULT_PRO_MODEL returns 404 NOT_FOUND', async () => {
      let attempts = 0;
      const requestedModels = [];

      const mockClient = {
        models: {
          generateContent: async (params) => {
            attempts++;
            requestedModels.push(params.model);
            if (params.model === DEFAULT_PRO_MODEL) {
              const err = new Error('Publisher model not found: 404 NOT_FOUND');
              err.status = 404;
              throw err;
            }
            return {
              text: JSON.stringify({
                totalActionsDetected: 1,
                actions: [
                  {
                    actionId: 'act_fallback_01',
                    actionType: 'VIAL_INSERTION',
                    description: 'Vial inserted into A1',
                    startTime: '00:01',
                    endTime: '00:05',
                    startTimestampSeconds: 1,
                    endTimestampSeconds: 5,
                    confidenceScore: 0.95,
                    targetCoordinate: 'A1',
                  },
                ],
              }),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_fallback.mp4',
        videoId: 'vid_fallback',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Inserting vial A1',
        },
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(requestedModels, [DEFAULT_PRO_MODEL, 'gemini-1.5-pro-002']);
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions.modelUsed, DEFAULT_PRO_MODEL);
      assert.strictEqual(actions.executionAudit.model, DEFAULT_PRO_MODEL);
      assert.strictEqual(actions.executionAudit.modelUsed, DEFAULT_PRO_MODEL);
    });

    it('Pass 2: should extract sub-events, call frame extraction, and upload best-shot frames to GCS', async () => {
      const mockClient = {
        models: {
          generateContent: async () => {
            return {
              text: JSON.stringify([
                {
                  eventId: 'evt_301',
                  actionId: 'act_101',
                  eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
                  eventTrack: 'video',
                  startTime: 10.0,
                  endTime: 14.0,
                  bestShotTimes: [12.0],
                  refinementList: ['ref_301'],
                },
              ]),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const events = await runPass2EventDetection({
        videoGcsUri: 'gs://cust-video-manager-storage/normalized/vid_99.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Check vial label',
        },
        actions: [
          {
            actionId: 'act_101',
            actionClass: 'VIAL_INSERTION_ACTION',
            eventList: ['evt_301'],
          },
        ],
        customerId: 'cust_abc',
        videoId: 'vid_99',
      });

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].eventId, 'evt_301');
      assert.strictEqual(events[0].bestShotUrls.length, 1);
      assert.ok(
        events[0].bestShotUrls[0].includes('gs://cust_abc-video-manager-storage/frames/vid_99/'),
        'Frame URI must target gs://{customerId}-video-manager-storage/frames/{videoId}/'
      );
    });

    it('Pass 3: should perform high-resolution OCR conflation and spatial differencing', async () => {
      const mockClient = {
        models: {
          generateContent: async () => {
            return {
              text: JSON.stringify([
                {
                  refinementId: 'ref_401',
                  eventId: 'evt_301',
                  refinementClass: 'OCR_CONFLATION',
                  transcriptionText: 'HEK293 Passage 4 Lot 992',
                  spatialResult: {
                    row: 'B',
                    col: 3,
                  },
                  conflationMetadata: {
                    confidence: 0.99,
                    framesEvaluated: 3,
                    ocrEngine: 'Tesseract-MultiFrame',
                  },
                },
              ]),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      const refinements = await runPass3AnalysisRefinement({
        videoGcsUri: 'gs://cust_abc-video-manager-storage/normalized/vid_99.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          transcribedAudio: 'Vial check',
        },
        actions: [],
        events: [
          {
            eventId: 'evt_301',
            actionId: 'act_101',
            eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
            eventTrack: 'video',
            startTime: 10.0,
            endTime: 14.0,
            bestShotUrls: [
              'gs://cust_abc-video-manager-storage/frames/vid_99/frame_evt_301_12.jpg',
            ],
            bestShotTimes: [12.0],
            refinementList: ['ref_401'],
          },
        ],
        customerId: 'cust_abc',
        videoId: 'vid_99',
      });

      assert.strictEqual(refinements.length, 1);
      assert.strictEqual(refinements[0].refinementId, 'ref_401');
      assert.strictEqual(refinements[0].spatialResult.row, 'B');
      assert.strictEqual(refinements[0].spatialResult.col, 3);
      assert.strictEqual(refinements[0].conflationMetadata.confidence, 0.99);
    });
  });

  describe('5. Firestore Multi-Tenant Analysis Persistence', () => {
    it('should persist structured analysis in tenant video_analyses collection', async () => {
      const db = getTenantFirestore('tenant-db-lab1');

      let savedDocId = null;
      let savedData = null;

      db.collection = (colName) => {
        if (colName !== 'video_analyses') {
          return {
            doc: () => ({
              set: async () => ({ writeTime: new Date() }),
              update: async () => ({ writeTime: new Date() }),
              get: async () => ({ exists: false, data: () => ({}) }),
            }),
            get: async () => ({ empty: true, docs: [] }),
          };
        }
        return {
          doc: (docId) => {
            savedDocId = docId;
            return {
              set: async (data, options) => {
                savedData = data;
                return { writeTime: new Date() };
              },
              get: async () => ({
                exists: true,
                data: () => savedData,
              }),
            };
          },
        };
      };

      const analysisPayload = {
        workloadClassification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          inventoryName: 'Main LN2 Freezer',
          transcribedAudio: 'Adding vial to slot A1',
        },
        actions: [
          {
            actionId: 'act_01',
            actionClass: 'VIAL_INSERTION_ACTION',
            boxRowId: 'A',
            boxColId: 1,
            eventList: ['evt_01'],
          },
        ],
        events: [
          {
            eventId: 'evt_01',
            actionId: 'act_01',
            eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
            eventTrack: 'video',
            startTime: 1.0,
            endTime: 3.0,
            bestShotUrls: ['gs://tenant-video-manager-storage/frames/vid_01/frame.jpg'],
            bestShotTimes: [2.0],
            refinementList: [],
          },
        ],
        refinements: [],
        isSignedOff: false,
        updatedAt: new Date().toISOString(),
      };

      await saveVideoAnalysis('tenant-db-lab1', 'vid_01', analysisPayload);

      assert.strictEqual(savedDocId, 'vid_01');
      assert.strictEqual(savedData.isSignedOff, false);
      assert.strictEqual(
        savedData.workloadClassification.workflowType,
        'INVENTORY_UPDATE_WORKFLOW'
      );
      assert.strictEqual(savedData.actions.length, 1);

      const fetched = await getVideoAnalysis('tenant-db-lab1', 'vid_01');
      assert.strictEqual(fetched.isSignedOff, false);
    });
  });

  describe('6. End-to-End Pipeline Controller & Route (POST /api/pipeline/analyze)', () => {
    it('should return 400 when x-customer-id header is missing', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/pipeline/analyze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-database-id': 'db-1',
          },
          body: JSON.stringify({
            videoId: 'vid-1',
            videoGcsUri: 'gs://b/v.mp4',
          }),
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(data.error.includes('x-customer-id'));
      } finally {
        server.close();
      }
    });

    it('should return 400 when x-database-id header is missing', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/pipeline/analyze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': 'cust-1',
          },
          body: JSON.stringify({
            videoId: 'vid-1',
            videoGcsUri: 'gs://b/v.mp4',
          }),
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(data.error.includes('x-database-id'));
      } finally {
        server.close();
      }
    });

    it('should return 400 when videoId is missing in body', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/pipeline/analyze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': 'cust-1',
            'x-database-id': 'db-1',
          },
          body: JSON.stringify({
            videoGcsUri: 'gs://b/v.mp4',
          }),
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(data.error.includes('videoId'));
      } finally {
        server.close();
      }
    });

    it('should successfully orchestrate Pass 0 -> Pass 3 and persist structured analysis', async () => {
      let callCount = 0;
      const mockClient = {
        models: {
          generateContent: async (params) => {
            callCount++;
            // Pass 0 response
            if (callCount === 1) {
              return {
                text: JSON.stringify({
                  workflowType: 'INVENTORY_UPDATE_WORKFLOW',
                  inventoryName: 'Freezer-Alpha',
                  transcribedAudio: 'Placing HEK293 into slot B2',
                }),
              };
            }
            // Pass 1 response
            if (callCount === 2) {
              return {
                text: JSON.stringify([
                  {
                    actionId: 'act_e2e_01',
                    actionClass: 'VIAL_INSERTION_ACTION',
                    inventoryId: 'inv_alpha',
                    cellLineName: 'HEK293',
                    towerId: 'Tower-1',
                    boxRowId: 'B',
                    boxColId: 2,
                    eventList: ['evt_e2e_01'],
                  },
                ]),
              };
            }
            // Pass 2 response
            if (callCount === 3) {
              return {
                text: JSON.stringify([
                  {
                    eventId: 'evt_e2e_01',
                    actionId: 'act_e2e_01',
                    eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
                    eventTrack: 'video',
                    startTime: 5.0,
                    endTime: 8.0,
                    bestShotTimes: [6.5],
                    refinementList: ['ref_e2e_01'],
                  },
                ]),
              };
            }
            // Pass 3 response
            return {
              text: JSON.stringify([
                {
                  refinementId: 'ref_e2e_01',
                  eventId: 'evt_e2e_01',
                  refinementClass: 'OCR_CONFLATION',
                  transcriptionText: 'HEK293 Passage 3',
                  spatialResult: {
                    row: 'B',
                    col: 2,
                  },
                  conflationMetadata: {
                    confidence: 0.992,
                    framesEvaluated: 2,
                    ocrEngine: 'Tesseract-MultiFrame',
                  },
                },
              ]),
            };
          },
        },
      };

      setGenAIClient(mockClient);

      // Mock Firestore
      const db = getTenantFirestore('tenant-db-prod');
      let savedDoc = null;
      db.collection = (colName) => {
        if (colName !== 'video_analyses') {
          return {
            doc: () => ({
              set: async () => ({ writeTime: new Date() }),
              update: async () => ({ writeTime: new Date() }),
              get: async () => ({ exists: false, data: () => ({}) }),
            }),
            get: async () => ({ empty: true, docs: [] }),
          };
        }
        return {
          doc: (docId) => ({
            set: async (data) => {
              savedDoc = { docId, data };
              return { writeTime: new Date() };
            },
          }),
        };
      };

      const server = app.listen(0);
      const port = server.address().port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/pipeline/analyze`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': 'cust-ph3',
            'x-database-id': 'tenant-db-prod',
          },
          body: JSON.stringify({
            videoId: 'vid-ph3-100',
            videoGcsUri: 'gs://cust-ph3-video-manager-storage/normalized/norm_vid-ph3-100.mp4',
          }),
        });

        assert.strictEqual(response.status, 200);
        const data = await response.json();

        assert.strictEqual(data.success, true);
        assert.strictEqual(data.videoId, 'vid-ph3-100');
        assert.strictEqual(data.summary.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
        assert.strictEqual(data.summary.actionCount, 1);
        assert.strictEqual(data.summary.eventCount, 1);
        assert.strictEqual(data.summary.refinementCount, 1);

        // Verify Firestore persistence
        assert.ok(savedDoc, 'Analysis must be saved to Firestore');
        assert.strictEqual(savedDoc.docId, 'vid-ph3-100');
        assert.strictEqual(savedDoc.data.isSignedOff, false);
        assert.strictEqual(savedDoc.data.actions.length, 1);
        assert.strictEqual(savedDoc.data.events.length, 1);
        assert.strictEqual(savedDoc.data.refinements.length, 1);
        assert.ok(savedDoc.data.updatedAt, 'Must include updatedAt timestamp');
      } finally {
        server.close();
      }
    });

    it('should execute Pass 0 independently and persist status COMPLETED and validated data to Firestore videos/{videoId}.passes.pass0', async () => {
      const mockClient = {
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
              archiveName: null,
              inventoryName: null,
              transcribedAudio: 'Beginning pipetting into 96-well plate',
            }),
          }),
        },
      };

      setGenAIClient(mockClient);

      const server = app.listen(0);
      const port = server.address().port;

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/pipeline/analyze-pass`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': 'cust-ph3',
            'x-database-id': 'tenant-db-prod',
          },
          body: JSON.stringify({
            videoId: 'vid-pass0-standalone',
            pass: 0,
            videoGcsUri: 'gs://cust-ph3-video-manager-storage/normalized/norm_vid-pass0-standalone.mp4',
          }),
        });

        assert.strictEqual(response.status, 200);
        const data = await response.json();

        assert.strictEqual(data.success, true);
        assert.strictEqual(data.videoId, 'vid-pass0-standalone');
        assert.strictEqual(data.passes.pass0.status, 'COMPLETED');
        assert.ok(data.passes.pass0.data, 'Pass 0 data must be present');
        assert.strictEqual(data.passes.pass0.data.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
        assert.strictEqual(data.passes.pass0.data.archiveName, 'vid-pass0-standalone');

        // Check Firestore record directly
        const db = getTenantFirestore('tenant-db-prod');
        const docSnap = await db.collection('videos').doc('vid-pass0-standalone').get();
        assert.ok(docSnap.exists);
        const videoData = docSnap.data();
        assert.strictEqual(videoData.passes.pass0.status, 'COMPLETED');
        assert.strictEqual(videoData.passes.pass0.data.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
        assert.strictEqual(videoData.passes.pass0.data.archiveName, 'vid-pass0-standalone');
      } finally {
        server.close();
      }
    });
  });

  describe('7. Pass 1 (1 fps) Event Detection & Action Association + Pass 2 (4 fps) Dual Best Frames & Boundary Refinement', () => {
    it('should detect BOX_LABEL_PRESENTATION and VIAL_LABEL_PRESENTATION events in Pass 1 (1 fps) and associate them with vial actions (box-wide & spoken count "four vial")', async () => {
      let capturedPass1Request = null;
      setGenAIClient({
        models: {
          generateContent: async (params) => {
            capturedPass1Request = params;
            return {
              text: JSON.stringify({
                totalActionsDetected: 5,
                actions: [1, 2, 3, 4, 5].map((idx) => ({
                  actionId: `act_p1_vial_0${idx}`,
                  actionType: idx === 5 ? 'VIAL_REMOVAL' : 'VIAL_INSERTION',
                  startTimestampSeconds: idx * 10,
                  endTimestampSeconds: idx * 10 + 4,
                  startTime: `00:${idx * 10}`,
                  endTime: `00:${idx * 10 + 4}`,
                  targetLocation: {
                    tower: 'Tower A',
                    box: 'Box 1',
                    coordinate: `A${idx}`,
                  },
                  targetCoordinate: `A${idx}`,
                  description: `Vial action ${idx} in Box 1 slot A${idx}`,
                  confidenceScore: 0.96,
                })),
                events: [
                  {
                    eventId: 'evt_p1_box_label',
                    eventClass: 'BOX_LABEL_PRESENTATION',
                    eventTrack: 'video',
                    startTime: 1.0,
                    endTime: 4.0,
                    description: 'Operator presents Box 1 label at start of video',
                  },
                  {
                    eventId: 'evt_p1_vial_four',
                    eventClass: 'VIAL_LABEL_PRESENTATION',
                    eventTrack: 'video',
                    startTime: 5.0,
                    endTime: 8.5,
                    spokenContext: 'four vial',
                    description: 'Operator shows vial label to camera and says four vial',
                  },
                ],
              }),
            };
          },
        },
      });

      const pass1Actions = await runPass1ActionDetection({
        videoId: 'vid-pass1-events-01',
        customerId: 'cust-alpha',
        databaseId: 'db-alpha',
        videoGcsUri: 'gs://cust-alpha-video-manager-storage/normalized/norm_vid-pass1-events-01.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          inventoryName: 'CryoTank-Alpha',
          transcribedAudio: 'Showing Box 1 label, then HEK293 vial label, four vial insertions.',
        },
      });

      // Verify Pass 1 samples at 1 fps
      const pass1VideoPart = capturedPass1Request.contents[0].parts.find((p) => p.fileData);
      assert.strictEqual(pass1VideoPart.videoMetadata.fps, 1);

      // Verify Pass 1 detected 5 actions and 2 presentation events
      assert.strictEqual(pass1Actions.length, 5);
      assert.ok(Array.isArray(pass1Actions.events), 'Pass 1 must attach associated events');
      assert.strictEqual(pass1Actions.events.length, 2);

      const boxEvent = pass1Actions.events.find((e) => e.eventId === 'evt_p1_box_label');
      const vialEvent = pass1Actions.events.find((e) => e.eventId === 'evt_p1_vial_four');

      // Box label event at start of video is associated with all 5 subsequent actions in Box 1
      assert.deepStrictEqual(boxEvent.actionIds, [
        'act_p1_vial_01',
        'act_p1_vial_02',
        'act_p1_vial_03',
        'act_p1_vial_04',
        'act_p1_vial_05',
      ]);

      // Vial label event with spoken "four vial" is associated with the 4 subsequent vial actions
      assert.deepStrictEqual(vialEvent.actionIds, [
        'act_p1_vial_01',
        'act_p1_vial_02',
        'act_p1_vial_03',
        'act_p1_vial_04',
      ]);

      // Actions 1..4 should cross-link both events in eventList; Action 5 should cross-link the box event
      assert.deepStrictEqual(pass1Actions[0].eventList, ['evt_p1_box_label', 'evt_p1_vial_four']);
      assert.deepStrictEqual(pass1Actions[3].eventList, ['evt_p1_box_label', 'evt_p1_vial_four']);
      assert.deepStrictEqual(pass1Actions[4].eventList, ['evt_p1_box_label']);
    });

    it('should associate a BOX_LABEL_PRESENTATION event at the beginning of the video with all subsequent vial actions in that box and extract 2 best frames in Pass 2', async () => {
      const pass1Actions = [
        {
          actionId: 'act_box_01',
          actionClass: 'VIAL_INSERTION_ACTION',
          actionType: 'VIAL_INSERTION',
          startTimestampSeconds: 10.0,
          endTimestampSeconds: 14.0,
          startTime: '00:10',
          endTime: '00:14',
          targetLocation: { tower: 'Tower A', box: 'Box 1', coordinate: 'A1' },
          eventList: ['evt_box_label_1'],
        },
        {
          actionId: 'act_box_02',
          actionClass: 'VIAL_INSERTION_ACTION',
          actionType: 'VIAL_INSERTION',
          startTimestampSeconds: 18.0,
          endTimestampSeconds: 22.0,
          startTime: '00:18',
          endTime: '00:22',
          targetLocation: { tower: 'Tower A', box: 'Box 1', coordinate: 'A2' },
          eventList: ['evt_box_label_1'],
        },
        {
          actionId: 'act_box_03',
          actionClass: 'VIAL_REMOVAL_ACTION',
          actionType: 'VIAL_REMOVAL',
          startTimestampSeconds: 26.0,
          endTimestampSeconds: 30.0,
          startTime: '00:26',
          endTime: '00:30',
          targetLocation: { tower: 'Tower A', box: 'Box 1', coordinate: 'B1' },
          eventList: ['evt_box_label_1'],
        },
      ];
      const pass1Events = [
        {
          eventId: 'evt_box_label_1',
          actionId: 'act_box_01',
          actionIds: ['act_box_01', 'act_box_02', 'act_box_03'],
          eventClass: 'BOX_LABEL_PRESENTATION',
          eventTrack: 'video',
          startTime: 1.0,
          endTime: 4.5,
          description: 'Operator presents Box 1 label to camera before accessing slots',
          bestShotTimes: [],
          bestShotUrls: [],
          bestFrames: [],
          refinementList: [],
        },
      ];

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              events: [
                {
                  eventId: 'evt_box_label_1',
                  eventClass: 'BOX_LABEL_PRESENTATION',
                  eventTrack: 'video',
                  startTime: 1.0,
                  endTime: 4.5,
                  description: 'Operator presents Box 1 label to camera before accessing slots',
                  highestContrastTimestamp: 2.25,
                  minimalBlurTimestamp: 3.0,
                  bestShotTimes: [2.25, 3.0],
                },
              ],
              refinedActions: [
                {
                  actionId: 'act_box_01',
                  refinedStartTimestampSeconds: 9.75,
                  refinedEndTimestampSeconds: 14.25,
                },
                {
                  actionId: 'act_box_02',
                  refinedStartTimestampSeconds: 17.5,
                  refinedEndTimestampSeconds: 22.25,
                },
                {
                  actionId: 'act_box_03',
                  refinedStartTimestampSeconds: 25.75,
                  refinedEndTimestampSeconds: 30.5,
                },
              ],
            }),
          }),
        },
      });

      const events = await runPass2EventDetection({
        videoId: 'vid-box-assoc-01',
        customerId: 'cust-alpha',
        databaseId: 'db-alpha',
        videoGcsUri: 'gs://cust-alpha-video-manager-storage/normalized/norm_vid-box-assoc-01.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          inventoryName: 'CryoTank-Alpha',
          transcribedAudio: 'Opening Box 1 and performing three vial updates.',
        },
        actions: pass1Actions,
        events: pass1Events,
      });

      assert.strictEqual(events.length, 1);
      const boxEvt = events[0];
      assert.strictEqual(boxEvt.eventClass, 'BOX_LABEL_PRESENTATION');
      assert.deepStrictEqual(boxEvt.actionIds, ['act_box_01', 'act_box_02', 'act_box_03']);
      assert.strictEqual(boxEvt.bestFrames.length, 2);
      assert.strictEqual(boxEvt.bestFrames[0].frameType, 'HIGHEST_CONTRAST');
      assert.strictEqual(boxEvt.bestFrames[1].frameType, 'MINIMAL_BLUR');
      assert.strictEqual(boxEvt.bestShotUrls.length, 2);
    });

    it('should run Pass 2 at 4 fps ONLY on targeted Pass 1 action [start-1s, end+1s] and event windows (no 1 fps full-video scan)', async () => {
      const pass1Actions = [1, 2, 3, 4, 5].map((idx) => ({
        actionId: `act_vial_0${idx}`,
        actionClass: 'VIAL_INSERTION_ACTION',
        actionType: 'VIAL_INSERTION',
        startTimestampSeconds: idx * 10,
        endTimestampSeconds: idx * 10 + 4,
        startTime: `00:${idx * 10}`,
        endTime: `00:${idx * 10 + 4}`,
        eventList: idx <= 4 ? ['evt_vial_four'] : [],
      }));
      const pass1Events = [
        {
          eventId: 'evt_vial_four',
          actionId: 'act_vial_01',
          actionIds: ['act_vial_01', 'act_vial_02', 'act_vial_03', 'act_vial_04'],
          eventClass: 'VIAL_LABEL_PRESENTATION',
          eventTrack: 'video',
          startTime: 4.0,
          endTime: 8.0,
          spokenContext: 'four vial',
          description: 'Operator shows vial label to camera and says four vial',
          bestShotTimes: [],
          bestShotUrls: [],
          bestFrames: [],
          refinementList: [],
        },
      ];

      let capturedRequest = null;
      setGenAIClient({
        models: {
          generateContent: async (params) => {
            capturedRequest = params;
            return {
              text: JSON.stringify({
                events: [
                  {
                    eventId: 'evt_vial_four',
                    eventClass: 'VIAL_LABEL_PRESENTATION',
                    eventTrack: 'video',
                    startTime: 4.0,
                    endTime: 8.0,
                    spokenContext: 'four vial',
                    description: 'Operator shows vial label to camera and says four vial',
                    highestContrastTimestamp: 5.5,
                    minimalBlurTimestamp: 6.25,
                    bestShotTimes: [5.5, 6.25],
                  },
                ],
                refinedActions: pass1Actions.map((a) => ({
                  actionId: a.actionId,
                  refinedStartTimestampSeconds: a.startTimestampSeconds - 0.5,
                  refinedEndTimestampSeconds: a.endTimestampSeconds + 0.5,
                })),
              }),
            };
          },
        },
      });

      const events = await runPass2EventDetection({
        videoId: 'vid-four-vials-01',
        customerId: 'cust-alpha',
        databaseId: 'db-alpha',
        videoGcsUri: 'gs://cust-alpha-video-manager-storage/normalized/norm_vid-four-vials-01.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          inventoryName: 'CryoTank-Alpha',
          transcribedAudio: 'Showing HEK293 label, four vial insertions starting at A1.',
        },
        actions: pass1Actions,
        events: pass1Events,
      });

      assert.strictEqual(events.length, 1);
      const vialEvt = events[0];
      assert.strictEqual(vialEvt.eventClass, 'VIAL_LABEL_PRESENTATION');
      assert.strictEqual(vialEvt.actionIds.length, 4, 'Should preserve Pass 1 association with 4 subsequent vial actions');
      assert.deepStrictEqual(vialEvt.actionIds, [
        'act_vial_01',
        'act_vial_02',
        'act_vial_03',
        'act_vial_04',
      ]);

      // Verify 2 best frames (HIGHEST_CONTRAST and MINIMAL_BLUR) are recorded
      assert.strictEqual(vialEvt.bestFrames.length, 2);
      assert.strictEqual(vialEvt.highestContrastFrame.frameType, 'HIGHEST_CONTRAST');
      assert.strictEqual(vialEvt.minimalBlurFrame.frameType, 'MINIMAL_BLUR');
      assert.ok(vialEvt.highestContrastFrame.url.includes('/api/videos/vid-four-vials-01/frames/'));
      assert.ok(vialEvt.minimalBlurFrame.url.includes('/api/videos/vid-four-vials-01/frames/'));

      // Verify Pass 2 sends ONLY 4 fps clipped video parts (5 action windows + 1 event window = 6 parts, zero 1 fps full-video parts)
      const userParts = capturedRequest.contents[0].parts;
      const videoParts = userParts.filter((p) => p.fileData);
      const oneFpsParts = videoParts.filter((p) => p.videoMetadata && p.videoMetadata.fps === 1);
      const fourFpsParts = videoParts.filter((p) => p.videoMetadata && p.videoMetadata.fps === 4);
      assert.strictEqual(oneFpsParts.length, 0, 'Pass 2 must not scan the full video at 1 fps');
      assert.strictEqual(
        fourFpsParts.length,
        6,
        'Pass 2 must include 4 fps clipped windows for the 5 Pass 1 actions and 1 Pass 1 presentation event'
      );
      assert.deepStrictEqual(fourFpsParts[0].videoMetadata, {
        fps: 4,
        startOffset: '9s',
        endOffset: '15s',
      });
      assert.deepStrictEqual(fourFpsParts[5].videoMetadata, {
        fps: 4,
        startOffset: '4s',
        endOffset: '8s',
      });

      // Verify refinedActions clamp strictly to [start - 1s, end + 1s]
      assert.strictEqual(events.refinedActions.length, 5);
      assert.strictEqual(events.refinedActions[0].searchWindowStartSeconds, 9);
      assert.strictEqual(events.refinedActions[0].searchWindowEndSeconds, 15);
      assert.strictEqual(events.refinedActions[0].refinedStartTimestampSeconds, 9.5);
      assert.strictEqual(events.refinedActions[0].refinedEndTimestampSeconds, 14.5);
      assert.strictEqual(events.refinedActions[0].fps, 4);
    });

    it('should prioritize clear label visibility for presentation events (allowing both frames to be the same) and refine action interval boundaries without before/after box frame selection, reporting refinedActions in event_detection_pass.json', async () => {
      const pass1Actions = [
        {
          actionId: 'act_refined_01',
          actionClass: 'VIAL_INSERTION_ACTION',
          actionType: 'VIAL_INSERTION',
          startTimestampSeconds: 10.0,
          endTimestampSeconds: 14.0,
          startTime: '00:10',
          endTime: '00:14',
          eventList: ['evt_same_frame_box', 'evt_same_frame_vial'],
        },
      ];
      const pass1Events = [
        {
          eventId: 'evt_same_frame_box',
          actionId: 'act_refined_01',
          actionIds: ['act_refined_01'],
          eventClass: 'BOX_LABEL_PRESENTATION',
          eventTrack: 'video',
          startTime: 1.0,
          endTime: 3.0,
          description: 'Operator shows Box 1 label clearly to camera at 2.25s',
          bestShotTimes: [],
          bestShotUrls: [],
          bestFrames: [],
          refinementList: [],
        },
        {
          eventId: 'evt_same_frame_vial',
          actionId: 'act_refined_01',
          actionIds: ['act_refined_01'],
          eventClass: 'VIAL_LABEL_PRESENTATION',
          eventTrack: 'video',
          startTime: 4.0,
          endTime: 7.0,
          description: 'Operator shows vial label clearly to camera at 5.75s',
          bestShotTimes: [],
          bestShotUrls: [],
          bestFrames: [],
          refinementList: [],
        },
      ];

      let capturedPass2Request = null;
      setGenAIClient({
        models: {
          generateContent: async (params) => {
            capturedPass2Request = params;
            return {
              text: JSON.stringify({
                events: [
                  {
                    eventId: 'evt_same_frame_box',
                    eventClass: 'BOX_LABEL_PRESENTATION',
                    eventTrack: 'video',
                    startTime: 1.0,
                    endTime: 3.0,
                    highestContrastTimestamp: 2.25,
                    minimalBlurTimestamp: 2.25,
                    bestShotTimes: [2.25, 2.25],
                  },
                  {
                    eventId: 'evt_same_frame_vial',
                    eventClass: 'VIAL_LABEL_PRESENTATION',
                    eventTrack: 'video',
                    startTime: 4.0,
                    endTime: 7.0,
                    highestContrastTimestamp: 5.75,
                    minimalBlurTimestamp: 5.75,
                    bestShotTimes: [5.75, 5.75],
                  },
                ],
                refinedActions: [
                  {
                    actionId: 'act_refined_01',
                    refinedStartTimestampSeconds: 9.25,
                    refinedEndTimestampSeconds: 14.75,
                  },
                ],
              }),
            };
          },
        },
      });

      const events = await runPass2EventDetection({
        videoId: 'vid-same-frame-refined-01',
        customerId: 'cust-alpha',
        databaseId: 'db-alpha',
        videoGcsUri: 'gs://cust-alpha-video-manager-storage/normalized/norm_vid-same-frame-refined-01.mp4',
        classification: {
          workflowType: 'INVENTORY_UPDATE_WORKFLOW',
          inventoryName: 'CryoTank-Alpha',
        },
        actions: pass1Actions,
        events: pass1Events,
      });

      assert.strictEqual(events.length, 2);
      // Both frames are allowed to have the exact same timestamp when a single frame best shows the label clearly to the camera
      assert.deepStrictEqual(events[0].bestShotTimes, [2.25, 2.25]);
      assert.strictEqual(events[0].highestContrastFrame.timestampSeconds, 2.25);
      assert.strictEqual(events[0].minimalBlurFrame.timestampSeconds, 2.25);
      assert.deepStrictEqual(events[1].bestShotTimes, [5.75, 5.75]);
      assert.strictEqual(events[1].highestContrastFrame.timestampSeconds, 5.75);
      assert.strictEqual(events[1].minimalBlurFrame.timestampSeconds, 5.75);

      // Verify action interval boundaries are refined in-place and before/after frame fields are omitted
      assert.strictEqual(pass1Actions[0].refinedStartTimestampSeconds, 9.25);
      assert.strictEqual(pass1Actions[0].refinedEndTimestampSeconds, 14.75);
      assert.strictEqual(pass1Actions[0].startTimestampSeconds, 9.25);
      assert.strictEqual(pass1Actions[0].endTimestampSeconds, 14.75);
      assert.strictEqual(pass1Actions[0].beforeActionFrame, undefined);
      assert.strictEqual(pass1Actions[0].afterActionFrame, undefined);
      assert.strictEqual(pass1Actions[0].firstFrame, undefined);
      assert.strictEqual(pass1Actions[0].lastFrame, undefined);

      // Verify serialized event_detection_pass.json payload includes both events and refinedActions
      const serializedPass2Json = JSON.parse(JSON.stringify(events));
      assert.strictEqual(Array.isArray(serializedPass2Json.events), true);
      assert.strictEqual(serializedPass2Json.events.length, 2);
      assert.strictEqual(Array.isArray(serializedPass2Json.refinedActions), true);
      assert.strictEqual(serializedPass2Json.refinedActions.length, 1);
      assert.strictEqual(serializedPass2Json.refinedActions[0].actionId, 'act_refined_01');
      assert.strictEqual(serializedPass2Json.refinedActions[0].actionType, 'VIAL_INSERTION');
      assert.strictEqual(serializedPass2Json.refinedActions[0].refinedStartTimestampSeconds, 9.25);
      assert.strictEqual(serializedPass2Json.refinedActions[0].refinedEndTimestampSeconds, 14.75);
      assert.strictEqual(serializedPass2Json.refinedActions[0].beforeActionFrame, undefined);
      assert.strictEqual(serializedPass2Json.refinedActions[0].afterActionFrame, undefined);

      // Verify prompt and system instruction contain label visibility rules and refined interval boundary rules (no before/after frame selection)
      const promptPart = capturedPass2Request.contents[0].parts.find((p) => p.text);
      assert.ok(promptPart.text.includes('shows the label clearly to the camera'));
      assert.ok(promptPart.text.includes('secondary properties'));
      assert.ok(promptPart.text.includes('It is OK if both frames are the same'));
      assert.ok(promptPart.text.includes('refine the action interval boundaries ("refinedStartTimestampSeconds" and "refinedEndTimestampSeconds") at 4 fps'));
      assert.ok(!promptPart.text.includes('ZERO HAND OCCLUSION MANDATE'));
      assert.ok(capturedPass2Request.config.systemInstruction.includes('shows the label clearly to the camera'));
      assert.ok(capturedPass2Request.config.systemInstruction.includes('Refining Vial Insertion & Removal Action Interval Boundaries (Pass 2 @ 4 fps)'));

      // Verify Pass 2 defaults to thinkingLevel MEDIUM and passes thinkingConfig to Gemini
      assert.deepStrictEqual(capturedPass2Request.config.thinkingConfig, {
        thinkingLevel: 'MEDIUM',
      });
      assert.strictEqual(events.thinkingLevel, 'MEDIUM');
      assert.strictEqual(events.executionAudit.thinkingLevel, 'MEDIUM');
      assert.deepStrictEqual(events.executionAudit.generationConfig.thinkingConfig, {
        thinkingLevel: 'MEDIUM',
      });
    });

    it('should support configurable thinkingLevel (e.g. HIGH or OFF) for Pass 2 and Pass 3', async () => {
      let lastRequestConfig = null;
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            lastRequestConfig = req.config;
            return {
              text: JSON.stringify({ events: [], refinedActions: [] }),
            };
          },
        },
      });

      const eventsHigh = await runPass2EventDetection({
        videoId: 'vid-thinking-p2',
        videoGcsUri: 'gs://test-bucket/normalized/norm_vid-thinking-p2.mp4',
        thinkingLevel: 'HIGH',
        actions: [
          {
            actionId: 'act-1',
            actionType: 'VIAL_INSERTION',
            startTime: '00:05.0',
            endTime: '00:08.0',
            startTimestampSeconds: 5,
            endTimestampSeconds: 8,
            description: 'Insert vial',
            confidence: 0.95,
          },
        ],
      });
      assert.deepStrictEqual(lastRequestConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
      assert.strictEqual(eventsHigh.thinkingLevel, 'HIGH');

      const eventsOff = await runPass2EventDetection({
        videoId: 'vid-thinking-p2-off',
        videoGcsUri: 'gs://test-bucket/normalized/norm_vid-thinking-p2-off.mp4',
        thinkingLevel: 'OFF',
        actions: [
          {
            actionId: 'act-1',
            actionType: 'VIAL_INSERTION',
            startTime: '00:05.0',
            endTime: '00:08.0',
            startTimestampSeconds: 5,
            endTimestampSeconds: 8,
            description: 'Insert vial',
            confidence: 0.95,
          },
        ],
      });
      assert.strictEqual(lastRequestConfig.thinkingConfig, undefined);
      assert.strictEqual(eventsOff.thinkingLevel, 'OFF');

      setGenAIClient({
        models: {
          generateContent: async (req) => {
            lastRequestConfig = req.config;
            return {
              text: JSON.stringify([]),
            };
          },
        },
      });

      const refinementsDefault = await runPass3AnalysisRefinement({
        videoId: 'vid-thinking-p3',
        videoGcsUri: 'gs://test-bucket/normalized/norm_vid-thinking-p3.mp4',
        events: [],
      });
      assert.deepStrictEqual(lastRequestConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });
      assert.strictEqual(refinementsDefault.thinkingLevel, 'MEDIUM');
      assert.strictEqual(refinementsDefault.executionAudit.thinkingLevel, 'MEDIUM');
      assert.strictEqual(refinementsDefault.executionAudit.model, 'gemini-1.5-pro');
    });

    it('should enforce no temporal overlap between neighboring intervals in Pass 2 and record targetModel & thinkingLevel in executionAudit', async () => {
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            if (req.model === 'gemini-1.5-pro' || req.model === 'gemini-1.5-pro-002') {
              const err = new Error('404 Model not found');
              err.status = 404;
              throw err;
            }
            return {
              text: JSON.stringify({
                events: [],
                refinedActions: [
                  {
                    actionId: 'act-1',
                    beforeActionTimestampSeconds: 9.2,
                    afterActionTimestampSeconds: 15.0,
                    refinedStartTimestampSeconds: 9.2,
                    refinedEndTimestampSeconds: 15.0,
                  },
                  {
                    actionId: 'act-2',
                    beforeActionTimestampSeconds: 13.8,
                    afterActionTimestampSeconds: 18.5,
                    refinedStartTimestampSeconds: 13.8,
                    refinedEndTimestampSeconds: 18.5,
                  },
                ],
              }),
            };
          },
        },
      });

      const actions = [
        {
          actionId: 'act-1',
          actionType: 'VIAL_INSERTION',
          startTime: '00:10.0',
          endTime: '00:14.0',
          startTimestampSeconds: 10,
          endTimestampSeconds: 14,
          description: 'Insert vial 1',
          confidence: 0.95,
        },
        {
          actionId: 'act-2',
          actionType: 'VIAL_INSERTION',
          startTime: '00:14.5',
          endTime: '00:18.0',
          startTimestampSeconds: 14.5,
          endTimestampSeconds: 18,
          description: 'Insert vial 2',
          confidence: 0.95,
        },
      ];

      const events = await runPass2EventDetection({
        videoId: 'vid-no-overlap-p2',
        videoGcsUri: 'gs://test-bucket/normalized/norm_vid-no-overlap-p2.mp4',
        model: 'gemini-1.5-pro',
        thinkingLevel: 'MEDIUM',
        actions,
      });

      // Verify model discrepancy is fixed: executionAudit.model is targetModel ('gemini-1.5-pro'), not fallback 'gemini-4-argon'
      assert.strictEqual(events.modelUsed, 'gemini-1.5-pro');
      assert.strictEqual(events.executionAudit.model, 'gemini-1.5-pro');
      assert.strictEqual(events.executionAudit.thinkingLevel, 'MEDIUM');

      // Verify neighboring refined action intervals do NOT overlap in time
      assert.strictEqual(events.refinedActions.length, 2);
      const r1 = events.refinedActions[0];
      const r2 = events.refinedActions[1];
      assert.ok(
        r1.searchWindowEndSeconds <= r2.searchWindowStartSeconds,
        `Expected search windows not to overlap: ${r1.searchWindowEndSeconds} <= ${r2.searchWindowStartSeconds}`
      );
      assert.ok(
        r1.refinedEndTimestampSeconds <= r2.refinedStartTimestampSeconds,
        `Expected refined intervals not to overlap: ${r1.refinedEndTimestampSeconds} <= ${r2.refinedStartTimestampSeconds}`
      );
      assert.ok(actions[0].endTimestampSeconds <= actions[1].startTimestampSeconds);
    });
  });
});
