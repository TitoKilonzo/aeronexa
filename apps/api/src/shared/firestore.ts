import { db } from '../config/firebase.js';
import { HttpError } from './http.js';

export function getDb() {
  if (!db) throw new HttpError(503, 'Database service is not configured. Complete the Firebase Admin setup first.');
  return db;
}

export function assertString(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `${label} is required and must be shorter than ${max} characters.`);
  return value.trim();
}

export function asIso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function') return value.toDate().toISOString();
  return null;
}
