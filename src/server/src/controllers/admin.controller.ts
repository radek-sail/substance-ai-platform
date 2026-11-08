import { Request, Response } from 'express';
import * as firestoreService from '../services/firestore.service';
import { db } from '../services/firestore.service';

/**
 * Queries all documents in the `videos` collection on the `(default)` Firestore database
 * and backfills `organizationId`, `uploadedBy`, and `uploaderEmail` on any legacy document
 * missing `organizationId`.
 */
export async function backfillLegacyVideos(
  defaultOrgId: string = 'substance-ai'
): Promise<number> {
  const snapshot = await db.collection('videos').get();
  let updatedCount = 0;

  for (const doc of snapshot.docs) {
    const docData: Record<string, any> =
      (typeof doc.data === 'function' ? doc.data() : (doc as any)) || {};
    if (!docData.organizationId) {
      const updatePayload = {
        organizationId: defaultOrgId,
        uploadedBy: docData.uploadedBy || 'legacy-system',
        uploaderEmail: docData.uploaderEmail || 'admin@substance-ai.com',
      };

      if (doc.ref && typeof doc.ref.update === 'function') {
        await doc.ref.update(updatePayload);
      } else {
        await db.collection('videos').doc(doc.id).update(updatePayload);
      }

      firestoreService.mirrorVideoToMemory('(default)', doc.id, updatePayload);
      updatedCount++;
    }
  }

  // Also backfill legacy inventories missing organizationId (or tagged with fallback default-org)
  try {
    const invSnapshot = await db.collection('inventories').get();
    for (const doc of invSnapshot.docs) {
      const invData: Record<string, any> =
        (typeof doc.data === 'function' ? doc.data() : (doc as any)) || {};
      if (!invData.organizationId || invData.organizationId === 'default-org') {
        const invUpdate = { organizationId: defaultOrgId };
        if (doc.ref && typeof doc.ref.update === 'function') {
          await doc.ref.update(invUpdate);
        } else {
          await db.collection('inventories').doc(doc.id).set({ ...invData, ...invUpdate }, { merge: true });
        }
      }
    }
  } catch (invErr) {
    console.warn('[Migration] Could not backfill legacy inventories:', invErr);
  }

  // Also backfill legacy experiment archives missing organizationId (or tagged with fallback default-org)
  try {
    const archSnapshot = await db.collection('archives').get();
    for (const doc of archSnapshot.docs) {
      const archData: Record<string, any> =
        (typeof doc.data === 'function' ? doc.data() : (doc as any)) || {};
      if (!archData.organizationId || archData.organizationId === 'default-org') {
        const archUpdate = { organizationId: defaultOrgId };
        if (doc.ref && typeof doc.ref.update === 'function') {
          await doc.ref.update(archUpdate);
        } else {
          await db.collection('archives').doc(doc.id).set({ ...archData, ...archUpdate }, { merge: true });
        }
      }
    }
  } catch (archErr) {
    console.warn('[Migration] Could not backfill legacy archives:', archErr);
  }

  console.log(`[Migration] Backfilled ${updatedCount} videos with organizationId: ${defaultOrgId}`);
  return updatedCount;
}

/**
 * Controller for POST /api/admin/backfill-videos
 * Allows users with `role === 'super_admin'` (or `'admin'`) or authenticated users of `'substance-ai'`
 * to trigger `backfillLegacyVideos('substance-ai')`.
 */
export async function backfillVideosHandler(
  req: Request,
  res: Response
): Promise<Response | void> {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isAllowed =
    req.user.role === 'super_admin' ||
    req.user.role === 'admin' ||
    req.user.organizationId === 'substance-ai';

  if (!isAllowed) {
    return res.status(403).json({
      error: 'Forbidden: Requires super_admin role or substance-ai organization membership',
    });
  }

  try {
    const updatedCount = await backfillLegacyVideos('substance-ai');
    return res.status(200).json({
      success: true,
      updatedCount,
      count: updatedCount,
      organizationId: 'substance-ai',
      message: `[Migration] Backfilled ${updatedCount} videos with organizationId: substance-ai`,
    });
  } catch (err: any) {
    console.error('[Migration] Error backfilling legacy videos:', err);
    return res.status(500).json({
      error: err?.message || 'Failed to backfill legacy videos',
    });
  }
}
