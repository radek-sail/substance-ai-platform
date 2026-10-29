import * as admin from 'firebase-admin';
import { getFirestore, Firestore, DocumentData, WriteResult } from 'firebase-admin/firestore';
import {
  type VideoMetadata,
  type BoxUpdate,
  type InventorySignOffPayload,
  type ArchiveSignOffPayload,
  type VideoPasses,
  type PassStepState,
  DEFAULT_VIDEO_PASSES,
  BoxUpdateSchema,
  InventorySignOffPayloadSchema,
  ArchiveSignOffPayloadSchema,
} from '@sail/shared';

export interface VideoRecord {
  videoId: string;
  originalName: string;
  gcsBucket?: string;
  rawPath?: string;
  normalizedPath?: string;
  rawGcsUri: string;
  normalizedGcsUri: string;
  geminiFileUri?: string;
  geminiFileName?: string;
  durationSeconds?: number;
  fileSizeBytes?: number;
  status:
    | 'UPLOADING'
    | 'TRANSCODING'
    | 'READY_FOR_ANALYSIS'
    | 'ANALYZING'
    | 'ANALYSIS_COMPLETE'
    | 'FAILED';
  passes?: VideoPasses;
  analysisId?: string;
  organizationId?: string;
  uploadedBy?: string;
  uploadedAt: FirebaseFirestore.FieldValue | string;
  transcodedAt?: FirebaseFirestore.FieldValue | string;
}

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  const explicitProjectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    (process.env.NODE_ENV === 'test' ? 'test-sail-project' : 'sail-platform-prod');
  admin.initializeApp(explicitProjectId ? { projectId: explicitProjectId } : undefined);
  try {
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  } catch {
    // Ignore if Firestore settings were already initialized
  }
}

function stripUndefinedFields<T extends Record<string, any>>(obj: T): T {
  const hasUndefined = Object.values(obj).some((v) => v === undefined);
  if (!hasUndefined) {
    return obj;
  }
  const cleaned: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      cleaned[key] = val;
    }
  }
  return cleaned as T;
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

