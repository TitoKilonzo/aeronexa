import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAuth, requireOrganizationRole } from '../middleware/auth.js';
import { getDb, assertString } from '../shared/firestore.js';
import { HttpError } from '../shared/http.js';
import { searchDuffelOffers } from '../services/duffel.service.js';

const router = Router();
const validCabins = ['economy', 'premium_economy', 'business', 'first'];

router.get('/airports', async (req, res, next) => {
  try {
    const code = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
    const snapshot = await getDb().collection('airports').limit(300).get();
    const airports = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((airport: any) => !code || `${airport.code} ${airport.city} ${airport.name}`.toUpperCase().includes(code));
    res.json({ airports });
  } catch (error) { next(error); }
});

router.get('/organizations/:orgId/flights', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const member = await db.collection('organizations').doc(req.params.orgId).collection('members').doc(req.authUser!.uid).get();
    if (!member.exists || member.data()?.status !== 'active' || !['organization_admin', 'operations_manager', 'booking_officer'].includes(String(member.data()?.role))) throw new HttpError(403, "You cannot view this organization flight operations.");
    const snapshot = await db.collection('flights').where('organizationId', '==', req.params.orgId).orderBy('departureTime', 'desc').limit(100).get();
    const flights = await Promise.all(snapshot.docs.map(async (doc) => {
      const inventory = await db.collection('flight_inventory').doc(doc.id).get();
      return { id: doc.id, ...doc.data(), ...inventory.data() };
    }));
    res.json({ flights });
  } catch (error) { next(error); }
});

