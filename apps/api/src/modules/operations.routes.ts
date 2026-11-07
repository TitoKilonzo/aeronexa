import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { getDb, assertString } from '../shared/firestore.js';
import { HttpError } from '../shared/http.js';
import { bucket } from '../config/firebase.js';

const router = Router();
router.use(requireAuth);

router.get('/dashboard/summary', async (req, res, next) => {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const [upcomingTrips, activeBookings, passengers, tickets, notifications] = await Promise.all([
      db.collection('bookings').where('customerId', '==', req.authUser!.uid).where('status', 'in', ['ticketed', 'confirmed']).where('departureTime', '>=', now).count().get(),
      db.collection('bookings').where('customerId', '==', req.authUser!.uid).where('status', 'in', ['held', 'pending', 'confirmed']).count().get(),
      db.collection('passengers').where('ownerUid', '==', req.authUser!.uid).count().get(),
      db.collection('tickets').where('customerId', '==', req.authUser!.uid).count().get(),
      db.collection('notifications').where('userId', '==', req.authUser!.uid).where('readAt', '==', null).count().get(),
    ]);
    res.json({ summary: {
      upcomingTrips: upcomingTrips.data().count,
      activeBookings: activeBookings.data().count,
      savedPassengers: passengers.data().count,
      unreadNotifications: notifications.data().count,
      ticketCount: tickets.data().count,
    } });
  } catch (error) { next(error); }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('notifications').where('userId', '==', req.authUser!.uid).orderBy('createdAt', 'desc').limit(50).get();
    res.json({ notifications: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.post('/notifications/:notificationId/read', async (req, res, next) => {
  try {
    const ref = getDb().collection('notifications').doc(req.params.notificationId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.userId !== req.authUser!.uid) throw new HttpError(404, 'Notification not found.');
    await ref.update({ readAt: FieldValue.serverTimestamp() });
    res.json({ status: 'read' });
  } catch (error) { next(error); }
});

router.patch('/profile', async (req, res, next) => {
  try {
    const displayName = assertString(req.body.displayName, 'Display name', 100);
    const phoneNumber = typeof req.body.phoneNumber === 'string' ? req.body.phoneNumber.slice(0, 24) : null;
    await getDb().collection('users').doc(req.authUser!.uid).set({ displayName, phoneNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (req.authUser!.email) await (await import('../config/firebase.js')).adminAuth?.updateUser(req.authUser!.uid, { displayName });
    res.json({ profile: { displayName, phoneNumber } });
  } catch (error) { next(error); }
});

router.get('/travel-documents', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('travel_documents').where('ownerUid', '==', req.authUser!.uid).orderBy('createdAt', 'desc').limit(50).get();
    res.json({ documents: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.post('/travel-documents/upload-url', async (req, res, next) => {
  try {
    if (!bucket) throw new HttpError(503, 'Firebase Storage bucket is not configured.');
    const fileName = assertString(req.body.fileName, 'File name', 120).replace(/[^a-zA-Z0-9._-]/g, '_');
    const contentType = assertString(req.body.contentType, 'Content type', 80);
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowed.includes(contentType)) throw new HttpError(400, 'Only PDF, JPG and PNG documents are accepted.');
    const id = randomUUID();
    const path = `travel-documents/${req.authUser!.uid}/${id}-${fileName}`;
    const file = bucket.file(path);
    const [uploadUrl] = await file.getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 5 * 60 * 1000, contentType });
    const ref = getDb().collection('travel_documents').doc(id);
    await ref.create({ ownerUid: req.authUser!.uid, fileName, contentType, storagePath: path, status: 'upload_pending', createdAt: FieldValue.serverTimestamp() });
    res.status(201).json({ document: { id, fileName, contentType }, uploadUrl, method: 'PUT', requiredHeaders: { 'Content-Type': contentType } });
  } catch (error) { next(error); }
});

router.post('/travel-documents/:documentId/complete', async (req, res, next) => {
  try {
    const db = getDb();
    const ref = db.collection('travel_documents').doc(req.params.documentId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== req.authUser!.uid) throw new HttpError(404, 'Document not found.');
    const path = String(snapshot.data()?.storagePath);
    const file = bucket!.file(path);
    const [exists] = await file.exists();
    if (!exists) throw new HttpError(400, 'The uploaded file could not be found.');
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size ?? 0) > 10 * 1024 * 1024) { await file.delete({ ignoreNotFound: true }); throw new HttpError(413, 'Travel documents must be 10 MB or smaller.'); }
    if (metadata.contentType !== snapshot.data()?.contentType) { await file.delete({ ignoreNotFound: true }); throw new HttpError(415, 'The uploaded document type does not match the selected file type.'); }
    await ref.update({ status: 'uploaded', updatedAt: FieldValue.serverTimestamp() });
    res.json({ status: 'uploaded' });
  } catch (error) { next(error); }
});

router.get('/travel-documents/:documentId/download-url', async (req, res, next) => {
  try {
    if (!bucket) throw new HttpError(503, 'Firebase Storage bucket is not configured.');
    const ref = getDb().collection('travel_documents').doc(req.params.documentId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== req.authUser!.uid || snapshot.data()?.status !== 'uploaded') throw new HttpError(404, 'Document not found.');
    const [downloadUrl] = await bucket.file(String(snapshot.data()?.storagePath)).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 5 * 60 * 1000 });
    res.json({ downloadUrl });
  } catch (error) { next(error); }
});

router.delete('/travel-documents/:documentId', async (req, res, next) => {
  try {
    const db = getDb();
    const ref = db.collection('travel_documents').doc(req.params.documentId);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data()?.ownerUid !== req.authUser!.uid) throw new HttpError(404, 'Document not found.');
    if (bucket && snapshot.data()?.storagePath) await bucket.file(String(snapshot.data()?.storagePath)).delete({ ignoreNotFound: true });
    await ref.delete();
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get('/organizations/:orgId/operations/overview', async (req, res, next) => {
  try {
    const db = getDb();
    const orgId = req.params.orgId;
    const member = await db.collection('organizations').doc(orgId).collection('members').doc(req.authUser!.uid).get();
    if (!member.exists || member.data()?.status !== 'active' || !['organization_admin', 'operations_manager', 'finance_officer', 'booking_officer'].includes(String(member.data()?.role))) throw new HttpError(403, 'Organization operations access is required.');
    const [flights, bookings] = await Promise.all([
      db.collection('flights').where('organizationId', '==', orgId).get(),
      db.collection('bookings').where('organizationId', '==', orgId).get(),
    ]);
    const revenue = bookings.docs.filter((doc) => ['ticketed', 'confirmed'].includes(String(doc.data().status))).reduce((sum, doc) => sum + Number(doc.data().totalAmountMinor ?? 0), 0);
    res.json({ overview: { flights: flights.size, bookings: bookings.size, ticketed: bookings.docs.filter((doc) => doc.data().status === 'ticketed').length, revenueMinor: revenue, currency: bookings.docs[0]?.data().currency ?? 'KES' } });
  } catch (error) { next(error); }
});

export default router;
