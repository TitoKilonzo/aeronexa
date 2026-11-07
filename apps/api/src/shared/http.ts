import type { Request, Response, NextFunction } from 'express';
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = 'HttpError'; }
}
export function notFound(_req: Request, res: Response) { res.status(404).json({ error: 'NOT_FOUND', message: 'The requested API route was not found.' }); }
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR', message: status === 500 ? 'An unexpected server error occurred.' : message });
}
