"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expireBookingHolds = exports.onNotificationCreated = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firebase_functions_1 = require("firebase-functions");
const firestore_2 = require("firebase-admin/firestore");
const app_1 = require("firebase-admin/app");
if (!(0, app_1.getApps)().length)
    (0, app_1.initializeApp)();
const db = (0, firestore_2.getFirestore)();
exports.onNotificationCreated = (0, firestore_1.onDocumentCreated)('notifications/{notificationId}', (event) => {
    firebase_functions_1.logger.info('AeroNexa notification queued', { notificationId: event.params.notificationId });
});
exports.expireBookingHolds = (0, scheduler_1.onSchedule)('every 1 minutes', async () => {
    const now = firestore_2.Timestamp.now();
    const expired = await db.collection('bookings').where('status', '==', 'held').where('holdExpiresAt', '<=', now).limit(200).get();
    let released = 0;
    for (const bookingDoc of expired.docs) {
        const wasReleased = await db.runTransaction(async (tx) => {
            const bookingSnap = await tx.get(bookingDoc.ref);
            if (!bookingSnap.exists || bookingSnap.data()?.status !== 'held')
                return false;
            const booking = bookingSnap.data();
            const inventoryRef = db.collection('flight_inventory').doc(String(booking.flightId));
            const inventory = await tx.get(inventoryRef);
            if (inventory.exists) {
                const capacity = Number(inventory.data()?.seatCapacity ?? Number.MAX_SAFE_INTEGER);
                const available = Number(inventory.data()?.availableSeats ?? 0);
                tx.update(inventoryRef, { availableSeats: Math.min(capacity, available + Number(booking.seatCount ?? 0)), updatedAt: firestore_2.FieldValue.serverTimestamp() });
            }
            tx.update(bookingDoc.ref, { status: 'expired', expiredAt: firestore_2.FieldValue.serverTimestamp(), updatedAt: firestore_2.FieldValue.serverTimestamp() });
            tx.set(db.collection('notifications').doc(), {
                userId: booking.customerId, type: 'booking_expired', title: 'Your seat hold expired',
                body: `The seat hold for ${booking.bookingReference} expired before payment was completed.`,
                bookingId: bookingDoc.id, createdAt: firestore_2.FieldValue.serverTimestamp(), readAt: null,
            });
            return true;
        });
        if (wasReleased)
            released += 1;
    }
    firebase_functions_1.logger.info('AeroNexa expired booking holds released', { released });
});
