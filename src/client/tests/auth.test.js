import { describe, it } from 'node:test';
import assert from 'node:assert';
import { auth, firebaseConfig } from '../src/firebase.ts';
import { ApiService, DEFAULT_TENANT_CONFIG } from '../src/services/api.service.ts';
import { getAuthorizedHeaders } from '../src/api.service.ts';
import { Login } from '../src/components/Login.tsx';
import { App } from '../src/App.tsx';

describe('Firebase Authentication & API Token Injection', () => {
  it('should initialize Firebase with project sail-platform-prod and export auth', () => {
    assert.strictEqual(firebaseConfig.apiKey, 'AIzaSy_MOCK_TEST_KEY_NOT_REAL');
    assert.strictEqual(firebaseConfig.authDomain, 'sail-platform-prod.firebaseapp.com');
    assert.strictEqual(firebaseConfig.projectId, 'sail-platform-prod');
    assert.strictEqual(firebaseConfig.storageBucket, 'sail-platform-prod.firebasestorage.app');
    assert.strictEqual(firebaseConfig.messagingSenderId, '820436998318');
    assert.strictEqual(firebaseConfig.appId, '1:820436998318:web:a64191af17494bc4e07537');
    assert.ok(auth);
    assert.strictEqual(auth.app.options.projectId, 'sail-platform-prod');
  });

  it('should export Login and gated App components', () => {
    assert.strictEqual(typeof Login, 'function');
    assert.strictEqual(typeof App, 'function');
  });

  it('should inject Authorization: Bearer <token> header when auth.currentUser is present', async () => {
    const api = new ApiService({ tenant: DEFAULT_TENANT_CONFIG });
    const originalDescriptor = Object.getOwnPropertyDescriptor(auth, 'currentUser');

    try {
      Object.defineProperty(auth, 'currentUser', {
        configurable: true,
        get: () => ({
          email: 'operator@substance-ai.lab',
          getIdToken: async () => 'mock-firebase-jwt-token-123',
        }),
      });

      const headers = await api.getHeaders();
      assert.strictEqual(headers['Authorization'], 'Bearer mock-firebase-jwt-token-123');
      assert.strictEqual(headers['x-customer-id'], DEFAULT_TENANT_CONFIG.customerId);
      assert.strictEqual(headers['x-database-id'], DEFAULT_TENANT_CONFIG.databaseId);

      const helperHeaders = await getAuthorizedHeaders({ 'x-test': '1' });
      assert.strictEqual(helperHeaders['Authorization'], 'Bearer mock-firebase-jwt-token-123');
      assert.strictEqual(helperHeaders['x-test'], '1');
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(auth, 'currentUser', originalDescriptor);
      } else {
        delete auth.currentUser;
      }
    }
  });
});
