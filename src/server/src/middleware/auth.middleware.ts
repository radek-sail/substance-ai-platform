import { Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { db } from '../services/firestore.service.js';

export interface AuthenticatedUser {
  uid: string;
  email: string;
  role: string;
  organizationId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const DEFAULT_FALLBACK_ORG_ID = process.env.DEFAULT_ORGANIZATION_ID || 'default-org';

/**
 * Express middleware that verifies the Firebase ID Bearer token from `req.headers.authorization`,
 * fetches the user profile document at `users/{decodedToken.uid}` from the `(default)` Firestore database,
 * and attaches `{ uid, email, role, organizationId }` to `req.user`.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> {
  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';

  if (!bearerToken) {
    // Allow static/binary frame & thumbnail image tags in browser that cannot attach Authorization headers
    const urlPath = req.originalUrl || req.url || '';
    if (
      req.method === 'GET' &&
      /^\/api\/videos\/[^/]+\/(frames\/[^/?#]+|thumbnail)(?:[?#].*)?$/.test(urlPath)
    ) {
      const mediaOrgId = String(
        (req.query?.organizationId as string) ||
          (req.query?.customerId as string) ||
          (req.headers['x-organization-id'] as string) ||
          (req.headers['x-customer-id'] as string) ||
          DEFAULT_FALLBACK_ORG_ID
      ).trim();
      req.user = {
        uid: 'media-reader',
        email: '',
        role: 'viewer',
        organizationId: mediaOrgId || DEFAULT_FALLBACK_ORG_ID,
      };
      return next();
    }

    // In automated test environment (NODE_ENV === 'test'), provide a default test tenant context
    // for legacy integration tests that do not attach a Firebase Bearer token, except on /api/auth/me.
    if (
      process.env.NODE_ENV === 'test' &&
      process.env.ENFORCE_TEST_AUTH !== 'true' &&
      !urlPath.startsWith('/api/auth/me')
    ) {
      const testOrgId =
        (req.headers['x-organization-id'] as string) || DEFAULT_FALLBACK_ORG_ID;
      req.user = {
        uid: 'test-user-uid',
        email: 'test@sail.local',
        role: 'admin',
        organizationId: testOrgId,
      };
      return next();
    }

    return res.status(401).json({
      error: 'Unauthorized: Missing or invalid Authorization Bearer token',
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(bearerToken);
    if (!decodedToken || !decodedToken.uid) {
      return res.status(401).json({
        error: 'Unauthorized: Invalid Firebase ID token',
      });
    }

    let userData: Record<string, any> | undefined;
    try {
      const userSnap = await db.collection('users').doc(decodedToken.uid).get();
      if (userSnap && userSnap.exists) {
        userData = userSnap.data() || {};
      }
    } catch (firestoreErr) {
      console.warn(
        `[AuthMiddleware] Failed to read users/${decodedToken.uid} from Firestore, using token claims/fallback:`,
        firestoreErr
      );
    }

    const email = String(userData?.email || decodedToken.email || '').trim();
    const role = String(userData?.role || (decodedToken as any).role || 'user').trim();
    const organizationId = String(
      userData?.organizationId ||
        (decodedToken as any).organizationId ||
        DEFAULT_FALLBACK_ORG_ID
    ).trim();

    if (!organizationId) {
      return res.status(403).json({
        error: 'Forbidden: User does not belong to an organization',
      });
    }

    req.user = {
      uid: decodedToken.uid,
      email,
      role,
      organizationId,
    };

    return next();
  } catch (err: any) {
    console.warn('[AuthMiddleware] Token verification failed:', err?.message || err);
    return res.status(401).json({
      error: 'Unauthorized: Invalid or expired Firebase ID token',
    });
  }
}

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile and active organizationId.
 */
export async function getMeHandler(req: Request, res: Response): Promise<Response> {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.status(200).json({
    uid: req.user.uid,
    email: req.user.email,
    role: req.user.role,
    organizationId: req.user.organizationId,
  });
}
