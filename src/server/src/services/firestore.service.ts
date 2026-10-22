import * as admin from 'firebase-admin';
import { getFirestore, Firestore, DocumentData, WriteResult } from 'firebase-admin/firestore';
import type { VideoMetadata } from '@sail/shared';

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT || 'substance-ai-platform',
  });
}

// In-memory cache for Firestore database instances scoped to each tenant database
const databaseCache = new Map<string, Firestore>();

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
 * Clears the internal database instance cache (primarily used for testing).
 */
export function clearDatabaseCache(): void {
  databaseCache.clear();
}

