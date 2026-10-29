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
} = require('../dist/services/gemini.service');

const {
  getTenantFirestore,
  saveVideoAnalysis,
  getVideoAnalysis,
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
        assert.strictEqual(colName, 'video_analyses');
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
        assert.strictEqual(colName, 'video_analyses');
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
  });
});
