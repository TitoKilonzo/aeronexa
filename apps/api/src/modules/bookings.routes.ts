import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireAuth } from '../middleware/auth.js';
import { getDb, assertString } from '../shared/firestore.js';
import { HttpError } from '../shared/http.js';
import { createBookingReference } from '../services/booking-lifecycle.js';

const router = Router();
router.use(requireAuth);

const passengerSchema = (value: unknown) => {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Passenger details are required.');
  const p = value as Record<string, unknown>;
  const givenName = assertString(p.givenName, 'Passenger first name', 80);
  const familyName = assertString(p.familyName, 'Passenger last name', 80);
  const dateOfBirth = assertString(p.dateOfBirth, 'Passenger date of birth', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || new Date(dateOfBirth) >= new Date()) throw new HttpError(400, 'Enter a valid passenger date of birth.');
  return { givenName, familyName, dateOfBirth, email: typeof p.email === 'string' ? p.email.slice(0, 254).toLowerCase() : undefined, phoneNumber: typeof p.phoneNumber === 'string' ? p.phoneNumber.slice(0, 24) : undefined };
};

router.post('/bookings', async (req, res, next) => {
  try {
    const db = getDb();
    const flightId = assertString(req.body.flightId, 'Flight ID', 100);
    if (!Array.isArray(req.body.passengers) || req.body.passengers.length < 1 || req.body.passengers.length > 9) throw new HttpError(400, 'A booking must include between 1 and 9 passengers.');
    const passengers = req.body.passengers.map(passengerSchema);
    const flightRef = db.collection('flights').doc(flightId);
    const inventoryRef = db.collection('flight_inventory').doc(flightId);
    const bookingId = randomUUID();
    const bookingRef = db.collection('bookings').doc(bookingId);
    const now = new Date();
    const expiresAt = Timestamp.fromDate(new Date(now.getTime() + 15 * 60 * 1000));
    const result = await db.runTransaction(async (tx) => {
      const [flightSnap, inventorySnap] = await Promise.all([tx.get(flightRef), tx.get(inventoryRef)]);
      if (!flightSnap.exists || !inventorySnap.exists) throw new HttpError(404, 'The selected flight is no longer available.');
      const flight = flightSnap.data()!;
      const organizationRef = db.collection('organizations').doc(String(flight.organizationId ?? ''));
      const organizationSnap = await tx.get(organizationRef);
      if (!organizationSnap.exists || organizationSnap.data()?.status !== 'active') throw new HttpError(409, 'This airline is not currently accepting bookings.');
      const inventory = inventorySnap.data()!;
      if (flight.status !== 'scheduled' || flight.visibility !== 'public' || inventory.visibility !== 'public' || inventory.status !== 'active') throw new HttpError(409, 'This flight is not accepting bookings.');
      if (!flight.departureTime || new Date(flight.departureTime).getTime() <= Date.now()) throw new HttpError(409, 'This flight has already departed or is no longer bookable.');
      const available = Number(inventory.availableSeats ?? 0);
      if (available < passengers.length) throw new HttpError(409, 'There are not enough seats remaining for this booking.');
      const unitFare = Number(inventory.fareAmountMinor ?? 0);
      const totalAmountMinor = unitFare * passengers.length;
      if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor < 1) throw new HttpError(409, 'The selected flight does not have a valid published fare.');
      const bookingReference = createBookingReference();
      const bookingData = {
        bookingReference, customerId: req.authUser!.uid, customerEmail: req.authUser!.email ?? null,
        organizationId: flight.organizationId ?? null, flightId, flightNumber: flight.flightNumber,
        airlineName: flight.airlineName, originCode: flight.originCode, destinationCode: flight.destinationCode,
        departureTime: flight.departureTime, arrivalTime: flight.arrivalTime,
        passengers, seatCount: passengers.length, unitFareMinor: unitFare, totalAmountMinor,
        currency: inventory.currency ?? 'KES', cabinClass: inventory.cabinClass ?? 'economy',
        status: 'held', holdExpiresAt: expiresAt, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      };
      tx.update(inventoryRef, { availableSeats: available - passengers.length, updatedAt: FieldValue.serverTimestamp() });
      tx.create(bookingRef, bookingData);
      tx.set(db.collection('audit_logs').doc(), { actorUid: req.authUser!.uid, action: 'booking.hold.created', targetId: bookingId, createdAt: FieldValue.serverTimestamp() });
      return { id: bookingId, bookingReference, flightId, flightNumber: flight.flightNumber, airlineName: flight.airlineName, originCode: flight.originCode, destinationCode: flight.destinationCode, departureTime: flight.departureTime, arrivalTime: flight.arrivalTime, passengers, seatCount: passengers.length, totalAmountMinor, currency: inventory.currency ?? 'KES', status: 'held', holdExpiresAt: expiresAt.toDate().toISOString() };
    });
    res.status(201).json({ booking: result, message: 'Seats are held for 15 minutes while you complete payment.' });
  } catch (error) { next(error); }
});

