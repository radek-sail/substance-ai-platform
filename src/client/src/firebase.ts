import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const env = (import.meta as any).env || {};

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSy_MOCK_TEST_KEY_NOT_REAL',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'sail-platform-prod.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'sail-platform-prod',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'sail-platform-prod.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '820436998318',
  appId: env.VITE_FIREBASE_APP_ID || '1:820436998318:web:a64191af17494bc4e07537'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
