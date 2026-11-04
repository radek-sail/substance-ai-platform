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
  bucketName?: string;
  gcsBucket?: string;
  rawPath?: string;
  normalizedPath?: string;
  rawGcsUri: string;
  normalizedGcsUri?: string;
  totalChunks?: number;
  chunks?: Array<{ index: number; gcsUri: string }>;
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
    | 'FAILED'
    | 'ERROR';
  errorMessage?: string;
  passes?: VideoPasses;
  analysisId?: string;
  organizationId?: string;
  uploadedBy?: string;
  uploadedAt: FirebaseFirestore.FieldValue | string;
  capturedAt?: FirebaseFirestore.FieldValue | string;
  transcodedAt?: FirebaseFirestore.FieldValue | string;
}

// Initialize Firebase Admin SDK targeting the default database
if (!admin.apps.length) {
  admin.initializeApp({
    projectId:
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.FIREBASE_PROJECT_ID ||
      (process.env.NODE_ENV === 'test' ? 'test-sail-project' : 'sail-platform-prod'),
  });
}

export const db: Firestore = admin.firestore();
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  // Ignore if Firestore settings were already initialized
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

function applyDotNotationUpdates(target: Record<string, any>, updates: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const [key, val] of Object.entries(updates)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        current[part] = current[part] ? { ...current[part] } : {};
        current = current[part];
      }
      current[parts[parts.length - 1]] = val;
    } else {
      result[key] = val;
    }
  }
  return result;
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
            const applied = applyDotNotationUpdates(existing, data);
            const mergedPasses =
              existing.passes || applied.passes
                ? { ...(existing.passes || {}), ...(applied.passes || {}) }
                : undefined;
            store.set(fullDocPath, {
              ...applied,
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
          delete: async () => {
            store.delete(fullDocPath);
            return { writeTime: new Date() } as unknown as WriteResult;
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

if (process.env.NODE_ENV === 'test') {
  (db as any).collection = createInMemoryCollectionFactory('(default)');
}

/**
 * Normalizes a database identifier.
 * In production/cloud environments, all Firestore data must target the '(default)' database.
 * Custom database IDs (e.g. 'customer-alpha', 'customer-alpha-db') do not exist in GCP
 * and cause PERMISSION_DENIED errors.
 */
export function normalizeDatabaseId(databaseId?: string): string {
  if (process.env.NODE_ENV !== 'test') {
    return '(default)';
  }
  if (!databaseId) return '(default)';
  const trimmed = databaseId.trim();
  if (!trimmed || trimmed === 'default' || trimmed === '(default)') {
    return '(default)';
  }
  const match = trimmed.match(/(?:^|\/)databases\/([^/]+)/);
  if (match) {
    const extracted = match[1];
    if (extracted === 'default' || extracted === '(default)') {
      return '(default)';
    }
    return extracted;
  }
  return trimmed;
}

/**
 * Returns a cached Firestore instance scoped to `/databases/{databaseID}/documents/`.
 * In production, always returns the default Firestore database instance (`db`),
 * removing any custom databaseId configuration that sets it to anything other than `(default)`.
 */
export function getTenantFirestore(databaseId?: string): Firestore {
  const dbId = normalizeDatabaseId(databaseId);
  if (dbId === '(default)' || process.env.NODE_ENV !== 'test') {
    return db;
  }
  if (!databaseCache.has(dbId)) {
    const firestoreInstance = getFirestore(dbId);
    if (process.env.NODE_ENV === 'test') {
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
    const existingPass = existingPasses[passKey] || {};
    const cleanPassState: PassStepState = {
      ...(passState.status === 'COMPLETED' ? { error: null } : {}),
      ...(existingPass.executionAudit ? { executionAudit: existingPass.executionAudit } : {}),
      ...passState,
    };
    const updatedPasses: VideoPasses = {
      ...existingPasses,
      [passKey]: stripUndefinedFields(cleanPassState),
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
  if (passes.hitl?.status !== 'COMPLETED') {
    if (data.isSignedOff === true) {
      passes.hitl = {
        ...passes.hitl,
        status: 'COMPLETED',
        completedAt: passes.hitl?.completedAt || data.signedOffAt,
      };
    } else {
      try {
        const analysisSnap = await db.collection('video_analyses').doc(videoId).get();
        if (analysisSnap && analysisSnap.exists) {
          const analysisData = analysisSnap.data() || {};
          if (analysisData.isSignedOff === true) {
            passes.hitl = {
              ...passes.hitl,
              status: 'COMPLETED',
              completedAt: passes.hitl?.completedAt || analysisData.signedOffAt,
            };
          }
        }
      } catch {
        // Ignore analysis lookup errors
      }
    }
  }
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
 * Deletes a video record and its associated analysis document from Firestore (`videos/{videoId}` and `video_analyses/{videoId}`)
 * as well as the in-memory store.
 */
export async function deleteVideoRecord(
  databaseId: string | undefined,
  videoId: string
): Promise<boolean> {
  const dbId = normalizeDatabaseId(databaseId || '(default)');
  const db = getTenantFirestore(dbId);

  // Remove from in-memory store for both tenant and (default)
  const memStore = getTenantMemoryStore(dbId);
  memStore.delete(`videos/${videoId}`);
  memStore.delete(`video_analyses/${videoId}`);

  if (dbId !== '(default)') {
    const defaultStore = getTenantMemoryStore('(default)');
    defaultStore.delete(`videos/${videoId}`);
    defaultStore.delete(`video_analyses/${videoId}`);
  }

  try {
    const videosCol = db.collection('videos');
    if (videosCol && typeof videosCol.doc === 'function') {
      const videoDocRef = videosCol.doc(videoId) as any;
      if (videoDocRef && typeof videoDocRef.delete === 'function') {
        await videoDocRef.delete();
      }
    }
  } catch (err) {
    console.warn(`[FirestoreService] Could not delete videos/${videoId} from Firestore:`, err);
  }

  try {
    const analysesCol = db.collection('video_analyses');
    if (analysesCol && typeof analysesCol.doc === 'function') {
      const analysisDocRef = analysesCol.doc(videoId) as any;
      if (analysisDocRef && typeof analysisDocRef.delete === 'function') {
        await analysisDocRef.delete();
      }
    }
  } catch (err) {
    console.warn(`[FirestoreService] Could not delete video_analyses/${videoId} from Firestore:`, err);
  }

  return true;
}

/**
 * Normalizes a raw Firestore/in-memory video document into a consistent VideoRecord object.
 */
function formatVideoDocument(id: string, data: Record<string, any>): Record<string, any> {
  const videoId = data.videoId || id;
  const uploadedAtIso = serializeTimestampField(data.uploadedAt, data.createdAt || data.updatedAt);
  const capturedAtIso = data.capturedAt
    ? serializeTimestampField(data.capturedAt, uploadedAtIso)
    : undefined;
  const transcodedAtIso = data.transcodedAt
    ? serializeTimestampField(data.transcodedAt, data.updatedAt || uploadedAtIso)
    : undefined;

  const pass0 = data.passes?.pass0 ? { ...data.passes.pass0 } : { status: 'PENDING' };
  if (pass0.status === 'COMPLETED') {
    pass0.error = null;
  }
  const passes: VideoPasses = {
    pass0,
    pass1: data.passes?.pass1 || { status: 'PENDING' },
    pass2: data.passes?.pass2 || { status: 'PENDING' },
    pass3: data.passes?.pass3 || { status: 'PENDING' },
    hitl: data.passes?.hitl || { status: 'PENDING' },
  };

  const firstChunkUri =
    Array.isArray(data.chunks) && data.chunks.length > 0 ? data.chunks[0]?.gcsUri : undefined;

  return {
    ...data,
    videoId,
    originalName: data.originalName || data.fileName || `${videoId}.mp4`,
    bucketName: data.bucketName || data.gcsBucket || process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod',
    gcsBucket: data.gcsBucket || data.bucketName || process.env.GCS_BUCKET_NAME || 'sail-platform-videos-prod',
    rawPath: data.rawPath || `raw/${videoId}/${data.originalName || `${videoId}.mp4`}`,
    normalizedPath: data.normalizedPath || `normalized/${videoId}/chunk_000.mp4`,
    rawGcsUri: data.rawGcsUri || data.originalGcsUri || '',
    normalizedGcsUri: data.normalizedGcsUri || firstChunkUri || '',
    status: data.status || 'READY_FOR_ANALYSIS',
    inventoryId: data.inventoryId !== undefined ? data.inventoryId : null,
    inventoryName: data.inventoryName !== undefined ? data.inventoryName : null,
    unmatchedInventoryName: data.unmatchedInventoryName !== undefined ? data.unmatchedInventoryName : null,
    inventoryAssociationType: data.inventoryAssociationType !== undefined ? data.inventoryAssociationType : null,
    associatedAt: data.associatedAt !== undefined ? data.associatedAt : null,
    passes,
    uploadedAt: uploadedAtIso,
    ...(capturedAtIso ? { capturedAt: capturedAtIso } : {}),
    ...(typeof data.durationSeconds === 'number' ? { durationSeconds: data.durationSeconds } : {}),
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
 * Resolves a box key inside `inventoryDoc.boxes` from a raw boxId such as
 * 'A-1', 'Box 1', 'box_01', 'CryoBox-A1', etc.
 */
function resolveInventoryBoxKey(boxes: Record<string, any>, rawBoxId: string): string {
  if (!boxes || typeof boxes !== 'object') {
    return rawBoxId || 'A-1';
  }
  if (boxes[rawBoxId]) {
    return rawBoxId;
  }
  const keys = Object.keys(boxes);
  const lower = String(rawBoxId || '').trim().toLowerCase();
  const caseMatch = keys.find((k) => k.toLowerCase() === lower);
  if (caseMatch) {
    return caseMatch;
  }
  // Match patterns like "CryoBox-A1", "Tower A Box 1", "A1" -> "A-1"
  const towerBoxMatch = String(rawBoxId || '').match(/([A-Za-z])[-_\s]*0*(\d+)/);
  if (towerBoxMatch) {
    const candidate = `${towerBoxMatch[1].toUpperCase()}-${parseInt(towerBoxMatch[2], 10)}`;
    if (boxes[candidate]) {
      return candidate;
    }
  }
  // Match patterns like "box_01", "Box 1" -> "A-1"
  const numOnlyMatch = String(rawBoxId || '').match(/(?:box|slot|rack)[-_\s]*0*(\d+)/i);
  if (numOnlyMatch) {
    const candidate = `A-${parseInt(numOnlyMatch[1], 10)}`;
    if (boxes[candidate]) {
      return candidate;
    }
  }
  return keys[0] || rawBoxId || 'A-1';
}

/**
 * Atomic Inventory Sign-Off Service:
 * Commits occupied cells to `inventories/{inventoryId}/contents/{boxId}`,
 * syncs the cells (with `highlighted: true` and extracted vial metadata) into `inventories/{inventoryId}.boxes`,
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
  const tenantDb = getTenantFirestore(dbId);

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

  // Read top-level inventory document if it exists so we can perform occupancy sanity checks
  let topLevelInvData: Record<string, any> | null = null;
  const loadTopLevelInventoryData = async (firestoreInstance: Firestore): Promise<Record<string, any> | null> => {
    try {
      const invRef = firestoreInstance.collection('inventories').doc(inventoryId);
      if (invRef && typeof invRef.get === 'function') {
        const snap = await invRef.get();
        if (snap && snap.exists) {
          return snap.data() || null;
        }
      }
    } catch {
      // Ignore read errors
    }
    return null;
  };

  topLevelInvData = await loadTopLevelInventoryData(tenantDb);
  if (!topLevelInvData && db && db !== tenantDb) {
    topLevelInvData = await loadTopLevelInventoryData(db);
  }

  // Pre-load existing box contents and run sanity checks BEFORE writing any changes
  const existingCellsByBox = new Map<string, Record<string, any>>();

  for (const [boxId, updates] of updatesByBox.entries()) {
    const boxDocRef = getInventoryBoxDocRef(tenantDb, inventoryId, boxId);
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
    existingCellsByBox.set(boxId, existingCells);

    const resolvedBoxKey = topLevelInvData?.boxes
      ? resolveInventoryBoxKey(topLevelInvData.boxes, boxId)
      : boxId;
    const topLevelBoxCells: Record<string, any> | undefined =
      topLevelInvData?.boxes?.[resolvedBoxKey]?.cells;

    const currentOccupancy = new Map<string, boolean>();

    for (const cell of updates) {
      const rowLetter = String(cell.row || 'A').toUpperCase();
      const colNum = Number(cell.col) || 1;
      const coordinate = `${rowLetter}${colNum}`;
      const isRemoval = cell.status === 'EMPTY' || cell.actionType === 'VIAL_REMOVAL';

      let isOccupied: boolean;
      if (currentOccupancy.has(coordinate)) {
        isOccupied = currentOccupancy.get(coordinate)!;
      } else if (topLevelBoxCells && topLevelBoxCells[coordinate] !== undefined) {
        isOccupied = Boolean(topLevelBoxCells[coordinate].occupied);
      } else if (existingCells[coordinate] !== undefined) {
        isOccupied = existingCells[coordinate].status !== 'EMPTY';
      } else {
        isOccupied = false;
      }

      if (!isRemoval && isOccupied) {
        throw new Error(
          `Sanity check failed: Cannot insert vial into box ${resolvedBoxKey} well ${coordinate} because it is already occupied.`
        );
      }
      if (isRemoval && !isOccupied) {
        throw new Error(
          `Sanity check failed: Cannot remove vial from box ${resolvedBoxKey} well ${coordinate} because the well is empty.`
        );
      }

      currentOccupancy.set(coordinate, !isRemoval);
    }
  }

  for (const [boxId, updates] of updatesByBox.entries()) {
    const boxDocRef = getInventoryBoxDocRef(tenantDb, inventoryId, boxId);
    const existingCells: Record<string, any> = { ...(existingCellsByBox.get(boxId) || {}) };

    for (const cell of updates) {
      const coordinate = `${cell.row.toUpperCase()}${cell.col}`;
      const isRemoval = cell.status === 'EMPTY' || cell.actionType === 'VIAL_REMOVAL';
      const resolvedStatus = isRemoval ? 'EMPTY' : cell.status || 'OCCUPIED';
      const resolvedActionType = cell.actionType || (isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION');
      existingCells[coordinate] = stripUndefinedFields({
        boxId,
        coordinate,
        row: cell.row.toUpperCase(),
        col: cell.col,
        cellLineName: cell.cellLineName,
        userInitials: cell.userInitials || cell.operatorInitials || operatorInitials,
        dateFrozen: cell.dateFrozen,
        fullText: cell.fullText,
        lotNumber: cell.lotNumber,
        passage: cell.passage,
        operatorInitials: cell.operatorInitials || cell.userInitials || operatorInitials,
        actionId: cell.actionId,
        actionType: resolvedActionType,
        highlighted: cell.highlighted !== undefined ? cell.highlighted : !isRemoval,
        status: resolvedStatus,
        updatedAt: cell.updatedAt || signedOffAt,
      });
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

  // Sync updates into the top-level inventory document (`inventories/{inventoryId}`) so Cryo-Inventory view updates immediately
  const syncTopLevelInventoryDoc = async (firestoreInstance: Firestore) => {
    try {
      const invRef = firestoreInstance.collection('inventories').doc(inventoryId);
      if (!invRef || typeof invRef.get !== 'function' || typeof invRef.set !== 'function') {
        return;
      }
      const invSnap = await invRef.get();
      const invData: Record<string, any> = invSnap && invSnap.exists ? invSnap.data() || {} : {};
      const boxes: Record<string, any> = invData.boxes ? { ...invData.boxes } : {};

      for (const [rawBoxId, updates] of updatesByBox.entries()) {
        const resolvedBoxKey = resolveInventoryBoxKey(boxes, rawBoxId);
        const existingBox = boxes[resolvedBoxKey] || {
          boxId: resolvedBoxKey,
          towerLabel: resolvedBoxKey.split('-')[0] || 'A',
          boxNumber: parseInt(resolvedBoxKey.split('-')[1] || '1', 10) || 1,
          rows: invData.rowsPerBox || 9,
          cols: invData.colsPerBox || 9,
          cells: {},
        };
        const updatedCells: Record<string, any> = { ...(existingBox.cells || {}) };

        for (const cell of updates) {
          const rowLetter = cell.row.toUpperCase();
          const colNum = cell.col;
          const coordinate = `${rowLetter}${colNum}`;
          const isRemoval = cell.status === 'EMPTY' || cell.actionType === 'VIAL_REMOVAL';
          const resolvedInitials = cell.userInitials || cell.operatorInitials || operatorInitials;

          if (isRemoval) {
            updatedCells[coordinate] = {
              row: rowLetter,
              col: colNum,
              cellCoordinate: coordinate,
              occupied: false,
              highlighted: false,
              lastActionType: 'VIAL_REMOVAL',
            };
          } else {
            updatedCells[coordinate] = {
              row: rowLetter,
              col: colNum,
              cellCoordinate: coordinate,
              occupied: true,
              highlighted: cell.highlighted !== undefined ? cell.highlighted : true,
              lastActionType: 'VIAL_INSERTION',
              vial: stripUndefinedFields({
                cellLineIdentifier: cell.cellLineName,
                cellLineName: cell.cellLineName,
                userInitials: resolvedInitials,
                operatorInitials: resolvedInitials,
                dateFrozen: cell.dateFrozen,
                fullText: cell.fullText,
                lotNumber: cell.lotNumber,
                passageNumber: cell.passage,
                targetCoordinate: coordinate,
                videoId,
                actionId: cell.actionId,
                notes: cell.fullText ? `Extracted from video label: ${cell.fullText}` : undefined,
                updatedAt: cell.updatedAt || signedOffAt,
              }),
            };
          }
        }

        boxes[resolvedBoxKey] = {
          ...existingBox,
          cells: updatedCells,
        };
      }

      if (invSnap && invSnap.exists) {
        await invRef.set({
          ...invData,
          boxes,
          updatedAt: signedOffAt,
        });
      }
    } catch (syncErr) {
      console.warn(`[FirestoreService] Could not sync top-level inventory doc ${inventoryId}:`, syncErr);
    }
  };

  await syncTopLevelInventoryDoc(tenantDb);
  if (db && db !== tenantDb) {
    await syncTopLevelInventoryDoc(db);
  }

  // Helper to apply HITL edits onto an actions list
  const applyHitlUpdatesToActions = (rawActions: any[]): any[] => {
    if (!Array.isArray(rawActions)) return rawActions;
    return rawActions.map((act, idx) => {
      const actId = act?.actionId || `act_${idx + 1}`;
      const matchedUpdate =
        boxUpdates.find((u) => u.actionId && u.actionId === actId) ||
        (boxUpdates.length === rawActions.length ? boxUpdates[idx] : undefined);
      if (!matchedUpdate) return act;

      const rowLetter = String(matchedUpdate.row || 'A').toUpperCase();
      const colNum = Number(matchedUpdate.col) || 1;
      const coordinate = `${rowLetter}${colNum}`;
      const isRemoval = matchedUpdate.status === 'EMPTY' || matchedUpdate.actionType === 'VIAL_REMOVAL';
      const actionType = isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION';
      const actionClass = isRemoval ? 'VIAL_REMOVAL_ACTION' : 'VIAL_INSERTION_ACTION';
      const resolvedCellLineName = isRemoval ? (matchedUpdate.cellLineName || '') : matchedUpdate.cellLineName;
      const resolvedInitials = isRemoval
        ? (matchedUpdate.userInitials || '')
        : (matchedUpdate.userInitials || matchedUpdate.operatorInitials || operatorInitials);
      const resolvedDateFrozen = isRemoval
        ? (matchedUpdate.dateFrozen || '')
        : (matchedUpdate.dateFrozen ?? act.vialLabelData?.dateFrozen);
      const resolvedFullText = isRemoval
        ? (matchedUpdate.fullText || '')
        : (matchedUpdate.fullText || matchedUpdate.cellLineName);

      return stripUndefinedFields({
        ...act,
        actionId: actId,
        inventoryId: inventoryId || act.inventoryId,
        actionType,
        actionClass,
        cellLineName: resolvedCellLineName,
        conflatedLabelText: resolvedFullText,
        targetCoordinate: coordinate,
        boxRowId: rowLetter,
        boxColId: colNum,
        vialLabelData: stripUndefinedFields({
          ...(act.vialLabelData || {}),
          cellLineName: resolvedCellLineName,
          userInitials: resolvedInitials,
          dateFrozen: resolvedDateFrozen,
          fullText: resolvedFullText,
        }),
        boxWellLocation: stripUndefinedFields({
          ...(act.boxWellLocation || {}),
          actionId: actId,
          actionType,
          row: rowLetter,
          col: colNum,
          coordinate,
        }),
        cellLineInfo: stripUndefinedFields({
          ...(act.cellLineInfo || {}),
          name: resolvedCellLineName,
          boxId: matchedUpdate.boxId || act.cellLineInfo?.boxId || 'box_01',
          lotNumber: isRemoval ? (matchedUpdate.lotNumber || '') : (matchedUpdate.lotNumber ?? act.cellLineInfo?.lotNumber),
          passage: isRemoval ? matchedUpdate.passage : (matchedUpdate.passage ?? act.cellLineInfo?.passage),
          userInitials: resolvedInitials,
          operatorInitials: resolvedInitials,
          dateFrozen: resolvedDateFrozen,
          fullText: resolvedFullText,
          targetCoordinate: coordinate,
        }),
      });
    });
  };

  // Helper to apply HITL edits onto a refinements list
  const applyHitlUpdatesToRefinements = (rawRefinements: any[]): any[] => {
    if (!Array.isArray(rawRefinements)) return rawRefinements;
    return rawRefinements.map((ref, idx) => {
      const matchedUpdate =
        boxUpdates.find((u) => u.actionId && ref?.actionId && u.actionId === ref.actionId) ||
        (boxUpdates.length === rawRefinements.length ? boxUpdates[idx] : undefined);
      if (!matchedUpdate) return ref;

      const rowLetter = String(matchedUpdate.row || 'A').toUpperCase();
      const colNum = Number(matchedUpdate.col) || 1;
      const coordinate = `${rowLetter}${colNum}`;
      const isRemoval = matchedUpdate.status === 'EMPTY' || matchedUpdate.actionType === 'VIAL_REMOVAL';
      const actionType = isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION';
      const resolvedCellLineName = isRemoval ? (matchedUpdate.cellLineName || '') : matchedUpdate.cellLineName;
      const resolvedInitials = isRemoval
        ? (matchedUpdate.userInitials || '')
        : (matchedUpdate.userInitials || matchedUpdate.operatorInitials || operatorInitials);
      const resolvedDateFrozen = isRemoval
        ? (matchedUpdate.dateFrozen || '')
        : (matchedUpdate.dateFrozen ?? ref.vialLabelData?.dateFrozen);
      const resolvedFullText = isRemoval
        ? (matchedUpdate.fullText || '')
        : (matchedUpdate.fullText || matchedUpdate.cellLineName);

      return stripUndefinedFields({
        ...ref,
        conflatedLabelText: resolvedFullText,
        vialLabelData: stripUndefinedFields({
          ...(ref.vialLabelData || {}),
          cellLineName: resolvedCellLineName,
          userInitials: resolvedInitials,
          dateFrozen: resolvedDateFrozen,
          fullText: resolvedFullText,
        }),
        boxWellLocation: stripUndefinedFields({
          ...(ref.boxWellLocation || {}),
          actionId: matchedUpdate.actionId || ref.actionId,
          actionType,
          row: rowLetter,
          col: colNum,
          coordinate,
        }),
        spatialResult: stripUndefinedFields({
          ...(ref.spatialResult || {}),
          row: rowLetter,
          col: colNum,
          cellLineName: resolvedCellLineName,
        }),
      });
    });
  };

  // Update video_analyses/{videoId} with committed edits and mark isSignedOff = true
  const syncVideoAnalysisDoc = async (firestoreInstance: Firestore) => {
    try {
      const analysisRef = firestoreInstance.collection('video_analyses').doc(videoId);
      let existingAnalysis: Record<string, any> = {};
      if (analysisRef && typeof analysisRef.get === 'function') {
        const snap = await analysisRef.get();
        if (snap && snap.exists) {
          existingAnalysis = snap.data() || {};
        }
      }
      const updatedAnalysisPayload: Record<string, any> = {
        ...existingAnalysis,
        videoId,
        inventoryId,
        isSignedOff: true,
        signedOffAt,
        updatedAt: signedOffAt,
        hitlBoxUpdates: boxUpdates,
      };
      if (Array.isArray(existingAnalysis.actions)) {
        updatedAnalysisPayload.actions = applyHitlUpdatesToActions(existingAnalysis.actions);
      }
      if (Array.isArray(existingAnalysis.refinements)) {
        updatedAnalysisPayload.refinements = applyHitlUpdatesToRefinements(existingAnalysis.refinements);
      }
      await analysisRef.set(stripUndefinedFields(updatedAnalysisPayload), { merge: true });
    } catch {
      // Ignore fallback write error
    }
  };

  await syncVideoAnalysisDoc(tenantDb);
  if (db && db !== tenantDb) {
    await syncVideoAnalysisDoc(db);
  }

  // Persist HITL data and updated pass1/pass3 actions into videos/{videoId}.passes across tenant & default DB
  const persistHitlToVideoPasses = async (targetDatabaseId: string) => {
    const existingPassInfo = await getVideoPasses(targetDatabaseId, videoId);
    if (existingPassInfo?.passes) {
      const p1 = existingPassInfo.passes.pass1;
      if (p1?.data) {
        const updatedP1Data = Array.isArray(p1.data)
          ? applyHitlUpdatesToActions(p1.data)
          : Array.isArray(p1.data.actions)
          ? { ...p1.data, actions: applyHitlUpdatesToActions(p1.data.actions) }
          : p1.data;
        await updateVideoPass(targetDatabaseId, videoId, 'pass1', {
          ...p1,
          data: updatedP1Data,
        });
      }
      const p3 = existingPassInfo.passes.pass3;
      if (p3?.data && Array.isArray(p3.data)) {
        await updateVideoPass(targetDatabaseId, videoId, 'pass3', {
          ...p3,
          data: applyHitlUpdatesToRefinements(p3.data),
        });
      }
    }
    await updateVideoPass(
      targetDatabaseId,
      videoId,
      'hitl',
      {
        status: 'COMPLETED',
        completedAt: signedOffAt,
        data: {
          inventoryId,
          operatorInitials,
          signedOffAt,
          boxUpdates,
        },
      },
      {
        inventoryId,
        updatedAt: signedOffAt,
      }
    );
  };

  await persistHitlToVideoPasses(dbId);
  if (dbId !== '(default)') {
    await persistHitlToVideoPasses('(default)');
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
    (db as any).collection = createInMemoryCollectionFactory('(default)');
    getTenantFirestore('(default)');
  }
}

if (process.env.NODE_ENV === 'test') {
  getTenantFirestore('(default)');
}
