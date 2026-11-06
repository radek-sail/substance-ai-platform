const { describe, it } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';

const { app } = require('../dist/server');
const {
  getFirestoreDb,
  getTenantFirestore,
  getVideoMetadata,
  updateVideoRecord,
  saveVideoAnalysis,
} = require('../dist/services/firestore.service');
const {
  reconcileVideoArchiveAssociation,
} = require('../dist/controllers/pipeline.controller');
const {
  normalizePass0ArchiveMetadata,
  runPass1ActionDetection,
  setGenAIClient,
} = require('../dist/services/gemini.service');

describe('Pass 0 Experiment Archive Workflow Classification & Association', () => {
  const databaseId = '(default)';
  const db = getFirestoreDb(databaseId);

  it('should extract archiveName, creatorName, creationDate, and archiveIntent from audio transcript when creating a new archive', () => {
    const rawClassification = {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      transcribedAudio:
        'Creating a new archive called CRISPR Knockout Screen B. Created by Dr. Elena Vance on 2026-11-04. Starting media preparation.',
    };

    normalizePass0ArchiveMetadata(rawClassification, 'fallback_video.mp4');

    assert.strictEqual(rawClassification.archiveName, 'CRISPR Knockout Screen B');
    assert.strictEqual(rawClassification.creatorName, 'Dr. Elena Vance');
    assert.strictEqual(rawClassification.creationDate, '2026-11-04');
    assert.strictEqual(rawClassification.archiveIntent, 'CREATE');
    assert.strictEqual(rawClassification.isAppending, false);
  });

  it('should detect APPEND intent when operator states they are appending to an existing archive', () => {
    const rawClassification = {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      archiveName: 'Experiment-402',
      transcribedAudio:
        'Appending to existing archive Experiment-402. Operator is Alex Rivera on November 4th, 2026.',
    };

    normalizePass0ArchiveMetadata(rawClassification, 'fallback_video.mp4');

    assert.strictEqual(rawClassification.archiveName, 'Experiment-402');
    assert.strictEqual(rawClassification.creatorName, 'Alex Rivera');
    assert.strictEqual(rawClassification.creationDate, 'November 4th, 2026');
    assert.strictEqual(rawClassification.archiveIntent, 'APPEND');
    assert.strictEqual(rawClassification.isAppending, true);
  });

  it('should automatically associate video when appending to an existing archive with a high-confidence match', async () => {
    const videoId = 'vid_archive_append_match_' + Date.now();
    const archiveId = 'arch_exp_402_' + Date.now();

    await db.collection('archives').doc(archiveId).set({
      id: archiveId,
      name: 'Experiment 402 Cell Seeding',
      creatorName: 'Dr. Sarah Chen',
      creationDate: '2026-10-20',
      markdownDoc: '# Experiment 402 Cell Seeding',
      videoIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await reconcileVideoArchiveAssociation(databaseId, videoId, {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      archiveName: 'Experiment 402 Cell Seeding',
      archiveIntent: 'APPEND',
      isAppending: true,
      transcribedAudio: 'Appending to archive Experiment 402 Cell Seeding.',
    });

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.archiveId, archiveId);
    assert.strictEqual(result.archiveName, 'Experiment 402 Cell Seeding');
    assert.strictEqual(result.archiveAssociationType, 'AUTOMATIC');

    const meta = await getVideoMetadata(databaseId, videoId);
    assert.strictEqual(meta.archiveId, archiveId);
    assert.strictEqual(meta.archiveName, 'Experiment 402 Cell Seeding');
    assert.strictEqual(meta.archiveAssociationType, 'AUTOMATIC');
    assert.strictEqual(meta.archiveIntent, 'APPEND');
    assert.ok(meta.associatedAt);
  });

  it('should mark video as UNMATCHED when appending to an archive with no high-confidence match in database', async () => {
    const videoId = 'vid_archive_append_unmatched_' + Date.now();

    const result = await reconcileVideoArchiveAssociation(databaseId, videoId, {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      archiveName: 'NonExistent Quantum Assay 999',
      creatorName: 'Dr. R. K.',
      creationDate: '2026-11-04',
      archiveIntent: 'APPEND',
      isAppending: true,
      transcribedAudio: 'Appending to archive NonExistent Quantum Assay 999.',
    });

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.archiveId, null);
    assert.strictEqual(result.unmatchedArchiveName, 'NonExistent Quantum Assay 999');
    assert.strictEqual(result.archiveAssociationType, 'UNMATCHED');

    const meta = await getVideoMetadata(databaseId, videoId);
    assert.strictEqual(meta.archiveId, null);
    assert.strictEqual(meta.unmatchedArchiveName, 'NonExistent Quantum Assay 999');
    assert.strictEqual(meta.archiveCreatorName, 'Dr. R. K.');
    assert.strictEqual(meta.archiveCreationDate, '2026-11-04');
    assert.strictEqual(meta.archiveIntent, 'APPEND');
    assert.strictEqual(meta.archiveAssociationType, 'UNMATCHED');
  });

  it('should populate initialization fields and set PENDING_CONFIRMATION when creating a new archive', async () => {
    const videoId = 'vid_archive_create_pending_' + Date.now();

    const result = await reconcileVideoArchiveAssociation(databaseId, videoId, {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      archiveName: 'Lentiviral Transduction Run 7',
      creatorName: 'Dr. Jane Doe',
      creationDate: '2026-11-04',
      archiveIntent: 'CREATE',
      isAppending: false,
      transcribedAudio:
        'Creating new archive Lentiviral Transduction Run 7, creator Dr. Jane Doe, date 2026-11-04.',
    });

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.archiveId, null);
    assert.strictEqual(result.unmatchedArchiveName, 'Lentiviral Transduction Run 7');
    assert.strictEqual(result.archiveCreatorName, 'Dr. Jane Doe');
    assert.strictEqual(result.archiveCreationDate, '2026-11-04');
    assert.strictEqual(result.archiveIntent, 'CREATE');
    assert.strictEqual(result.archiveAssociationType, 'PENDING_CONFIRMATION');

    const meta = await getVideoMetadata(databaseId, videoId);
    assert.strictEqual(meta.archiveId, null);
    assert.strictEqual(meta.unmatchedArchiveName, 'Lentiviral Transduction Run 7');
    assert.strictEqual(meta.archiveCreatorName, 'Dr. Jane Doe');
    assert.strictEqual(meta.archiveCreationDate, '2026-11-04');
    assert.strictEqual(meta.archiveIntent, 'CREATE');
    assert.strictEqual(meta.archiveAssociationType, 'PENDING_CONFIRMATION');
  });

  it('should support confirming new archive creation via POST /api/archives and manual association via POST /api/videos/:videoId/associate-archive', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const videoId1 = 'vid_confirm_create_' + Date.now();
      const createRes = await fetch(`http://localhost:${port}/api/archives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Confirmed Organoid Assay',
          creatorName: 'Dr. Jane Doe',
          creationDate: '2026-11-04',
          videoId: videoId1,
        }),
      });

      assert.strictEqual(createRes.status, 201);
      const createdData = await createRes.json();
      assert.ok(createdData.id);
      assert.strictEqual(createdData.name, 'Confirmed Organoid Assay');
      assert.strictEqual(createdData.creatorName, 'Dr. Jane Doe');
      assert.strictEqual(createdData.creationDate, '2026-11-04');

      const meta1 = await getVideoMetadata(databaseId, videoId1);
      assert.strictEqual(meta1.archiveId, createdData.id);
      assert.strictEqual(meta1.archiveName, 'Confirmed Organoid Assay');
      assert.strictEqual(meta1.archiveCreatorName, 'Dr. Jane Doe');
      assert.strictEqual(meta1.archiveCreationDate, '2026-11-04');
      assert.strictEqual(meta1.archiveAssociationType, 'MANUAL');

      // Also test associating an unmatched video with the existing archive
      const videoId2 = 'vid_manual_assoc_archive_' + Date.now();
      const assocRes = await fetch(
        `http://localhost:${port}/api/videos/${videoId2}/associate-archive`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archiveId: createdData.id }),
        }
      );

      assert.strictEqual(assocRes.status, 200);
      const assocData = await assocRes.json();
      assert.strictEqual(assocData.success, true);
      assert.strictEqual(assocData.archiveId, createdData.id);
      assert.strictEqual(assocData.archiveName, 'Confirmed Organoid Assay');

      const meta2 = await getVideoMetadata(databaseId, videoId2);
      assert.strictEqual(meta2.archiveId, createdData.id);
      assert.strictEqual(meta2.archiveName, 'Confirmed Organoid Assay');
      assert.strictEqual(meta2.archiveAssociationType, 'MANUAL');
    } finally {
      server.close();
    }
  });

  it('Pass 1 (EXPERIMENT_NOTEBOOK_WORKFLOW): should enforce concise formatting constraints, multimodal instructions, and omit redundant string startTime/endTime on events schema', async () => {
    let passedSchema = null;
    let passedPrompt = '';
    let passedSystemInstruction = '';

    const mockClient = {
      models: {
        generateContent: async (params) => {
          passedSchema = params.config?.responseSchema;
          passedPrompt = params.contents?.[0]?.parts?.find((p) => p.text)?.text || '';
          passedSystemInstruction = params.config?.systemInstruction || '';
          return {
            text: JSON.stringify({
              totalActionsDetected: 1,
              actions: [
                {
                  actionId: 'act_001',
                  actionType: 'MIX_REAGENTS',
                  actionClass: 'REAGENT_MIXING_ACTION',
                  description: 'Operator mixes 5 mL FBS into 45 mL DMEM',
                  startTime: '00:02',
                  endTime: '00:18',
                  startTimestampSeconds: 2,
                  endTimestampSeconds: 18,
                  confidenceScore: 0.96,
                },
              ],
              events: [
                {
                  eventId: 'evt_001',
                  eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                  eventTrack: 'video',
                  actionId: 'act_001',
                  actionIds: ['act_001'],
                  startTimestampSeconds: 3,
                  endTimestampSeconds: 6,
                  description: 'Operator presents FBS bottle label to camera',
                },
              ],
            }),
          };
        },
      },
    };

    setGenAIClient(mockClient);

    const actions = await runPass1ActionDetection({
      videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_pass1.mp4',
      videoId: 'vid_archive_pass1',
      classification: {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: 'Media Prep Protocol',
      },
    });

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].actionType, 'MIX_REAGENTS');
    assert.strictEqual(actions.events.length, 1);
    assert.strictEqual(actions.events[0].startTime, 3);
    assert.strictEqual(actions.events[0].endTime, 6);

    // Schema must NOT include string startTime/endTime on events items (which caused token degeneration)
    const eventItemProps = passedSchema?.properties?.events?.items?.properties;
    assert.strictEqual(eventItemProps?.startTime, undefined);
    assert.strictEqual(eventItemProps?.endTime, undefined);
    assert.strictEqual(eventItemProps?.startTimestampSeconds?.type, 'NUMBER');
    assert.strictEqual(eventItemProps?.endTimestampSeconds?.type, 'NUMBER');

    // Prompt & systemInstruction checks for archive workflow
    assert.ok(passedPrompt.includes('CRITICAL WORK STEP DETECTION RULES:'));
    assert.ok(passedPrompt.includes('CRITICAL CONSTRAINTS:'));
    assert.ok(passedPrompt.includes('NEVER output comma-separated lists of alternate timestamp formats'));
    assert.strictEqual(
      passedSystemInstruction.includes('IGNORE verbal count cues from the audio transcript'),
      false
    );
  });

  it('Pass 1 (EXPERIMENT_NOTEBOOK_WORKFLOW): should repair unterminated runaway timestamp string in events and preserve empty actions array without fabricating spurious actions', async () => {
    const truncatedRunawayPayload =
      '{ "totalActionsDetected": 0, "actions": [], "events": [ { "eventId": "evt_001", "eventClass": "PROTOCOL_AUDIO_UTTERANCE_EVENT", "startTimestampSeconds": 1, "endTimestampSeconds": 11, "startTime": "00:01.000,00:01,1.0s,00:01.0,1,00:01.00,0:01,00:01.000s,0:01.0,00:01s,00:01.0s,00:01:00,0:01.000,1.0,1s,0:01s,00:00:01,00:00:01.000,1.000,1.00s,1.00,1.000s,0:00:01,0:00:01.000,00:01:00.000,00:01.200,1.2,00:01.2,1.2s,00:01.500,1.5,1.5s,00:01.5,00:02.000,00:02,2.0s';

    const mockClient = {
      models: {
        generateContent: async () => ({
          candidates: [{ finishReason: 'MAX_TOKENS' }],
          text: truncatedRunawayPayload,
        }),
      },
    };

    setGenAIClient(mockClient);

    const actions = await runPass1ActionDetection({
      videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_truncated.mp4',
      videoId: 'vid_archive_truncated',
      classification: {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: 'Truncated Archive Test',
      },
    });

    assert.strictEqual(actions.length, 0);
    assert.strictEqual(actions.totalActionsDetected, 0);
    assert.strictEqual(actions.events.length, 1);
    assert.strictEqual(actions.events[0].eventId, 'evt_001');
    assert.strictEqual(actions.events[0].actionId, '');
    assert.deepStrictEqual(actions.events[0].actionIds, []);
    assert.strictEqual(actions.events[0].startTime, 1);
    assert.strictEqual(actions.events[0].endTime, 11);
  });

  it('Pass 1 (EXPERIMENT_NOTEBOOK_WORKFLOW): should normalize MIX_REAGENTS and SEED_REAGENTS in actionClass to REAGENT_MIXING_ACTION and REAGENT_SEEDING_ACTION', async () => {
    const mockClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            totalActionsDetected: 2,
            actions: [
              {
                actionId: 'act_001',
                actionType: 'MIX_REAGENTS',
                actionClass: 'MIX_REAGENTS',
                description: 'Operator mixes 5 mL FBS into 45 mL DMEM',
                startTime: '00:02',
                endTime: '00:18',
                startTimestampSeconds: 2,
                endTimestampSeconds: 18,
                confidenceScore: 0.96,
              },
              {
                actionId: 'act_002',
                actionType: 'SEED_REAGENTS',
                actionClass: 'SEED_REAGENTS',
                description: 'Operator seeds HEK293T cells into 96-well plate',
                startTime: '00:20',
                endTime: '00:45',
                startTimestampSeconds: 20,
                endTimestampSeconds: 45,
                confidenceScore: 0.95,
              },
            ],
            events: [],
          }),
        }),
      },
    };

    setGenAIClient(mockClient);

    const actions = await runPass1ActionDetection({
      videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_alias.mp4',
      videoId: 'vid_archive_alias',
      classification: {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: 'Alias ActionClass Test',
      },
    });

    assert.strictEqual(actions.length, 2);
    assert.strictEqual(actions[0].actionClass, 'REAGENT_MIXING_ACTION');
    assert.strictEqual(actions[0].actionType, 'MIX_REAGENTS');
    assert.strictEqual(actions[1].actionClass, 'REAGENT_SEEDING_ACTION');
    assert.strictEqual(actions[1].actionType, 'SEED_REAGENTS');
  });

  it('Pass 0 & Pass 1: should populate ARCHIVE_IDENTIFICATION and INVENTORY_IDENTIFICATION in Pass 0 and exclude repeated/misclassified identification events from Pass 1', async () => {
    const archivePass0Payload = {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      transcribedAudio:
        'Creating a new archive called A549 Proliferation Assay created by Dr. Jane Smith on 2026-11-05.',
      identificationEvent: {
        eventId: 'evt_id_001',
        eventClass: 'ARCHIVE_IDENTIFICATION',
        eventTrack: 'audio',
        startTime: 1.0,
        endTime: 11.0,
        description:
          'Operator announces experiment title, researcher name, date, and A549 cell proliferation protocol.',
      },
    };
    normalizePass0ArchiveMetadata(archivePass0Payload);
    assert.strictEqual(archivePass0Payload.identificationEvent.eventClass, 'ARCHIVE_IDENTIFICATION');
    assert.strictEqual(archivePass0Payload.identificationEvent.startTime, 1.0);
    assert.strictEqual(archivePass0Payload.identificationEvent.endTime, 11.0);

    const invPass0Payload = {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      inventoryName: 'Tank Alpha',
      transcribedAudio: 'Updating Tank Alpha cryo inventory.',
    };
    normalizePass0ArchiveMetadata(invPass0Payload);
    assert.strictEqual(invPass0Payload.identificationEvent.eventClass, 'INVENTORY_IDENTIFICATION');

    const mockClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            totalActionsDetected: 1,
            actions: [
              {
                actionId: 'act_001',
                actionType: 'MIX_REAGENTS',
                actionClass: 'REAGENT_MIXING_ACTION',
                description: 'Operator mixes 5 mL FBS into 45 mL DMEM',
                startTime: '00:15',
                endTime: '00:30',
                startTimestampSeconds: 15,
                endTimestampSeconds: 30,
                confidenceScore: 0.96,
              },
            ],
            events: [
              {
                eventId: 'evt_001',
                eventClass: 'VIAL_LABEL_PRESENTATION',
                eventTrack: 'audio',
                actionId: 'act_001',
                actionIds: ['act_001'],
                startTimestampSeconds: 1.0,
                endTimestampSeconds: 11.0,
                description:
                  'Operator announces experiment title, researcher name, date, and A549 cell proliferation protocol.',
              },
              {
                eventId: 'evt_002',
                eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                eventTrack: 'video',
                actionId: 'act_001',
                actionIds: ['act_001'],
                startTimestampSeconds: 12.0,
                endTimestampSeconds: 14.5,
                description: 'Operator presents FBS bottle label to camera',
              },
            ],
          }),
        }),
      },
    };

    setGenAIClient(mockClient);

    const actions = await runPass1ActionDetection({
      videoGcsUri: 'gs://customer-video-manager-storage/normalized/vid_archive_id_dedup.mp4',
      videoId: 'vid_archive_id_dedup',
      classification: archivePass0Payload,
    });

    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions.events.length, 1);
    assert.strictEqual(actions.events[0].eventId, 'evt_002');
    assert.strictEqual(actions.events[0].eventClass, 'REAGENT_LABEL_PRESENTATION_EVENT');
  });

  it('should preserve and merge reagents, labelTranscriptions, workSteps, and markdownDoc from Video 1 when Video 2 is signed off and committed to the same archive', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const videoId1 = 'vid_exp_part1_' + Date.now();
      const videoId2 = 'vid_exp_part2_' + Date.now();

      // 1. Create archive for Video 1
      const createRes = await fetch(`http://localhost:${port}/api/archives`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({
          name: 'Multi-Video Cell Seeding Experiment',
          creatorName: 'Dr. Elena Vance',
          creationDate: '2026-11-05',
          videoId: videoId1,
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const createdArchive = await createRes.json();
      const archiveId = createdArchive.id;

      // 2. Sign off and commit Video 1 entries (Media preparation: mixing DMEM + FBS)
      const signOff1Res = await fetch(`http://localhost:${port}/api/signoff/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({
          databaseId,
          videoId: videoId1,
          archiveId,
          archiveName: 'Multi-Video Cell Seeding Experiment',
          creatorName: 'Dr. Elena Vance',
          creationDate: '2026-11-05',
          markdownDoc:
            "## Description\nPart 1: Media preparation.\n\n## Reagents Used\n- **Dulbecco's Modified Eagle Medium** (DMEM)\n- **Fetal Bovine Serum** (FBS)\n\n## Experiment Steps\n1. **Mix Reagents**: Mixed 45 mL of DMEM with 5 mL of FBS.",
          reagents: [
            {
              id: 'reagent_1',
              reagentName: "Dulbecco's Modified Eagle Medium",
              reagentAcronym: 'DMEM',
              manufacturer: 'Gibco',
              catalogNumber: '11965-092',
              lotNumber: 'LOT-DMEM-01',
            },
            {
              id: 'reagent_2',
              reagentName: 'FBS',
              reagentAcronym: 'FBS',
              manufacturer: 'N/A',
              catalogNumber: 'N/A',
              lotNumber: '22C419',
            },
          ],
          labelTranscriptions: [
            "Gibco Dulbecco's Modified Eagle Medium (DMEM) | REF 11965-092 | LOT-DMEM-01",
          ],
          workSteps: [
            {
              id: 'step_1',
              stepNumber: 1,
              actionId: 'act_001',
              actionType: 'MIX_REAGENTS',
              description: 'Mixed 45 mL of DMEM with 5 mL of FBS.',
              mixReagentsData: {
                firstReagentName: "Dulbecco's Modified Eagle Medium",
                firstReagentAmount: '45 mL',
                secondReagentName: 'Fetal Bovine Serum',
                secondReagentAmount: '5 mL',
              },
            },
          ],
        }),
      });
      assert.strictEqual(signOff1Res.status, 200);

      // 3. Associate Video 2 with the same archive (as Pass 0 APPEND reconciliation does)
      await reconcileVideoArchiveAssociation(databaseId, videoId2, {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        archiveName: 'Multi-Video Cell Seeding Experiment',
        archiveIntent: 'APPEND',
        isAppending: true,
        transcribedAudio: 'Appending to Multi-Video Cell Seeding Experiment.',
      });

      // 4. Sign off and commit Video 2 entries (presents full FBS bottle + Trypsin-EDTA and seeds 96-well plate)
      const signOff2Res = await fetch(`http://localhost:${port}/api/signoff/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({
          databaseId,
          videoId: videoId2,
          archiveId,
          archiveName: 'Experiment Archive Notebook',
          creatorName: 'Lab Operator',
          creationDate: 'N/A',
          markdownDoc:
            '## Description\nPart 2: Seeding cells into 96-well plate.\n\n## Reagents Used\n- **Fetal Bovine Serum** (FBS)\n- **Trypsin-EDTA** (TE)\n\n## Experiment Steps\n1. **Seed Reagents**: Seeded A549 into 96-well plate.',
          reagents: [
            {
              id: 'reagent_1',
              reagentName: 'Fetal Bovine Serum',
              reagentAcronym: 'FBS',
              manufacturer: 'Sigma-Aldrich',
              catalogNumber: 'F2442',
              lotNumber: 'N/A',
            },
            {
              id: 'reagent_2',
              reagentName: 'Trypsin-EDTA',
              reagentAcronym: 'TE',
              manufacturer: 'Gibco',
              catalogNumber: '25200-056',
              lotNumber: 'LOT-TE-99',
            },
          ],
          labelTranscriptions: [
            'Sigma-Aldrich Fetal Bovine Serum (FBS) | Cat. # F2442',
            'Gibco Trypsin-EDTA (TE) | REF 25200-056 | LOT-TE-99',
          ],
          workSteps: [
            {
              id: 'step_1',
              stepNumber: 1,
              actionId: 'act_001',
              actionType: 'SEED_REAGENTS',
              description: 'Seeded A549 cells into 96-well plate using 8-channel pipette.',
              seedReagentsData: {
                plateType: '96-well plate',
                pipetteType: '8-channel pipette',
                cellsSeeded: 'A549',
                cellsPerWell: '5,000 cells/well',
                seedingEventsCount: 12,
                expectedSeedingEventsCount: 12,
                isSeedingCountCorrect: true,
              },
            },
          ],
        }),
      });
      assert.strictEqual(signOff2Res.status, 200);
      const signOff2Data = await signOff2Res.json();

      // Verify response from Video 2 sign-off contains merged reagents (3 total: DMEM, merged FBS, TE) and both workSteps (2 total)
      assert.strictEqual(signOff2Data.reagents.length, 3);
      assert.strictEqual(signOff2Data.workSteps.length, 2);

      // 5. Fetch the archive via GET /api/archives/:id and verify Video 1 + Video 2 contents are both intact
      const getArchiveRes = await fetch(`http://localhost:${port}/api/archives/${archiveId}`, {
        headers: { 'x-database-id': databaseId },
      });
      assert.strictEqual(getArchiveRes.status, 200);
      const finalArchive = await getArchiveRes.json();

      // Metadata from Video 1 must not be overwritten by generic placeholders from Video 2
      assert.strictEqual(finalArchive.name, 'Multi-Video Cell Seeding Experiment');
      assert.strictEqual(finalArchive.creatorName, 'Dr. Elena Vance');
      assert.strictEqual(finalArchive.creationDate, '2026-11-05');
      assert.deepStrictEqual(finalArchive.videoIds, [videoId1, videoId2]);

      // Reagents from Video 1 (DMEM, FBS) and Video 2 (FBS enriched, Trypsin-EDTA) must all be present and merged
      assert.strictEqual(finalArchive.reagents.length, 3);
      const dmem = finalArchive.reagents.find((r) => r.reagentAcronym === 'DMEM');
      const fbs = finalArchive.reagents.find((r) => r.reagentAcronym === 'FBS');
      const te = finalArchive.reagents.find((r) => r.reagentAcronym === 'TE');
      assert.ok(dmem, 'DMEM from Video 1 must be preserved');
      assert.strictEqual(dmem.lotNumber, 'LOT-DMEM-01');
      assert.ok(fbs, 'FBS must be merged across Video 1 and Video 2');
      assert.strictEqual(fbs.reagentName, 'Fetal Bovine Serum');
      assert.strictEqual(fbs.manufacturer, 'Sigma-Aldrich');
      assert.strictEqual(fbs.catalogNumber, 'F2442');
      assert.strictEqual(fbs.lotNumber, '22C419');
      assert.ok(te, 'Trypsin-EDTA from Video 2 must be added');

      // Label transcriptions from both videos must be preserved
      assert.strictEqual(finalArchive.labelTranscriptions.length, 3);

      // Work steps from both Video 1 and Video 2 must be preserved in sequence (step 1 = MIX_REAGENTS, step 2 = SEED_REAGENTS)
      assert.strictEqual(finalArchive.workSteps.length, 2);
      assert.strictEqual(finalArchive.workSteps[0].stepNumber, 1);
      assert.strictEqual(finalArchive.workSteps[0].actionType, 'MIX_REAGENTS');
      assert.strictEqual(finalArchive.workSteps[0].videoId, videoId1);
      assert.strictEqual(finalArchive.workSteps[1].stepNumber, 2);
      assert.strictEqual(finalArchive.workSteps[1].actionType, 'SEED_REAGENTS');
      assert.strictEqual(finalArchive.workSteps[1].videoId, videoId2);

      // Markdown document must contain both Video 1 and Video 2 reagents and steps
      assert.ok(finalArchive.markdownDoc.includes("Dulbecco's Modified Eagle Medium"));
      assert.ok(finalArchive.markdownDoc.includes('Trypsin-EDTA'));
      assert.ok(finalArchive.markdownDoc.includes('1. **Mix Reagents**'));
      assert.ok(finalArchive.markdownDoc.includes('2. **Seed Reagents**'));

      // 5b. Verify committed videos and test POST /api/videos/:videoId/undo-commit
      const v2MetaCommitted = await getVideoMetadata(databaseId, videoId2);
      assert.strictEqual(v2MetaCommitted.isSignedOff, true);
      assert.strictEqual(v2MetaCommitted.passes?.hitl?.status, 'COMPLETED');

      // Undo commit for Video 2 via POST /api/videos/:videoId/undo-commit
      const undoRes = await fetch(`http://localhost:${port}/api/videos/${videoId2}/undo-commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({ databaseId }),
      });
      assert.strictEqual(undoRes.status, 200);
      const undoData = await undoRes.json();
      assert.strictEqual(undoData.success, true);
      assert.strictEqual(undoData.passes?.hitl?.status, 'PENDING');
      assert.strictEqual(undoData.isSignedOff, false);

      const v2MetaUndone = await getVideoMetadata(databaseId, videoId2);
      assert.strictEqual(v2MetaUndone.isSignedOff, false);
      assert.strictEqual(v2MetaUndone.passes?.hitl?.status, 'PENDING');

      // Re-commit Video 2 notes
      const reCommitRes = await fetch(`http://localhost:${port}/api/signoff/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({
          databaseId,
          archiveId,
          videoId: videoId2,
          reagents: finalArchive.reagents,
          workSteps: finalArchive.workSteps,
        }),
      });
      assert.strictEqual(reCommitRes.status, 200);

      // 6. Erase the archive notebook content via POST /api/archives/:id/empty
      const emptyRes = await fetch(`http://localhost:${port}/api/archives/${archiveId}/empty`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({ databaseId }),
      });
      assert.strictEqual(emptyRes.status, 200);
      const emptiedData = await emptyRes.json();
      assert.strictEqual(emptiedData.success, true);
      assert.strictEqual(emptiedData.name, 'Multi-Video Cell Seeding Experiment');
      assert.strictEqual(emptiedData.creatorName, 'Dr. Elena Vance');
      assert.strictEqual(emptiedData.creationDate, '2026-11-05');
      assert.deepStrictEqual(emptiedData.reagents, []);
      assert.deepStrictEqual(emptiedData.labelTranscriptions, []);
      assert.deepStrictEqual(emptiedData.workSteps, []);
      assert.deepStrictEqual(emptiedData.videoIds, []);

      // Verify linked videos (videoId1 and videoId2) had their commit states automatically reset
      const v1MetaAfterEmpty = await getVideoMetadata(databaseId, videoId1);
      const v2MetaAfterEmpty = await getVideoMetadata(databaseId, videoId2);
      assert.strictEqual(v1MetaAfterEmpty.isSignedOff, false);
      assert.strictEqual(v1MetaAfterEmpty.passes?.hitl?.status, 'PENDING');
      assert.strictEqual(v2MetaAfterEmpty.isSignedOff, false);
      assert.strictEqual(v2MetaAfterEmpty.passes?.hitl?.status, 'PENDING');

      // Verify GET /api/archives/:id returns empty notebook arrays while retaining identification metadata
      const getAfterEmptyRes = await fetch(`http://localhost:${port}/api/archives/${archiveId}`, {
        headers: { 'x-database-id': databaseId },
      });
      assert.strictEqual(getAfterEmptyRes.status, 200);
      const afterEmptyArchive = await getAfterEmptyRes.json();
      assert.strictEqual(afterEmptyArchive.name, 'Multi-Video Cell Seeding Experiment');
      assert.deepStrictEqual(afterEmptyArchive.reagents, []);
      assert.deepStrictEqual(afterEmptyArchive.labelTranscriptions, []);
      assert.deepStrictEqual(afterEmptyArchive.workSteps, []);

      // 7. Delete the archive via DELETE /api/archives/:id
      const deleteRes = await fetch(`http://localhost:${port}/api/archives/${archiveId}`, {
        method: 'DELETE',
        headers: { 'x-database-id': databaseId },
      });
      assert.strictEqual(deleteRes.status, 200);
      const deleteData = await deleteRes.json();
      assert.strictEqual(deleteData.success, true);
      assert.strictEqual(deleteData.deletedId, archiveId);

      // Verify GET /api/archives/:id returns 404 after deletion
      const getAfterDeleteRes = await fetch(`http://localhost:${port}/api/archives/${archiveId}`, {
        headers: { 'x-database-id': databaseId },
      });
      assert.strictEqual(getAfterDeleteRes.status, 404);
    } finally {
      server.close();
    }
  });

  it('should match archive names that differ by capitalization in Pass 0 and preserve canonical archive capitalization on manual pull-down association and sign-off', async () => {
    const databaseId = 'test_db_cap_match';
    const tenantDb = getTenantFirestore(databaseId);
    const canonicalArchiveId = 'arch_cap_001';
    const canonicalArchiveName = 'A549 cell Proliferation Assay';

    // 1. Seed an existing archive where one word ("cell") is not capitalized
    await tenantDb.collection('archives').doc(canonicalArchiveId).set({
      id: canonicalArchiveId,
      name: canonicalArchiveName,
      creatorName: 'Dr. Sarah Chen',
      creationDate: '2026-11-01',
      videoIds: ['vid_cap_1'],
      reagents: [],
      labelTranscriptions: [],
      workSteps: [],
      markdownDoc: '# Experiment Archive\n\n## Description\nA549 cell Proliferation Assay',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });

    // 2. Video 2 Pass 0 transcribes the archive name with "Cell" capitalized (or ALL CAPS)
    // and even if Gemini defaults archiveIntent to CREATE (without explicit "creating a new" speech)
    const videoIdAuto = 'vid_cap_auto_2';
    await updateVideoRecord(databaseId, videoIdAuto, {
      videoId: videoIdAuto,
      originalName: 'cap_auto_2.mp4',
      status: 'READY_FOR_ANALYSIS',
    });
    const classificationAuto = {
      workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
      transcribedAudio: 'This video is for the A549 Cell Proliferation Assay archive.',
      archiveName: 'The A549 Cell Proliferation Assay Archive',
      creatorName: 'Dr. Sarah Chen',
      creationDate: '2026-11-01',
      archiveIntent: 'CREATE',
      isAppending: false,
    };

    const reconcileAuto = await reconcileVideoArchiveAssociation(
      databaseId,
      videoIdAuto,
      classificationAuto
    );
    assert.strictEqual(reconcileAuto.matched, true);
    assert.strictEqual(reconcileAuto.archiveId, canonicalArchiveId);
    assert.strictEqual(reconcileAuto.archiveName, canonicalArchiveName);
    assert.strictEqual(classificationAuto.archiveName, canonicalArchiveName);

    const autoVideoMeta = await getVideoMetadata(databaseId, videoIdAuto);
    assert.strictEqual(autoVideoMeta.archiveId, canonicalArchiveId);
    assert.strictEqual(autoVideoMeta.archiveName, canonicalArchiveName);

    // 3. Test manual pull-down association when a video initially had a fully-capitalized Pass 0 archiveName
    const videoIdManual = 'vid_cap_manual_3';
    const fullyCapName = 'A549 CELL PROLIFERATION ASSAY';
    await updateVideoRecord(databaseId, videoIdManual, {
      videoId: videoIdManual,
      originalName: 'cap_manual_3.mp4',
      status: 'ANALYSIS_COMPLETE',
      unmatchedArchiveName: fullyCapName,
      archiveAssociationType: 'UNMATCHED',
      passes: {
        pass0: {
          status: 'COMPLETED',
          data: {
            workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
            transcribedAudio: 'Recording for A549 CELL PROLIFERATION ASSAY.',
            archiveName: fullyCapName,
            archiveIntent: 'APPEND',
            isAppending: true,
          },
        },
        pass1: { status: 'COMPLETED', data: { actions: [] } },
        pass2: { status: 'COMPLETED', data: { events: [] } },
        pass3: { status: 'COMPLETED', data: [] },
        hitl: { status: 'PENDING' },
      },
    });
    await saveVideoAnalysis(databaseId, videoIdManual, {
      videoId: videoIdManual,
      archiveName: fullyCapName,
      workflowClassification: {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        transcribedAudio: 'Recording for A549 CELL PROLIFERATION ASSAY.',
        archiveName: fullyCapName,
      },
      workloadClassification: {
        workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
        transcribedAudio: 'Recording for A549 CELL PROLIFERATION ASSAY.',
        archiveName: fullyCapName,
      },
      actions: [],
      events: [],
      refinements: [],
      isSignedOff: false,
    });

    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = server.address().port;

    try {
      // User picks canonicalArchiveId from the pull-down menu
      const assocRes = await fetch(
        `http://localhost:${port}/api/videos/${videoIdManual}/associate-archive`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-database-id': databaseId,
          },
          body: JSON.stringify({
            archiveId: canonicalArchiveId,
            databaseId,
          }),
        }
      );
      assert.strictEqual(assocRes.status, 200);
      const assocData = await assocRes.json();
      assert.strictEqual(assocData.archiveId, canonicalArchiveId);
      assert.strictEqual(assocData.archiveName, canonicalArchiveName);

      // Verify pass0.data.archiveName on videos/{videoIdManual} was updated to canonicalArchiveName
      const manualVidMeta = await getVideoMetadata(databaseId, videoIdManual);
      assert.strictEqual(manualVidMeta.archiveName, canonicalArchiveName);
      assert.strictEqual(manualVidMeta.passes?.pass0?.data?.archiveName, canonicalArchiveName);

      // Verify GET video_analyses/:videoId returns canonicalArchiveName everywhere
      const analysisRes = await fetch(
        `http://localhost:${port}/databases/${databaseId}/documents/video_analyses/${videoIdManual}`,
        {
          headers: { 'x-database-id': databaseId },
        }
      );
      assert.strictEqual(analysisRes.status, 200);
      const analysisDoc = await analysisRes.json();
      assert.strictEqual(analysisDoc.archiveId, canonicalArchiveId);
      assert.strictEqual(analysisDoc.archiveName, canonicalArchiveName);
      assert.strictEqual(analysisDoc.workflowClassification?.archiveName, canonicalArchiveName);
      assert.strictEqual(analysisDoc.workloadClassification?.archiveName, canonicalArchiveName);

      // Even if sign-off payload sends the fully capitalized name from an older cached state,
      // commitArchiveSignOff must preserve the existing archive's canonicalArchiveName
      const signOffRes = await fetch(`http://localhost:${port}/api/signoff/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-database-id': databaseId,
        },
        body: JSON.stringify({
          databaseId,
          archiveId: canonicalArchiveId,
          videoId: videoIdManual,
          archiveName: fullyCapName,
          reagents: [],
          workSteps: [],
        }),
      });
      assert.strictEqual(signOffRes.status, 200);
      const signOffData = await signOffRes.json();
      assert.strictEqual(signOffData.archiveName, canonicalArchiveName);

      // Verify the archive's name in Firestore is still 'A549 cell Proliferation Assay'
      const getArchRes = await fetch(
        `http://localhost:${port}/api/archives/${canonicalArchiveId}`,
        {
          headers: { 'x-database-id': databaseId },
        }
      );
      assert.strictEqual(getArchRes.status, 200);
      const finalArch = await getArchRes.json();
      assert.strictEqual(finalArch.name, canonicalArchiveName);
    } finally {
      server.close();
    }
  });
});
