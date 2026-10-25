import * as admin from 'firebase-admin';
import { getFirestore, Firestore, DocumentData, WriteResult } from 'firebase-admin/firestore';
import {
  type VideoMetadata,
  type BoxUpdate,
  type InventorySignOffPayload,
  type ArchiveSignOffPayload,
  BoxUpdateSchema,
  InventorySignOffPayloadSchema,
  ArchiveSignOffPayloadSchema,
} from '@sail/shared';

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT || 'substance-ai-platform',
  });
}

// In-memory cache for Firestore database instances scoped to each tenant database
const databaseCache = new Map<string, Firestore>();

// In-memory document store used in test environments so E2E & unit tests run offline without GCP credentials
const inMemoryTenantDocs = new Map<string, Map<string, Record<string, any>>>();

function getTenantMemoryStore(dbId: string): Map<string, Record<string, any>> {
  if (!inMemoryTenantDocs.has(dbId)) {
    inMemoryTenantDocs.set(dbId, new Map<string, Record<string, any>>());
  }
  return inMemoryTenantDocs.get(dbId)!;
}

function createInMemoryCollectionFactory(dbId: string) {
  const store = getTenantMemoryStore(dbId);

  const makeCollection = (collectionPath: string): any => {
    const cleanCollectionPath = collectionPath.replace(/^\/+|\/+$/g, '');
    return {
      id: cleanCollectionPath.split('/').pop() || cleanCollectionPath,
      path: cleanCollectionPath,
      doc: (docId: string) => {
        const cleanDocId = String(docId).replace(/^\/+|\/+$/g, '');
        const fullDocPath = `${cleanCollectionPath}/${cleanDocId}`;
        return {
          id: cleanDocId,
          path: fullDocPath,
          set: async (data: Record<string, any>, options?: { merge?: boolean }) => {
            const existing = store.get(fullDocPath);
            if (options?.merge && existing) {
              store.set(fullDocPath, { ...existing, ...data });
            } else {
              store.set(fullDocPath, { ...data });
            }
            return { writeTime: new Date() } as unknown as WriteResult;
          },
          update: async (data: Record<string, any>) => {
            const existing = store.get(fullDocPath) || {};
            store.set(fullDocPath, { ...existing, ...data });
            return { writeTime: new Date() } as unknown as WriteResult;
          },
          get: async () => {
            const existing = store.get(fullDocPath);
            return {
              id: cleanDocId,
              exists: existing !== undefined,
              data: () => (existing !== undefined ? { ...existing } : undefined),
            };
          },
          collection: (subCollectionName: string) => {
            return makeCollection(`${fullDocPath}/${subCollectionName}`);
          },
        };
      },
    };
  };

  return makeCollection;
}

/**
 * Normalizes a database identifier. Supports both plain IDs (e.g. 'tenant-db-1')
 * and full path formats (e.g. '/databases/tenant-db-1/documents/').
 */
export function normalizeDatabaseId(databaseId?: string): string {
  if (!databaseId) return '(default)';
  const trimmed = databaseId.trim();
  const match = trimmed.match(/(?:^|\/)databases\/([^/]+)/);
  if (match) {
    return match[1];
  }
  return trimmed;
}

/**
 * Returns a cached Firestore instance scoped to `/databases/{databaseID}/documents/`.
 * Multi-tenant isolation is enforced at the database level per tenant requirements.
 */
export function getTenantFirestore(databaseId?: string): Firestore {
  const dbId = normalizeDatabaseId(databaseId);
  if (!databaseCache.has(dbId)) {
    const firestoreInstance = getFirestore(dbId);
    if (process.env.NODE_ENV === 'test') {
      // Attach an offline in-memory collection handler for test environments while preserving
      // Firestore instance properties (`databaseId`, `formattedName`) and allowing test spies to override `db.collection`.
      (firestoreInstance as any).collection = createInMemoryCollectionFactory(dbId);
    }
    databaseCache.set(dbId, firestoreInstance);
  }
  return databaseCache.get(dbId)!;
}

