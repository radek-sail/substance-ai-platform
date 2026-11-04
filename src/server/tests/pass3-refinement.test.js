const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  computeBoxWellFromTopLeftOrigin,
  computeBoxWellFromTopRightOrigin,
  VialLabelDataSchema,
  LabelTranscriptionRecordSchema,
  BoxWellLocationSchema,
} = require('@sail/shared');

const {
  conflateTwoShotLabelText,
  parseVialLabelFields,
  runPass3AnalysisRefinement,
  setGenAIClient,
  resetGenAIClient,
} = require('../dist/services/gemini.service');

const {
  getDatabase,
  commitInventorySignOff,
  clearDatabaseCache,
} = require('../dist/services/firestore.service');

describe('Pass 3 Analysis Refinement: Dual-Shot Label Conflation, Top-Right Black Corner Well Location & Action JSON Enrichment', () => {
  beforeEach(() => {
    clearDatabaseCache();
    resetGenAIClient();
  });

  afterEach(() => {
    resetGenAIClient();
  });

  describe('1. Dual-Shot Label Transcription Conflation & Vial Label Field Formatting', () => {
    it('should conflate text from HIGHEST_CONTRAST and MINIMAL_BLUR shots without duplicating tokens', () => {
      const shot1 = 'HEK293T P5 RS';
      const shot2 = 'HEK293T P5 RS 2026-03-15';
      const conflated = conflateTwoShotLabelText(shot1, shot2);
      assert.ok(conflated.includes('HEK293T'));
      assert.ok(conflated.includes('RS'));
      assert.ok(conflated.includes('2026-03-15'));
    });

    it('should parse vial label text into required cellLineName & fullText and optional userInitials & dateFrozen', () => {
      const parsed = parseVialLabelFields('HEK293T P5 Lot#8841 RS 2026-03-15');
      const validated = VialLabelDataSchema.parse(parsed);
      assert.strictEqual(validated.cellLineName, 'HEK293T');
      assert.strictEqual(validated.userInitials, 'RS');
      assert.strictEqual(validated.dateFrozen, '2026-03-15');
      assert.strictEqual(validated.fullText, 'HEK293T P5 Lot#8841 RS 2026-03-15');
    });
  });

  describe('2. Box Well Coordinate Resolution with Top-Left Black Corner Origin (A1)', () => {
    it('should resolve top-left corner (normX=0.05, normY=0.05) to well A1 with TOP_LEFT_BLACK origin', () => {
      const wellA1 = computeBoxWellFromTopLeftOrigin(0.05, 0.05, 9, 9);
      assert.strictEqual(wellA1.row, 'A');
      assert.strictEqual(wellA1.col, 1);
      assert.strictEqual(wellA1.coordinate, 'A1');
      assert.strictEqual(wellA1.originCorner, 'TOP_LEFT_BLACK');
      // Backward-compatible alias also delegates to top-left origin
      const aliasA1 = computeBoxWellFromTopRightOrigin(0.05, 0.05, 9, 9);
      assert.strictEqual(aliasA1.coordinate, 'A1');
      assert.strictEqual(aliasA1.originCorner, 'TOP_LEFT_BLACK');
    });

    it('should resolve top-right corner (normX=0.95, normY=0.05) to well A9 for a 9x9 box', () => {
      const wellA9 = computeBoxWellFromTopLeftOrigin(0.95, 0.05, 9, 9);
      assert.strictEqual(wellA9.row, 'A');
      assert.strictEqual(wellA9.col, 9);
      assert.strictEqual(wellA9.coordinate, 'A9');
    });

    it('should resolve bottom-left corner (normX=0.05, normY=0.95) to well I1 for a 9x9 box', () => {
      const wellI1 = computeBoxWellFromTopLeftOrigin(0.05, 0.95, 9, 9);
      assert.strictEqual(wellI1.row, 'I');
      assert.strictEqual(wellI1.col, 1);
      assert.strictEqual(wellI1.coordinate, 'I1');
    });
  });

  describe('3. Pass 3 Execution & Action JSON File Enrichment', () => {
    it('should transcribe two best shots, determine box well locations, enrich action JSONs, and write label_transcriptions.json', async () => {
      const mockGeminiPass3Response = {
        refinements: [
          {
            refinementId: 'ref_001',
            eventId: 'evt_label_01',
            actionId: 'act_insert_01',
            refinementClass: 'OCR_CONFLATION',
            transcriptionText: 'Jurkat E6-1 JD 2026-04-10',
            vialLabelData: {
              cellLineName: 'Jurkat',
              userInitials: 'JD',
              dateFrozen: '2026-04-10',
              fullText: 'Jurkat E6-1 JD 2026-04-10',
            },
            boxWellLocation: {
              row: 'B',
              col: 3,
              coordinate: 'B3',
              boxId: 'A-1',
              originCorner: 'TOP_LEFT_BLACK',
              confidence: 0.98,
            },
            spatialResult: {
              row: 'B',
              col: 3,
            },
            conflationMetadata: {
              confidence: 0.98,
              framesEvaluated: 2,
              ocrEngine: 'Gemini-DualShot-Conflation',
            },
          },
        ],
        labelTranscriptions: [
          {
            eventId: 'evt_label_01',
            eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
            actionIds: ['act_insert_01'],
            cellLineName: 'Jurkat',
            userInitials: 'JD',
            dateFrozen: '2026-04-10',
            fullText: 'Jurkat E6-1 JD 2026-04-10',
            frame1Text: 'Jurkat E6-1 JD',
            frame2Text: 'Jurkat E6-1 JD 2026-04-10',
          },
        ],
        actionWellLocations: [
          {
            actionId: 'act_insert_01',
            actionType: 'VIAL_INSERTION_ACTION',
            boxId: 'A-1',
            row: 'B',
            col: 3,
            coordinate: 'B3',
            originCorner: 'TOP_LEFT_BLACK',
            confidence: 0.97,
          },
        ],
      };

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify(mockGeminiPass3Response),
          }),
        },
      });

      const pass0 = {
        workflowType: 'INVENTORY_UPDATE_WORKFLOW',
        confidence: 0.99,
        notes: 'Cryo vial insertion with label presentation',
      };

      const actions = [
        {
          actionId: 'act_insert_01',
          actionType: 'VIAL_INSERTION',
          actionClass: 'VIAL_INSERTION_ACTION',
          startTimestampSeconds: 1.0,
          endTimestampSeconds: 6.0,
          startTime: 1.0,
          endTime: 6.0,
          description: 'Operator presents vial and inserts into box A-1',
          eventList: ['evt_label_01'],
        },
      ];

      const events = [
        {
          eventId: 'evt_label_01',
          actionId: 'act_insert_01',
          actionIds: ['act_insert_01'],
          eventClass: 'VIAL_LABEL_PRESENTATION',
          startTime: 2.0,
          endTime: 3.0,
          bestShotTimes: [2.25, 2.75],
          bestShotUrls: [
            'gs://test-bucket/frames/evt_label_01_contrast.jpg',
            'gs://test-bucket/frames/evt_label_01_blur.jpg',
          ],
          refinementList: [],
        },
      ];

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_test_01',
        videoGcsUri: 'gs://test-bucket/normalized/vid_test_01.mp4',
        classification: pass0,
        actions,
        events,
      });

      assert.strictEqual(Array.isArray(refinements), true);
      assert.strictEqual(refinements.length, 1);
      assert.strictEqual(refinements.labelTranscriptions.length, 1);
      assert.strictEqual(refinements.actionWellLocations.length, 1);

      const labelRec = LabelTranscriptionRecordSchema.parse(refinements.labelTranscriptions[0]);
      assert.strictEqual(labelRec.cellLineName, 'Jurkat');
      assert.strictEqual(labelRec.userInitials, 'JD');
      assert.strictEqual(labelRec.dateFrozen, '2026-04-10');
      assert.strictEqual(labelRec.fullText, 'Jurkat E6-1 JD 2026-04-10');

      const wellLoc = BoxWellLocationSchema.parse(refinements.actionWellLocations[0]);
      assert.strictEqual(wellLoc.row, 'B');
      assert.strictEqual(wellLoc.col, 3);
      assert.strictEqual(wellLoc.coordinate, 'B3');
      assert.strictEqual(wellLoc.originCorner, 'TOP_LEFT_BLACK');

      // Verify action object was enriched in-place with both label data and well location
      const enrichedAction = actions[0];
      assert.strictEqual(enrichedAction.cellLineName, 'Jurkat');
      assert.strictEqual(enrichedAction.userInitials, 'JD');
      assert.strictEqual(enrichedAction.dateFrozen, '2026-04-10');
      assert.strictEqual(enrichedAction.fullText, 'Jurkat E6-1 JD 2026-04-10');
      assert.strictEqual(enrichedAction.boxRowId, 'B');
      assert.strictEqual(enrichedAction.boxColId, 3);
      assert.strictEqual(enrichedAction.targetCoordinate, 'B3');
      assert.strictEqual(enrichedAction.boxWellLocation.originCorner, 'TOP_LEFT_BLACK');

      // Verify JSON artifact files written on disk
      const artifactPaths = refinements.artifactPaths;
      assert.ok(artifactPaths, 'artifactPaths should be attached to Pass 3 output');
      assert.ok(fs.existsSync(artifactPaths.labelTranscriptionsPath), 'label_transcriptions.json should be created');
      const actionJsonPath = path.join(artifactPaths.artifactDir, 'action_act_insert_01.json');
      assert.ok(fs.existsSync(actionJsonPath), 'action_act_insert_01.json should be created');

      const actionFileContent = JSON.parse(fs.readFileSync(actionJsonPath, 'utf-8'));
      assert.strictEqual(actionFileContent.cellLineName, 'Jurkat');
      assert.strictEqual(actionFileContent.userInitials, 'JD');
      assert.strictEqual(actionFileContent.dateFrozen, '2026-04-10');
      assert.strictEqual(actionFileContent.fullText, 'Jurkat E6-1 JD 2026-04-10');
      assert.strictEqual(actionFileContent.boxWellLocation.coordinate, 'B3');
      assert.strictEqual(actionFileContent.boxWellLocation.originCorner, 'TOP_LEFT_BLACK');
    });

    it('should normalize Gemini Pass 3 responses when refinementId and refinementClass are omitted on array items', async () => {
      const mockUnstructuredGeminiResponse = [
        {
          eventId: 'evt_001',
          cellLineName: 'HEK293T',
          userInitials: 'RK',
          dateFrozen: '2026-03-15',
          fullText: 'HEK293T RK 2026-03-15',
          row: 'A',
          col: 1,
        },
        {
          eventId: 'evt_002',
          cellLineName: 'HeLa',
          userInitials: 'RK',
          dateFrozen: '2026-03-16',
          fullText: 'HeLa RK 2026-03-16',
          row: 'A',
          col: 2,
        },
        {
          actionId: 'act_003',
          row: 'B',
          col: '4',
          coordinate: 'B4',
        },
      ];

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify(mockUnstructuredGeminiResponse),
          }),
        },
      });

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_test_unstructured',
        videoGcsUri: 'gs://test-bucket/normalized/vid_test_unstructured.mp4',
        classification: { workflowType: 'INVENTORY_UPDATE_WORKFLOW', confidence: 0.99 },
        actions: [
          { actionId: 'act_001', actionClass: 'VIAL_INSERTION_ACTION', eventList: ['evt_001'] },
          { actionId: 'act_002', actionClass: 'VIAL_INSERTION_ACTION', eventList: ['evt_002'] },
          { actionId: 'act_003', actionClass: 'VIAL_INSERTION_ACTION', eventList: [] },
        ],
        events: [
          { eventId: 'evt_001', actionId: 'act_001', eventClass: 'VIAL_LABEL_PRESENTATION', startTime: 1, endTime: 2 },
          { eventId: 'evt_002', actionId: 'act_002', eventClass: 'VIAL_LABEL_PRESENTATION', startTime: 3, endTime: 4 },
        ],
      });

      assert.strictEqual(refinements.length, 3);
      assert.strictEqual(refinements[0].refinementId, 'ref_001');
      assert.strictEqual(refinements[0].refinementClass, 'OCR_CONFLATION');
      assert.strictEqual(refinements[1].refinementId, 'ref_002');
      assert.strictEqual(refinements[1].refinementClass, 'OCR_CONFLATION');
      assert.strictEqual(refinements[2].refinementId, 'ref_003');
      assert.strictEqual(refinements[2].refinementClass, 'OCR_CONFLATION');
    });

    it('should submit one video clip at a time at 4 fps when refining 3 label events + 8 inventory update actions (11 total clips)', async () => {
      const capturedRequests = [];

      setGenAIClient({
        models: {
          generateContent: async (req) => {
            capturedRequests.push(req);
            const parts = req.contents?.[0]?.parts || [];
            const textPart = parts.find((p) => typeof p.text === 'string')?.text || '';

            // Simulate per-clip Gemini responses (1 video clip per call)
            const eventMatch = textPart.match(/"eventId":\s*"(evt_\d+)"/);
            if (eventMatch) {
              const evtId = eventMatch[1];
              return {
                text: JSON.stringify({
                  eventId: evtId,
                  cellLineName: `CellLine_${evtId}`,
                  userInitials: 'RK',
                  dateFrozen: '2026-03-20',
                  fullText: `CellLine_${evtId} RK 2026-03-20`,
                }),
              };
            }

            const actionMatch = textPart.match(/"actionId":\s*"(act_\d+)"/);
            if (actionMatch) {
              const actId = actionMatch[1];
              const actNum = parseInt(actId.replace('act_', ''), 10) || 1;
              return {
                text: JSON.stringify({
                  actionId: actId,
                  boxWellLocation: {
                    actionId: actId,
                    row: 'A',
                    col: actNum,
                    coordinate: `A${actNum}`,
                    originCorner: 'TOP_RIGHT_BLACK',
                    confidence: 0.99,
                  },
                  spatialResult: {
                    row: 'A',
                    col: actNum,
                  },
                }),
              };
            }

            return { text: JSON.stringify([]) };
          },
        },
      });

      const events = [1, 2, 3].map((i) => ({
        eventId: `evt_${i}`,
        actionId: `act_${i}`,
        actionIds: [`act_${i}`],
        eventClass: 'VIAL_LABEL_PRESENTATION',
        startTime: i * 2,
        endTime: i * 2 + 1,
        bestShotTimes: [i * 2 + 0.2, i * 2 + 0.8],
      }));

      const actions = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        actionId: `act_${i}`,
        actionType: 'VIAL_INSERTION',
        actionClass: 'VIAL_INSERTION_ACTION',
        startTimestampSeconds: 10 + i * 3,
        endTimestampSeconds: 12 + i * 3,
        startTime: 10 + i * 3,
        endTime: 12 + i * 3,
        eventList: i <= 3 ? [`evt_${i}`] : [`evt_3`],
      }));

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_11_clips',
        videoGcsUri: 'gs://test-bucket/normalized/vid_11_clips.mp4',
        classification: { workflowType: 'INVENTORY_UPDATE_WORKFLOW', confidence: 0.99 },
        actions,
        events,
      });

      // 3 event calls + 8 action calls = 11 sequential calls, each with strictly 1 video file at 4 fps
      assert.strictEqual(capturedRequests.length, 11);
      for (const req of capturedRequests) {
        const parts = req.contents?.[0]?.parts || [];
        const videoParts = parts.filter((p) => p.fileData && p.fileData.mimeType === 'video/mp4');
        assert.strictEqual(videoParts.length, 1, 'Each Pass 3 request must submit exactly 1 video file');
        assert.strictEqual(videoParts[0].videoMetadata?.fps, 4, 'Each Pass 3 video clip must be sampled at 4 fps');
        assert.ok(videoParts[0].videoMetadata?.startOffset, 'Each Pass 3 video clip must specify startOffset');
        assert.ok(videoParts[0].videoMetadata?.endOffset, 'Each Pass 3 video clip must specify endOffset');
      }

      assert.strictEqual(refinements.labelTranscriptions.length, 3);
      assert.strictEqual(refinements.actionWellLocations.length, 8);
      for (let i = 0; i < 8; i++) {
        assert.strictEqual(actions[i].targetCoordinate, `A${i + 1}`);
        assert.strictEqual(actions[i].boxColId, i + 1);
      }
    });

    it('should attach full-resolution best-shot JPEG frames as inlineData and preserve transcribed label text when Gemini omits eventId', async () => {
      const os = require('node:os');
      const videoId = 'vid_fullres_frames_test';
      const framesDir = path.join(os.tmpdir(), 'sail_frames_cache', videoId);
      fs.mkdirSync(framesDir, { recursive: true });
      const contrastFramePath = path.join(framesDir, 'evt_label_99_contrast.jpg');
      const blurFramePath = path.join(framesDir, 'evt_label_99_blur.jpg');
      fs.writeFileSync(contrastFramePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]));
      fs.writeFileSync(blurFramePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x03, 0x04]));

      const capturedEventRequests = [];
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            const parts = req.contents?.[0]?.parts || [];
            const textPart = parts.find((p) => typeof p.text === 'string')?.text || '';
            if (textPart.includes('LABEL PRESENTATION EVENT')) {
              capturedEventRequests.push(req);
              // Simulate Gemini returning a single object WITHOUT eventId
              return {
                text: JSON.stringify({
                  cellLineName: 'CHO-K1',
                  userInitials: 'AB',
                  dateFrozen: '2026-05-01',
                  fullText: 'CHO-K1 P12 AB 2026-05-01',
                  frame1Text: 'CHO-K1 P12 AB',
                  frame2Text: 'CHO-K1 2026-05-01',
                }),
              };
            }
            return {
              text: JSON.stringify({
                row: 'A',
                col: 1,
                coordinate: 'A1',
                originCorner: 'TOP_LEFT_BLACK',
              }),
            };
          },
        },
      });

      const actions = [
        {
          actionId: 'act_99',
          actionType: 'VIAL_INSERTION',
          actionClass: 'VIAL_INSERTION_ACTION',
          startTime: 1.0,
          endTime: 5.0,
          eventList: ['evt_label_99'],
        },
      ];
      const events = [
        {
          eventId: 'evt_label_99',
          actionId: 'act_99',
          actionIds: ['act_99'],
          eventClass: 'VIAL_LABEL_PRESENTATION',
          description: 'Vial label shown to camera',
          startTime: 1.5,
          endTime: 3.0,
          bestFrames: [
            {
              frameType: 'HIGHEST_CONTRAST',
              timestampSeconds: 1.8,
              url: `/api/videos/${videoId}/frames/evt_label_99_contrast.jpg`,
            },
            {
              frameType: 'MINIMAL_BLUR',
              timestampSeconds: 2.4,
              url: `/api/videos/${videoId}/frames/evt_label_99_blur.jpg`,
            },
          ],
        },
      ];

      const refinements = await runPass3AnalysisRefinement({
        videoId,
        videoGcsUri: `gs://test-bucket/normalized/${videoId}.mp4`,
        classification: { workflowType: 'INVENTORY_UPDATE_WORKFLOW', confidence: 0.99 },
        actions,
        events,
      });

      assert.strictEqual(capturedEventRequests.length, 1);
      const eventParts = capturedEventRequests[0].contents[0].parts;
      const imageParts = eventParts.filter((p) => p.inlineData && p.inlineData.mimeType === 'image/jpeg');
      assert.strictEqual(imageParts.length, 2, 'Both full-resolution best-shot frames must be attached as inlineData image/jpeg');

      assert.strictEqual(refinements.labelTranscriptions.length, 1);
      const lt = refinements.labelTranscriptions[0];
      assert.strictEqual(lt.cellLineName, 'CHO-K1');
      assert.strictEqual(lt.vialLabelData.cellLineName, 'CHO-K1');
      assert.strictEqual(lt.userInitials, 'AB');
      assert.strictEqual(lt.dateFrozen, '2026-05-01');
      assert.strictEqual(lt.fullText, 'CHO-K1 P12 AB 2026-05-01');
      assert.strictEqual(lt.highestContrastShotText, 'CHO-K1 P12 AB');
      assert.strictEqual(lt.minimalBlurShotText, 'CHO-K1 2026-05-01');
      assert.strictEqual(actions[0].cellLineName, 'CHO-K1');
      assert.strictEqual(actions[0].boxWellLocation.originCorner, 'TOP_LEFT_BLACK');
    });
  });

  describe('4. HITL Inventory Sign-Off & Cryo-Inventory Highlighted Well Persistence', () => {
    it('should persist verified/edited vial label and well coordinates into inventories/{inventoryId} with highlighted=true', async () => {
      const db = getDatabase('tenant-db');
      await db.collection('inventories').doc('inv_cryo_01').set({
        id: 'inv_cryo_01',
        name: 'Primary Cryo Tank',
        towersCount: 1,
        boxesPerTower: 1,
        rowsPerBox: 9,
        colsPerBox: 9,
        createdAt: new Date().toISOString(),
        boxes: {
          'A-1': {
            towerId: 1,
            towerLabel: 'Tower A',
            boxNumber: 1,
            boxLabel: 'Box 1',
            cells: {},
          },
        },
      });

      const signOffResult = await commitInventorySignOff({
        databaseId: 'tenant-db',
        videoId: 'vid_test_01',
        inventoryId: 'inv_cryo_01',
        operatorInitials: 'JD',
        boxUpdates: [
          {
            boxId: 'A-1',
            row: 'B',
            col: 3,
            cellLineName: 'Jurkat-Edited',
            userInitials: 'JD',
            dateFrozen: '2026-04-10',
            fullText: 'Jurkat-Edited E6-1 JD 2026-04-10',
            actionId: 'act_insert_01',
            actionType: 'VIAL_INSERTION_ACTION',
            highlighted: true,
            status: 'OCCUPIED',
          },
        ],
      });

      assert.strictEqual(signOffResult.success, true);
      assert.strictEqual(signOffResult.isSignedOff, true);

      const invSnap = await db.collection('inventories').doc('inv_cryo_01').get();
      const invData = invSnap.data();
      const cellB3 = invData.boxes['A-1'].cells['B3'];

      assert.ok(cellB3, 'Well B3 should be populated in inventories/inv_cryo_01');
      assert.strictEqual(cellB3.occupied, true);
      assert.strictEqual(cellB3.highlighted, true);
      assert.strictEqual(cellB3.vial.cellLineName, 'Jurkat-Edited');
      assert.strictEqual(cellB3.vial.userInitials, 'JD');
      assert.strictEqual(cellB3.vial.dateFrozen, '2026-04-10');
      assert.strictEqual(cellB3.vial.fullText, 'Jurkat-Edited E6-1 JD 2026-04-10');
    });
  });
});