router.get('/flights/search', async (req, res, next) => {
  try {
    const origin = assertString(req.query.origin, 'Origin', 3).toUpperCase();
    const destination = assertString(req.query.destination, 'Destination', 3).toUpperCase();
    const departureDate = assertString(req.query.departureDate, 'Departure date', 10);
    const returnDate = typeof req.query.returnDate === 'string' ? req.query.returnDate : undefined;
    const adults = Math.min(9, Math.max(1, Number(req.query.adults ?? 1)));
    const cabinClass = validCabins.includes(String(req.query.cabinClass)) ? String(req.query.cabinClass) : 'economy';
    if (origin === destination) throw new HttpError(400, 'Origin and destination must be different.');
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new HttpError(400, 'Passenger count must be between 1 and 9.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate) || (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate))) throw new HttpError(400, 'Use YYYY-MM-DD for travel dates.');
    if (Number.isNaN(Date.parse(`${departureDate}T00:00:00.000Z`)) || (returnDate && Number.isNaN(Date.parse(`${returnDate}T00:00:00.000Z`)))) throw new HttpError(400, 'Enter valid travel dates.');
    if (departureDate < new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'Departure date cannot be in the past.');
    if (returnDate && returnDate < departureDate) throw new HttpError(400, 'Return date cannot be before departure date.');
    const start = new Date(`${departureDate}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86400000);
    const db = getDb();
    const snapshot = returnDate ? null : await db.collection('flights')
      .where('originCode', '==', origin).where('destinationCode', '==', destination)
      .where('status', '==', 'scheduled').where('visibility', '==', 'public')
      .where('departureTime', '>=', start.toISOString()).where('departureTime', '<', end.toISOString()).limit(100).get();
    const internal = await Promise.all((snapshot?.docs ?? []).map(async (flightDoc) => {
      const flight = flightDoc.data();
      const [inventory, organization] = await Promise.all([db.collection('flight_inventory').doc(flightDoc.id).get(), flight.organizationId ? db.collection('organizations').doc(String(flight.organizationId)).get() : Promise.resolve(null)]);
      const stock = inventory.data();
      if (!inventory.exists || !organization?.exists || organization.data()?.status !== 'active' || Number(stock?.availableSeats ?? 0) < adults) return null;
      if (stock?.cabinClass && stock.cabinClass !== cabinClass) return null;
      return {
        id: flightDoc.id, source: 'internal', airline: flight.airlineName, airlineCode: flight.airlineCode,
        flightNumber: flight.flightNumber, origin: flight.originCode, destination: flight.destinationCode,
        departureTime: flight.departureTime, arrivalTime: flight.arrivalTime, durationMinutes: flight.durationMinutes,
        stops: flight.stops ?? 0, amountMinor: Number(stock?.fareAmountMinor ?? 0), currency: stock?.currency ?? 'KES',
        availableSeats: stock?.availableSeats, cabinClass: stock?.cabinClass ?? cabinClass, bookable: true,
      };
    }));
    let external: unknown[] = [];
    let supplierWarning: string | null = null;
    if (process.env.DUFFEL_ACCESS_TOKEN) {
      try { external = await searchDuffelOffers({ origin, destination, departureDate, ...(returnDate ? { returnDate } : {}), adults, cabinClass }); }
      catch (error) { supplierWarning = error instanceof Error ? error.message : 'External supplier search failed.'; }
    }
    const flights = [...internal.filter(Boolean), ...external].sort((a: any, b: any) => (a.amountMinor ?? (a.amount ?? 0) * 100) - (b.amountMinor ?? (b.amount ?? 0) * 100));
    res.json({ flights, providers: { internal: true, duffel: Boolean(process.env.DUFFEL_ACCESS_TOKEN) }, supplierWarning, resultCount: flights.length });
  } catch (error) { next(error); }
});

router.get('/flights/:flightId', async (req, res, next) => {
  try {
    const db = getDb();
    const flight = await db.collection('flights').doc(req.params.flightId).get();
    const inventory = await db.collection('flight_inventory').doc(req.params.flightId).get();
    if (!flight.exists || !inventory.exists || flight.data()?.visibility !== 'public' || inventory.data()?.visibility !== 'public') throw new HttpError(404, 'Flight not found.');
    const orgId = String(flight.data()?.organizationId ?? '');
    const organization = orgId ? await db.collection('organizations').doc(orgId).get() : null;
    if (!organization?.exists || organization.data()?.status !== 'active') throw new HttpError(404, 'Flight not found.');
    res.json({ flight: { id: flight.id, ...flight.data(), ...inventory.data() } });
  } catch (error) { next(error); }
});

router.post('/flights', requireAuth, requireOrganizationRole(['organization_admin', 'operations_manager']), async (req, res, next) => {
  try {
    const db = getDb();
    const body = req.body as Record<string, any>;
    const flightNumber = assertString(body.flightNumber, 'Flight number', 12).toUpperCase();
    const airlineName = assertString(body.airlineName, 'Airline name');
    const originCode = assertString(body.originCode, 'Origin airport', 3).toUpperCase();
    const destinationCode = assertString(body.destinationCode, 'Destination airport', 3).toUpperCase();
    const departureTime = new Date(assertString(body.departureTime, 'Departure time'));
    const arrivalTime = new Date(assertString(body.arrivalTime, 'Arrival time'));
    const cabinClass = String(body.cabinClass ?? 'economy');
    if (!validCabins.includes(cabinClass)) throw new HttpError(400, 'Select a valid cabin class.');
    const seatCapacity = Math.min(600, Math.max(1, Number(body.seatCapacity)));
    const availableSeats = seatCapacity;
    const fareAmountMinor = Math.round(Number(body.fareAmountMinor));
    if (originCode === destinationCode || Number.isNaN(departureTime.getTime()) || Number.isNaN(arrivalTime.getTime()) || departureTime <= new Date() || arrivalTime <= departureTime || !Number.isInteger(seatCapacity) || !Number.isSafeInteger(fareAmountMinor) || fareAmountMinor < 1) throw new HttpError(400, 'Provide valid airports, times, seat capacity and a positive fare.');
    const [origin, destination, organization] = await Promise.all([db.collection('airports').doc(originCode).get(), db.collection('airports').doc(destinationCode).get(), db.collection('organizations').doc(String(req.organizationId)).get()]);
    if (!origin.exists || !destination.exists) throw new HttpError(400, 'Both airport codes must exist in the airport catalogue.');
    if (!organization.exists || organization.data()?.status !== 'active') throw new HttpError(403, 'This organization must be approved before publishing public flight inventory.');
    const flightId = randomUUID();
    const batch = db.batch();
    batch.create(db.collection('flights').doc(flightId), {
      organizationId: req.organizationId, flightNumber, airlineName, airlineCode: body.airlineCode ?? '',
      originCode, destinationCode, departureTime: departureTime.toISOString(), arrivalTime: arrivalTime.toISOString(),
      durationMinutes: Math.round((arrivalTime.getTime() - departureTime.getTime()) / 60000), stops: 0,
      status: 'scheduled', visibility: 'public', createdBy: req.authUser!.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    batch.create(db.collection('flight_inventory').doc(flightId), {
      flightId, organizationId: req.organizationId, seatCapacity, availableSeats,
      cabinClass, fareAmountMinor, currency: body.currency === 'USD' ? 'USD' : 'KES',
      status: 'active', visibility: 'public', updatedAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    res.status(201).json({ flight: { id: flightId, flightNumber, originCode, destinationCode, departureTime: departureTime.toISOString(), arrivalTime: arrivalTime.toISOString() } });
  } catch (error) { next(error); }
});

router.patch('/flights/:flightId/status', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const ref = db.collection('flights').doc(req.params.flightId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new HttpError(404, 'Flight not found.');
    const orgId = String(snapshot.data()?.organizationId ?? '');
    const member = await db.collection('organizations').doc(orgId).collection('members').doc(req.authUser!.uid).get();
    if (!member.exists || member.data()?.status !== 'active' || !['organization_admin', 'operations_manager'].includes(String(member.data()?.role))) throw new HttpError(403, 'You cannot manage this flight.');
    const status = String(req.body.status);
    if (!['scheduled', 'boarding', 'departed', 'arrived', 'delayed', 'cancelled'].includes(status)) throw new HttpError(400, 'Invalid flight status.');
    const organization = await db.collection('organizations').doc(orgId).get();
    if (!organization.exists || organization.data()?.status !== 'active') throw new HttpError(403, 'This organization is not active.');
    if (status === 'cancelled') {
      const relatedBookings = await db.collection('bookings').where('flightId', '==', ref.id).limit(500).get();
      const hasPaidOrActiveBooking = relatedBookings.docs.some((booking) => ['ticketed', 'confirmed'].includes(String(booking.data().status)) || (booking.data().status === 'held' && booking.data().holdExpiresAt?.toDate?.().getTime() > Date.now()));
      if (hasPaidOrActiveBooking) throw new HttpError(409, 'This flight has paid tickets or active seat holds. Resolve customer changes and refunds before cancelling the schedule.');
    }
    await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
    res.json({ status });
  } catch (error) { next(error); }
});

export default router;
