import { Request, Response } from 'express';
import { executeHierarchicalPipeline } from '../services/gemini.service';
import { saveVideoAnalysis } from '../services/firestore.service';

/**
 * Controller for POST /api/pipeline/analyze
 *
 * Orchestrates Pass 0 -> Pass 1 -> Pass 2 -> Pass 3:
 * 1. Validates required headers (`x-customer-id`, `x-database-id`) and body payload (`videoId`, `videoGcsUri`).
 * 2. Executes the 4-stage hierarchical pipeline.
 * 3. Persists structured analysis into Firestore under `/databases/{databaseId}/documents/video_analyses/{videoId}`.
 * 4. Returns summary and analysis data.
 */
export async function analyzePipelineHandler(req: Request, res: Response): Promise<Response | void> {
  const customerId = (req.headers['x-customer-id'] || req.body?.customerId) as string | undefined;
  const databaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;

  if (!customerId) {
    return res.status(400).json({ error: 'Missing required header: x-customer-id' });
  }

  if (!databaseId) {
    return res.status(400).json({ error: 'Missing required header: x-database-id' });
  }

  const { videoId, videoGcsUri, localFilePath } = req.body || {};

  if (!videoId) {
    return res.status(400).json({ error: 'Missing required field: videoId' });
  }

  if (!videoGcsUri) {
    return res.status(400).json({ error: 'Missing required field: videoGcsUri' });
  }

  try {
    const { workloadClassification, actions, events, refinements } = await executeHierarchicalPipeline({
      customerId,
      databaseId,
      videoId,
      videoGcsUri,
      localVideoPath: localFilePath,
    });

    const nowIso = new Date().toISOString();
    const analysisPayload = {
      workloadClassification,
      workflowClassification: workloadClassification,
      actions,
      events,
      refinements,
      isSignedOff: false,
      updatedAt: nowIso,
    };

    // Persist into Firestore /databases/{databaseId}/documents/video_analyses/{videoId}
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
