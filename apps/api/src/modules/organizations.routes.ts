import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth, requireOrganizationRole, requirePlatformAdmin } from '../middleware/auth.js';
import { getDb, assertString } from '../shared/firestore.js';
import { HttpError } from '../shared/http.js';

const router = Router();
const organizationRoles = ['organization_admin', 'operations_manager', 'booking_officer', 'finance_officer', 'checkin_officer', 'travel_agent'];

router.post('/platform/organizations/:orgId/approve', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    await getDb().collection('organizations').doc(req.params.orgId).update({ status, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: req.authUser!.uid });
    res.json({ status });
  } catch (error) { next(error); }
});

router.get('/platform/organizations/pending', requireAuth, requirePlatformAdmin, async (_req, res, next) => {
  try {
    const snapshot = await getDb().collection('organizations').where('status', '==', 'pending').limit(100).get();
    res.json({ organizations: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.get('/organizations/mine', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const user = await db.collection('users').doc(req.authUser!.uid).get();
    const ids = (user.data()?.organizationIds ?? []) as string[];
    const organizations = await Promise.all(ids.slice(0, 30).map(async (id) => {
      const [org, member] = await Promise.all([db.collection('organizations').doc(id).get(), db.collection('organizations').doc(id).collection('members').doc(req.authUser!.uid).get()]);
      return org.exists && member.exists ? { id: org.id, ...org.data(), role: member.data()?.role } : null;
    }));
    res.json({ organizations: organizations.filter(Boolean) });
  } catch (error) { next(error); }
});

router.post('/organizations', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const name = assertString(req.body.name, 'Organization name');
    const country = assertString(req.body.country ?? 'Kenya', 'Country', 80);
    const type = req.body.type === 'airline' ? 'airline' : req.body.type === 'travel_agency' ? 'travel_agency' : null;
    if (!type) throw new HttpError(400, 'Organization type must be airline or travel_agency.');
    const id = randomUUID();
    const orgRef = db.collection('organizations').doc(id);
    const memberRef = orgRef.collection('members').doc(req.authUser!.uid);
    await db.runTransaction(async (tx) => {
      tx.create(orgRef, { name, country, type, currency: req.body.currency === 'USD' ? 'USD' : 'KES', status: 'pending', createdAt: FieldValue.serverTimestamp(), ownerUid: req.authUser!.uid });
      tx.create(memberRef, { uid: req.authUser!.uid, email: req.authUser!.email ?? null, role: 'organization_admin', status: 'active', joinedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection('users').doc(req.authUser!.uid), { organizationIds: FieldValue.arrayUnion(id), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    res.status(201).json({ organization: { id, name, country, type, currency: req.body.currency === 'USD' ? 'USD' : 'KES', status: 'pending', role: 'organization_admin' } });
  } catch (error) { next(error); }
});

router.get('/organizations/:orgId/members', requireAuth, requireOrganizationRole(['organization_admin', 'operations_manager']), async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('organizations').doc(req.params.orgId).collection('members').limit(200).get();
    res.json({ members: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.patch('/organizations/:orgId/members/:uid', requireAuth, requireOrganizationRole(['organization_admin']), async (req, res, next) => {
  try {
    const role = assertString(req.body.role, 'Role', 40);
    if (!organizationRoles.includes(role) || role === 'organization_admin') throw new HttpError(400, 'Select a valid non-owner organization role.');
    if (req.params.uid === req.authUser!.uid) throw new HttpError(400, 'The organization owner cannot change their own role.');
    const memberRef = getDb().collection('organizations').doc(req.params.orgId).collection('members').doc(req.params.uid);
    const member = await memberRef.get();
    if (!member.exists) throw new HttpError(404, 'Organization member not found.');
    await memberRef.update({ role, updatedAt: FieldValue.serverTimestamp() });
    res.json({ uid: req.params.uid, role });
  } catch (error) { next(error); }
});

router.post('/organizations/:orgId/invitations', requireAuth, requireOrganizationRole(['organization_admin']), async (req, res, next) => {
  try {
    const email = assertString(req.body.email, 'Email', 254).toLowerCase();
    const role = assertString(req.body.role, 'Role', 40);
    if (!organizationRoles.includes(role) || role === 'organization_admin') throw new HttpError(400, 'Select a valid non-owner organization role.');
    const db = getDb();
    const inviteRef = db.collection('organization_invitations').doc(randomUUID());
    await inviteRef.set({ organizationId: req.params.orgId, email, role, status: 'pending', invitedBy: req.authUser!.uid, createdAt: FieldValue.serverTimestamp(), expiresAt: new Date(Date.now() + 7 * 86400000) });
    res.status(201).json({ invitation: { id: inviteRef.id, email, role, status: 'pending' } });
  } catch (error) { next(error); }
});

router.post('/organizations/invitations/:inviteId/accept', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const inviteRef = db.collection('organization_invitations').doc(req.params.inviteId);
    await db.runTransaction(async (tx) => {
      const invite = await tx.get(inviteRef);
      const data = invite.data();
      if (invite.exists && data?.status === 'accepted' && data.acceptedBy === req.authUser!.uid) return;
      if (!invite.exists || data?.status !== 'pending' || !req.authUser!.email || data.email !== req.authUser!.email.toLowerCase() || !data.expiresAt?.toDate || data.expiresAt.toDate().getTime() < Date.now()) throw new HttpError(404, 'This invitation is invalid, expired or belongs to another email address.');
      const memberRef = db.collection('organizations').doc(data.organizationId).collection('members').doc(req.authUser!.uid);
      tx.set(memberRef, { uid: req.authUser!.uid, email: req.authUser!.email, role: data.role, status: 'active', joinedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection('users').doc(req.authUser!.uid), { organizationIds: FieldValue.arrayUnion(data.organizationId), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.update(inviteRef, { status: 'accepted', acceptedBy: req.authUser!.uid, acceptedAt: FieldValue.serverTimestamp() });
    });
    res.json({ status: 'accepted' });
  } catch (error) { next(error); }
});

export default router;
