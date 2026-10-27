import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

export const firebaseConfig = {
  apiKey: "AIzaSyDfGrZ8nVf6L3xNw1_gx-RDSJCWJoAQoYQ",
  authDomain: "sail-platform-prod.firebaseapp.com",
  projectId: "sail-platform-prod",
  storageBucket: "sail-platform-prod.firebasestorage.app",
  messagingSenderId: "820436998318",
  appId: "1:820436998318:web:a64191af17494bc4e07537"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);