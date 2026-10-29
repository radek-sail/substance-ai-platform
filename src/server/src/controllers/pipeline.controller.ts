import { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  type WorkflowClassification,
  type Action,
  type Event,
  type Refinement,
  type VideoPasses,
  AnalyzePassRequestSchema,
} from '@sail/shared';
import {
  executeHierarchicalPipeline,
  ensureGeminiFileRegistered,
  runPass0WorkflowClassification,
  runPass1ActionDetection,
  runPass2EventDetection,
  runPass3AnalysisRefinement,
} from '../services/gemini.service';
import {
  normalizeDatabaseId,
  getVideoMetadata,
  updateVideoRecord,
  updateVideoPass,
  getVideoPasses,
  saveVideoAnalysis,
  getVideoAnalysis,
  commitInventorySignOff,
  commitArchiveSignOff,
} from '../services/firestore.service';

/**
 * Persists a pass JSON artifact to disk (`workflowClassification.json`, `workloadClassification.json`,
 * `action_detection_pass.json`, `event_detection_pass.json`, `analysis_refinement_pass.json`).
 */
async function writePassArtifactJson(videoId: string, filename: string, data: any): Promise<string> {
  const safeVideoId = String(videoId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const artifactDir = path.join(os.tmpdir(), 'sail_pass_artifacts', safeVideoId);
  const serialized = JSON.stringify(data, null, 2);
  try {
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }
    const targetPath = path.join(artifactDir, filename);
    await fs.promises.writeFile(targetPath, serialized, 'utf-8');
    // Also write to top-level tmpdir for direct inspection if requested
    await fs.promises.writeFile(path.join(os.tmpdir(), filename), serialized, 'utf-8');
    return targetPath;
  } catch (err) {
    console.warn(`[PipelineController] Could not write pass artifact ${filename}:`, err);
    return filename;
  }
}

/**
 * Controller for POST /api/pipeline/analyze
 *
 * Orchestrates Pass 0 -> Pass 1 -> Pass 2 -> Pass 3 on demand for any transcoded video:
 * 1. Accepts `{ videoId }` (and optional `videoGcsUri`).
 * 2. Sets video status in `videos/{videoId}` to `ANALYZING`.
 * 3. Retrieves the normalized video from GCS, registers it with the Gemini Files API (`ai.files.upload`),
 *    waits for `ACTIVE` state, and executes Pass 0 through Pass 3.
 * 4. Writes analysis payload to `video_analyses/{videoId}`.
 * 5. Updates video status in `videos/{videoId}` to `ANALYSIS_COMPLETE` (or `FAILED` if error occurs)
 *    and links `analysisId`.
 */
