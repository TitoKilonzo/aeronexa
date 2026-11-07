import { Router } from 'express';
import { firebaseAdminReady } from '../../config/firebase.js';
const router = Router();
router.get('/', (_req, res) => res.json({ status: 'ok', service: 'AeroNexa API', timestamp: new Date().toISOString(), firebase: firebaseAdminReady ? 'configured' : 'not_configured' }));
export default router;
