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
  ArchiveReagentSchema,
  generateReagentAcronym,
  areSameReagent,
  mergeReagentRecords,
  parseReagentLabelFields,
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

    it('should skip vial label transcription for VIAL_REMOVAL actions and leave all label fields empty except well coordinate', async () => {
      const capturedRequests = [];
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            capturedRequests.push(req);
            const parts = req.contents?.[0]?.parts || [];
            const textPart = parts.find((p) => typeof p.text === 'string')?.text || '';
            assert.ok(
              !textPart.includes('LABEL PRESENTATION EVENT'),
              'Should NOT call Gemini for vial label presentation events associated with VIAL_REMOVAL actions'
            );
            return {
              text: JSON.stringify({
                actionId: 'act_remove_01',
                refinementClass: 'SPATIAL_REFINEMENT',
                boxWellLocation: {
                  actionId: 'act_remove_01',
                  row: 'D',
                  col: 6,
                  coordinate: 'D6',
                  originCorner: 'TOP_LEFT_BLACK',
                  confidence: 0.99,
                },
                spatialResult: {
                  row: 'D',
                  col: 6,
                },
              }),
            };
          },
        },
      });

      const actions = [
        {
          actionId: 'act_remove_01',
          actionType: 'VIAL_REMOVAL',
          actionClass: 'VIAL_REMOVAL_ACTION',
          startTime: 2.0,
          endTime: 6.0,
          cellLineName: 'ShouldBeCleared',
          userInitials: 'RK',
          dateFrozen: '2026-01-01',
          fullText: 'ShouldBeCleared RK 2026-01-01',
          eventList: ['evt_remove_label_01'],
        },
      ];
      const events = [
        {
          eventId: 'evt_remove_label_01',
          actionId: 'act_remove_01',
          actionIds: ['act_remove_01'],
          eventClass: 'VIAL_LABEL_PRESENTATION',
          description: 'Operator glances at vial label after removing vial',
          startTime: 4.5,
          endTime: 5.5,
          bestShotTimes: [4.8, 5.2],
        },
      ];

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_removal_skip_label',
        videoGcsUri: 'gs://test-bucket/normalized/vid_removal_skip_label.mp4',
        classification: { workflowType: 'INVENTORY_UPDATE_WORKFLOW', confidence: 0.99 },
        actions,
        events,
      });

      // Only 1 request should be made (for the action well coordinate interval), 0 for the vial label presentation event
      assert.strictEqual(capturedRequests.length, 1);
      assert.strictEqual(refinements.labelTranscriptions.length, 0);
      assert.strictEqual(refinements.actionWellLocations.length, 1);

      const act = actions[0];
      assert.strictEqual(act.targetCoordinate, 'D6');
      assert.strictEqual(act.boxRowId, 'D');
      assert.strictEqual(act.boxColId, 6);
      assert.strictEqual(act.boxWellLocation.coordinate, 'D6');
      assert.strictEqual(act.cellLineName, '');
      assert.strictEqual(act.userInitials, '');
      assert.strictEqual(act.operatorInitials, '');
      assert.strictEqual(act.dateFrozen, '');
      assert.strictEqual(act.fullText, '');
      assert.strictEqual(act.conflatedLabelText, '');
      assert.strictEqual(act.lotNumber, '');
      assert.strictEqual(act.vialLabelData.cellLineName, '');
      assert.strictEqual(act.vialLabelData.userInitials, '');
      assert.strictEqual(act.vialLabelData.dateFrozen, '');
      assert.strictEqual(act.vialLabelData.fullText, '');
      assert.strictEqual(act.cellLineInfo.name, '');
      assert.strictEqual(act.cellLineInfo.cellLineName, '');
      assert.strictEqual(act.cellLineInfo.userInitials, '');
      assert.strictEqual(act.cellLineInfo.dateFrozen, '');
      assert.strictEqual(act.cellLineInfo.fullText, '');
      assert.strictEqual(act.cellLineInfo.targetCoordinate, 'D6');
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

  describe('5. Distinction Between Vial Label Presentation & Reagent Label Presentation + Acronym Identity Resolution', () => {
    it('should form reagent acronyms from the first letters of reagent names and leave missing label fields as N/A', () => {
      assert.strictEqual(generateReagentAcronym('Fetal Bovine Serum'), 'FBS');
      assert.strictEqual(generateReagentAcronym("Dulbecco's Modified Eagle Medium"), 'DMEM');
      assert.strictEqual(generateReagentAcronym('Phosphate Buffered Saline'), 'PBS');
      assert.strictEqual(generateReagentAcronym('Complete Growth Medium'), 'CGM');

      // Full reagent label with all fields present
      const fullReagent = parseReagentLabelFields(
        'Fetal Bovine Serum\nGibco\nREF: A31605-01\nLOT: 2510492'
      );
      const validatedFull = ArchiveReagentSchema.parse(fullReagent);
      assert.strictEqual(validatedFull.reagentName, 'Fetal Bovine Serum');
      assert.strictEqual(validatedFull.reagentAcronym, 'FBS');
      assert.strictEqual(validatedFull.manufacturer, 'Gibco');
      assert.strictEqual(validatedFull.catalogNumber, 'A31605-01');
      assert.strictEqual(validatedFull.lotNumber, '2510492');

      // Partial reagent label where manufacturer and catalog # are not printed on the vessel
      const partialReagent = parseReagentLabelFields('Complete Growth Medium\nLot # 99812');
      const validatedPartial = ArchiveReagentSchema.parse(partialReagent);
      assert.strictEqual(validatedPartial.reagentName, 'Complete Growth Medium');
      assert.strictEqual(validatedPartial.reagentAcronym, 'CGM');
      assert.strictEqual(validatedPartial.manufacturer, 'N/A');
      assert.strictEqual(validatedPartial.catalogNumber, 'N/A');
      assert.strictEqual(validatedPartial.lotNumber, '99812');

      // Vessel label with ONLY the acronym printed on it
      const acronymOnlyVessel = parseReagentLabelFields('CGM\nLot: 99812');
      assert.strictEqual(acronymOnlyVessel.reagentName, 'N/A');
      assert.strictEqual(acronymOnlyVessel.reagentAcronym, 'CGM');
      assert.strictEqual(acronymOnlyVessel.manufacturer, 'N/A');
      assert.strictEqual(acronymOnlyVessel.catalogNumber, 'N/A');
      assert.strictEqual(acronymOnlyVessel.lotNumber, '99812');
    });

    it('should identify that two vessels/references refer to the same reagent regardless of whether full name or acronym is used', () => {
      assert.strictEqual(areSameReagent('Fetal Bovine Serum', 'FBS'), true);
      assert.strictEqual(areSameReagent("Dulbecco's Modified Eagle Medium", 'DMEM'), true);
      assert.strictEqual(areSameReagent('Complete Growth Medium', 'CGM'), true);
      assert.strictEqual(
        areSameReagent(
          { reagentName: 'Complete Growth Medium', reagentAcronym: 'CGM', manufacturer: 'Gibco' },
          { reagentName: 'N/A', reagentAcronym: 'CGM', lotNumber: 'LOT-772' }
        ),
        true
      );
      assert.strictEqual(areSameReagent('Fetal Bovine Serum', 'DMEM'), false);

      const merged = mergeReagentRecords(
        {
          reagentName: 'N/A',
          reagentAcronym: 'CGM',
          manufacturer: 'N/A',
          catalogNumber: 'N/A',
          lotNumber: 'LOT-772',
        },
        {
          reagentName: 'Complete Growth Medium',
          reagentAcronym: 'CGM',
          manufacturer: 'Gibco',
          catalogNumber: 'CAT-500',
          lotNumber: 'N/A',
        }
      );
      assert.strictEqual(merged.reagentName, 'Complete Growth Medium');
      assert.strictEqual(merged.reagentAcronym, 'CGM');
      assert.strictEqual(merged.manufacturer, 'Gibco');
      assert.strictEqual(merged.catalogNumber, 'CAT-500');
      assert.strictEqual(merged.lotNumber, 'LOT-772');
    });

    it('should extract reagent fields (defaulting missing to N/A) for REAGENT_LABEL_PRESENTATION and merge full-name and acronym vessels into the same reagent in Pass 3', async () => {
      const mockArchivePass3Response = {
        refinements: [
          {
            refinementId: 'ref_reagent_1',
            eventId: 'evt_reagent_full',
            actionId: 'act_mix_01',
            refinementClass: 'OCR_CONFLATION',
            transcriptionText: 'Dulbecco\'s Modified Eagle Medium | Gibco | REF 11965-092',
            reagentData: {
              reagentName: "Dulbecco's Modified Eagle Medium",
              reagentAcronym: 'N/A',
              manufacturer: 'Gibco',
              catalogNumber: '11965-092',
              lotNumber: 'N/A',
            },
          },
          {
            refinementId: 'ref_reagent_2',
            eventId: 'evt_reagent_acronym_only',
            actionId: 'act_mix_01',
            refinementClass: 'OCR_CONFLATION',
            transcriptionText: 'DMEM Lot: 2489103',
            reagentData: {
              reagentName: 'N/A',
              reagentAcronym: 'DMEM',
              manufacturer: 'N/A',
              catalogNumber: 'N/A',
              lotNumber: '2489103',
            },
          },
          {
            refinementId: 'ref_reagent_3',
            eventId: 'evt_reagent_fbs',
            actionId: 'act_mix_01',
            refinementClass: 'OCR_CONFLATION',
            transcriptionText: 'Fetal Bovine Serum Lot: 99120',
            reagentData: {
              reagentName: 'Fetal Bovine Serum',
              reagentAcronym: 'FBS',
              manufacturer: 'N/A',
              catalogNumber: 'N/A',
              lotNumber: '99120',
            },
          },
        ],
      };

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify(mockArchivePass3Response),
          }),
        },
      });

      const pass0 = {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: 'Media Preparation Protocol',
        transcribedAudio: 'Mixing 45 mL of DMEM with 5 mL of FBS.',
      };

      const actions = [
        {
          actionId: 'act_mix_01',
          actionType: 'MIX_REAGENTS',
          actionClass: 'REAGENT_MIXING_ACTION',
          startTime: 1.0,
          endTime: 20.0,
          description: 'Operator mixes DMEM and FBS',
          mixReagentsData: {
            firstReagentName: 'DMEM',
            firstReagentAmount: '45 mL',
            secondReagentName: 'FBS',
            secondReagentAmount: '5 mL',
          },
          eventList: ['evt_reagent_full', 'evt_reagent_acronym_only', 'evt_reagent_fbs'],
        },
      ];

      // Note: fix typo in secondReagentName to 'FBS' to test acronym resolution to 'Fetal Bovine Serum (FBS)'
      actions[0].mixReagentsData.secondReagentName = 'FBS';

      const events = [
        {
          eventId: 'evt_reagent_full',
          actionId: 'act_mix_01',
          actionIds: ['act_mix_01'],
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          eventTrack: 'video',
          startTime: 2.0,
          endTime: 4.0,
          bestShotTimes: [2.5, 3.0],
        },
        {
          eventId: 'evt_reagent_acronym_only',
          actionId: 'act_mix_01',
          actionIds: ['act_mix_01'],
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          eventTrack: 'video',
          startTime: 5.0,
          endTime: 7.0,
          bestShotTimes: [5.5, 6.0],
        },
        {
          eventId: 'evt_reagent_fbs',
          actionId: 'act_mix_01',
          actionIds: ['act_mix_01'],
          eventClass: 'REAGENT_LABEL_PRESENTATION',
          eventTrack: 'video',
          startTime: 8.0,
          endTime: 10.0,
          bestShotTimes: [8.5, 9.0],
        },
      ];

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_reagent_presentation_test',
        videoGcsUri: 'gs://test-bucket/normalized/vid_reagent_presentation_test.mp4',
        classification: pass0,
        actions,
        events,
      });

      assert.strictEqual(refinements.labelTranscriptions.length, 3);

      // 1. First vessel had full name ("Dulbecco's Modified Eagle Medium"), manufacturer ("Gibco"), catalogNumber ("11965-092"), but no lotNumber ("N/A")
      const lt1 = refinements.labelTranscriptions[0];
      assert.strictEqual(lt1.isReagentLabel, true);
      assert.strictEqual(lt1.isVialLabel, false);
      assert.strictEqual(lt1.reagentName, "Dulbecco's Modified Eagle Medium");
      assert.strictEqual(lt1.reagentAcronym, 'DMEM');
      assert.strictEqual(lt1.manufacturer, 'Gibco');
      assert.strictEqual(lt1.catalogNumber, '11965-092');
      assert.strictEqual(lt1.lotNumber, 'N/A');

      // 2. Second vessel had ONLY acronym ("DMEM") and lotNumber ("2489103"); missing fields are "N/A"
      const lt2 = refinements.labelTranscriptions[1];
      assert.strictEqual(lt2.isReagentLabel, true);
      assert.strictEqual(lt2.reagentName, 'N/A');
      assert.strictEqual(lt2.reagentAcronym, 'DMEM');
      assert.strictEqual(lt2.manufacturer, 'N/A');
      assert.strictEqual(lt2.catalogNumber, 'N/A');
      assert.strictEqual(lt2.lotNumber, '2489103');

      // Both DMEM vessels must be linked to the SAME canonical reagent ID
      assert.ok(lt1.reagentData.id);
      assert.strictEqual(lt1.reagentData.id, lt2.reagentData.id);

      // 3. Synthesized reagents list must have deduplicated DMEM ("Dulbecco's Modified Eagle Medium" + "DMEM") into a single reagent entry
      assert.strictEqual(refinements.reagents.length, 2);
      const dmemReagent = refinements.reagents.find((r) => r.reagentAcronym === 'DMEM');
      assert.ok(dmemReagent);
      assert.strictEqual(dmemReagent.reagentName, "Dulbecco's Modified Eagle Medium");
      assert.strictEqual(dmemReagent.reagentAcronym, 'DMEM');
      assert.strictEqual(dmemReagent.manufacturer, 'Gibco');
      assert.strictEqual(dmemReagent.catalogNumber, '11965-092');
      assert.strictEqual(dmemReagent.lotNumber, '2489103');

      const fbsReagent = refinements.reagents.find((r) => r.reagentAcronym === 'FBS');
      assert.ok(fbsReagent);
      assert.strictEqual(fbsReagent.reagentName, 'Fetal Bovine Serum');
      assert.strictEqual(fbsReagent.manufacturer, 'N/A');
      assert.strictEqual(fbsReagent.catalogNumber, 'N/A');
      assert.strictEqual(fbsReagent.lotNumber, '99120');

      // 4. Work step mixReagentsData resolved acronym references ("DMEM" and "FBS") to the canonical reagents
      assert.strictEqual(refinements.workSteps.length, 1);
      assert.strictEqual(
        refinements.workSteps[0].mixReagentsData.firstReagentName,
        "Dulbecco's Modified Eagle Medium (DMEM)"
      );
      assert.strictEqual(
        refinements.workSteps[0].mixReagentsData.secondReagentName,
        'Fetal Bovine Serum (FBS)'
      );
    });

    it('should extract reagent bottle fields (and never cellLineName/vialLabelData) for Gibco Fetal Bovine Serum label presentation in Pass 3', async () => {
      const shotText =
        'gibco Fetal Bovine Serum Premium Heat Inactivated, 1X Origin: United States 2026-04-30 REF A38400-01 500 mL LOT 2472285P';
      const conflatedPipeText =
        'gibco | Fetal Bovine Serum, Premium Heat Inactivated, 1X | REF A38400-01 | LOT 2472285P | EXP 2026-04-30 | 500 mL | Origin: United States';

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify([
              {
                refinementId: 'ref_evt_001',
                eventId: 'evt_001',
                actionId: 'act_001',
                refinementClass: 'OCR_CONFLATION',
                transcriptionText: conflatedPipeText,
                vialLabelData: {
                  cellLineName: 'gibco',
                  userInitials: 'REF',
                  dateFrozen: '2026-04-30',
                  fullText: conflatedPipeText,
                  frame1Text: shotText,
                  frame2Text: shotText,
                },
              },
            ]),
          }),
        },
      });

      const refinements = await runPass3AnalysisRefinement({
        videoId: 'vid_gibco_fbs_reagent_test',
        videoGcsUri: 'gs://test-bucket/normalized/vid_gibco_fbs_reagent_test.mp4',
        classification: { workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW', confidence: 0.99 },
        actions: [
          {
            actionId: 'act_001',
            actionType: 'REAGENT_IDENTIFICATION',
            actionClass: 'REAGENT_IDENTIFICATION_ACTION',
            startTime: 0.0,
            endTime: 5.0,
            eventList: ['evt_001'],
          },
        ],
        events: [
          {
            eventId: 'evt_001',
            actionId: 'act_001',
            actionIds: ['act_001'],
            eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
            eventTrack: 'video',
            startTime: 1.0,
            endTime: 4.0,
            bestShotTimes: [1.5, 2.5],
          },
        ],
      });

      assert.strictEqual(refinements.labelTranscriptions.length, 1);
      const lt = refinements.labelTranscriptions[0];
      assert.strictEqual(lt.isReagentLabel, true);
      assert.strictEqual(lt.isVialLabel, false);
      assert.strictEqual(lt.reagentName, 'Fetal Bovine Serum');
      assert.strictEqual(lt.reagentAcronym, 'FBS');
      assert.strictEqual(lt.manufacturer, 'Gibco');
      assert.strictEqual(lt.catalogNumber, 'A38400-01');
      assert.strictEqual(lt.lotNumber, '2472285P');
      assert.strictEqual(lt.highestContrastShotText, shotText);
      assert.strictEqual(lt.minimalBlurShotText, shotText);

      // The refinement entry itself must carry reagentData and NOT vialLabelData
      assert.strictEqual(refinements[0].vialLabelData, undefined);
      assert.ok(refinements[0].reagentData);
      assert.strictEqual(refinements[0].reagentData.reagentName, 'Fetal Bovine Serum');
      assert.strictEqual(refinements[0].reagentData.reagentAcronym, 'FBS');
      assert.strictEqual(refinements[0].reagentData.manufacturer, 'Gibco');
      assert.strictEqual(refinements[0].reagentData.catalogNumber, 'A38400-01');
      assert.strictEqual(refinements[0].reagentData.lotNumber, '2472285P');
    });
  });
});