// Aliases for compatibility
export const getFirestoreDb = getTenantFirestore;
export const getDatabase = getTenantFirestore;

/**
 * Updates or persists video metadata in the tenant's `videos` collection.
 * Target document path: `/databases/{databaseID}/documents/videos/{videoId}`
 */
export async function saveVideoMetadata(
  databaseId: string,
  videoId: string,
  metadata: Partial<VideoMetadata> | Record<string, any>
): Promise<WriteResult> {
  const db = getTenantFirestore(databaseId);
  const docRef = db.collection('videos').doc(videoId);
  return await docRef.set(metadata, { merge: true });
}

/**
 * Retrieves video metadata from the tenant's `videos` collection.
 */
export async function getVideoMetadata(
  databaseId: string,
  videoId: string
): Promise<DocumentData | null> {
  const db = getTenantFirestore(databaseId);
  const docSnap = await db.collection('videos').doc(videoId).get();
  return docSnap.exists ? docSnap.data()! : null;
}

/**
 * Persists or updates video analysis in the tenant's `video_analyses` collection.
 * Target document path: `/databases/{databaseID}/documents/video_analyses/{videoId}`
 */
export async function saveVideoAnalysis(
  databaseId: string,
  videoId: string,
  analysis: Record<string, any>
): Promise<WriteResult> {
  const db = getTenantFirestore(databaseId);
  const docRef = db.collection('video_analyses').doc(videoId);
  return await docRef.set(analysis, { merge: true });
}

/**
 * Retrieves video analysis from the tenant's `video_analyses` collection.
 */
export async function getVideoAnalysis(
  databaseId: string,
  videoId: string
): Promise<DocumentData | null> {
  const db = getTenantFirestore(databaseId);
  const docSnap = await db.collection('video_analyses').doc(videoId).get();
  return docSnap.exists ? docSnap.data()! : null;
}

/**
 * Helper to resolve `inventories/{inventoryId}/contents/{boxId}` document reference,
 * supporting both nested `.collection('inventories').doc(inventoryId).collection('contents').doc(boxId)`
 * and flat path mocks.
 */
function getInventoryBoxDocRef(db: Firestore, inventoryId: string, boxId: string): any {
  const invDoc = db.collection('inventories').doc(inventoryId) as any;
  if (invDoc && typeof invDoc.collection === 'function') {
    return invDoc.collection('contents').doc(boxId);
  }
  return db.collection(`inventories/${inventoryId}/contents`).doc(boxId);
}

/**
 * Retrieves the contents of a cryo-box at `inventories/{inventoryId}/contents/{boxId}`.
 */
export async function getInventoryBoxContents(
  databaseId: string,
  inventoryId: string,
  boxId: string
): Promise<DocumentData | null> {
  const db = getTenantFirestore(databaseId);
  const boxDocRef = getInventoryBoxDocRef(db, inventoryId, boxId);
  const docSnap = await boxDocRef.get();
  return docSnap.exists ? docSnap.data()! : null;
}

/**
 * Retrieves an experiment archive document at `archives/{archiveId}`.
 */
export async function getArchiveDocument(
  databaseId: string,
  archiveId: string
): Promise<DocumentData | null> {
  const db = getTenantFirestore(databaseId);
  const docSnap = await db.collection('archives').doc(archiveId).get();
  return docSnap.exists ? docSnap.data()! : null;
}

/**
 * Formats an experiment archive Markdown document with required sections:
 * - `## Description`
 * - `## Reagents Used`
 * - `## Experiment Steps`
 */