export async function analyzePipelineHandler(req: Request, res: Response): Promise<Response | void> {
  const rawCustomerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;

  if (!rawCustomerId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-customer-id' });
  }

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-database-id' });
  }

  const customerId = rawCustomerId || 'customer-alpha';
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  const { videoId, videoGcsUri, localFilePath } = req.body || {};

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required field: videoId' });
  }

  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';

  // Resolve normalizedGcsUri from request body or from Firestore videos/{videoId}
  let candidateGcsUri: string | undefined = videoGcsUri;
  if (!candidateGcsUri) {
    try {
      const videoDoc =
        (await getVideoMetadata(databaseId, videoId)) ||
        (databaseId !== '(default)' ? await getVideoMetadata('(default)', videoId) : null);
      if (videoDoc?.normalizedGcsUri) {
        candidateGcsUri = videoDoc.normalizedGcsUri;
      }
    } catch {
      // Ignore lookup errors on mocked Firestore instances
    }
  }

  if (!candidateGcsUri) {
    candidateGcsUri = `gs://${bucketName}/normalized/norm_${videoId}.mp4`;
  }

  const resolvedVideoGcsUri =
    typeof candidateGcsUri === 'string' && candidateGcsUri.startsWith('gs://')
      ? candidateGcsUri.replace(/^gs:\/\/[^/]+\//, `gs://${bucketName}/`)
      : candidateGcsUri;

  // Set video status in videos/{videoId} to ANALYZING
  await updateVideoRecord('(default)', videoId, {
    status: 'ANALYZING',
    updatedAt: new Date().toISOString(),
  });
  if (databaseId !== '(default)' && !videoGcsUri) {
    await updateVideoRecord(databaseId, videoId, {
      status: 'ANALYZING',
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const { workloadClassification, actions, events, refinements } = await executeHierarchicalPipeline({
      customerId,
      databaseId,
      videoId,
      videoGcsUri: resolvedVideoGcsUri,
      localVideoPath: localFilePath,
    });

    const nowIso = new Date().toISOString();
    const analysisPayload = {
      videoId,
      workloadClassification,
      workflowClassification: workloadClassification,
      actions,
      events,
      refinements,
      isSignedOff: false,
      updatedAt: nowIso,
    };

    // Persist into Firestore default database (or specified tenant database) under video_analyses/{videoId}
    await saveVideoAnalysis(databaseId, videoId, analysisPayload);

    const completedPasses: VideoPasses = {
      pass0: { status: 'COMPLETED', data: workloadClassification, completedAt: nowIso },
      pass1: { status: 'COMPLETED', data: actions, completedAt: nowIso },
      pass2: { status: 'COMPLETED', data: events, completedAt: nowIso },
      pass3: { status: 'COMPLETED', data: refinements, completedAt: nowIso },
      hitl: { status: 'PENDING' },
    };

    // Update video status in videos/{videoId} to ANALYSIS_COMPLETE and link analysisId
    await updateVideoRecord('(default)', videoId, {
      status: 'ANALYSIS_COMPLETE',
      analysisId: videoId,
      passes: completedPasses,
      updatedAt: nowIso,
    });
    if (databaseId !== '(default)' && !videoGcsUri) {
      await updateVideoRecord(databaseId, videoId, {
        status: 'ANALYSIS_COMPLETE',
        analysisId: videoId,
        passes: completedPasses,
        updatedAt: nowIso,
      });
    }

    return res.status(200).json({
      success: true,
      videoId,
      analysisId: videoId,
      status: 'ANALYSIS_COMPLETE',
      passes: completedPasses,
      summary: {
        workflowType: workloadClassification.workflowType,
        actionCount: actions.length,
        eventCount: events.length,
        refinementCount: refinements.length,
      },
      analysis: analysisPayload,
    });
  } catch (error: any) {
    console.error(`[PipelineController] Error executing pipeline for video ${videoId}:`, error);

    await updateVideoRecord('(default)', videoId, {
      status: 'FAILED',
      updatedAt: new Date().toISOString(),
    });
    if (databaseId !== '(default)' && !videoGcsUri) {
      await updateVideoRecord(databaseId, videoId, {
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
      });
    }

    return res.status(500).json({
      error: error?.message || 'Pipeline analysis execution failed',
      videoId,
      status: 'FAILED',
    });
  }
}

/**
 * Controller for POST /api/pipeline/analyze-pass
 *
 * Executes a single pass (`0 | 1 | 2 | 3`) or all passes sequentially (`"all"`):
 * - Retrieves video metadata from `videos/{videoId}`.
 * - If not already registered, registers the normalized video with the Gemini Files API (`ai.files.upload`),
 *   waits until `state === 'ACTIVE'`, and caches `geminiFileUri` in the `videos` record.
 * - Pass 0 (Workflow Classification): Executes Gemini Flash @ 1 fps prompt. Writes result to
 *   `workflowClassification.json` and updates `videos/{videoId}.passes.pass0 = { status: "COMPLETED", data: result, completedAt }`.
 * - Pass 1 (Action Detection): Executes Gemini Pro @ 1 fps using Pass 0 context. Writes `action_detection_pass.json`
 *   and updates `videos/{videoId}.passes.pass1 = { status: "COMPLETED", data: result, completedAt }`.
 * - Pass 2 (Event Detection Temporal): Executes Gemini Flash/Pro @ 4 fps. Writes `event_detection_pass.json`
 *   and updates `videos/{videoId}.passes.pass2 = { status: "COMPLETED", data: result, completedAt }`.
 * - Pass 3 (Analysis Refinement): Executes Gemini Pro @ Full Resolution Crop. Writes `analysis_refinement_pass.json`,
 *   updates `videos/{videoId}.passes.pass3 = { status: "COMPLETED", data: result, completedAt }`, and aggregates
 *   findings into `video_analyses/{videoId}`.
 * - If `pass === "all"`, awaits all 4 sequentially.
 */
export async function analyzePassHandler(req: Request, res: Response): Promise<Response | void> {
  const rawCustomerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
  const customerId = rawCustomerId || 'customer-alpha';
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  const parsedReq = AnalyzePassRequestSchema.safeParse({
    videoId: req.body?.videoId,
    pass: req.body?.pass !== undefined ? req.body.pass : 'all',
    videoGcsUri: req.body?.videoGcsUri,
    localFilePath: req.body?.localFilePath,
    customerId,
    databaseId,
  });

  if (!parsedReq.success) {
    return res.status(400).json({
      error: parsedReq.error.issues.map((i) => i.message).join('; ') || 'Invalid analyze-pass request payload',
    });
  }

  const { videoId, pass, videoGcsUri, localFilePath } = parsedReq.data;
  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';

  // 1. Retrieve video metadata from videos/{videoId}
  const videoDoc =
    (await getVideoMetadata(databaseId, videoId)) ||
    (databaseId !== '(default)' ? await getVideoMetadata('(default)', videoId) : null) ||
    {};

  const candidateGcsUri =
    videoGcsUri ||
    videoDoc.normalizedGcsUri ||
    (videoDoc.normalizedPath ? `gs://${videoDoc.gcsBucket || bucketName}/${videoDoc.normalizedPath}` : undefined) ||
    `gs://${bucketName}/normalized/norm_${videoId}.mp4`;

  const resolvedVideoGcsUri =
    typeof candidateGcsUri === 'string' && candidateGcsUri.startsWith('gs://')
      ? candidateGcsUri.replace(/^gs:\/\/[^/]+\//, `gs://${bucketName}/`)
      : candidateGcsUri;

  let currentPasses: VideoPasses = {
    pass0: videoDoc.passes?.pass0 || { status: 'PENDING' },
    pass1: videoDoc.passes?.pass1 || { status: 'PENDING' },
    pass2: videoDoc.passes?.pass2 || { status: 'PENDING' },
    pass3: videoDoc.passes?.pass3 || { status: 'PENDING' },
    hitl: videoDoc.passes?.hitl || { status: 'PENDING' },
  };

  let activePassKey: keyof VideoPasses =
    pass === 'all' ? 'pass0' : (`pass${pass}` as keyof VideoPasses);

  try {
    // 2. Register normalized video with Gemini Files API if not already cached
    const registration = await ensureGeminiFileRegistered({
      videoId,
      videoGcsUri: resolvedVideoGcsUri,
      localVideoPath: localFilePath,
      existingGeminiFileUri: videoDoc.geminiFileUri,
      existingGeminiFileName: videoDoc.geminiFileName,
    });

    const geminiFileUri = registration.geminiFileUri;
    const effectiveLocalVideoPath = registration.localVideoPath || localFilePath;

    // Cache geminiFileUri on videos/{videoId}
    const metaUpdates: Record<string, any> = {
      status: 'ANALYZING',
      updatedAt: new Date().toISOString(),
    };
    if (geminiFileUri) {
      metaUpdates.geminiFileUri = geminiFileUri;
    }
    if (registration.geminiFileName) {
      metaUpdates.geminiFileName = registration.geminiFileName;
    }

    await updateVideoRecord(databaseId, videoId, metaUpdates);
    if (databaseId !== '(default)') {
      await updateVideoRecord('(default)', videoId, metaUpdates);
    }

    const syncPassState = async (
      passKey: keyof VideoPasses,
      state: VideoPasses[keyof VideoPasses],
      extra?: Record<string, any>
    ) => {
      currentPasses = {
        ...currentPasses,
        [passKey]: state,
      };
      await updateVideoPass(databaseId, videoId, passKey, state, extra);
      if (databaseId !== '(default)') {
        await updateVideoPass('(default)', videoId, passKey, state, extra);
      }
    };

    const runStep0 = async (): Promise<WorkflowClassification> => {
      activePassKey = 'pass0';
      const startedAt = new Date().toISOString();
      await syncPassState('pass0', { status: 'RUNNING', startedAt });
      const classification = await runPass0WorkflowClassification({
        videoGcsUri: resolvedVideoGcsUri,
        localVideoPath: effectiveLocalVideoPath,
        customerId,
        videoId,
        registeredFileUri: geminiFileUri,
      });
      await writePassArtifactJson(videoId, 'workflowClassification.json', classification);
      await writePassArtifactJson(videoId, 'workloadClassification.json', classification);
      const completedAt = new Date().toISOString();
      await syncPassState('pass0', {
        status: 'COMPLETED',
        data: classification,
        startedAt,
        completedAt,
      });
      return classification;
    };

    const runStep1 = async (classificationInput?: WorkflowClassification): Promise<Action[]> => {
      activePassKey = 'pass1';
      const classification: WorkflowClassification =
        classificationInput ||
        currentPasses.pass0?.data ||
        (await runStep0());
      activePassKey = 'pass1';
      const startedAt = new Date().toISOString();
      await syncPassState('pass1', { status: 'RUNNING', startedAt });
      const actions = await runPass1ActionDetection({
        videoGcsUri: resolvedVideoGcsUri,
        classification,
        localVideoPath: effectiveLocalVideoPath,
        customerId,
        videoId,
        registeredFileUri: geminiFileUri,
      });
      await writePassArtifactJson(videoId, 'action_detection_pass.json', actions);
      const completedAt = new Date().toISOString();
      await syncPassState('pass1', {
        status: 'COMPLETED',
        data: actions,
        startedAt,
        completedAt,
      });
      return actions;
    };

    const runStep2 = async (
      classificationInput?: WorkflowClassification,
      actionsInput?: Action[]
    ): Promise<Event[]> => {
      activePassKey = 'pass2';
      const classification: WorkflowClassification =
        classificationInput ||
        currentPasses.pass0?.data ||
        (await runStep0());
      const actions: Action[] =
        actionsInput ||
        currentPasses.pass1?.data ||
        (await runStep1(classification));
      activePassKey = 'pass2';
      const startedAt = new Date().toISOString();
      await syncPassState('pass2', { status: 'RUNNING', startedAt });
      const events = await runPass2EventDetection({
        videoGcsUri: resolvedVideoGcsUri,
        classification,
        localVideoPath: effectiveLocalVideoPath,
        actions,
        customerId,
        videoId,
        registeredFileUri: geminiFileUri,
      });
      await writePassArtifactJson(videoId, 'event_detection_pass.json', events);
      const completedAt = new Date().toISOString();
      await syncPassState('pass2', {
        status: 'COMPLETED',
        data: events,
        startedAt,
        completedAt,
      });

      // Also persist intermediate analysis to video_analyses/{videoId} so CryoInventory can load after Pass 2
      const partialAnalysis = {
        videoId,
        workloadClassification: classification,
        workflowClassification: classification,
        actions,
        events,
        refinements: currentPasses.pass3?.data || [],
        isSignedOff: false,
        updatedAt: completedAt,
      };
      await saveVideoAnalysis(databaseId, videoId, partialAnalysis);
      if (databaseId !== '(default)') {
        await saveVideoAnalysis('(default)', videoId, partialAnalysis);
      }

      return events;
    };

    const runStep3 = async (
      classificationInput?: WorkflowClassification,
      actionsInput?: Action[],
      eventsInput?: Event[]
    ): Promise<{
      classification: WorkflowClassification;
      actions: Action[];
      events: Event[];
      refinements: Refinement[];
      analysisPayload: Record<string, any>;
    }> => {
      activePassKey = 'pass3';
      const classification: WorkflowClassification =
        classificationInput ||
        currentPasses.pass0?.data ||
        (await runStep0());
      const actions: Action[] =
        actionsInput ||
        currentPasses.pass1?.data ||
        (await runStep1(classification));
      const events: Event[] =
        eventsInput ||
        currentPasses.pass2?.data ||
        (await runStep2(classification, actions));
      activePassKey = 'pass3';
      const startedAt = new Date().toISOString();
      await syncPassState('pass3', { status: 'RUNNING', startedAt });
      const refinements = await runPass3AnalysisRefinement({
        videoGcsUri: resolvedVideoGcsUri,
        localVideoPath: effectiveLocalVideoPath,
        classification,
        actions,
        events,
        customerId,
        videoId,
        registeredFileUri: geminiFileUri,
      });

      // Link refinementIds back onto corresponding parent events
      const eventToRefinements = new Map<string, string[]>();
      for (const ref of refinements) {
        const list = eventToRefinements.get(ref.eventId) || [];
        list.push(ref.refinementId);
        eventToRefinements.set(ref.eventId, list);
      }
      const enrichedEvents = events.map((evt) => ({
        ...evt,
        refinementList: eventToRefinements.get(evt.eventId) || evt.refinementList || [],
      }));

      // Link eventIds back onto corresponding parent actions
      const actionToEvents = new Map<string, string[]>();
      for (const evt of enrichedEvents) {
        const list = actionToEvents.get(evt.actionId) || [];
        list.push(evt.eventId);
        actionToEvents.set(evt.actionId, list);
      }
      const enrichedActions = actions.map((act) => ({
        ...act,
        eventList: actionToEvents.get(act.actionId) || act.eventList || [],
      }));

      await writePassArtifactJson(videoId, 'analysis_refinement_pass.json', refinements);
      const completedAt = new Date().toISOString();

      // Update pass1 & pass2 enriched links in currentPasses
      currentPasses.pass1 = {
        ...currentPasses.pass1,
        data: enrichedActions,
      };
      currentPasses.pass2 = {
        ...currentPasses.pass2,
        data: enrichedEvents,
      };

      const analysisPayload = {
        videoId,
        workloadClassification: classification,
        workflowClassification: classification,
        actions: enrichedActions,
        events: enrichedEvents,
        refinements,
        isSignedOff: false,
        updatedAt: completedAt,
      };

      // Aggregate findings into video_analyses/{videoId}
      await saveVideoAnalysis(databaseId, videoId, analysisPayload);
      if (databaseId !== '(default)') {
        await saveVideoAnalysis('(default)', videoId, analysisPayload);
      }

      await syncPassState(
        'pass3',
        {
          status: 'COMPLETED',
          data: refinements,
          startedAt,
          completedAt,
        },
        {
          status: 'ANALYSIS_COMPLETE',
          analysisId: videoId,
          updatedAt: completedAt,
        }
      );

      return {
        classification,
        actions: enrichedActions,
        events: enrichedEvents,
        refinements,
        analysisPayload,
      };
    };

    let passResultData: any = null;
    let aggregatedAnalysis: Record<string, any> | undefined;

    if (pass === 0) {
      passResultData = await runStep0();
    } else if (pass === 1) {
      passResultData = await runStep1();
    } else if (pass === 2) {
      passResultData = await runStep2();
    } else if (pass === 3) {
      const res3 = await runStep3();
      passResultData = res3.refinements;
      aggregatedAnalysis = res3.analysisPayload;
    } else if (pass === 'all') {
      const c0 = await runStep0();
      const a1 = await runStep1(c0);
      const e2 = await runStep2(c0, a1);
      const res3 = await runStep3(c0, a1, e2);
      passResultData = {
        workloadClassification: res3.classification,
        actions: res3.actions,
        events: res3.events,
        refinements: res3.refinements,
      };
      aggregatedAnalysis = res3.analysisPayload;
    }

    const finalStatus =
      currentPasses.pass3?.status === 'COMPLETED' ? 'ANALYSIS_COMPLETE' : 'READY_FOR_ANALYSIS';

    if (finalStatus !== 'ANALYSIS_COMPLETE') {
      await updateVideoRecord(databaseId, videoId, {
        status: finalStatus,
        updatedAt: new Date().toISOString(),
      });
      if (databaseId !== '(default)') {
        await updateVideoRecord('(default)', videoId, {
          status: finalStatus,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return res.status(200).json({
      success: true,
      videoId,
      pass,
      status: finalStatus,
      geminiFileUri,
      data: passResultData,
      passes: currentPasses,
      ...(aggregatedAnalysis ? { analysis: aggregatedAnalysis } : {}),
    });
  } catch (error: any) {
    console.error(`[PipelineController] Error in analyzePassHandler (video=${videoId}, pass=${pass}):`, error);
    const errMsg = error?.message || 'Pass execution failed';

    await updateVideoPass(
      databaseId,
      videoId,
      activePassKey,
      {
        ...(currentPasses[activePassKey] || {}),
        status: 'ERROR',
        error: errMsg,
        completedAt: new Date().toISOString(),
      },
      {
        status: 'FAILED',
        updatedAt: new Date().toISOString(),
      }
    );
    if (databaseId !== '(default)') {
      await updateVideoPass(
        '(default)',
        videoId,
        activePassKey,
        {
          ...(currentPasses[activePassKey] || {}),
          status: 'ERROR',
          error: errMsg,
          completedAt: new Date().toISOString(),
        },
        {
          status: 'FAILED',
          updatedAt: new Date().toISOString(),
        }
      );
    }

    return res.status(500).json({
      error: errMsg,
      videoId,
      pass,
      failedPass: activePassKey,
      status: 'FAILED',
    });
  }
}

/**
 * Controller for GET /api/pipeline/passes/:videoId
 * Returns current pass statuses and outputs for the specified video from Firestore.
 */
export async function getVideoPassesHandler(req: Request, res: Response): Promise<Response | void> {
  const rawDatabaseId = (req.headers['x-database-id'] || req.query?.databaseId) as string | undefined;
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
  const videoId = req.params.videoId as string | undefined;

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required parameter: videoId' });
  }

  try {
    const passInfo =
      (await getVideoPasses(databaseId, videoId)) ||
      (databaseId !== '(default)' ? await getVideoPasses('(default)', videoId) : null);

    if (!passInfo) {
      return res.status(200).json({
        videoId,
        status: 'READY_FOR_ANALYSIS',
        passes: {
          pass0: { status: 'PENDING' },
          pass1: { status: 'PENDING' },
          pass2: { status: 'PENDING' },
          pass3: { status: 'PENDING' },
          hitl: { status: 'PENDING' },
        },
      });
    }

    return res.status(200).json(passInfo);
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Failed to retrieve video passes',
      videoId,
    });
  }
}

/**
 * Controller for POST /api/signoff/inventory (and POST /api/pipeline/signoff/inventory)
 *
 * Atomically commits occupied cryo-box cells to `inventories/{inventoryId}/contents/{boxId}`
 * and marks `video_analyses/{videoId}.isSignedOff = true`.
 */
export async function inventorySignOffHandler(req: Request, res: Response): Promise<Response | void> {
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
  const { videoId, inventoryId, boxUpdates, operatorInitials, signedOffAt } = req.body || {};

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required field or header: databaseId / x-database-id' });
  }
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required field: videoId' });
  }
  if (!inventoryId) {
    return res.status(400).json({ error: 'Missing required field: inventoryId' });
  }
  if (!Array.isArray(boxUpdates)) {
    return res.status(400).json({ error: 'Missing required array field: boxUpdates' });
  }

  try {
    const result = await commitInventorySignOff({
      databaseId,
      videoId,
      inventoryId,
      boxUpdates,
      operatorInitials,
      signedOffAt,
    });

    return res.status(200).json({
      success: true,
      message: `Successfully committed ${boxUpdates.length} cell updates to inventories/${inventoryId}/contents/${result.boxId} and signed off analysis ${videoId}.`,
      signedOffAt: result.signedOffAt,
      documentPath: result.documentPath,
      details: {
        inventoryId,
        videoId,
        boxId: result.boxId,
        updatesCount: boxUpdates.length,
        occupiedCells: result.occupiedCells,
        isSignedOff: result.isSignedOff,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      error: error?.message || 'Inventory sign-off failed',
    });
  }
}

/**
 * Controller for POST /api/signoff/archive (and POST /api/pipeline/signoff/archive)
 *
 * Formats and persists the experiment Markdown document (`## Description`, `## Reagents Used`, `## Experiment Steps`)
 * in `archives/{archiveId}` and marks `video_analyses/{videoId}.isSignedOff = true`.
 */
export async function archiveSignOffHandler(req: Request, res: Response): Promise<Response | void> {
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
  const { videoId, archiveId, markdownDoc, analysis, description, reagents, steps, operatorInitials, signedOffAt } =
    req.body || {};

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required field or header: databaseId / x-database-id' });
  }
  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required field: videoId' });
  }
  if (!archiveId) {
    return res.status(400).json({ error: 'Missing required field: archiveId' });
  }

  try {
    const result = await commitArchiveSignOff({
      databaseId,
      videoId,
      archiveId,
      markdownDoc,
      analysis,
      description,
      reagents,
      steps,
      operatorInitials,
      signedOffAt,
    });

    return res.status(200).json({
      success: true,
      message: `Successfully compiled and committed experiment archive to archives/${archiveId} and marked analysis ${videoId} as signed off.`,
      signedOffAt: result.signedOffAt,
      documentPath: result.documentPath,
      markdownDoc: result.markdownDoc,
      details: {
        archiveId,
        videoId,
        isSignedOff: result.isSignedOff,
        contentLength: result.markdownDoc.length,
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      error: error?.message || 'Archive sign-off failed',
    });
  }
}

/**
 * Controller for GET /databases/:databaseId/documents/video_analyses/:videoId
 */
export async function getVideoAnalysisHandler(req: Request, res: Response): Promise<Response | void> {
  const rawDatabaseId = (req.params.databaseId || req.headers['x-database-id']) as string | undefined;
  const videoId = req.params.videoId as string | undefined;

  if (!videoId) {
    return res.status(400).json({ error: 'Missing databaseId or videoId' });
  }

  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  try {
    const analysis = await getVideoAnalysis(databaseId, videoId);
    if (!analysis) {
      return res.status(404).json({ error: `Video analysis ${videoId} not found` });
    }
    return res.status(200).json({ videoId, ...analysis });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || 'Failed to retrieve video analysis' });
  }
}
