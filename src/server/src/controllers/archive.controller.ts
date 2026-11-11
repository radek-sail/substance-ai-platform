import { Request, Response } from 'express';
import crypto from 'crypto';
import {
  type ArchiveRecord,
  CreateArchiveInputSchema,
} from '@sail/shared';
import * as firestoreService from '../services/firestore.service';
import { db, getTenantFirestore, normalizeDatabaseId } from '../services/firestore.service';

const deletedArchiveDatabases = new Set<string>();

/**
 * Builds the default demo experiment archive.
 */
export function createDefaultDemoArchive(organizationId: string = 'default-org'): ArchiveRecord {
  const nowIso = new Date().toISOString();
  const defaultReagents = [
    {
      id: 'reagent_1',
      reagentName: "Dulbecco's Modified Eagle Medium",
      reagentAcronym: 'DMEM',
      manufacturer: 'Gibco',
      catalogNumber: '11965-092',
      lotNumber: '2849102',
      rawLabelText: "Gibco Dulbecco's Modified Eagle Medium (DMEM) 1X | REF 11965-092 | LOT 2849102 | 500 mL",
    },
    {
      id: 'reagent_2',
      reagentName: 'Fetal Bovine Serum',
      reagentAcronym: 'FBS',
      manufacturer: 'Sigma-Aldrich',
      catalogNumber: 'F2442',
      lotNumber: '22C419',
      rawLabelText: 'Sigma-Aldrich Fetal Bovine Serum (FBS) Heat Inactivated | Cat. # F2442 | Lot # 22C419',
    },
    {
      id: 'reagent_3',
      reagentName: 'Phosphate Buffered Saline',
      reagentAcronym: 'PBS',
      manufacturer: 'N/A',
      catalogNumber: '10010-023',
      lotNumber: 'N/A',
      rawLabelText: 'Phosphate Buffered Saline (PBS) pH 7.4 | REF 10010-023',
    },
  ];
  const defaultLabelTranscriptions = [
    "Gibco Dulbecco's Modified Eagle Medium (DMEM) 1X | REF 11965-092 | LOT 2849102 | 500 mL",
    'Sigma-Aldrich Fetal Bovine Serum (FBS) Heat Inactivated | Cat. # F2442 | Lot # 22C419',
    'Phosphate Buffered Saline (PBS) pH 7.4 | REF 10010-023',
  ];
  const defaultWorkSteps = [
    {
      id: 'step_mix_001',
      stepNumber: 1,
      actionType: 'MIX_REAGENTS' as const,
      actionId: 'act_001',
      description:
        "Mixed 45 mL of Dulbecco's Modified Eagle Medium (DMEM) with 5 mL of Fetal Bovine Serum (FBS) to prepare complete culture medium.",
      startTime: '00:04',
      endTime: '00:26',
      mixReagentsData: {
        firstReagentName: "Dulbecco's Modified Eagle Medium (DMEM)",
        firstReagentAmount: '45 mL',
        secondReagentName: 'Fetal Bovine Serum (FBS)',
        secondReagentAmount: '5 mL',
      },
    },
    {
      id: 'step_seed_002',
      stepNumber: 2,
      actionType: 'SEED_REAGENTS' as const,
      actionId: 'act_002',
      description:
        'Seeded HEK293T cells at 10,000 cells/well into a 96-well plate using an 8-channel pipette (12/12 seeding events detected across all 12 columns).',
      startTime: '00:30',
      endTime: '01:18',
      seedReagentsData: {
        plateType: '96-well plate',
        pipetteType: '8-channel pipette',
        cellsSeeded: 'HEK293T',
        cellsPerWell: '10,000 cells/well',
        seedingEventsCount: 12,
        expectedSeedingEventsCount: 12,
        isSeedingCountCorrect: true,
      },
    },
  ];
  const demoId =
    organizationId === 'default-org'
      ? 'demo-archive-01'
      : `demo-archive-01_${organizationId}`;
  return {
    id: demoId,
    name: 'Cell Seeding & Media Prep Protocol',
    organizationId,
    creatorName: 'Dr. Sarah Chen',
    creationDate: '2026-10-15',
    reagents: defaultReagents,
    labelTranscriptions: defaultLabelTranscriptions,
    workSteps: defaultWorkSteps,
    markdownDoc: `# Cell Seeding & Media Prep Protocol\n\n- **Creator**: Dr. Sarah Chen\n- **Creation Date**: 2026-10-15\n\n## Description\nAutomated experiment archive generated from SAIL video analysis.\n\n## Reagents Used\n- **Dulbecco's Modified Eagle Medium** (DMEM) | Manufacturer: Gibco | Catalog/Ref #: 11965-092 | Lot #: 2849102\n- **Fetal Bovine Serum** (FBS) | Manufacturer: Sigma-Aldrich | Catalog/Ref #: F2442 | Lot #: 22C419\n- **Phosphate Buffered Saline** (PBS) | Manufacturer: N/A | Catalog/Ref #: 10010-023 | Lot #: N/A\n\n## Experiment Steps\n1. **Mix Reagents**: Mixed 45 mL of Dulbecco's Modified Eagle Medium (DMEM) with 5 mL of Fetal Bovine Serum (FBS).\n2. **Seed Reagents**: Seeded HEK293T (10,000 cells/well) into 96-well plate using 8-channel pipette — Seeding Events: Verified (12/12 events).\n`,
    videoIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * GET /api/archives
 * Fetches all experiment archive documents from Firestore `archives` collection scoped by `organizationId`.
 */
export const listArchivesHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const organizationId = req.user?.organizationId || 'default-org';
  try {
    const rawDatabaseId = (req.headers['x-database-id'] || req.query?.databaseId) as string | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const dbTarget = getTenantFirestore(databaseId);
    const archivesRef = dbTarget.collection('archives') as any;
    const scopedQuery =
      archivesRef && typeof archivesRef.where === 'function'
        ? archivesRef.where('organizationId', '==', organizationId)
        : archivesRef;

    let snapshot: any;
    try {
      snapshot = await scopedQuery.get();
      if (!snapshot || snapshot.empty) {
        snapshot = await scopedQuery.orderBy('createdAt', 'desc').get();
      }
    } catch {
      try {
        snapshot = await scopedQuery.orderBy('createdAt', 'desc').get();
      } catch {
        snapshot = null;
      }
    }

    if ((!snapshot || snapshot.empty) && db && db !== dbTarget) {
      try {
        const fallbackRef = db.collection('archives') as any;
        const fallbackQuery =
          fallbackRef && typeof fallbackRef.where === 'function'
            ? fallbackRef.where('organizationId', '==', organizationId)
            : fallbackRef;
        snapshot = await fallbackQuery.get();
      } catch {
        // ignore fallback error
      }
    }

    const docsById = new Map<string, any>();
    if (snapshot && !snapshot.empty && Array.isArray(snapshot.docs)) {
      for (const doc of snapshot.docs) {
        docsById.set(doc.id, doc);
      }
    }

    // Backfill and include legacy unscoped archives created for 'substance-ai' prior to organizationId scoping
    if (organizationId === 'substance-ai' && archivesRef && typeof archivesRef.get === 'function') {
      try {
        const allSnap = await archivesRef.get();
        if (allSnap && !allSnap.empty && Array.isArray(allSnap.docs)) {
          for (const doc of allSnap.docs) {
            const data = doc.data() || {};
            const docOrg = data.organizationId;
            if (!docOrg || docOrg === 'default-org' || docOrg === 'substance-ai') {
              if (!docOrg || docOrg === 'default-org') {
                try {
                  await archivesRef.doc(doc.id).set({ ...data, organizationId: 'substance-ai' }, { merge: true });
                } catch {
                  // Ignore backfill write error
                }
              }
              docsById.set(doc.id, {
                id: doc.id,
                data: () => ({ ...data, organizationId: 'substance-ai' }),
              });
            }
          }
        }
      } catch {
        // Ignore fallback scan error
      }
    }

    if (docsById.has('demo-archive-01') && docsById.has('demo-archive-01_substance-ai')) {
      docsById.delete('demo-archive-01_substance-ai');
    }

    if (docsById.size === 0) {
      if (deletedArchiveDatabases.has(databaseId) || deletedArchiveDatabases.has('(default)')) {
        return res.status(200).json({ archives: [] });
      }
      const demoArchive = createDefaultDemoArchive(organizationId);
      try {
        await archivesRef.doc(demoArchive.id).set(demoArchive);
      } catch (saveErr) {
        console.warn('[ArchiveController] Could not persist default demo archive:', saveErr);
      }
      return res.status(200).json({ archives: [demoArchive] });
    }

    const archives: ArchiveRecord[] = Array.from(docsById.values()).map((doc: any) => {
      const data = doc.data() || {};
      const isDefaultDemo = doc.id === 'demo-archive-01' || doc.id.startsWith('demo-archive-01_');
      const isErased = Boolean(data.contentErased);
      const demoFallback = isDefaultDemo && !isErased ? createDefaultDemoArchive(organizationId) : null;
      return {
        id: doc.id,
        name: data.name || doc.id,
        ...(data.organizationId ? { organizationId: data.organizationId } : { organizationId }),
        creatorName: data.creatorName ?? null,
        creationDate: data.creationDate ?? null,
        purpose: data.purpose ?? null,
        reagents: Array.isArray(data.reagents)
          ? data.reagents.length > 0 || isErased || !demoFallback
            ? data.reagents
            : demoFallback.reagents
          : demoFallback?.reagents || [],
        labelTranscriptions: Array.isArray(data.labelTranscriptions)
          ? data.labelTranscriptions.length > 0 || isErased || !demoFallback
            ? data.labelTranscriptions
            : demoFallback.labelTranscriptions
          : demoFallback?.labelTranscriptions || [],
        workSteps: Array.isArray(data.workSteps)
          ? data.workSteps.length > 0 || isErased || !demoFallback
            ? data.workSteps
            : demoFallback.workSteps
          : demoFallback?.workSteps || [],
        markdownDoc: typeof data.markdownDoc === 'string' ? data.markdownDoc : '',
        videoIds: Array.isArray(data.videoIds) ? data.videoIds : [],
        ...(isErased ? { contentErased: true } : {}),
        ...(data.isSignedOff ? { isSignedOff: true } : {}),
        createdAt: data.createdAt || data.signedOffAt || data.updatedAt || new Date().toISOString(),
        updatedAt: data.updatedAt || data.signedOffAt || data.createdAt || new Date().toISOString(),
      };
    });

    archives.sort((a, b) => {
      const timeA = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      const timeB = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      return timeB - timeA;
    });

    return res.status(200).json({ archives });
  } catch (error: any) {
    console.error('[ArchiveController] Error listing archives:', error);
    return res.status(200).json({ archives: [] });
  }
};

/**
 * POST /api/archives
 * Creates a new experiment archive (and optionally associates a video with it).
 */
export const createArchiveHandler = async (req: Request, res: Response): Promise<Response | void> => {
  const organizationId = req.user?.organizationId || 'default-org';
  try {
    const parseResult = CreateArchiveInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid archive creation parameters',
        details: parseResult.error.flatten(),
      });
    }

    const { name, creatorName, creationDate, purpose, reagents, labelTranscriptions, workSteps, markdownDoc, videoId } =
      parseResult.data;
    const trimmedName = name.trim();
    if (!trimmedName) {
      return res.status(400).json({ error: 'Archive name is required' });
    }

    const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId) as string | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const dbTarget = getTenantFirestore(databaseId);

    const archiveId = `arch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const normalizedCreator = creatorName?.trim() || null;
    const normalizedDate = creationDate?.trim() || null;
    const normalizedPurpose = purpose?.trim() || null;

    const defaultMarkdownHeader = [
      `# ${trimmedName}`,
      '',
      ...(normalizedCreator ? [`- **Creator**: ${normalizedCreator}`] : []),
      ...(normalizedDate ? [`- **Creation Date**: ${normalizedDate}`] : []),
      ...(normalizedPurpose ? [`- **Purpose**: ${normalizedPurpose}`] : []),
      '',
      '## Experiment Log',
      '',
    ].join('\n');

    const archiveRecord: ArchiveRecord = {
      id: archiveId,
      name: trimmedName,
      organizationId,
      creatorName: normalizedCreator,
      creationDate: normalizedDate,
      purpose: normalizedPurpose,
      reagents: Array.isArray(reagents) ? reagents : [],
      labelTranscriptions: Array.isArray(labelTranscriptions) ? labelTranscriptions : [],
      workSteps: Array.isArray(workSteps) ? workSteps : [],
      markdownDoc: typeof markdownDoc === 'string' && markdownDoc.trim().length > 0
        ? markdownDoc
        : defaultMarkdownHeader,
      videoIds: videoId ? [videoId] : [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await dbTarget.collection('archives').doc(archiveId).set(archiveRecord);
    if (databaseId !== '(default)' && db && db !== dbTarget) {
      try {
        await db.collection('archives').doc(archiveId).set(archiveRecord);
      } catch {
        // ignore fallback write error
      }
    }

    let updatedVideo: any = null;
    if (videoId) {
      const videoUpdatePayload = {
        archiveId,
        archiveName: trimmedName,
        archiveCreatorName: normalizedCreator,
        archiveCreationDate: normalizedDate,
        archivePurpose: normalizedPurpose,
        unmatchedArchiveName: null,
        archiveAssociationType: 'MANUAL' as const,
        associatedAt: nowIso,
        updatedAt: nowIso,
      };
      await firestoreService.updateVideoRecord(databaseId, videoId, videoUpdatePayload);
      if (databaseId !== '(default)') {
        await firestoreService.updateVideoRecord('(default)', videoId, videoUpdatePayload);
      }
      try {
        const existingVid =
          (await firestoreService.getVideoMetadata(databaseId, videoId)) ||
          (databaseId !== '(default)' ? await firestoreService.getVideoMetadata('(default)', videoId) : null);
        if (existingVid?.passes?.pass0) {
          const prevPass0Data = existingVid.passes.pass0.data || {};
          const updatedPass0State = {
            ...existingVid.passes.pass0,
            data: {
              ...prevPass0Data,
              archiveName: trimmedName,
              creatorName: normalizedCreator ?? prevPass0Data.creatorName ?? null,
              creationDate: normalizedDate ?? prevPass0Data.creationDate ?? null,
              purpose: normalizedPurpose ?? prevPass0Data.purpose ?? null,
            },
          };
          await firestoreService.updateVideoPass(databaseId, videoId, 'pass0', updatedPass0State);
          if (databaseId !== '(default)') {
            await firestoreService.updateVideoPass('(default)', videoId, 'pass0', updatedPass0State);
          }
        }
      } catch {
        // ignore pass0 sync error
      }
      try {
        const existingAnalysis =
          (await firestoreService.getVideoAnalysis(databaseId, videoId)) ||
          (databaseId !== '(default)' ? await firestoreService.getVideoAnalysis('(default)', videoId) : null);
        if (existingAnalysis) {
          const analysisUpdate = {
            ...existingAnalysis,
            archiveId,
            archiveName: trimmedName,
            creatorName: normalizedCreator,
            creationDate: normalizedDate,
            purpose: normalizedPurpose,
            ...(existingAnalysis.workflowClassification
              ? {
                  workflowClassification: {
                    ...existingAnalysis.workflowClassification,
                    archiveName: trimmedName,
                    creatorName: normalizedCreator,
                    creationDate: normalizedDate,
                    purpose: normalizedPurpose,
                  },
                }
              : {}),
            ...(existingAnalysis.workloadClassification
              ? {
                  workloadClassification: {
                    ...existingAnalysis.workloadClassification,
                    archiveName: trimmedName,
                    creatorName: normalizedCreator,
                    creationDate: normalizedDate,
                    purpose: normalizedPurpose,
                  },
                }
              : {}),
            updatedAt: nowIso,
          };
          await firestoreService.saveVideoAnalysis(databaseId, videoId, analysisUpdate);
          if (databaseId !== '(default)') {
            await firestoreService.saveVideoAnalysis('(default)', videoId, analysisUpdate);
          }
        }
      } catch {
        // ignore video_analyses sync error
      }
      updatedVideo =
        (await firestoreService.getVideoMetadata(databaseId, videoId)) ||
        (await firestoreService.getVideoMetadata('(default)', videoId));
    }

    return res.status(201).json({
      ...archiveRecord,
      archive: archiveRecord,
      video: updatedVideo,
    });
  } catch (error: any) {
    console.error('[ArchiveController] Error creating archive:', error);
    return res.status(500).json({
      error: 'Failed to create archive',
      message: error?.message,
    });
  }
};