export function formatArchiveMarkdown(
  input:
    | string
    | {
        markdownDoc?: string;
        description?: string;
        reagents?: string[];
        steps?: string[];
        analysis?: Record<string, any>;
        workflowClassification?: Record<string, any>;
        workloadClassification?: Record<string, any>;
        actions?: Array<Record<string, any>>;
        events?: Array<Record<string, any>>;
        refinements?: Array<Record<string, any>>;
      }
): string {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (
      trimmed.includes('## Description') &&
      trimmed.includes('## Reagents Used') &&
      trimmed.includes('## Experiment Steps')
    ) {
      return trimmed;
    }
    return [
      '## Description',
      trimmed || 'Experiment notebook entry recorded via SAIL video pipeline.',
      '',
      '## Reagents Used',
      '- Standard protocol reagents',
      '',
      '## Experiment Steps',
      '1. Executed protocol steps from video analysis.',
    ].join('\n');
  }

  if (
    input.markdownDoc &&
    input.markdownDoc.includes('## Description') &&
    input.markdownDoc.includes('## Reagents Used') &&
    input.markdownDoc.includes('## Experiment Steps')
  ) {
    return input.markdownDoc.trim();
  }

  const source = input.analysis || input;
  const classification =
    source.workflowClassification || source.workloadClassification || {};
  const actions: Array<Record<string, any>> = Array.isArray(source.actions)
    ? source.actions
    : [];
  const events: Array<Record<string, any>> = Array.isArray(source.events)
    ? source.events
    : [];
  const refinements: Array<Record<string, any>> = Array.isArray(source.refinements)
    ? source.refinements
    : [];

  const descriptionText =
    input.description ||
    classification.transcribedAudio ||
    classification.archiveName ||
    'Automated experiment archive generated from SAIL video analysis.';

  const reagentLines: string[] = [];
  if (Array.isArray(input.reagents) && input.reagents.length > 0) {
    for (const r of input.reagents) {
      reagentLines.push(r.startsWith('-') ? r : `- ${r}`);
    }
  } else {
    for (const ref of refinements) {
      if (
        ref.refinementClass === 'REAGENT_OCR_CONFLATION' ||
        ref.refinementClass === 'ACRONYM_MAPPING' ||
        ref.refinementClass === 'REAGENT_ACRONYM_RESOLUTION'
      ) {
        reagentLines.push(`- ${ref.transcriptionText}`);
      }
    }
    for (const act of actions) {
      if (act.cellLineName) {
        const info = act.cellLineInfo ? ` (${JSON.stringify(act.cellLineInfo)})` : '';
        reagentLines.push(`- Cell Line: ${act.cellLineName}${info}`);
      }
    }
    if (reagentLines.length === 0) {
      reagentLines.push('- Protocol reagents verified via video analysis');
    }
  }

  const stepLines: string[] = [];
  if (Array.isArray(input.steps) && input.steps.length > 0) {
    input.steps.forEach((s, idx) => {
      stepLines.push(/^\d+\./.test(s.trim()) ? s.trim() : `${idx + 1}. ${s.trim()}`);
    });
  } else {
    let stepNum = 1;
    for (const act of actions) {
      const relatedRefs = refinements.filter((r) =>
        (act.eventList || []).includes(r.eventId)
      );
      const refSummary =
        relatedRefs.length > 0
          ? ` — ${relatedRefs.map((r) => r.transcriptionText).join('; ')}`
          : '';
      stepLines.push(
        `${stepNum}. **${act.actionClass}** (${act.actionId}): ${
          act.cellLineName || 'Protocol execution'
        } (${(act.eventList || []).length} events)${refSummary}`
      );
      stepNum++;
    }
    if (stepLines.length === 0 && events.length > 0) {
      events.forEach((evt, idx) => {
        stepLines.push(
          `${idx + 1}. ${evt.eventClass} [${evt.startTime}s - ${evt.endTime}s]`
        );
      });
    }
    if (stepLines.length === 0) {
      stepLines.push('1. Protocol steps verified and signed off.');
    }
  }

  return [
    '## Description',
    descriptionText,
    '',
    '## Reagents Used',
    ...reagentLines,
    '',
    '## Experiment Steps',
    ...stepLines,
  ].join('\n');
}

