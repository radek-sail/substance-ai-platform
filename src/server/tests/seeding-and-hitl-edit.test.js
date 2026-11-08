const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  PLATE_96_ROWS,
  PLATE_96_COLS,
  parseColumnNumbersFromText,
  resolveSeededColumnsAndWells,
  render96WellPlateMarkdown,
  SeedReagentsActionDataSchema,
  ArchiveWorkStepSchema,
  extractCellsPerWellFromText,
  extractCellsSeededFromText,
  resolveSeedReagentsDataFromContext,
  toActiveVoiceDescription,
} = require('@sail/shared');

const {
  formatArchiveMarkdown,
  commitArchiveSignOff,
  getDatabase,
  clearDatabaseCache,
} = require('../dist/services/firestore.service');

const {
  runPass1ActionDetection,
  runPass2EventDetection,
  runPass3AnalysisRefinement,
  setGenAIClient,
  resetGenAIClient,
} = require('../dist/services/gemini.service');

describe('96-Well Plate Seeding Event Detection, Column Mapping & Sign-Off Verification', () => {
  beforeEach(() => {
    clearDatabaseCache();
  });

  afterEach(() => {
    resetGenAIClient();
  });

  describe('1. 96-Well Plate Layout & Column Parsing (Columns 1-12 Left to Right, Rows A-H)', () => {
    it('should define exact 96-well plate dimensions (8 rows A-H, 12 columns 1-12)', () => {
      assert.deepStrictEqual(
        Array.from(PLATE_96_ROWS),
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
        '96-well plate rows must be letters A through H'
      );
      assert.deepStrictEqual(
        Array.from(PLATE_96_COLS),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        '96-well plate columns must be 1 through 12 left to right'
      );
    });

    it('should parse column numbers (1-12) from various natural language formats', () => {
      assert.deepStrictEqual(
        parseColumnNumbersFromText('columns 1 to 12'),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        'Should parse range "columns 1 to 12"'
      );
      assert.deepStrictEqual(
        parseColumnNumbersFromText('cols 1-6'),
        [1, 2, 3, 4, 5, 6],
        'Should parse range "cols 1-6"'
      );
      assert.deepStrictEqual(
        parseColumnNumbersFromText('columns 1, 3, 5, 12'),
        [1, 3, 5, 12],
        'Should parse comma-separated columns'
      );
      assert.deepStrictEqual(
        parseColumnNumbersFromText('seeded well range A1:H4'),
        [1, 2, 3, 4],
        'Should parse well coordinate range A1:H4'
      );
      assert.deepStrictEqual(
        parseColumnNumbersFromText('invalid col 0 and col 13'),
        [],
        'Should reject numbers outside 1..12'
      );
    });

    it('should resolve seeded columns and map corresponding wells (all 8 rows A-H per column)', () => {
      const allCols = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const resFull = resolveSeededColumnsAndWells({ seededColumns: allCols });
      assert.strictEqual(resFull.seededColumns.length, 12);
      assert.strictEqual(resFull.seededWells.length, 96, 'All 12 columns seeded must equal 96 wells');
      assert.ok(resFull.seededWells.includes('A1') && resFull.seededWells.includes('H12'));

      const resPartial = resolveSeededColumnsAndWells({ seededColumns: [1, 2] });
      assert.deepStrictEqual(resPartial.seededColumns, [1, 2]);
      assert.strictEqual(resPartial.seededWells.length, 16);
      assert.deepStrictEqual(
        resPartial.seededWells.slice(0, 8),
        ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1']
      );
    });
  });

  describe('2. 96-Well Plate Markdown Representation & Cryo-Box Origin Removal', () => {
    it('should render an ASCII/markdown 96-well plate showing seeded columns and unseeded columns', () => {
      const md = render96WellPlateMarkdown([1, 2, 3]);
      assert.ok(md.includes('96-Well Plate Map'), 'Must include 96-well title');
      assert.ok(md.includes('Columns 1') && md.includes('Left to Right'), 'Must describe left-to-right columns');
      assert.ok(!md.includes('TOP_LEFT_BLACK') && !md.includes('Top-Left Black'), 'Must NOT include cryo-box origin');
      assert.ok(!md.includes('cryo-box'), 'Must NOT describe as cryo-box');
      assert.ok(md.includes('●') && md.includes('○'), 'Must use seeded and empty markers');
    });

    it('should format archive markdown notes including work steps and 96-well plate map for seeding steps', () => {
      const formatted = formatArchiveMarkdown({
        archiveName: 'Experiment Exp-402 Seeding Verification',
        creatorName: 'Radek S',
        creationDate: '2026-11-06',
        reagents: [
          {
            reagentName: 'Dulbecco Modified Eagle Medium',
            reagentAcronym: 'DMEM',
            manufacturer: 'Gibco',
            catalogNumber: '11965092',
            lotNumber: '2458911',
          },
        ],
        labelTranscriptions: ['Bottle label: DMEM Gibco Ref 11965092 Lot 2458911'],
        workSteps: [
          {
            stepId: 'step_seed_01',
            stepNumber: 1,
            actionType: 'SEED_REAGENTS',
            description: 'Seed HEK293T cells into 96-well plate across all 12 columns',
            startTimeSeconds: 20,
            endTimeSeconds: 45,
            seedReagentsData: {
              plateType: '96-well plate',
              pipetteType: '8-channel pipette',
              cellsSeeded: 'HEK293T',
              cellsPerWell: '10000',
              seedingEventsCount: 12,
              expectedSeedingEventsCount: 12,
              isSeedingCountCorrect: true,
              seededColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
              seededWells: resolveSeededColumnsAndWells({ seededColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }).seededWells,
            },
          },
        ],
      });

      assert.ok(formatted.includes('Experiment Exp-402 Seeding Verification'));
      assert.ok(formatted.includes('Seed Reagents'));
      assert.ok(formatted.includes('HEK293T'));
      assert.ok(formatted.includes('Verified (12/12 events)'));
      assert.ok(formatted.includes('96-Well Plate Map'));
      assert.ok(!formatted.includes('A1 (Origin: Top-Left Black Corner)'));
      assert.ok(!formatted.includes('TOP_LEFT_BLACK'));
    });
  });

  describe('3. Dynamic Guideline Configuration Checks', () => {
    it('should specify 96-well plate column numbering 1-12 left to right and no cryo-box origin in archive agent guidelines', () => {
      const archiveGuidelines = fs.readFileSync(
        path.join(__dirname, '../../../config/archive-agent-guidelines.md'),
        'utf-8'
      );
      assert.ok(archiveGuidelines.includes('96-well plate'));
      assert.ok(archiveGuidelines.includes('12 columns'));
      assert.ok(archiveGuidelines.includes('left side and column') && archiveGuidelines.includes('all the way to the right'));
      assert.ok(archiveGuidelines.includes('individual seeding events'));
    });

    it('should specify no cryo-box origin and drawing 96-plate in refinement agent guidelines', () => {
      const refinementGuidelines = fs.readFileSync(
        path.join(__dirname, '../../../config/refinement-agent-guidelines.md'),
        'utf-8'
      );
      assert.ok(refinementGuidelines.includes('96-well plate'));
      assert.ok(refinementGuidelines.includes('cryo-box'));
      assert.ok(refinementGuidelines.includes('draw a 96-well plate') || refinementGuidelines.includes('96-well plate diagram'));
    });
  });

  describe('4. Atomic Commit with Edited HITL Experiment Archive Notebook', () => {
    it('should commit edited archive sign-off and persist updated reagents, workSteps, and markdownDoc in database', async () => {
      const db = getDatabase('(default)');
      const videoId = 'vid_archive_hitl_edit_test';
      const archiveId = 'archive_hitl_edit_01';

      // Pre-seed video
      await db.collection('videos').doc(videoId).set({
        videoId,
        archiveId,
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        isSignedOff: false,
      });

      const editedReagents = [
        {
          id: 'reagent_dmem',
          reagentName: 'Dulbecco Modified Eagle Medium High Glucose',
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco ThermoFisher',
          catalogNumber: '11965-092',
          lotNumber: 'LOT-99882',
        },
      ];

      const editedWorkSteps = [
        {
          stepId: 'step_1',
          stepNumber: 1,
          actionType: 'SEED_REAGENTS',
          description: 'Operator seeds cells into columns 1 through 12 using multi-channel pipette',
          startTimeSeconds: 15,
          endTimeSeconds: 40,
          seedReagentsData: {
            plateType: '96-well plate',
            pipetteType: '8-channel pipette',
            cellsSeeded: 'Jurkat T-cells',
            cellsPerWell: '20000',
            seedingEventsCount: 12,
            expectedSeedingEventsCount: 12,
            isSeedingCountCorrect: true,
            seededColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            seededWells: resolveSeededColumnsAndWells({ seededColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }).seededWells,
          },
        },
      ];

      const editedMarkdown = formatArchiveMarkdown({
        archiveName: 'Edited Notebook 402',
        creatorName: 'Radek S',
        creationDate: '2026-11-06',
        reagents: editedReagents,
        labelTranscriptions: ['Label: DMEM High Glucose Gibco'],
        workSteps: editedWorkSteps,
      });

      const commitResult = await commitArchiveSignOff({
        databaseId: '(default)',
        videoId,
        archiveId,
        markdownDoc: editedMarkdown,
        archiveName: 'Edited Notebook 402',
        creatorName: 'Radek S',
        creationDate: '2026-11-06',
        reagents: editedReagents,
        labelTranscriptions: ['Label: DMEM High Glucose Gibco'],
        workSteps: editedWorkSteps,
      });

      assert.ok(commitResult.signedOffAt);
      assert.strictEqual(commitResult.archiveId, archiveId);

      // Verify persisted archive document
      const archiveSnap = await db.collection('archives').doc(archiveId).get();
      assert.ok(archiveSnap.exists);
      const archiveData = archiveSnap.data();
      assert.strictEqual(archiveData.reagents.length, 1);
      assert.strictEqual(archiveData.reagents[0].reagentName, 'Dulbecco Modified Eagle Medium High Glucose');
      assert.strictEqual(archiveData.workSteps.length, 1);
      assert.deepStrictEqual(archiveData.workSteps[0].seedReagentsData.seededColumns, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.ok(archiveData.markdownDoc.includes('96-Well Plate Map'));

      // Verify video is marked as signed off
      const videoSnap = await db.collection('videos').doc(videoId).get();
      assert.strictEqual(videoSnap.data().isSignedOff, true);
    });
  });

  describe('5. Seeding Audio Extraction & Strict Anti-Placeholder Enforcement (A549 & 3K cells/well vs N/A)', () => {
    it('should extract 3K cells/well and A549 from operator spoken audio and reagent events, overriding any stale placeholders', () => {
      const spokenAudio =
        'We are seeding A549 cells today. There are 30K cells/mL, each well receives 100 microliters of reagent and there are 3K cells/well.';

      assert.strictEqual(
        extractCellsPerWellFromText(spokenAudio),
        '3K cells/well',
        'Must extract explicit 3K cells/well from operator utterance'
      );

      // Even if only concentration and volume per well are stated in audio, it should compute 3K cells/well
      const concentrationOnlyAudio =
        'The suspension has 30K cells/mL and each well receives 100 microliters of reagent.';
      assert.strictEqual(
        extractCellsPerWellFromText(concentrationOnlyAudio),
        '3K cells/well',
        'Must compute 3K cells/well from 30K cells/mL * 100 microliters (0.1 mL)'
      );

      const resolved = resolveSeedReagentsDataFromContext({
        explicitCandidates: [
          // Simulate stale placeholder values that must be rejected in favor of actual audio/reagent evidence
          {
            plateType: '96-well plate',
            pipetteType: '8-channel pipette',
            cellsSeeded: 'HEK293T',
            cellsPerWell: '10,000 cells/well',
          },
        ],
        actionDescription: 'Operator seeds A549 cells into a 96-well plate using an 8-channel pipette.',
        audioAndEventTexts: [spokenAudio],
        reagents: [
          {
            reagentName: 'A549',
            reagentAcronym: 'A549',
            manufacturer: 'N/A',
            catalogNumber: 'N/A',
            lotNumber: 'N/A',
          },
        ],
      });

      assert.strictEqual(resolved.cellsSeeded, 'A549');
      assert.strictEqual(resolved.cellsPerWell, '3K cells/well');
      assert.strictEqual(resolved.plateType, '96-well plate');
      assert.strictEqual(resolved.pipetteType, '8-channel pipette');
    });

    it('should populate N/A when seeding fields cannot be found in detected events or spoken audio (never placeholders)', () => {
      const resolvedEmpty = resolveSeedReagentsDataFromContext({
        explicitCandidates: [
          // Unverified placeholder values with zero supporting evidence in description, audio, or reagents
          {
            cellsSeeded: 'HEK293T',
            cellsPerWell: '10,000 cells/well',
          },
        ],
        actionDescription: 'Operator dispenses reagent into wells.',
        audioAndEventTexts: ['Operator performs dispensing step silently.'],
        reagents: [],
      });

      assert.strictEqual(resolvedEmpty.cellsSeeded, 'N/A', 'cellsSeeded must be N/A when not found in events/audio');
      assert.strictEqual(resolvedEmpty.cellsPerWell, 'N/A', 'cellsPerWell must be N/A when not found in events/audio');
      assert.strictEqual(resolvedEmpty.plateType, 'N/A', 'plateType must be N/A when not found in events/audio');
      assert.strictEqual(resolvedEmpty.pipetteType, 'N/A', 'pipetteType must be N/A when not found in events/audio');
    });

    it('should propagate A549 and 3K cells/well across Pass 1, Pass 2, and Pass 3 workSteps from Pass 1 PROTOCOL_AUDIO_UTTERANCE_EVENT', async () => {
      const classification = {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        confidence: 0.99,
        reasoning: 'Cell seeding experiment',
        transcribedAudio:
          'Starting experiment archive. There are 30K cells/mL, each well receives 100 microliters of reagent and there are 3K cells/well.',
      };

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              actions: [
                {
                  actionId: 'act_seed_1',
                  actionClass: 'REAGENT_SEEDING_ACTION',
                  actionType: 'SEED_REAGENTS',
                  startTime: 25.75,
                  endTime: 100.25,
                  description: 'Operator seeds A549 cells into a 96-well plate using an 8-channel pipette.',
                },
              ],
              events: [
                {
                  eventId: 'evt_reagent_a549',
                  actionId: 'act_seed_1',
                  actionIds: ['act_seed_1'],
                  eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                  startTime: 26.0,
                  endTime: 30.0,
                  description: 'Operator presents A549 cell suspension tube label to camera.',
                  reagentName: 'A549',
                  reagentAcronym: 'A549',
                },
                {
                  eventId: 'evt_audio_seed',
                  actionId: 'act_seed_1',
                  actionIds: ['act_seed_1'],
                  eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
                  startTime: 32.0,
                  endTime: 42.0,
                  description:
                    'Operator states that there are 30K cells/mL, each well receives 100 microliters of reagent and that there are 3K cells/well.',
                },
              ],
            }),
          }),
        },
      });

      const pass1Actions = await runPass1ActionDetection({
        videoGcsUri: 'gs://test-bucket/videos/a549_seeding.mp4',
        classification,
      });

      assert.strictEqual(pass1Actions[0].seedReagentsData.cellsSeeded, 'A549');
      assert.strictEqual(pass1Actions[0].seedReagentsData.cellsPerWell, '3K cells/well');

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              events: [
                {
                  eventId: 'evt_reagent_a549',
                  actionId: 'act_seed_1',
                  actionIds: ['act_seed_1'],
                  eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                  startTimeSeconds: 26.0,
                  endTimeSeconds: 30.0,
                  bestShotTimestampSeconds: 27.5,
                  secondBestShotTimestampSeconds: 28.0,
                  description: 'A549 label presentation',
                  reagentName: 'A549',
                  reagentAcronym: 'A549',
                },
                {
                  eventId: 'evt_seed_col_1',
                  actionId: 'act_seed_1',
                  actionIds: ['act_seed_1'],
                  eventClass: 'WELL_SEEDING_EVENT',
                  startTimeSeconds: 45.0,
                  endTimeSeconds: 50.0,
                  bestShotTimestampSeconds: 47.0,
                  secondBestShotTimestampSeconds: 48.0,
                  seededColumn: 1,
                  description: 'Dispensing A549 into column 1',
                },
              ],
            }),
          }),
        },
      });

      const pass2Events = await runPass2EventDetection({
        videoGcsUri: 'gs://test-bucket/videos/a549_seeding.mp4',
        classification,
        actions: pass1Actions,
        events: pass1Actions.events,
      });

      assert.strictEqual(pass1Actions[0].seedReagentsData.cellsSeeded, 'A549');
      assert.strictEqual(pass1Actions[0].seedReagentsData.cellsPerWell, '3K cells/well');

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              refinements: [
                {
                  refinementId: 'ref_a549',
                  eventId: 'evt_reagent_a549',
                  actionId: 'act_seed_1',
                  refinementClass: 'OCR_CONFLATION',
                  transcriptionText: 'A549',
                  reagentData: {
                    reagentName: 'A549',
                    reagentAcronym: 'A549',
                    manufacturer: 'N/A',
                    catalogNumber: 'N/A',
                    lotNumber: 'N/A',
                    rawLabelText: 'A549',
                  },
                },
              ],
            }),
          }),
        },
      });

      const pass3Result = await runPass3AnalysisRefinement({
        videoGcsUri: 'gs://test-bucket/videos/a549_seeding.mp4',
        classification,
        actions: pass1Actions,
        events: pass2Events,
      });

      assert.strictEqual(pass3Result.workSteps.length, 1);
      const step = pass3Result.workSteps[0];
      assert.strictEqual(step.actionType, 'SEED_REAGENTS');
      assert.strictEqual(step.seedReagentsData.cellsSeeded, 'A549');
      assert.strictEqual(step.seedReagentsData.cellsPerWell, '3K cells/well');
      assert.strictEqual(step.seedReagentsData.plateType, '96-well plate');
      assert.strictEqual(step.seedReagentsData.pipetteType, '8-channel pipette');
    });

    it('should populate N/A in Pass 3 workSteps when seeding details are not present in events or spoken audio', async () => {
      const classification = {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        confidence: 0.99,
        reasoning: 'Silent seeding video without spoken details or readable labels',
      };

      const actions = [
        {
          actionId: 'act_silent_seed',
          actionClass: 'REAGENT_SEEDING_ACTION',
          actionType: 'SEED_REAGENTS',
          startTime: 10,
          endTime: 40,
          description: 'Operator dispenses liquid into wells.',
        },
      ];
      const events = [
        {
          eventId: 'evt_silent_seed_1',
          actionId: 'act_silent_seed',
          actionIds: ['act_silent_seed'],
          eventClass: 'WELL_SEEDING_EVENT',
          startTime: 15,
          endTime: 20,
          seededColumn: 1,
          description: 'Dispensing into column 1',
        },
      ];

      setGenAIClient({
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              refinements: [],
            }),
          }),
        },
      });

      const pass3Result = await runPass3AnalysisRefinement({
        videoGcsUri: 'gs://test-bucket/videos/silent_seeding.mp4',
        classification,
        actions,
        events,
      });

      assert.strictEqual(pass3Result.workSteps.length, 1);
      const step = pass3Result.workSteps[0];
      assert.strictEqual(step.seedReagentsData.cellsSeeded, 'N/A');
      assert.strictEqual(step.seedReagentsData.cellsPerWell, 'N/A');
      assert.strictEqual(step.seedReagentsData.plateType, 'N/A');
      assert.strictEqual(step.seedReagentsData.pipetteType, 'N/A');
      assert.strictEqual(step.description, 'Dispensing liquid into wells.');
    });

    it('should convert "Operator pours..." and "Operator seeds..." descriptions into active voice ("Pouring...", "Seeding...")', () => {
      assert.strictEqual(
        toActiveVoiceDescription('Operator pours 5 mL FBS into 45 mL DMEM'),
        'Pouring 5 mL FBS into 45 mL DMEM'
      );
      assert.strictEqual(
        toActiveVoiceDescription('operator seeds A549 cells into a 96-well plate'),
        'Seeding A549 cells into a 96-well plate'
      );
      assert.strictEqual(
        toActiveVoiceDescription('Operator mixes two reagents together'),
        'Mixing two reagents together'
      );
      assert.strictEqual(
        toActiveVoiceDescription('The operator dispenses media into columns 1 to 12'),
        'Dispensing media into columns 1 to 12'
      );
    });
  });
});