/**
 * GET /api/archives/:id
 * Fetches a single experiment archive by ID.
 */
export const getArchiveHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Missing archive ID' });
    }

    const rawDatabaseId = (req.headers['x-database-id'] || req.query?.databaseId) as string | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const dbTarget = getTenantFirestore(databaseId);

    let docSnap = await dbTarget.collection('archives').doc(id).get();
    if ((!docSnap || !docSnap.exists) && db && db !== dbTarget) {
      docSnap = await db.collection('archives').doc(id).get();
    }

    if (!docSnap || !docSnap.exists) {
      return res.status(404).json({ error: `Archive '${id}' not found` });
    }

    const data = docSnap.data() || {};
    return res.status(200).json({
      id: docSnap.id,
      ...data,
    });
  } catch (error: any) {
    console.error('[ArchiveController] Error fetching archive:', error);
    return res.status(500).json({
      error: 'Failed to fetch archive',
      message: error?.message,
    });
  }
};

/**
 * POST /api/archives/:id/empty (and /api/archives/:id/erase)
 * Erases the notebook content (reagents, labelTranscriptions, workSteps, markdownDoc, videoIds)
 * of the specified experiment archive while keeping the archive record and its identification metadata.
 */
export const emptyArchiveHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Missing required parameter: id' });
    }

    const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId || req.query?.databaseId) as
      | string
      | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const dbTarget = getTenantFirestore(databaseId);

    let docSnap = await dbTarget.collection('archives').doc(id).get();
    if ((!docSnap || !docSnap.exists) && db && db !== dbTarget) {
      docSnap = await db.collection('archives').doc(id).get();
    }

    let existingData: Record<string, any> | undefined =
      docSnap && docSnap.exists ? docSnap.data() || {} : undefined;

    if (!existingData && id === 'demo-archive-01') {
      existingData = createDefaultDemoArchive();
    } else if (!existingData && req.body?.name) {
      existingData = {
        id,
        name: String(req.body.name).trim(),
        creatorName: req.body.creatorName ?? null,
        creationDate: req.body.creationDate ?? null,
        createdAt: new Date().toISOString(),
      };
    }

    if (!existingData) {
      return res.status(404).json({ error: `Archive '${id}' not found` });
    }

    const nowIso = new Date().toISOString();
    const archiveName = existingData.name || req.body?.name || id;
    const creatorName =
      existingData.creatorName !== undefined ? existingData.creatorName : (req.body?.creatorName ?? null);
    const creationDate =
      existingData.creationDate !== undefined ? existingData.creationDate : (req.body?.creationDate ?? null);
    const purpose =
      existingData.purpose !== undefined ? existingData.purpose : (req.body?.purpose ?? null);

    const defaultMarkdownHeader = [
      `# ${archiveName}`,
      '',
      ...(creatorName ? [`- **Creator**: ${creatorName}`] : []),
      ...(creationDate ? [`- **Creation Date**: ${creationDate}`] : []),
      ...(purpose ? [`- **Purpose**: ${purpose}`] : []),
      '',
      '## Experiment Log',
      '',
    ].join('\n');

    const emptiedArchive: ArchiveRecord & { isSignedOff?: boolean; contentErased?: boolean } = {
      id,
      name: archiveName,
      creatorName,
      creationDate,
      purpose,
      reagents: [],
      labelTranscriptions: [],
      workSteps: [],
      markdownDoc: defaultMarkdownHeader,
      videoIds: [],
      isSignedOff: false,
      contentErased: true,
      createdAt: existingData.createdAt || nowIso,
      updatedAt: nowIso,
    };

    await dbTarget.collection('archives').doc(id).set(emptiedArchive);
    if (databaseId !== '(default)' && db && db !== dbTarget) {
      try {
        await db.collection('archives').doc(id).set(emptiedArchive);
      } catch {
        // Ignore fallback write error
      }
    }

    // Reset HITL commit and sign-off state on all videos linked to this emptied archive
    const associatedVideoIds = new Set<string>(
      Array.isArray(existingData.videoIds) ? existingData.videoIds : []
    );
    if (existingData.videoId) {
      associatedVideoIds.add(String(existingData.videoId));
    }
    try {
      const allVideos = await firestoreService.listVideos(databaseId);
      for (const v of allVideos) {
        if (
          v.archiveId === id ||
          (v.passes?.hitl as any)?.data?.archiveId === id ||
          associatedVideoIds.has(v.videoId)
        ) {
          associatedVideoIds.add(v.videoId);
        }
      }
    } catch {
      // Ignore video list scan error
    }

    for (const vid of associatedVideoIds) {
      try {
        await firestoreService.resetVideoHitlCommit(databaseId, vid);
        if (databaseId !== '(default)') {
          await firestoreService.resetVideoHitlCommit('(default)', vid);
        }
      } catch (err) {
        console.warn(`[ArchiveController] Warning: Could not reset HITL commit for video ${vid}:`, err);
      }
    }

    return res.status(200).json({
      success: true,
      archive: emptiedArchive,
      ...emptiedArchive,
    });
  } catch (error: any) {
    console.error('[ArchiveController] Error erasing archive notebook content:', error);
    return res.status(500).json({
      error: 'Failed to erase archive notebook content',
      message: error?.message || String(error),
    });
  }
};

