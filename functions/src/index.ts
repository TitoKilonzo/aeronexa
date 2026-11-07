import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';

if (!getApps().length) initializeApp();
const db = getFirestore();

export const onNotificationCreated = onDocumentCreated('notifications/{notificationId}', (event) => {
  logger.info('AeroNexa notification queued', { notificationId: event.params.notificationId });
});

export const expireBookingHolds = onSchedule('every 1 minutes', async () => {
  const now = Timestamp.now();
  const expired = await db.collection('bookings').where('status', '==', 'held').where('holdExpiresAt', '<=', now).limit(200).get();
  let released = 0;
  for (const bookingDoc of expired.docs) {
    const wasReleased = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingDoc.ref);
      if (!bookingSnap.exists || bookingSnap.data()?.status !== 'held') return false;
      const booking = bookingSnap.data()!;
      const inventoryRef = db.collection('flight_inventory').doc(String(booking.flightId));
      const inventory = await tx.get(inventoryRef);
      if (inventory.exists) {
        const capacity = Number(inventory.data()?.seatCapacity ?? Number.MAX_SAFE_INTEGER);
        const available = Number(inventory.data()?.availableSeats ?? 0);
        tx.update(inventoryRef, { availableSeats: Math.min(capacity, available + Number(booking.seatCount ?? 0)), updatedAt: FieldValue.serverTimestamp() });
      }
      tx.update(bookingDoc.ref, { status: 'expired', expiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection('notifications').doc(), {
        userId: booking.customerId, type: 'booking_expired', title: 'Your seat hold expired',
        body: `The seat hold for ${booking.bookingReference} expired before payment was completed.`,
        bookingId: bookingDoc.id, createdAt: FieldValue.serverTimestamp(), readAt: null,
      });
      return true;
    });
    if (wasReleased) released += 1;
  }
  logger.info('AeroNexa expired booking holds released', { released });
});
