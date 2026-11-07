import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';
import { requireAuth } from '../middleware/auth.js';
import { getDb, assertString } from '../shared/firestore.js';
import { HttpError } from '../shared/http.js';
import { confirmBookingAfterPayment } from '../services/booking-lifecycle.js';
import { initiateMpesa, initiateStripe, queryMpesaStk, verifyStripeSignature } from '../services/payments.service.js';

const router = Router();

async function markPaymentPending(db: ReturnType<typeof getDb>, paymentRef: DocumentReference, bookingRef: DocumentReference, providerFields: Record<string, unknown>) {
  await db.runTransaction(async (tx) => {
    const [paymentSnap, bookingSnap] = await Promise.all([tx.get(paymentRef), tx.get(bookingRef)]);
    if (!paymentSnap.exists || !bookingSnap.exists) throw new Error('Payment or booking record disappeared.');
    if (['succeeded', 'failed', 'review_required'].includes(String(paymentSnap.data()?.status)) || bookingSnap.data()?.status === 'ticketed') return;
    tx.update(paymentRef, { status: 'pending', ...providerFields, updatedAt: FieldValue.serverTimestamp() });
    tx.update(bookingRef, { paymentStatus: 'pending', updatedAt: FieldValue.serverTimestamp() });
  });
}

async function markPaymentFailed(db: ReturnType<typeof getDb>, paymentRef: DocumentReference, bookingRef: DocumentReference, reason: string) {
  await db.runTransaction(async (tx) => {
    const [paymentSnap, bookingSnap] = await Promise.all([tx.get(paymentRef), tx.get(bookingRef)]);
    if (!paymentSnap.exists || !bookingSnap.exists || paymentSnap.data()?.status === 'succeeded' || bookingSnap.data()?.status === 'ticketed') return;
    tx.update(paymentRef, { status: 'failed', failureReason: reason, updatedAt: FieldValue.serverTimestamp() });
    tx.update(bookingRef, { paymentStatus: 'failed', updatedAt: FieldValue.serverTimestamp() });
  });
}

async function markPaymentReviewRequired(db: ReturnType<typeof getDb>, paymentRef: DocumentReference, bookingRef: DocumentReference, reason: string) {
  await db.runTransaction(async (tx) => {
    const [paymentSnap, bookingSnap] = await Promise.all([tx.get(paymentRef), tx.get(bookingRef)]);
    if (!paymentSnap.exists || !bookingSnap.exists || paymentSnap.data()?.status === 'succeeded' || bookingSnap.data()?.status === 'ticketed') return;
    tx.update(paymentRef, { status: 'review_required', reviewReason: reason, updatedAt: FieldValue.serverTimestamp() });
    tx.update(bookingRef, { paymentStatus: 'review_required', updatedAt: FieldValue.serverTimestamp() });
  });
}