router.get('/bookings', async (req, res, next) => {
  try {
    const db = getDb();
    const snapshot = await db.collection('bookings').where('customerId', '==', req.authUser!.uid).orderBy('createdAt', 'desc').limit(100).get();
    res.json({ bookings: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data(), holdExpiresAt: doc.data().holdExpiresAt?.toDate?.().toISOString() ?? null, createdAt: doc.data().createdAt?.toDate?.().toISOString() ?? null })) });
  } catch (error) { next(error); }
});

router.get('/bookings/:bookingId', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('bookings').doc(req.params.bookingId).get();
    if (!snapshot.exists || snapshot.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Booking not found.');
    res.json({ booking: { id: snapshot.id, ...snapshot.data() } });
  } catch (error) { next(error); }
});

router.post('/bookings/:bookingId/cancel', async (req, res, next) => {
  try {
    const db = getDb();
    const bookingRef = db.collection('bookings').doc(req.params.bookingId);
    const status = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists || bookingSnap.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Booking not found.');
      const booking = bookingSnap.data()!;
      if (['initiating', 'pending', 'review_required'].includes(String(booking.paymentStatus))) throw new HttpError(409, 'A payment is currently processing. Refresh its status before cancelling this booking.');
      if (!['held', 'pending'].includes(String(booking.status))) throw new HttpError(409, 'Only unpaid held bookings can be cancelled online. Contact support for changes to a paid ticket.');
      if (booking.status === 'held') {
        const inventoryRef = db.collection('flight_inventory').doc(String(booking.flightId));
        const inventory = await tx.get(inventoryRef);
        if (inventory.exists) tx.update(inventoryRef, { availableSeats: Number(inventory.data()?.availableSeats ?? 0) + Number(booking.seatCount ?? 0), updatedAt: FieldValue.serverTimestamp() });
      }
      tx.update(bookingRef, { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      return 'cancelled';
    });
    res.json({ status });
  } catch (error) { next(error); }
});

router.get('/tickets', async (req, res, next) => {
  try {
    const db = getDb();
    const bookings = await db.collection('bookings').where('customerId', '==', req.authUser!.uid).where('status', '==', 'ticketed').limit(100).get();
    const ticketGroups = await Promise.all(bookings.docs.map(async (booking) => {
      const tickets = await db.collection('tickets').where('bookingId', '==', booking.id).get();
      return tickets.docs.map((ticket) => ({ id: ticket.id, ...ticket.data(), bookingReference: booking.data().bookingReference, flightNumber: booking.data().flightNumber, originCode: booking.data().originCode, destinationCode: booking.data().destinationCode, departureTime: booking.data().departureTime }));
    }));
    res.json({ tickets: ticketGroups.flat() });
  } catch (error) { next(error); }
});

router.post('/tickets/:ticketId/check-in', async (req, res, next) => {
  try {
    const db = getDb();
    const ticketRef = db.collection('tickets').doc(req.params.ticketId);
    const result = await db.runTransaction(async (tx) => {
      const ticket = await tx.get(ticketRef);
      if (!ticket.exists) throw new HttpError(404, 'Ticket not found.');
      const bookingRef = db.collection('bookings').doc(String(ticket.data()?.bookingId));
      const booking = await tx.get(bookingRef);
      if (!booking.exists || booking.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Ticket not found.');
      if (ticket.data()?.status !== 'issued') throw new HttpError(409, 'This ticket is not eligible for check-in.');
      if (ticket.data()?.checkInStatus === 'checked_in') throw new HttpError(409, 'This ticket has already been checked in.');
      tx.update(ticketRef, { checkInStatus: 'checked_in', checkedInAt: FieldValue.serverTimestamp() });
      return { ticketNumber: ticket.data()?.ticketNumber, checkInStatus: 'checked_in' };
    });
    res.json({ checkIn: result });
  } catch (error) { next(error); }
});

router.get('/passengers', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('passengers').where('ownerUid', '==', req.authUser!.uid).limit(100).get();
    res.json({ passengers: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.post('/passengers', async (req, res, next) => {
  try {
    const db = getDb();
    const passenger = passengerSchema(req.body);
    const ref = db.collection('passengers').doc(randomUUID());
    await ref.create({ ...passenger, ownerUid: req.authUser!.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    res.status(201).json({ passenger: { id: ref.id, ...passenger } });
  } catch (error) { next(error); }
});

router.delete('/passengers/:passengerId', async (req, res, next) => {
  try {
    const ref = getDb().collection('passengers').doc(req.params.passengerId);
    const passenger = await ref.get();
    if (!passenger.exists || passenger.data()?.ownerUid !== req.authUser!.uid) throw new HttpError(404, 'Passenger profile not found.');
    await ref.delete();
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
