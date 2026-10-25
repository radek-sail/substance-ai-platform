const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Set test environment variables to guarantee offline execution
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  WorkflowClassificationSchema,
  ActionSchema,
  EventSchema,
  RefinementSchema,
  VideoAnalysisDocSchema,
  BoxUpdateSchema,
  InventorySignOffPayloadSchema,
  ArchiveSignOffPayloadSchema,
} = require('@sail/shared');

const {
  setGenAIClient,
  resetGenAIClient,
  executeHierarchicalPipeline,
} = require('../dist/services/gemini.service');

const {
  saveVideoAnalysis,
  getVideoAnalysis,
  getInventoryBoxContents,
  getArchiveDocument,
  commitInventorySignOff,
  commitArchiveSignOff,
  formatArchiveMarkdown,
  clearDatabaseCache,
} = require('../dist/services/firestore.service');

const { app } = require('../dist/server');

const inventoryFixturePath = path.join(__dirname, 'fixtures', 'inventoryWorkflowFixture.json');
const archiveFixturePath = path.join(__dirname, 'fixtures', 'archiveWorkflowFixture.json');

const inventoryFixture = JSON.parse(fs.readFileSync(inventoryFixturePath, 'utf-8'));
const archiveFixture = JSON.parse(fs.readFileSync(archiveFixturePath, 'utf-8'));