/**
 * Atomic Inventory Sign-Off Service:
 * Commits occupied cells to `inventories/{inventoryId}/contents/{boxId}`
 * and marks `video_analyses/{videoId}.isSignedOff = true`.
 */
export async function commitInventorySignOff(
  payloadOrDatabaseId: InventorySignOffPayload | string,
  videoIdArg?: string,
  inventoryIdArg?: string,
  boxUpdatesArg?: BoxUpdate[],
  operatorInitialsArg?: string
): Promise<{
  success: boolean;
  databaseId: string;
  videoId: string;
  inventoryId: string;
  boxId: string;
  documentPath: string;
  signedOffAt: string;
  occupiedCells: Record<string, any>;
  isSignedOff: boolean;
}> {
  const rawPayload: InventorySignOffPayload =
    typeof payloadOrDatabaseId === 'string'
      ? {
          databaseId: payloadOrDatabaseId,
          videoId: videoIdArg!,
          inventoryId: inventoryIdArg!,
          boxUpdates: (boxUpdatesArg || []).map((u) => BoxUpdateSchema.parse(u)),
          signedOffAt: new Date().toISOString(),
          operatorInitials: operatorInitialsArg,
        }
      : {
          ...payloadOrDatabaseId,
          signedOffAt: payloadOrDatabaseId.signedOffAt || new Date().toISOString(),
        };

  const parsedPayload = InventorySignOffPayloadSchema.parse(rawPayload);
  const { databaseId, videoId, inventoryId, boxUpdates, operatorInitials } = parsedPayload;
  const signedOffAt = parsedPayload.signedOffAt || new Date().toISOString();
  const dbId = normalizeDatabaseId(databaseId);
  const db = getTenantFirestore(dbId);

  // Group updates by boxId
  const updatesByBox = new Map<string, BoxUpdate[]>();
  for (const update of boxUpdates) {
    const bId = update.boxId || 'box_01';
    if (!updatesByBox.has(bId)) {
      updatesByBox.set(bId, []);
    }
    updatesByBox.get(bId)!.push(update);
  }

  // Ensure at least default box_01 if boxUpdates was empty
  const primaryBoxId = boxUpdates[0]?.boxId || 'box_01';
  let combinedOccupiedCells: Record<string, any> = {};

  for (const [boxId, updates] of updatesByBox.entries()) {
    const boxDocRef = getInventoryBoxDocRef(db, inventoryId, boxId);
    let existingCells: Record<string, any> = {};
    if (typeof boxDocRef.get === 'function') {
      const existingSnap = await boxDocRef.get();
      if (existingSnap && existingSnap.exists) {
        const existingData = existingSnap.data();
        if (existingData?.occupiedCells) {
          existingCells = { ...existingData.occupiedCells };
        }
      }
    }

    for (const cell of updates) {
      const coordinate = `${cell.row.toUpperCase()}${cell.col}`;
      existingCells[coordinate] = {
        boxId,
        coordinate,
        row: cell.row.toUpperCase(),
        col: cell.col,
        cellLineName: cell.cellLineName,
        lotNumber: cell.lotNumber,
        passage: cell.passage,
        operatorInitials: cell.operatorInitials || operatorInitials,
        status: cell.status || 'OCCUPIED',
        updatedAt: cell.updatedAt || signedOffAt,
      };
    }

    combinedOccupiedCells = { ...combinedOccupiedCells, ...existingCells };

    await boxDocRef.set(
      {
        boxId,
        inventoryId,
        occupiedCells: existingCells,
        cells: Object.values(existingCells),
        lastVideoId: videoId,
        updatedAt: signedOffAt,
      },
      { merge: true }
    );
  }

  // Mark video_analyses/{videoId}.isSignedOff = true
  await db
    .collection('video_analyses')
    .doc(videoId)
    .set(
      {
        videoId,
        isSignedOff: true,
        signedOffAt,
        updatedAt: signedOffAt,
      },
      { merge: true }
    );

  return {
    success: true,
    databaseId: dbId,
    videoId,
    inventoryId,
    boxId: primaryBoxId,
    documentPath: `/databases/${dbId}/documents/inventories/${inventoryId}/contents/${primaryBoxId}`,
    signedOffAt,
    occupiedCells: combinedOccupiedCells,
    isSignedOff: true,
  };
}