router.post('/payments/mpesa/callback', async (req, res) => {
  try {
    const db = getDb();
    const callback = req.body?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID;
    if (!checkoutRequestId) return res.status(400).json({ ResultCode: 1, ResultDesc: 'Missing checkout request ID.' });
    const payments = await db.collection('payments').where('checkoutRequestId', '==', checkoutRequestId).limit(1).get();
    if (payments.empty) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received.' });
    const paymentDoc = payments.docs[0];
    if (callback.ResultCode === 0) {
      const items = callback.CallbackMetadata?.Item ?? [];
      const getItem = (name: string) => items.find((item: any) => item.Name === name)?.Value;
      const paidAmount = Number(getItem('Amount'));
      const payment = paymentDoc.data();
      if (!Number.isFinite(paidAmount) || paidAmount !== Math.ceil(Number(payment.amountMinor) / 100)) {
        await markPaymentReviewRequired(db, paymentDoc.ref, db.collection('bookings').doc(String(payment.bookingId)), 'M-Pesa callback amount did not match the booking total.');
        await paymentDoc.ref.update({ callbackPayload: callback, updatedAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received for review.' });
      }
      let verified: Awaited<ReturnType<typeof queryMpesaStk>>;
      try { verified = await queryMpesaStk(String(checkoutRequestId)); }
      catch (error) { await markPaymentReviewRequired(db, paymentDoc.ref, db.collection('bookings').doc(String(payment.bookingId)), error instanceof Error ? error.message : 'Safaricom STK Query could not confirm the payment.'); return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback recorded for manual review.' }); }
      if (verified.resultCode !== '0') {
        if (verified.resultCode === null) await markPaymentReviewRequired(db, paymentDoc.ref, db.collection('bookings').doc(String(payment.bookingId)), verified.resultDescription || 'Safaricom returned no final STK result.');
        else await markPaymentFailed(db, paymentDoc.ref, db.collection('bookings').doc(String(payment.bookingId)), verified.resultDescription || 'M-Pesa payment failed.');
        await paymentDoc.ref.update({ providerResultCode: verified.resultCode, providerResultDescription: verified.resultDescription, callbackPayload: callback, updatedAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback recorded; provider query did not confirm a successful payment.' });
      }
      try { await confirmBookingAfterPayment(db, String(payment.bookingId), paymentDoc.id, String(getItem('MpesaReceiptNumber') ?? checkoutRequestId)); }
      catch (error) { await markPaymentReviewRequired(db, paymentDoc.ref, db.collection('bookings').doc(String(payment.bookingId)), error instanceof Error ? error.message : 'Payment confirmation requires reconciliation.'); return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment received but requires manual reconciliation.' }); }
      await paymentDoc.ref.update({ mpesaReceiptNumber: getItem('MpesaReceiptNumber') ?? null, payerPhone: getItem('PhoneNumber') ?? null, callbackReceivedAt: FieldValue.serverTimestamp() });
    } else {
      await markPaymentFailed(db, paymentDoc.ref, db.collection('bookings').doc(String(paymentDoc.data().bookingId)), String(callback.ResultDesc ?? 'M-Pesa payment failed.'));
    }
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback processed.' });
  } catch (error) {
    console.error('M-Pesa callback processing failed:', error);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Callback received; processing requires review.' });
  }
});

router.post('/payments/stripe/webhook', async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !verifyStripeSignature(req.body, req.header('stripe-signature'))) return res.status(400).json({ error: 'Invalid Stripe webhook signature.' });
    const event = JSON.parse(req.body.toString('utf8')) as { type?: string; data?: { object?: Record<string, any> } };
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object;
      if (session?.payment_status === 'paid' && session.metadata?.paymentId && session.metadata?.bookingId) {
        const db = getDb();
        const paymentRef = db.collection('payments').doc(String(session.metadata.paymentId));
        const bookingRef = db.collection('bookings').doc(String(session.metadata.bookingId));
        try {
          const paymentSnap = await paymentRef.get();
          const bookingSnap = await bookingRef.get();
          if (!paymentSnap.exists || !bookingSnap.exists || paymentSnap.data()?.bookingId !== String(session.metadata.bookingId)) {
            throw new Error('Stripe session does not match a valid AeroNexa payment and booking.');
          }
          const expectedAmount = Number(paymentSnap.data()?.amountMinor);
          const expectedCurrency = String(paymentSnap.data()?.currency ?? '').toLowerCase();
          if (Number(session.amount_total) !== expectedAmount || String(session.currency ?? '').toLowerCase() !== expectedCurrency) {
            throw new Error('Stripe session amount or currency does not match the payment record.');
          }
          await confirmBookingAfterPayment(db, String(session.metadata.bookingId), String(session.metadata.paymentId), String(session.payment_intent ?? session.id));
        } catch (error) {
          await markPaymentReviewRequired(db, paymentRef, bookingRef, error instanceof Error ? error.message : 'Stripe payment requires manual reconciliation.');
        }
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing failed:', error);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

router.use(requireAuth);

router.post('/payments', async (req, res, next) => {
  try {
    const db = getDb();
    const bookingId = assertString(req.body.bookingId, 'Booking ID', 100);
    const method = req.body.method === 'card' ? 'card' : req.body.method === 'mpesa' ? 'mpesa' : null;
    if (!method) throw new HttpError(400, 'Payment method must be mpesa or card.');
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists || bookingSnap.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Booking not found.');
    const booking = bookingSnap.data()!;
    if (booking.status !== 'held' || booking.holdExpiresAt?.toDate?.().getTime() <= Date.now()) throw new HttpError(409, 'This seat hold has expired or is no longer payable.');
    const amountMinor = Number(booking.totalAmountMinor);
    const currency = String(booking.currency ?? 'KES');
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new HttpError(409, 'This booking has an invalid payment amount.');
    if (method === 'mpesa' && currency !== 'KES') throw new HttpError(400, 'M-Pesa payments are only available for KES bookings.');
    if (method === 'mpesa' && amountMinor % 100 !== 0) throw new HttpError(400, 'M-Pesa requires a whole KES amount. Please contact support to adjust this fare.');

    const paymentId = randomUUID();
    const paymentRef = db.collection('payments').doc(paymentId);
    const payment = {
      bookingId, bookingReference: booking.bookingReference, customerId: req.authUser!.uid,
      amountMinor, currency, method, status: 'initiating', provider: method === 'mpesa' ? 'safaricom_daraja' : 'stripe',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    };

    // Serialize concurrent payment attempts through the booking document.
    await db.runTransaction(async (tx) => {
      const freshBooking = await tx.get(bookingRef);
      if (!freshBooking.exists || freshBooking.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Booking not found.');
      const fresh = freshBooking.data()!;
      if (fresh.status !== 'held' || fresh.holdExpiresAt?.toDate?.().getTime() <= Date.now()) throw new HttpError(409, 'This seat hold has expired or is no longer payable.');
      if (['initiating', 'pending', 'review_required'].includes(String(fresh.paymentStatus))) throw new HttpError(409, 'A payment is already in progress for this booking. Refresh payment status before trying again.');
      tx.create(paymentRef, payment);
      tx.update(bookingRef, { paymentStatus: 'initiating', paymentId, updatedAt: FieldValue.serverTimestamp() });
    });

    try {
      if (method === 'mpesa') {
        const response = await initiateMpesa({ paymentId, bookingReference: String(booking.bookingReference), amountMinor, phone: assertString(req.body.phoneNumber, 'M-Pesa phone number', 24) });
        await markPaymentPending(db, paymentRef, bookingRef, response);
        res.status(201).json({ payment: { id: paymentId, status: 'pending', method, message: response.customerMessage } });
      } else {
        const response = await initiateStripe({ paymentId, bookingId, amountMinor, currency, description: `AeroNexa booking ${booking.bookingReference}`, customerEmail: req.authUser!.email });
        await markPaymentPending(db, paymentRef, bookingRef, { stripeSessionId: response.sessionId });
        res.status(201).json({ payment: { id: paymentId, status: 'pending', method, checkoutUrl: response.checkoutUrl } });
      }
    } catch (error) {
      await markPaymentFailed(db, paymentRef, bookingRef, error instanceof Error ? error.message : 'Payment could not be initiated.');
      throw error;
    }
  } catch (error) { next(error); }
});

router.get('/payments', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('payments').where('customerId', '==', req.authUser!.uid).orderBy('createdAt', 'desc').limit(100).get();
    res.json({ payments: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

router.get('/payments/:paymentId', async (req, res, next) => {
  try {
    const snapshot = await getDb().collection('payments').doc(req.params.paymentId).get();
    if (!snapshot.exists || snapshot.data()?.customerId !== req.authUser!.uid) throw new HttpError(404, 'Payment not found.');
    res.json({ payment: { id: snapshot.id, ...snapshot.data() } });
  } catch (error) { next(error); }
});

export default router;
