import { auth } from './firebase';

export * from './services/api.service';

/**
 * Helper to build request headers with the Firebase Auth ID token attached
 * in the `Authorization: Bearer <token>` header.
 */
export async function getAuthorizedHeaders(
  extraHeaders: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
}

/**
 * Fetch wrapper that automatically attaches `Authorization: Bearer <token>`
 * from `auth.currentUser?.getIdToken()`.
 */
export async function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  const existingHeaders =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Array.isArray(init.headers)
      ? Object.fromEntries(init.headers)
      : (init.headers as Record<string, string> | undefined) || {};

  return fetch(input, {
    ...init,
    headers: {
      ...existingHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
