import { randomBytes } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';

export function createBookingReference() {
  return `ANX-${new Date().getUTCFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function confirmBookingAfterPayment(db: Firestore, bookingId: string, paymentId: string, providerReference: string) {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const paymentRef = db.collection('payments').doc(paymentId);
  await db.runTransaction(async (tx) => {
    const [bookingSnap, paymentSnap] = await Promise.all([tx.get(bookingRef), tx.get(paymentRef)]);
    if (!bookingSnap.exists || !paymentSnap.exists) throw new Error('Booking or payment record was not found.');
    const booking = bookingSnap.data()!;
    const payment = paymentSnap.data()!;
    if (payment.status === 'succeeded' && booking.status === 'ticketed') return;
    if (payment.bookingId !== bookingId) throw new Error('Payment does not belong to this booking.');
    if (Number(payment.amountMinor) !== Number(booking.totalAmountMinor) || payment.currency !== booking.currency) throw new Error('Payment amount does not match the booking.');
    if (booking.status === 'cancelled' || booking.status === 'expired') throw new Error('Booking is no longer payable.');
    if (booking.holdExpiresAt?.toDate && booking.holdExpiresAt.toDate().getTime() <= Date.now()) throw new Error('The booking hold expired before payment confirmation. Payment requires manual reconciliation.');
    tx.update(paymentRef, { status: 'succeeded', providerReference, verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.update(bookingRef, { status: 'ticketed', paymentStatus: 'succeeded', paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const tickets = booking.passengers as Array<{ givenName: string; familyName: string }>;
    for (let index = 0; index < tickets.length; index += 1) {
      const ticketRef = db.collection('tickets').doc(`${bookingId}-${index + 1}`);
      tx.set(ticketRef, {
        bookingId, bookingReference: booking.bookingReference, customerId: booking.customerId, passengerIndex: index,
        passengerName: `${tickets[index].givenName} ${tickets[index].familyName}`,
        ticketNumber: `${booking.bookingReference}-${String(index + 1).padStart(2, '0')}`,
        status: 'issued', issuedAt: FieldValue.serverTimestamp(), checkInStatus: 'not_checked_in',
      }, { merge: true });
    }
    tx.set(db.collection('notifications').doc(), {
      userId: booking.customerId, type: 'booking_ticketed', title: 'Your ticket is ready',
      body: `Booking ${booking.bookingReference} has been paid and ticketed.`,
      bookingId, createdAt: FieldValue.serverTimestamp(), readAt: null,
    });
  });
}

export async function releaseExpiredHolds(db: Firestore, now = Timestamp.now()) {
  const expired = await db.collection('bookings').where('status', '==', 'held').where('holdExpiresAt', '<=', now).limit(200).get();
  let released = 0;
  for (const bookingDoc of expired.docs) {
    const releasedOne = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(bookingDoc.ref);
      if (!fresh.exists || fresh.data()?.status !== 'held') return false;
      const booking = fresh.data()!;
      const inventoryRef = db.collection('flight_inventory').doc(String(booking.flightId));
      const inventory = await tx.get(inventoryRef);
      if (inventory.exists) tx.update(inventoryRef, { availableSeats: Number(inventory.data()?.availableSeats ?? 0) + Number(booking.seatCount ?? 0), updatedAt: FieldValue.serverTimestamp() });
      tx.update(bookingDoc.ref, { status: 'expired', expiredAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (releasedOne) released += 1;
  }
  return released;
}