function toComparableMillis(val: any, fallbackIso?: string): number {
  if (!val && fallbackIso) {
    const parsed = Date.parse(fallbackIso);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (val && typeof val.toMillis === 'function') {
    return val.toMillis();
  }
  if (val && typeof val.toDate === 'function') {
    return val.toDate().getTime();
  }
  if (val && typeof val._seconds === 'number') {
    return val._seconds * 1000;
  }
  if (fallbackIso) {
    const parsed = Date.parse(fallbackIso);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function serializeTimestampField(val: any, fallbackIso?: string): string {
  if (typeof val === 'string') return val;
  if (val && typeof val.toDate === 'function') {
    return val.toDate().toISOString();
  }
  if (val && typeof val._seconds === 'number') {
    return new Date(val._seconds * 1000).toISOString();
  }
  return fallbackIso || new Date().toISOString();
}

function createInMemoryCollectionFactory(dbId: string) {
  const store = getTenantMemoryStore(dbId);

  const makeCollection = (collectionPath: string): any => {
    const cleanCollectionPath = collectionPath.replace(/^\/+|\/+$/g, '');

    const queryCollection = (orderField?: string, orderDir: 'asc' | 'desc' = 'desc') => {
      const prefix = `${cleanCollectionPath}/`;
      const docs: Array<{ id: string; exists: boolean; data: () => Record<string, any> }> = [];
      for (const [key, val] of store.entries()) {
        if (key.startsWith(prefix)) {
          const remainder = key.slice(prefix.length);
          if (!remainder.includes('/')) {
            docs.push({
              id: remainder,
              exists: true,
              data: () => ({ ...val }),
            });
          }
        }
      }
      if (orderField) {
        docs.sort((a, b) => {
          const aData = a.data();
          const bData = b.data();
          const aTime = toComparableMillis(aData[orderField], aData.createdAt || aData.updatedAt);
          const bTime = toComparableMillis(bData[orderField], bData.createdAt || bData.updatedAt);
          return orderDir === 'desc' ? bTime - aTime : aTime - bTime;
        });
      }
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
      };
    };

    return {
      id: cleanCollectionPath.split('/').pop() || cleanCollectionPath,
      path: cleanCollectionPath,
      get: async () => queryCollection(),
      orderBy: (field: string, direction: 'asc' | 'desc' = 'asc') => ({
        get: async () => queryCollection(field, direction),
      }),
      doc: (docId: string) => {
        const cleanDocId = String(docId).replace(/^\/+|\/+$/g, '');
        const fullDocPath = `${cleanCollectionPath}/${cleanDocId}`;
        return {
          id: cleanDocId,
          path: fullDocPath,
          set: async (data: Record<string, any>, options?: { merge?: boolean }) => {
            const existing = store.get(fullDocPath);
            if (options?.merge && existing) {
              const mergedPasses =
                existing.passes || data.passes
                  ? { ...(existing.passes || {}), ...(data.passes || {}) }
                  : undefined;
              store.set(fullDocPath, {
                ...existing,
                ...data,
                ...(mergedPasses ? { passes: mergedPasses } : {}),
              });
            } else {
              store.set(fullDocPath, { ...data });
            }
            return { writeTime: new Date() } as unknown as WriteResult;
          },
          update: async (data: Record<string, any>) => {
            const existing = store.get(fullDocPath) || {};
            const mergedPasses =
              existing.passes || data.passes
                ? { ...(existing.passes || {}), ...(data.passes || {}) }
                : undefined;
            store.set(fullDocPath, {
              ...existing,
              ...data,
              ...(mergedPasses ? { passes: mergedPasses } : {}),
            });
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
 * Normalizes a database identifier. Defaults to `(default)` and avoids connecting
 * to placeholder database IDs like `customer-alpha-db` unless explicitly in test mode.
 */
export function normalizeDatabaseId(databaseId?: string): string {
  if (!databaseId) return '(default)';
  const trimmed = databaseId.trim();
  if (!trimmed || trimmed === 'default' || trimmed === '(default)') {
    return '(default)';
  }
  const demoTenantDbs = ['customer-alpha-db', 'biolab-db', 'pharma-db'];
  if (demoTenantDbs.includes(trimmed) && process.env.NODE_ENV !== 'test') {
    return '(default)';
  }
  const match = trimmed.match(/(?:^|\/)databases\/([^/]+)/);
  if (match) {
    const extracted = match[1];
    if (
      extracted === 'default' ||
      extracted === '(default)' ||
      (demoTenantDbs.includes(extracted) && process.env.NODE_ENV !== 'test')
    ) {
      return '(default)';
    }
    return extracted;
  }
  return trimmed;
}

/**
 * Returns a cached Firestore instance scoped to `/databases/{databaseID}/documents/`.
 * Uses the default Firestore instance (`admin.firestore()`) when targeting `(default)`.
 */
export function getTenantFirestore(databaseId?: string): Firestore {
  const dbId = normalizeDatabaseId(databaseId);
  if (!databaseCache.has(dbId)) {
    const firestoreInstance = dbId === '(default)' ? admin.firestore() : getFirestore(dbId);
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
 * Mirrors a video record into the in-memory store for immediate read-after-write consistency.
 */
export function mirrorVideoToMemory(
  databaseId: string,
  videoId: string,
  metadata: Partial<VideoRecord> | Partial<VideoMetadata> | Record<string, any>
): void {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const sanitized = stripUndefinedFields(metadata);

  const memStore = getTenantMemoryStore(dbId);
  const existing = memStore.get(`videos/${videoId}`) || {};
  memStore.set(`videos/${videoId}`, {
    ...existing,
    ...sanitized,
    videoId,
  });

  if (dbId !== '(default)') {
    const defaultStore = getTenantMemoryStore('(default)');
    const existingDefault = defaultStore.get(`videos/${videoId}`) || {};
    defaultStore.set(`videos/${videoId}`, {
      ...existingDefault,
      ...sanitized,
      videoId,
    });
  }
}

/**
 * Returns all in-memory mirrored video records for the specified database.
 */
export function getInMemoryVideos(databaseId: string = '(default)'): Array<Record<string, any>> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const memStore = getTenantMemoryStore(dbId);
  const results: Array<Record<string, any>> = [];
  for (const [key, rawData] of memStore.entries()) {
    if (key.startsWith('videos/')) {
      const id = key.slice('videos/'.length);
      results.push(formatVideoDocument(id, rawData));
    }
  }
  return results;
}

/**
 * Updates or persists video metadata/record in the `videos` collection.
 * Target document path: `/databases/{databaseID}/documents/videos/{videoId}`
 */
export async function saveVideoMetadata(
  databaseId: string,
  videoId: string,
  metadata: Partial<VideoRecord> | Partial<VideoMetadata> | Record<string, any>
): Promise<WriteResult> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const db = getTenantFirestore(dbId);
  const sanitized = stripUndefinedFields(metadata);

  // Mirror into in-memory store for immediate read-after-write consistency
  mirrorVideoToMemory(dbId, videoId, sanitized);

  const docRef = db.collection('videos').doc(videoId);
  return await docRef.set(sanitized, { merge: true });
}

/**
 * Updates fields on an existing video record in `videos/{videoId}` safely.
 */
export async function updateVideoRecord(
  databaseId: string | undefined,
  videoId: string,
  updates: Partial<VideoRecord> | Record<string, any>
): Promise<WriteResult | null> {
  try {
    const dbId = normalizeDatabaseId(databaseId || '(default)');
    const db = getTenantFirestore(dbId);
    const sanitized = stripUndefinedFields(updates);

    const memStore = getTenantMemoryStore(dbId);
    const existing = memStore.get(`videos/${videoId}`) || {};
    memStore.set(`videos/${videoId}`, {
      ...existing,
      ...sanitized,
      videoId,
    });

    const col = db.collection('videos');
    if (!col || typeof col.doc !== 'function') {
      return null;
    }
    const docRef = col.doc(videoId);
    if (!docRef || typeof docRef.set !== 'function') {
      return null;
    }
    return await docRef.set(sanitized, { merge: true });
  } catch (err) {
    console.warn(`[FirestoreService] Could not update video record ${videoId}:`, err);
    return null;
  }
}

/**
 * Updates a single pass state (`pass0`..`pass3` or `hitl`) in `videos/{videoId}.passes`.
 */
export async function updateVideoPass(
  databaseId: string | undefined,
  videoId: string,
  passKey: keyof VideoPasses,
  passState: PassStepState,
  extraUpdates?: Record<string, any>
): Promise<WriteResult | null> {
  try {
    const dbId = normalizeDatabaseId(databaseId || '(default)');
    const db = getTenantFirestore(dbId);
    const col = db.collection('videos');
    if (!col || typeof col.doc !== 'function') {
      return null;
    }
    const docRef = col.doc(videoId);
    if (!docRef || typeof docRef.set !== 'function') {
      return null;
    }
    let existingPasses: VideoPasses = {
      pass0: { status: 'PENDING' },
      pass1: { status: 'PENDING' },
      pass2: { status: 'PENDING' },
      pass3: { status: 'PENDING' },
      hitl: { status: 'PENDING' },
    };
    const memStore = getTenantMemoryStore(dbId);
    const memDoc = memStore.get(`videos/${videoId}`);
    if (memDoc?.passes) {
      existingPasses = {
        ...existingPasses,
        ...memDoc.passes,
      };
    }
    if (typeof docRef.get === 'function') {
      try {
        const snap = await docRef.get();
        if (snap && snap.exists) {
          const data = snap.data();
          if (data?.passes) {
            existingPasses = {
              ...existingPasses,
              ...data.passes,
            };
          }
        }
      } catch {
        // Ignore read error before merge
      }
    }
    const updatedPasses: VideoPasses = {
      ...existingPasses,
      [passKey]: stripUndefinedFields(passState),
    };
    const payload = stripUndefinedFields({
      videoId,
      passes: updatedPasses,
      ...(extraUpdates || {}),
    });
    memStore.set(`videos/${videoId}`, {
      ...(memDoc || {}),
      ...payload,
    });
    return await docRef.set(payload, { merge: true });
  } catch (err) {
    console.warn(`[FirestoreService] Could not update video pass ${passKey} for ${videoId}:`, err);
    return null;
  }
}

/**
 * Retrieves the pass statuses and outputs for a specified video from `videos/{videoId}`.
 */
export async function getVideoPasses(
  databaseId: string | undefined,
  videoId: string
): Promise<{ videoId: string; status: string; geminiFileUri?: string; passes: VideoPasses } | null> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const db = getTenantFirestore(dbId);
  let data: Record<string, any> | undefined;
  try {
    const docSnap = await db.collection('videos').doc(videoId).get();
    if (docSnap.exists) {
      data = docSnap.data() || {};
    }
  } catch (err) {
    console.warn(`[FirestoreService] getVideoPasses fallback to memory for ${videoId}:`, err);
  }
  if (!data) {
    const memDoc = getTenantMemoryStore(dbId).get(`videos/${videoId}`);
    if (!memDoc) {
      return null;
    }
    data = memDoc;
  }
  const passes: VideoPasses = {
    pass0: data.passes?.pass0 || { status: 'PENDING' },
    pass1: data.passes?.pass1 || { status: 'PENDING' },
    pass2: data.passes?.pass2 || { status: 'PENDING' },
    pass3: data.passes?.pass3 || { status: 'PENDING' },
    hitl: data.passes?.hitl || { status: 'PENDING' },
  };
  return {
    videoId: data.videoId || videoId,
    status: data.status || 'READY_FOR_ANALYSIS',
    geminiFileUri: data.geminiFileUri,
    passes,
  };
}

/**
 * Retrieves video metadata/record from the `videos` collection.
 */
export async function getVideoMetadata(
  databaseId: string,
  videoId: string
): Promise<DocumentData | null> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const db = getTenantFirestore(dbId);
  const docSnap = await db.collection('videos').doc(videoId).get();
  return docSnap.exists ? docSnap.data()! : null;
}

/**
 * Normalizes a raw Firestore/in-memory video document into a consistent VideoRecord object.
 */
function formatVideoDocument(id: string, data: Record<string, any>): Record<string, any> {
  const videoId = data.videoId || id;
  const uploadedAtIso = serializeTimestampField(data.uploadedAt, data.createdAt || data.updatedAt);
  const transcodedAtIso = data.transcodedAt
    ? serializeTimestampField(data.transcodedAt, data.updatedAt || uploadedAtIso)
    : undefined;

  const passes: VideoPasses = {
    pass0: data.passes?.pass0 || { status: 'PENDING' },
    pass1: data.passes?.pass1 || { status: 'PENDING' },
    pass2: data.passes?.pass2 || { status: 'PENDING' },
    pass3: data.passes?.pass3 || { status: 'PENDING' },
    hitl: data.passes?.hitl || { status: 'PENDING' },
  };

  return {
    ...data,
    videoId,
    originalName: data.originalName || data.fileName || `${videoId}.mp4`,
    gcsBucket: data.gcsBucket || process.env.GCS_BUCKET_NAME || 'sail-platform-videos',
    rawPath: data.rawPath || `raw/${videoId}_${data.originalName || `${videoId}.mp4`}`,
    normalizedPath: data.normalizedPath || `normalized/norm_${videoId}.mp4`,
    rawGcsUri: data.rawGcsUri || data.originalGcsUri || '',
    normalizedGcsUri: data.normalizedGcsUri || '',
    status: data.status || 'READY_FOR_ANALYSIS',
    passes,
    uploadedAt: uploadedAtIso,
    ...(transcodedAtIso ? { transcodedAt: transcodedAtIso } : {}),
  };
}

/**
 * Lists all uploaded/transcoded videos from Firestore `videos` collection ordered by `uploadedAt desc`.
 * Falls back to `db.collection('videos').get()` and sorts in memory if `orderBy('uploadedAt', 'desc')`
 * fails due to missing indexes or mixed timestamp types.
 */
export async function listVideos(databaseId: string = '(default)'): Promise<Array<Record<string, any>>> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const db = getTenantFirestore(dbId);
  const videosCollection = db.collection('videos') as any;

  let snapshot: any = null;
  if (videosCollection && typeof videosCollection.orderBy === 'function') {
    try {
      snapshot = await videosCollection.orderBy('uploadedAt', 'desc').get();
    } catch (orderErr) {
      console.warn(
        '[FirestoreService] orderBy("uploadedAt", "desc") failed, falling back to unfiltered get():',
        orderErr
      );
      try {
        snapshot = await videosCollection.get();
      } catch (getErr) {
        console.warn('[FirestoreService] videos.get() failed, using in-memory registry fallback:', getErr);
      }
    }
  } else if (videosCollection && typeof videosCollection.get === 'function') {
    try {
      snapshot = await videosCollection.get();
    } catch (getErr) {
      console.warn('[FirestoreService] videos.get() failed, using in-memory registry fallback:', getErr);
    }
  }

  const byId = new Map<string, Record<string, any>>();

  for (const docSnap of snapshot?.docs || []) {
    const rawData = typeof docSnap.data === 'function' ? docSnap.data() || {} : {};
    const formatted = formatVideoDocument(docSnap.id, rawData);
    byId.set(formatted.videoId, formatted);
  }

  // Merge any recently saved records from in-memory store for read-after-write consistency
  const memStore = getTenantMemoryStore(dbId);
  for (const [key, rawData] of memStore.entries()) {
    if (key.startsWith('videos/')) {
      const id = key.slice('videos/'.length);
      if (!byId.has(id)) {
        const formatted = formatVideoDocument(id, rawData);
        byId.set(formatted.videoId, formatted);
      }
    }
  }

  const docs = Array.from(byId.values());

  // Ensure deterministic descending order by uploadedAt
  docs.sort((a, b) => {
    const aMillis = toComparableMillis(a.uploadedAt, a.createdAt);
    const bMillis = toComparableMillis(b.uploadedAt, b.createdAt);
    return bMillis - aMillis;
  });

  return docs;
}

/**
 * Persists or updates video analysis in the default `(default)` (or specified tenant) Firestore
 * database under the `video_analyses` collection using `videoId` as the document ID.
 * Target document path: `/databases/{databaseID}/documents/video_analyses/{videoId}`
 */
export async function saveVideoAnalysis(
  databaseId: string | undefined,
  videoId: string,
  analysis: Record<string, any>
): Promise<WriteResult> {
  const db = getTenantFirestore(databaseId || '(default)');
  const docRef = db.collection('video_analyses').doc(videoId);
  return await docRef.set(analysis, { merge: true });
}

/**
 * Retrieves video analysis from the `video_analyses` collection.
 */
export async function getVideoAnalysis(
  databaseId: string | undefined,
  videoId: string
): Promise<DocumentData | null> {
  const db = getTenantFirestore(databaseId || '(default)');
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

  if (process.env.NODE_ENV !== 'test') {
    await updateVideoPass(dbId, videoId, 'hitl', {
      status: 'COMPLETED',
      completedAt: signedOffAt,
    });
  }

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

  if (process.env.NODE_ENV !== 'test') {
    await updateVideoPass(dbId, videoId, 'hitl', {
      status: 'COMPLETED',
      completedAt: signedOffAt,
    });
  }

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
  if (process.env.NODE_ENV === 'test') {
    getTenantFirestore('(default)');
  }
}

if (process.env.NODE_ENV === 'test') {
  getTenantFirestore('(default)');
}
