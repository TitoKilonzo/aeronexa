import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../config/firebase.js';

const router = Router();
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const snapshot = db ? await db.collection('users').doc(req.authUser!.uid).get() : null;
    const profile = snapshot?.exists ? snapshot.data() : null;
    res.json({ user: {
      uid: req.authUser!.uid, email: req.authUser!.email ?? null,
      displayName: profile?.displayName ?? req.authUser!.name ?? null,
      phoneNumber: profile?.phoneNumber ?? null, organizationIds: profile?.organizationIds ?? [],
      status: profile?.status ?? 'active',
    } });
  } catch (error) { next(error); }
});
export default router;