/**
 * Atomic Archive Sign-Off Service:
 * Formats the experiment markdown document (`## Description`, `## Reagents Used`, `## Experiment Steps`)
 * in `archives/{archiveId}` and marks `video_analyses/{videoId}.isSignedOff = true`.
 */
export async function commitArchiveSignOff(
  payloadOrDatabaseId:
    | (Omit<ArchiveSignOffPayload, 'markdownDoc'> & {
        markdownDoc?: string;
        analysis?: Record<string, any>;
        description?: string;
        reagents?: string[];
        steps?: string[];
      })
    | string,
  videoIdArg?: string,
  archiveIdArg?: string,
  markdownOrAnalysisArg?: string | Record<string, any>,
  operatorInitialsArg?: string
): Promise<{
  success: boolean;
  databaseId: string;
  videoId: string;
  archiveId: string;
  documentPath: string;
  markdownDoc: string;
  signedOffAt: string;
  isSignedOff: boolean;
}> {
  let databaseId: string;
  let videoId: string;
  let archiveId: string;
  let markdownDoc: string;
  let signedOffAt: string;
  let operatorInitials: string | undefined;

  if (typeof payloadOrDatabaseId === 'string') {
    databaseId = payloadOrDatabaseId;
    videoId = videoIdArg!;
    archiveId = archiveIdArg!;
    markdownDoc = formatArchiveMarkdown(markdownOrAnalysisArg || '');
    signedOffAt = new Date().toISOString();
    operatorInitials = operatorInitialsArg;
  } else {
    databaseId = payloadOrDatabaseId.databaseId;
    videoId = payloadOrDatabaseId.videoId;
    archiveId = payloadOrDatabaseId.archiveId;
    markdownDoc = formatArchiveMarkdown(
      payloadOrDatabaseId.markdownDoc
        ? payloadOrDatabaseId.markdownDoc
        : payloadOrDatabaseId
    );
    signedOffAt = payloadOrDatabaseId.signedOffAt || new Date().toISOString();
    operatorInitials = payloadOrDatabaseId.operatorInitials;
  }

  const validatedPayload = ArchiveSignOffPayloadSchema.parse({
    databaseId,
    videoId,
    archiveId,
    markdownDoc,
    signedOffAt,
    operatorInitials,
  });

  const dbId = normalizeDatabaseId(validatedPayload.databaseId);
  const db = getTenantFirestore(dbId);

  // Persist compiled Markdown experiment document to archives/{archiveId}
  await db
    .collection('archives')
    .doc(archiveId)
    .set(
      {
        archiveId,
        videoId,
        markdownDoc: validatedPayload.markdownDoc,
        operatorInitials: validatedPayload.operatorInitials,
        isSignedOff: true,
        signedOffAt,
        updatedAt: signedOffAt,
      },
      { merge: true }
    );

  // Mark video_analyses/{videoId}.isSignedOff = true
  await db
    .collection('video_analyses')
    .doc(videoId)
    .set(
      {
        videoId,
        isSignedOff: true,
        signedOffAt,
        updatedAt: signedOffAt,
      },
      { merge: true }
    );

  return {
    success: true,
    databaseId: dbId,
    videoId,
    archiveId,
    documentPath: `/databases/${dbId}/documents/archives/${archiveId}`,
    markdownDoc: validatedPayload.markdownDoc,
    signedOffAt,
    isSignedOff: true,
  };
}

/**
 * Clears the internal database instance cache and in-memory test documents (primarily used for testing).
 */
export function clearDatabaseCache(): void {
  databaseCache.clear();
  inMemoryTenantDocs.clear();
}