/**
 * DELETE /api/archives/:id
 * Deletes an experiment archive document from Firestore and disassociates any linked videos.
 */
export const deleteArchiveHandler = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const id = req.params.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Missing required parameter: id' });
    }

    const rawDatabaseId = (req.headers['x-database-id'] || req.body?.databaseId || req.query?.databaseId) as
      | string
      | undefined;
    const databaseId = normalizeDatabaseId(rawDatabaseId || '(default)');
    const dbTarget = getTenantFirestore(databaseId);

    deletedArchiveDatabases.add(databaseId);
    deletedArchiveDatabases.add('(default)');

    let docSnap = await dbTarget.collection('archives').doc(id).get();
    if ((!docSnap || !docSnap.exists) && db && db !== dbTarget) {
      docSnap = await db.collection('archives').doc(id).get();
    }

    const existingData = docSnap && docSnap.exists ? docSnap.data() || {} : null;
    const linkedVideoIds = new Set<string>(
      Array.isArray(existingData?.videoIds) ? existingData.videoIds : []
    );
    if (existingData?.videoId) {
      linkedVideoIds.add(String(existingData.videoId));
    }

    await dbTarget.collection('archives').doc(id).delete();
    if (db && db !== dbTarget) {
      try {
        await db.collection('archives').doc(id).delete();
      } catch {
        // Ignore fallback delete error
      }
    }

    // Also scan videos for any linked to this archiveId and clear their archive association
    try {
      const allVideos = await firestoreService.listVideos(databaseId);
      for (const v of allVideos) {
        if (v.archiveId === id && v.videoId) {
          linkedVideoIds.add(v.videoId);
        }
      }
    } catch {
      // Ignore video scan error
    }

    const nowIso = new Date().toISOString();
    for (const vid of linkedVideoIds) {
      try {
        await firestoreService.resetVideoHitlCommit(databaseId, vid);
        if (databaseId !== '(default)') {
          await firestoreService.resetVideoHitlCommit('(default)', vid);
        }
        const disassociatePayload = {
          archiveId: null,
          archiveName: null,
          archiveCreatorName: null,
          archiveCreationDate: null,
          archivePurpose: null,
          archiveAssociationType: null,
          updatedAt: nowIso,
        };
        await firestoreService.updateVideoRecord(databaseId, vid, disassociatePayload);
        if (databaseId !== '(default)') {
          await firestoreService.updateVideoRecord('(default)', vid, disassociatePayload);
        }
      } catch {
        // Ignore disassociation error
      }
    }

    return res.status(200).json({
      success: true,
      deletedId: id,
    });
  } catch (error: any) {
    console.error('[ArchiveController] Error deleting archive:', error);
    return res.status(500).json({
      error: 'Failed to delete archive',
      message: error?.message || String(error),
    });
  }
};
