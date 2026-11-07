import { auth } from './firebase';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api/v1';

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await auth?.currentUser?.getIdToken();
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
  return payload as T;
}
