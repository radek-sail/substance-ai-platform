const { describe, it } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  computeLabelVisibilityScore,
  isReagentLabelPresentationEvent,
  extractReagentIdentityFromEvent,
  deduplicateReagentLabelPresentationEvents,
} = require('@sail/shared');

describe('Pass 2: Reagent Label Presentation Deduplication & Best-Visibility Selection', () => {
  describe('computeLabelVisibilityScore', () => {
    it('should assign a higher score to an event that is closer to camera and not occluded', () => {
      const occludedFarEvent = {
        eventId: 'evt_001',
        eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
        description: 'Reagent bottle held far from camera, partly occluded by operator hand',
        isOccluded: true,
        cameraCloseness: 'FAR',
        highestContrastFrame: {
          sharpnessScore: 10,
          contrastScore: 15,
          blurScore: 40,
        },
      };

      const closeUnoccludedEvent = {
        eventId: 'evt_002',
        eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
        description: 'Reagent bottle presented close to camera and not occluded by objects in the foreground',
        isOccluded: false,
        cameraCloseness: 'CLOSE',
        highestContrastFrame: {
          sharpnessScore: 85,
          contrastScore: 90,
          blurScore: 5,
        },
      };

      const score1 = computeLabelVisibilityScore(occludedFarEvent);
      const score2 = computeLabelVisibilityScore(closeUnoccludedEvent);

      assert.ok(
        score2 > score1,
        `Expected close & unoccluded event score (${score2}) to exceed occluded far score (${score1})`
      );
    });

    it('should penalize foreground occlusion indicated in text descriptions', () => {
      const occludedTextEvent = {
        eventId: 'evt_a',
        eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
        description: 'Operator shows bottle but label is occluded by objects in the foreground',
      };

      const unoccludedTextEvent = {
        eventId: 'evt_b',
        eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
        description: 'Operator shows bottle; label is unoccluded and closest to camera',
      };

      const scoreA = computeLabelVisibilityScore(occludedTextEvent);
      const scoreB = computeLabelVisibilityScore(unoccludedTextEvent);

      assert.ok(
        scoreB > scoreA,
        `Expected unoccluded description score (${scoreB}) to be higher than occluded description (${scoreA})`
      );
    });
  });

  describe('isReagentLabelPresentationEvent', () => {
    it('should accurately identify reagent label presentation events', () => {
      assert.strictEqual(
        isReagentLabelPresentationEvent({ eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT' }),
        true
      );
      assert.strictEqual(
        isReagentLabelPresentationEvent({ eventClass: 'REAGENT_LABEL_PRESENTATION' }),
        true
      );
      assert.strictEqual(
        isReagentLabelPresentationEvent({ eventClass: 'VIAL_LABEL_PRESENTATION' }),
        false
      );
      assert.strictEqual(
        isReagentLabelPresentationEvent({ eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT' }),
        false
      );
    });
  });

  describe('deduplicateReagentLabelPresentationEvents', () => {
    it('should select the single event where the label is closest to camera and not occluded', () => {
      const events = [
        {
          eventId: 'evt_dmem_far',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: "Dulbecco's Modified Eagle Medium",
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco',
          catalogNumber: '11965-092',
          lotNumber: '2456101',
          startTime: 10,
          endTime: 14,
          description: 'DMEM bottle held far in background, partially occluded by beaker in foreground',
          isOccluded: true,
          cameraCloseness: 'FAR',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_dmem_best',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'DMEM',
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco',
          catalogNumber: '11965-092',
          lotNumber: '2456101',
          startTime: 45,
          endTime: 48,
          description: 'DMEM bottle presented directly to camera, closest to the camera and not occluded by objects in the foreground',
          isOccluded: false,
          cameraCloseness: 'CLOSE',
          actionId: 'act_002',
          actionIds: ['act_002'],
          highestContrastFrame: {
            sharpnessScore: 92,
            contrastScore: 88,
            blurScore: 4,
          },
        },
      ];

      const actions = [
        { actionId: 'act_001', actionClass: 'REAGENT_MIXING_ACTION', eventList: ['evt_dmem_far'] },
        { actionId: 'act_002', actionClass: 'REAGENT_MIXING_ACTION', eventList: ['evt_dmem_best'] },
      ];

      const { deduplicatedEvents, droppedEventIds, replacementMap } =
        deduplicateReagentLabelPresentationEvents(events, actions);

      assert.strictEqual(deduplicatedEvents.length, 1, 'Should output exactly one event for DMEM');
      assert.strictEqual(deduplicatedEvents[0].eventId, 'evt_dmem_best', 'Should pick the best visible event');
      assert.deepStrictEqual(droppedEventIds, ['evt_dmem_far']);
      assert.strictEqual(replacementMap.get('evt_dmem_far'), 'evt_dmem_best');

      // Check actionIds merged onto winning event
      assert.ok(deduplicatedEvents[0].actionIds.includes('act_001'));
      assert.ok(deduplicatedEvents[0].actionIds.includes('act_002'));

      // Check actions.eventList updated
      assert.deepStrictEqual(actions[0].eventList, ['evt_dmem_best']);
      assert.deepStrictEqual(actions[1].eventList, ['evt_dmem_best']);
    });

    it('should deduplicate multiple presentations of different reagents independently', () => {
      const events = [
        // Reagent 1: FBS (two events: one occluded, one clear)
        {
          eventId: 'evt_fbs_occluded',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'Fetal Bovine Serum',
          reagentAcronym: 'FBS',
          isOccluded: true,
          startTime: 5,
          endTime: 8,
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_fbs_clear',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'FBS',
          reagentAcronym: 'FBS',
          isOccluded: false,
          cameraCloseness: 'CLOSE',
          startTime: 20,
          endTime: 23,
          actionIds: ['act_002'],
        },
        // Reagent 2: Trypsin-EDTA (two events: one far, one close)
        {
          eventId: 'evt_te_close',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'Trypsin-EDTA',
          reagentAcronym: 'TE',
          isOccluded: false,
          cameraCloseness: 'CLOSE',
          startTime: 30,
          endTime: 33,
          actionIds: ['act_003'],
        },
        {
          eventId: 'evt_te_far',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'Trypsin-EDTA',
          reagentAcronym: 'TE',
          isOccluded: false,
          cameraCloseness: 'FAR',
          startTime: 50,
          endTime: 53,
          actionIds: ['act_004'],
        },
        // Non-reagent event (should remain untouched)
        {
          eventId: 'evt_audio_01',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          spokenContext: 'Preparing 50 mL of complete growth medium',
          startTime: 1,
          endTime: 4,
          actionIds: ['act_001'],
        },
      ];

      const { deduplicatedEvents } = deduplicateReagentLabelPresentationEvents(events);

      // Total events should be 3: 1 for FBS + 1 for Trypsin-EDTA + 1 audio event
      assert.strictEqual(deduplicatedEvents.length, 3);

      const fbsEvents = deduplicatedEvents.filter((e) =>
        e.eventClass === 'REAGENT_LABEL_PRESENTATION_EVENT' &&
        (e.reagentAcronym === 'FBS' || e.reagentName === 'Fetal Bovine Serum')
      );
      assert.strictEqual(fbsEvents.length, 1);
      assert.strictEqual(fbsEvents[0].eventId, 'evt_fbs_clear');

      const teEvents = deduplicatedEvents.filter((e) =>
        e.eventClass === 'REAGENT_LABEL_PRESENTATION_EVENT' &&
        (e.reagentAcronym === 'TE' || e.reagentName === 'Trypsin-EDTA')
      );
      assert.strictEqual(teEvents.length, 1);
      assert.strictEqual(teEvents[0].eventId, 'evt_te_close');

      const audioEvents = deduplicatedEvents.filter(
        (e) => e.eventClass === 'PROTOCOL_AUDIO_UTTERANCE_EVENT'
      );
      assert.strictEqual(audioEvents.length, 1);
      assert.strictEqual(audioEvents[0].eventId, 'evt_audio_01');
    });

    it('should preserve missing label attributes by merging data from duplicate events', () => {
      const events = [
        {
          eventId: 'evt_dmem_1',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: "Dulbecco's Modified Eagle Medium",
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco',
          catalogNumber: '11965-092',
          lotNumber: 'N/A', // missed lot number
          isOccluded: true,
          startTime: 10,
          endTime: 12,
        },
        {
          eventId: 'evt_dmem_2',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          reagentName: 'DMEM',
          reagentAcronym: 'DMEM',
          manufacturer: 'N/A', // missed manufacturer
          catalogNumber: 'N/A',
          lotNumber: 'LOT-998822', // read lot number
          isOccluded: false,
          cameraCloseness: 'CLOSE',
          startTime: 25,
          endTime: 28,
        },
      ];

      const { deduplicatedEvents } = deduplicateReagentLabelPresentationEvents(events);
      assert.strictEqual(deduplicatedEvents.length, 1);

      const winner = deduplicatedEvents[0];
      assert.strictEqual(winner.eventId, 'evt_dmem_2'); // winning event because close & unoccluded
      // Verify merged label fields
      assert.strictEqual(winner.manufacturer, 'Gibco');
      assert.strictEqual(winner.catalogNumber, '11965-092');
      assert.strictEqual(winner.lotNumber, 'LOT-998822');
      assert.strictEqual(winner.reagentAcronym, 'DMEM');
    });
  });

  describe('generateContentWithRetry resilience against fetch failed', () => {
    it('should retry when encountering transient "fetch failed" error and return response on retry', async () => {
      const { generateContentWithRetry } = require('../dist/services/gemini.service');

      let attempts = 0;
      const mockClient = {
        models: {
          generateContent: async () => {
            attempts++;
            if (attempts === 1) {
              throw new TypeError('fetch failed');
            }
            return {
              text: '{"status":"ok"}',
            };
          },
        },
      };

      const result = await generateContentWithRetry(mockClient, { model: 'gemini-1.5-pro' }, 3);
      assert.strictEqual(attempts, 2, 'Expected retry after initial fetch failed error');
      assert.strictEqual(result.text, '{"status":"ok"}');
    });
  });

  describe('Pass 1: Reagent Label Presentation Deduplication & Best-Visibility Selection', () => {
    it('should deduplicate reagent presentation events in Pass 1 and select the best visible event', async () => {
      const {
        runPass1ActionDetection,
        setGenAIClient,
        resetGenAIClient,
      } = require('../dist/services/gemini.service');

      setGenAIClient({
        models: {
          generateContent: async () => {
            return {
              text: JSON.stringify({
                workflowContext: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
                totalActionsDetected: 2,
                totalEventsDetected: 2,
                modelUsed: 'gemini-1.5-pro',
                actions: [
                  {
                    actionId: 'act_001',
                    actionClass: 'REAGENT_MIXING_ACTION',
                    description: 'Operator mixes FBS into DMEM',
                    startTimestampSeconds: 10,
                    endTimestampSeconds: 20,
                    startTime: '00:10',
                    endTime: '00:20',
                    confidenceScore: 0.95,
                  },
                  {
                    actionId: 'act_002',
                    actionClass: 'REAGENT_MIXING_ACTION',
                    description: 'Operator transfers mixed media',
                    startTimestampSeconds: 25,
                    endTimestampSeconds: 35,
                    startTime: '00:25',
                    endTime: '00:35',
                    confidenceScore: 0.9,
                  },
                ],
                events: [
                  {
                    eventId: 'evt_fbs_occluded',
                    eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                    reagentName: 'Fetal Bovine Serum',
                    reagentAcronym: 'FBS',
                    manufacturer: 'Gibco',
                    catalogNumber: '11965-092',
                    lotNumber: 'N/A',
                    startTime: 5,
                    endTime: 8,
                    isOccluded: true,
                    cameraCloseness: 'FAR',
                    description: 'FBS bottle shown far from camera, partly occluded by operator hand',
                    actionId: 'act_001',
                    actionIds: ['act_001'],
                  },
                  {
                    eventId: 'evt_fbs_best_visible',
                    eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                    reagentName: 'FBS',
                    reagentAcronym: 'FBS',
                    manufacturer: 'Gibco',
                    catalogNumber: '11965-092',
                    lotNumber: 'LOT-FBS-999',
                    startTime: 22,
                    endTime: 24,
                    isOccluded: false,
                    cameraCloseness: 'CLOSE',
                    description: 'FBS bottle shown closest to camera and not occluded by objects in foreground',
                    actionId: 'act_002',
                    actionIds: ['act_002'],
                  },
                ],
              }),
            };
          },
        },
      });

      try {
        const pass1Actions = await runPass1ActionDetection({
          videoId: 'vid_archive_pass1_dedup',
          videoGcsUri: 'gs://test-bucket/normalized/norm_archive_pass1.mp4',
          classification: {
            workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
            confidence: 1.0,
            notes: 'Test archive',
          },
        });

        // Pass 1 actions must have events attached
        const pass1Events = pass1Actions.events;
        assert.ok(Array.isArray(pass1Events), 'Expected pass1Actions.events to be an array');
        assert.strictEqual(
          pass1Events.length,
          1,
          'Pass 1 should have deduplicated the two FBS presentations to exactly 1 event'
        );

        const surviving = pass1Events[0];
        assert.strictEqual(
          surviving.eventId,
          'evt_fbs_best_visible',
          'Pass 1 should select the best visible (closest to camera, unoccluded) event'
        );
        assert.strictEqual(surviving.lotNumber, 'LOT-FBS-999');

        // Verify actionIds merged onto surviving event in Pass 1
        assert.ok(surviving.actionIds.includes('act_001'));
        assert.ok(surviving.actionIds.includes('act_002'));

        // Verify Pass 1 actions have updated eventList referencing the winning event
        assert.ok(pass1Actions[0].eventList.includes('evt_fbs_best_visible'));
        assert.ok(pass1Actions[1].eventList.includes('evt_fbs_best_visible'));
        assert.strictEqual(pass1Actions[0].eventList.includes('evt_fbs_occluded'), false);
      } finally {
        resetGenAIClient();
      }
    });
  });

  describe('Pass 2: Archive Workflow Spurious Vial/Box Event Suppression', () => {
    it('should generate schema without vial/box classes when isArchiveWorkflow is true', () => {
      const { getEventDetectionSchema } = require('../dist/services/gemini.service');

      const defaultSchema = getEventDetectionSchema(false);
      const archiveSchema = getEventDetectionSchema(true);

      const defaultClasses = defaultSchema.properties.events.items.properties.eventClass.enum;
      const archiveClasses = archiveSchema.properties.events.items.properties.eventClass.enum;

      assert.ok(defaultClasses.includes('VIAL_LABEL_PRESENTATION'), 'Default schema must include VIAL_LABEL_PRESENTATION');
      assert.ok(defaultClasses.includes('BOX_LABEL_PRESENTATION'), 'Default schema must include BOX_LABEL_PRESENTATION');
      assert.ok(defaultClasses.includes('VIAL_INSERTION'), 'Default schema must include VIAL_INSERTION');

      assert.strictEqual(
        archiveClasses.includes('VIAL_LABEL_PRESENTATION'),
        false,
        'Archive schema must NOT include VIAL_LABEL_PRESENTATION'
      );
      assert.strictEqual(
        archiveClasses.includes('BOX_LABEL_PRESENTATION'),
        false,
        'Archive schema must NOT include BOX_LABEL_PRESENTATION'
      );
      assert.strictEqual(
        archiveClasses.includes('VIAL_INSERTION'),
        false,
        'Archive schema must NOT include VIAL_INSERTION'
      );
      assert.ok(
        archiveClasses.includes('REAGENT_LABEL_PRESENTATION_EVENT'),
        'Archive schema must include REAGENT_LABEL_PRESENTATION_EVENT'
      );
      assert.strictEqual(
        archiveClasses.includes('PROTOCOL_AUDIO_UTTERANCE_EVENT'),
        false,
        'Archive Pass 2 schema must NOT include PROTOCOL_AUDIO_UTTERANCE_EVENT'
      );
    });

    it('should only select best shots for the 3 Pass 1 REAGENT_LABEL_PRESENTATION_EVENTs and ignore the 5 Pass 1 PROTOCOL_AUDIO_UTTERANCE_EVENTs', async () => {
      const {
        runPass2EventDetection,
        setGenAIClient,
        resetGenAIClient,
      } = require('../dist/services/gemini.service');

      const pass1EventsFrom8Cards = [
        {
          eventId: 'evt_001',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          eventTrack: 'audio',
          startTime: 8.0,
          endTime: 12.0,
          description: 'Operator announces making media for growing A549 cells.',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_002',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          eventTrack: 'video',
          startTime: 9.0,
          endTime: 15.0,
          description: 'Operator presents the Gibco DMEM media bottle label to the camera.',
          reagentName: 'DMEM',
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_003',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          eventTrack: 'video',
          startTime: 16.0,
          endTime: 24.0,
          description: 'Operator presents the Gibco Penicillin-Streptomycin bottle label to the camera.',
          reagentName: 'Penicillin-Streptomycin',
          reagentAcronym: 'PS',
          manufacturer: 'Gibco',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_004',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          eventTrack: 'audio',
          startTime: 19.0,
          endTime: 23.0,
          description: 'Operator states adding 5 milliliters of Penicillin-Streptomycin.',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_005',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          eventTrack: 'audio',
          startTime: 26.0,
          endTime: 33.0,
          description: 'Operator states adding 50 milliliters of FBS from the previously shown bottle.',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_006',
          eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
          eventTrack: 'video',
          startTime: 27.0,
          endTime: 33.0,
          description: 'Operator presents the 50 mL tube labeled FBS to the camera.',
          reagentName: 'Fetal Bovine Serum',
          reagentAcronym: 'FBS',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_007',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          eventTrack: 'audio',
          startTime: 38.0,
          endTime: 40.0,
          description: 'Operator states 50 mL while uncapping and pouring the FBS tube.',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
        {
          eventId: 'evt_008',
          eventClass: 'PROTOCOL_AUDIO_UTTERANCE_EVENT',
          eventTrack: 'audio',
          startTime: 48.0,
          endTime: 50.0,
          description: 'Operator states 5 mL while preparing pipette and Penicillin-Streptomycin bottle.',
          actionId: 'act_001',
          actionIds: ['act_001'],
        },
      ];

      let capturedPromptText = '';
      setGenAIClient({
        models: {
          generateContent: async (req) => {
            const parts = req?.contents?.[0]?.parts || [];
            const textPart = parts.find((p) => typeof p.text === 'string');
            capturedPromptText = textPart ? textPart.text : '';
            // Even if model renumbers eventIds as evt_001..evt_003 or emits extra events, Pass 2 must only return the 3 Pass 1 reagent events
            return {
              text: JSON.stringify({
                events: [
                  {
                    eventId: 'evt_001',
                    eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                    startTime: 9.0,
                    endTime: 15.0,
                    highestContrastTimestamp: 11.5,
                    minimalBlurTimestamp: 12.0,
                    bestShotTimes: [11.5, 12.0],
                  },
                  {
                    eventId: 'evt_002',
                    eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                    startTime: 16.0,
                    endTime: 24.0,
                    highestContrastTimestamp: 19.5,
                    minimalBlurTimestamp: 20.0,
                    bestShotTimes: [19.5, 20.0],
                  },
                  {
                    eventId: 'evt_003',
                    eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                    startTime: 27.0,
                    endTime: 33.0,
                    highestContrastTimestamp: 29.5,
                    minimalBlurTimestamp: 30.0,
                    bestShotTimes: [29.5, 30.0],
                  },
                ],
                refinedActions: [
                  {
                    actionId: 'act_001',
                    refinedStartTimestampSeconds: 8.0,
                    refinedEndTimestampSeconds: 50.0,
                  },
                ],
              }),
            };
          },
        },
      });

      try {
        const pass2Events = await runPass2EventDetection({
          videoId: 'vid_archive_3_of_8_test',
          videoGcsUri: 'gs://test-bucket/normalized/norm_archive_3_of_8.mp4',
          classification: {
            workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
            confidence: 1.0,
            notes: 'A549 media preparation',
          },
          actions: [
            {
              actionId: 'act_001',
              actionClass: 'REAGENT_MIXING_ACTION',
              startTime: '00:08',
              endTime: '00:50',
              startTimestampSeconds: 8,
              endTimestampSeconds: 50,
              eventList: pass1EventsFrom8Cards.map((e) => e.eventId),
            },
          ],
          events: pass1EventsFrom8Cards,
          customerId: 'cust_archive_test',
        });

        assert.ok(
          capturedPromptText.includes('Pass 1 Detected Reagent Label Presentation Events (3):'),
          'Prompt must only list the 3 Pass 1 REAGENT_LABEL_PRESENTATION_EVENTs, not all 8 Pass 1 events'
        );
        assert.strictEqual(
          pass2Events.length,
          3,
          `Expected exactly 3 reagent label presentation events in Pass 2, got ${pass2Events.length}`
        );
        assert.deepStrictEqual(
          pass2Events.map((e) => e.eventId),
          ['evt_002', 'evt_003', 'evt_006'],
          'Must preserve the exact 3 Pass 1 reagent label presentation event IDs'
        );
        assert.ok(
          pass2Events.every((e) => e.eventClass === 'REAGENT_LABEL_PRESENTATION_EVENT'),
          'All 3 Pass 2 events must be REAGENT_LABEL_PRESENTATION_EVENT'
        );
      } finally {
        resetGenAIClient();
      }
    });

    it('should purge any spurious vial or box label presentation events returned by Gemini in Pass 2 archive workflow', async () => {
      const {
        runPass2EventDetection,
        setGenAIClient,
        resetGenAIClient,
      } = require('../dist/services/gemini.service');

      setGenAIClient({
        models: {
          generateContent: async () => {
            return {
              text: JSON.stringify([
                // Valid refined reagent event (matched to Pass 1 event)
                {
                  eventId: 'evt_reagent_1',
                  actionId: 'act_archive_1',
                  eventClass: 'REAGENT_LABEL_PRESENTATION_EVENT',
                  reagentName: 'DMEM High Glucose',
                  reagentAcronym: 'DMEM',
                  manufacturer: 'Gibco',
                  catalogNumber: '11965-092',
                  lotNumber: 'LOT-2024-001',
                  startTime: 12.0,
                  endTime: 16.0,
                  bestShotTimes: [14.0],
                  description: 'DMEM bottle held close to camera, clear label',
                },
                // Spurious vial event from model hallucination or legacy prompt
                {
                  eventId: 'evt_spurious_vial_1',
                  actionId: 'act_archive_1',
                  eventClass: 'VIAL_LABEL_PRESENTATION',
                  description: 'Spurious vial label presentation event',
                  startTime: 18.0,
                  endTime: 21.0,
                  bestShotTimes: [19.5],
                },
                // Unmatched spurious box event
                {
                  eventId: 'evt_spurious_box_unmatched',
                  eventClass: 'BOX_LABEL_PRESENTATION',
                  description: 'Spurious box event',
                  startTime: 25.0,
                  endTime: 28.0,
                  bestShotTimes: [26.0],
                },
              ]),
            };
          },
        },
      });

      try {
        const pass2Events = await runPass2EventDetection({
          videoId: 'vid_archive_pass2_test',
          videoGcsUri: 'gs://test-bucket/normalized/norm_archive_pass2.mp4',
          classification: {
            workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
            confidence: 1.0,
            notes: 'Archive workflow test',
          },
          actions: [
            {
              actionId: 'act_archive_1',
              actionClass: 'REAGENT_PREPARATION_ACTION',
              startTime: '00:10',
              endTime: '00:30',
              eventList: ['evt_reagent_1'],
            },
          ],
          customerId: 'cust_archive_test',
        });

        // Assert that the spurious vial and box events were purged
        assert.strictEqual(
          pass2Events.length,
          1,
          `Expected only 1 event in Pass 2 output, but got ${pass2Events.length}`
        );
        assert.strictEqual(pass2Events[0].eventId, 'evt_reagent_1');
        assert.strictEqual(pass2Events[0].eventClass, 'REAGENT_LABEL_PRESENTATION_EVENT');
        assert.strictEqual(pass2Events[0].reagentAcronym, 'DMEM');

        // Check that neither VIAL_ nor BOX_ events exist anywhere in the result
        const vialEvents = pass2Events.filter((e) =>
          e.eventClass === 'VIAL_LABEL_PRESENTATION' ||
          e.eventClass === 'BOX_LABEL_PRESENTATION'
        );
        assert.strictEqual(vialEvents.length, 0, 'No vial or box events should be present in Pass 2 archive result');
      } finally {
        resetGenAIClient();
      }
    });
  });
});
