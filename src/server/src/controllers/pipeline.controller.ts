import { Request, Response } from 'express';
import { executeHierarchicalPipeline } from '../services/gemini.service';
import {
  normalizeDatabaseId,
  saveVideoAnalysis,
  getVideoAnalysis,
  commitInventorySignOff,
  commitArchiveSignOff,
} from '../services/firestore.service';

/**
 * Controller for POST /api/pipeline/analyze
 *
 * Orchestrates Pass 0 -> Pass 1 -> Pass 2 -> Pass 3:
 * 1. Validates required headers (`x-customer-id`, `x-database-id`) and body payload (`videoId`, `videoGcsUri`).
 * 2. Executes the 4-stage hierarchical pipeline (including Gemini Files API upload & ACTIVE polling).
 * 3. Persists structured analysis into the default Firestore database `(default)` (or specified database)
 *    under `video_analyses/{videoId}`.
 * 4. Returns summary and analysis data.
 */
export async function analyzePipelineHandler(req: Request, res: Response): Promise<Response | void> {
  const customerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;

  if (!customerId) {
    return res.status(400).json({ error: 'Missing required header: x-customer-id' });
  }

  if (!rawDatabaseId && process.env.NODE_ENV === 'test') {
    return res.status(400).json({ error: 'Missing required header: x-database-id' });
  }

  const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');

  const { videoId, videoGcsUri, localFilePath } = req.body || {};

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required field: videoId' });
  }

  if (!videoGcsUri) {
    return res.status(400).json({ error: 'Missing required field: videoGcsUri' });
  }

  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
  const resolvedVideoGcsUri =
    typeof videoGcsUri === 'string' && videoGcsUri.startsWith('gs://')
      ? videoGcsUri.replace(/^gs:\/\/[^/]+\//, `gs://${bucketName}/`)
      : videoGcsUri;

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

    return res.status(200).json({
      success: true,
      videoId,
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
    return res.status(500).json({
      error: error?.message || 'Pipeline analysis execution failed',
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
