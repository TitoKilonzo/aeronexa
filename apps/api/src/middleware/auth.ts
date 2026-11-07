import type { Request, Response, NextFunction } from 'express';
import { adminAuth, db } from '../config/firebase.js';
import { HttpError } from '../shared/http.js';

export interface AuthUser {
  uid: string;
  email?: string;
  name?: string;
  platformRole?: string;
}

declare global {
  namespace Express {
    interface Request { authUser?: AuthUser; organizationId?: string; organizationRole?: string; }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!adminAuth) throw new HttpError(503, 'Authentication service is not configured on the API.');
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'A valid bearer token is required.');
    const decoded = await adminAuth.verifyIdToken(header.slice(7), true);
    req.authUser = { uid: decoded.uid, email: decoded.email, name: decoded.name, platformRole: typeof decoded.platformRole === 'string' ? decoded.platformRole : undefined };
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, 'Your session is invalid or expired.'));
  }
}

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  const configuredAdmins = (process.env.PLATFORM_ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const uid = req.authUser?.uid;
  if (!uid || (req.authUser.platformRole !== 'platform_admin' && !configuredAdmins.includes(uid))) {
    return next(new HttpError(403, 'Platform administrator access is required.'));
  }
  next();
}

export function requireOrganizationRole(roles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const orgId = String(req.params.orgId ?? req.body?.organizationId ?? req.query.organizationId ?? '');
      if (!orgId || !req.authUser || !db) throw new HttpError(400, 'An organization ID is required.');
      const member = await db.collection('organizations').doc(orgId).collection('members').doc(req.authUser.uid).get();
      const data = member.data();
      if (!member.exists || data?.status !== 'active' || !roles.includes(String(data.role))) throw new HttpError(403, 'You do not have permission to perform this action.');
      req.organizationId = orgId;
      req.organizationRole = String(data.role);
      next();
    } catch (error) { next(error); }
  };
}
