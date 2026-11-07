import 'dotenv/config';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const projectId = process.env.FIREBASE_PROJECT_ID;
let initialized = false;
try {
  if (projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_CONFIG) {
    if (!getApps().length) {
      initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
    }
    initialized = true;
  }
} catch (error) {
  console.error('Firebase Admin initialization failed:', error instanceof Error ? error.message : error);
}

export const firebaseAdminReady = initialized;
export const adminAuth = initialized ? getAuth() : null;
export const db = initialized ? getFirestore() : null;
export const bucket = initialized && process.env.FIREBASE_STORAGE_BUCKET ? getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET) : null;