describe('Phase 5: End-to-End Pipeline Simulation, Fixture Validation & Atomic Sign-Off', () => {
  beforeEach(() => {
    clearDatabaseCache();
    resetGenAIClient();
  });

  afterEach(() => {
    resetGenAIClient();
  });

  describe('1. Fixture & Schema Adherence (Pass 0 -> Pass 1 -> Pass 2 -> Pass 3)', () => {
    it('should validate inventoryWorkflowFixture.json across all 4 passes against @sail/shared Zod schemas', () => {
      // Pass 0: WorkflowClassificationSchema
      const pass0 = WorkflowClassificationSchema.parse(inventoryFixture.workflowClassification);
      assert.strictEqual(pass0.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
      assert.strictEqual(pass0.inventoryName, 'CryoTank-Alpha');

      // Pass 1: ActionSchema (VIAL_INSERTION_ACTION)
      assert.strictEqual(inventoryFixture.actions.length, 1);
      const pass1Actions = inventoryFixture.actions.map((a) => ActionSchema.parse(a));
      assert.strictEqual(pass1Actions[0].actionClass, 'VIAL_INSERTION_ACTION');
      assert.strictEqual(pass1Actions[0].boxRowId, 'A');
      assert.strictEqual(pass1Actions[0].boxColId, 4);

      // Pass 2: EventSchema (label presentation, pre/post frames)
      assert.strictEqual(inventoryFixture.events.length, 3);
      const pass2Events = inventoryFixture.events.map((e) => EventSchema.parse(e));
      const eventClasses = pass2Events.map((e) => e.eventClass);
      assert.ok(eventClasses.includes('VIAL_LABEL_PRESENTATION_EVENT'));
      assert.ok(eventClasses.includes('PRE_ACTION_BOX_STATE_EVENT'));
      assert.ok(eventClasses.includes('POST_ACTION_BOX_STATE_EVENT'));

      // Pass 3: RefinementSchema (OCR text and spatial coordinates A4)
      assert.strictEqual(inventoryFixture.refinements.length, 3);
      const pass3Refinements = inventoryFixture.refinements.map((r) => RefinementSchema.parse(r));
      const ocrRefinement = pass3Refinements.find((r) => r.refinementClass === 'OCR_CONFLATION');
      assert.ok(ocrRefinement, 'Must include OCR_CONFLATION refinement');
      assert.ok(ocrRefinement.transcriptionText.includes('HEK293T'));
      assert.strictEqual(ocrRefinement.spatialResult.row, 'A');
      assert.strictEqual(ocrRefinement.spatialResult.col, 4);

      // Full Document Validation
      const fullDoc = VideoAnalysisDocSchema.parse(inventoryFixture);
      assert.strictEqual(fullDoc.videoId, 'vid_inventory_fixture_01');
      assert.strictEqual(fullDoc.isSignedOff, false);
    });

    it('should validate archiveWorkflowFixture.json across all 4 passes against @sail/shared Zod schemas', () => {
      // Pass 0: WorkflowClassificationSchema
      const pass0 = WorkflowClassificationSchema.parse(archiveFixture.workflowClassification);
      assert.strictEqual(pass0.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(pass0.archiveName, 'Experiment-96Well-FullPlate-Seeding');

      // Pass 1: ActionSchema (REAGENT_MIXING_ACTION, REAGENT_SEEDING_ACTION)
      assert.strictEqual(archiveFixture.actions.length, 2);
      const pass1Actions = archiveFixture.actions.map((a) => ActionSchema.parse(a));
      const actionClasses = pass1Actions.map((a) => a.actionClass);
      assert.ok(actionClasses.includes('REAGENT_MIXING_ACTION'));
      assert.ok(actionClasses.includes('REAGENT_SEEDING_ACTION'));

      // Pass 2: EventSchema (seeding events across all 12 columns)
      const pass2Events = archiveFixture.events.map((e) => EventSchema.parse(e));
      const seedingEvents = pass2Events.filter((e) => e.actionId === 'act_arch_002');
      assert.strictEqual(seedingEvents.length, 12, 'Must contain 12 column seeding events');

      // Pass 3: RefinementSchema (reagent OCR conflation, FBS acronym mapping, 100 µL / 3000 cells/well transcription)
      const pass3Refinements = archiveFixture.refinements.map((r) => RefinementSchema.parse(r));
      const ocrRef = pass3Refinements.find((r) => r.refinementClass === 'REAGENT_OCR_CONFLATION');
      const acronymRef = pass3Refinements.find((r) => r.refinementClass === 'ACRONYM_MAPPING');
      const seedingRef = pass3Refinements.find(
        (r) => r.refinementClass === 'SEEDING_TRANSCRIPTION_CONFIRMATION'
      );

      assert.ok(ocrRef, 'Must contain reagent OCR conflation refinement');
      assert.ok(acronymRef, 'Must contain FBS acronym mapping refinement');
      assert.ok(acronymRef.transcriptionText.includes('FBS: Fetal Bovine Serum'));
      assert.ok(seedingRef, 'Must contain seeding transcription confirmation refinement');
      assert.ok(seedingRef.transcriptionText.includes('100 µL / 3000 cells/well'));

      // Full Document Validation
      const fullDoc = VideoAnalysisDocSchema.parse(archiveFixture);
      assert.strictEqual(fullDoc.videoId, 'vid_archive_fixture_02');
      assert.strictEqual(fullDoc.isSignedOff, false);
    });
  });

  describe('2. End-to-End Pipeline Simulation Using Fixtures', () => {
    it('should execute full Pass 0 -> Pass 1 -> Pass 2 -> Pass 3 simulation for Inventory workflow', async () => {
      let passCall = 0;
      setGenAIClient({
        models: {
          generateContent: async () => {
            passCall++;
            if (passCall === 1) {
              return { text: JSON.stringify(inventoryFixture.workflowClassification) };
            }
            if (passCall === 2) {
              return { text: JSON.stringify(inventoryFixture.actions) };
            }
            if (passCall === 3) {
              return { text: JSON.stringify(inventoryFixture.events) };
            }
            return { text: JSON.stringify(inventoryFixture.refinements) };
          },
        },
      });

      const result = await executeHierarchicalPipeline({
        customerId: inventoryFixture.customerId,
        databaseId: inventoryFixture.databaseId,
        videoId: inventoryFixture.videoId,
        videoGcsUri: `gs://${inventoryFixture.customerId}-video-manager-storage/normalized/norm_${inventoryFixture.videoId}.mp4`,
      });

      assert.strictEqual(passCall, 4, 'Must execute all 4 pipeline passes');
      assert.strictEqual(result.workloadClassification.workflowType, 'INVENTORY_UPDATE_WORKFLOW');
      assert.strictEqual(result.actions[0].actionClass, 'VIAL_INSERTION_ACTION');
      assert.strictEqual(result.events.length, 3);
      assert.strictEqual(result.refinements[0].spatialResult.row, 'A');
      assert.strictEqual(result.refinements[0].spatialResult.col, 4);
    });

    it('should execute full Pass 0 -> Pass 1 -> Pass 2 -> Pass 3 simulation for Archive workflow', async () => {
      let passCall = 0;
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            passCall++;
            const promptStr = JSON.stringify(req?.contents || []);
            if (passCall === 1) {
              return { text: JSON.stringify(archiveFixture.workflowClassification) };
            }
            if (passCall === 2) {
              return { text: JSON.stringify(archiveFixture.actions) };
            }
            for (const act of archiveFixture.actions) {
              if (promptStr.includes(`Action ID: ${act.actionId}`)) {
                return {
                  text: JSON.stringify(
                    archiveFixture.events.filter((e) => e.actionId === act.actionId)
                  ),
                };
              }
            }
            return { text: JSON.stringify(archiveFixture.refinements) };
          },
        },
      });

      const result = await executeHierarchicalPipeline({
        customerId: archiveFixture.customerId,
        databaseId: archiveFixture.databaseId,
        videoId: archiveFixture.videoId,
        videoGcsUri: `gs://${archiveFixture.customerId}-video-manager-storage/normalized/norm_${archiveFixture.videoId}.mp4`,
      });

      assert.strictEqual(passCall, 5, 'Must execute all pipeline passes (Pass 0, Pass 1, 2x Pass 2 per action, Pass 3)');
      assert.strictEqual(result.workloadClassification.workflowType, 'EXPERIMENT_NOTEBOOK_WORKFLOW');
      assert.strictEqual(result.actions.length, 2);
      assert.strictEqual(result.events.length, 14);
      assert.strictEqual(result.refinements.length, 3);
    });
  });

  describe('3. Atomic Sign-Off Service & Endpoints (Inventory & Archive)', () => {
    it('should commit an inventory update by adding occupied cells to inventories/{inventoryId}/contents/{boxId} and marking video_analyses/{videoId}.isSignedOff = true', async () => {
      const { databaseId, videoId, inventoryId, boxId } = inventoryFixture;

      // Seed initial unsigned analysis in Firestore
      await saveVideoAnalysis(databaseId, videoId, {
        ...inventoryFixture,
        isSignedOff: false,
      });

      const beforeAnalysis = await getVideoAnalysis(databaseId, videoId);
      assert.strictEqual(beforeAnalysis.isSignedOff, false);

      const action = inventoryFixture.actions[0];
      const refinement = inventoryFixture.refinements[0];

      const boxUpdates = [
        {
          boxId,
          row: refinement.spatialResult.row,
          col: refinement.spatialResult.col,
          cellLineName: action.cellLineName,
          lotNumber: action.cellLineInfo.lotNumber,
          passage: action.cellLineInfo.passage,
          operatorInitials: action.cellLineInfo.operatorInitials,
          status: 'OCCUPIED',
        },
      ];

      // Execute Atomic Sign-Off via service
      const signOffResult = await commitInventorySignOff({
        databaseId,
        videoId,
        inventoryId,
        boxUpdates,
        operatorInitials: 'RS',
      });

      assert.strictEqual(signOffResult.success, true);
      assert.strictEqual(signOffResult.isSignedOff, true);
      assert.strictEqual(
        signOffResult.documentPath,
        `/databases/${databaseId}/documents/inventories/${inventoryId}/contents/${boxId}`
      );

      // Verify occupied cell A4 was written to inventories/{inventoryId}/contents/{boxId}
      const boxContents = await getInventoryBoxContents(databaseId, inventoryId, boxId);
      assert.ok(boxContents, 'Box contents document must exist in Firestore');
      assert.strictEqual(boxContents.boxId, boxId);
      assert.strictEqual(boxContents.inventoryId, inventoryId);
      assert.ok(boxContents.occupiedCells.A4, 'Coordinate A4 must be recorded in occupiedCells');
      assert.strictEqual(boxContents.occupiedCells.A4.row, 'A');
      assert.strictEqual(boxContents.occupiedCells.A4.col, 4);
      assert.strictEqual(boxContents.occupiedCells.A4.cellLineName, 'HEK293T');
      assert.strictEqual(boxContents.occupiedCells.A4.lotNumber, 'LOT-2026-A4');
      assert.strictEqual(boxContents.occupiedCells.A4.status, 'OCCUPIED');

      // Verify video_analyses/{videoId}.isSignedOff is now true
      const afterAnalysis = await getVideoAnalysis(databaseId, videoId);
      assert.strictEqual(afterAnalysis.isSignedOff, true);
      assert.ok(afterAnalysis.signedOffAt);
    });

    it('should commit an archive update by formatting the experiment markdown document in archives/{archiveId} and marking video_analyses/{videoId}.isSignedOff = true', async () => {
      const { databaseId, videoId, archiveId } = archiveFixture;

      // Seed initial unsigned analysis in Firestore
      await saveVideoAnalysis(databaseId, videoId, {
        ...archiveFixture,
        isSignedOff: false,
      });

      const beforeAnalysis = await getVideoAnalysis(databaseId, videoId);
      assert.strictEqual(beforeAnalysis.isSignedOff, false);

      // Format experiment markdown from fixture and commit atomic sign-off
      const compiledMarkdown = formatArchiveMarkdown(archiveFixture);
      const signOffResult = await commitArchiveSignOff({
        databaseId,
        videoId,
        archiveId,
        markdownDoc: compiledMarkdown,
        operatorInitials: 'RS',
      });

      assert.strictEqual(signOffResult.success, true);
      assert.strictEqual(signOffResult.isSignedOff, true);
      assert.strictEqual(
        signOffResult.documentPath,
        `/databases/${databaseId}/documents/archives/${archiveId}`
      );

      // Verify archives/{archiveId} contains required Markdown sections & content
      const archiveDoc = await getArchiveDocument(databaseId, archiveId);
      assert.ok(archiveDoc, 'Archive document must exist in Firestore');
      assert.strictEqual(archiveDoc.archiveId, archiveId);
      assert.strictEqual(archiveDoc.videoId, videoId);
      assert.strictEqual(archiveDoc.isSignedOff, true);
      assert.ok(archiveDoc.markdownDoc.includes('## Description'), 'Must include ## Description');
      assert.ok(
        archiveDoc.markdownDoc.includes('## Reagents Used'),
        'Must include ## Reagents Used'
      );
      assert.ok(
        archiveDoc.markdownDoc.includes('## Experiment Steps'),
        'Must include ## Experiment Steps'
      );
      assert.ok(
        archiveDoc.markdownDoc.includes('FBS: Fetal Bovine Serum'),
        'Must include FBS acronym mapping'
      );
      assert.ok(
        archiveDoc.markdownDoc.includes('100 µL / 3000 cells/well'),
        'Must include seeding volume and cell density transcription'
      );

      // Verify video_analyses/{videoId}.isSignedOff is now true
      const afterAnalysis = await getVideoAnalysis(databaseId, videoId);
      assert.strictEqual(afterAnalysis.isSignedOff, true);
      assert.ok(afterAnalysis.signedOffAt);
    });

    it('should execute HTTP POST /api/signoff/inventory and POST /api/signoff/archive end-to-end', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        // 1. Seed both analyses
        await saveVideoAnalysis(inventoryFixture.databaseId, inventoryFixture.videoId, {
          ...inventoryFixture,
          isSignedOff: false,
        });
        await saveVideoAnalysis(archiveFixture.databaseId, archiveFixture.videoId, {
          ...archiveFixture,
          isSignedOff: false,
        });

        // 2. Call POST /api/signoff/inventory
        const invRes = await fetch(`http://127.0.0.1:${port}/api/signoff/inventory`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': inventoryFixture.customerId,
            'x-database-id': inventoryFixture.databaseId,
          },
          body: JSON.stringify({
            databaseId: inventoryFixture.databaseId,
            videoId: inventoryFixture.videoId,
            inventoryId: inventoryFixture.inventoryId,
            boxUpdates: [
              {
                boxId: inventoryFixture.boxId,
                row: 'A',
                col: 4,
                cellLineName: 'HEK293T',
                lotNumber: 'LOT-2026-A4',
                passage: 4,
                operatorInitials: 'RS',
                status: 'OCCUPIED',
              },
            ],
            operatorInitials: 'RS',
          }),
        });

        assert.strictEqual(invRes.status, 200);
        const invBody = await invRes.json();
        assert.strictEqual(invBody.success, true);
        assert.strictEqual(invBody.details.isSignedOff, true);
        assert.ok(invBody.details.occupiedCells.A4);

        const updatedInvAnalysis = await getVideoAnalysis(
          inventoryFixture.databaseId,
          inventoryFixture.videoId
        );
        assert.strictEqual(updatedInvAnalysis.isSignedOff, true);

        // 3. Call POST /api/signoff/archive
        const archRes = await fetch(`http://127.0.0.1:${port}/api/signoff/archive`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-customer-id': archiveFixture.customerId,
            'x-database-id': archiveFixture.databaseId,
          },
          body: JSON.stringify({
            databaseId: archiveFixture.databaseId,
            videoId: archiveFixture.videoId,
            archiveId: archiveFixture.archiveId,
            analysis: archiveFixture,
            operatorInitials: 'RS',
          }),
        });

        assert.strictEqual(archRes.status, 200);
        const archBody = await archRes.json();
        assert.strictEqual(archBody.success, true);
        assert.strictEqual(archBody.details.isSignedOff, true);
        assert.ok(archBody.markdownDoc.includes('## Description'));
        assert.ok(archBody.markdownDoc.includes('## Reagents Used'));
        assert.ok(archBody.markdownDoc.includes('## Experiment Steps'));

        const updatedArchAnalysis = await getVideoAnalysis(
          archiveFixture.databaseId,
          archiveFixture.videoId
        );
        assert.strictEqual(updatedArchAnalysis.isSignedOff, true);
      } finally {
        server.close();
      }
    });
  });
});
