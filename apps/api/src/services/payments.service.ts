import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpError } from '../shared/http.js';

export function normalizeKenyanPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  throw new HttpError(400, 'Enter a valid Kenyan M-Pesa number, for example 07XXXXXXXX or 2547XXXXXXXX.');
}

async function mpesaToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) throw new HttpError(503, 'M-Pesa is not configured on the API server.');
  const base = process.env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const response = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } });
  const body = await response.json() as { access_token?: string };
  if (!response.ok || !body.access_token) throw new HttpError(502, 'Could not authenticate with Safaricom Daraja.');
  return { base, token: body.access_token };
}

export async function queryMpesaStk(checkoutRequestId: string) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  if (!shortcode || !passkey) throw new HttpError(503, 'M-Pesa STK Query is not configured.');
  const { base, token } = await mpesaToken();
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const response = await fetch(`${base}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessShortCode: shortcode, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
  });
  const payload = await response.json() as Record<string, any>;
  if (!response.ok || payload.ResponseCode !== '0') throw new HttpError(502, payload.errorMessage ?? payload.ResponseDescription ?? 'Safaricom could not verify the STK Push result.');
  return { resultCode: payload.ResultCode === undefined ? null : String(payload.ResultCode), resultDescription: String(payload.ResultDesc ?? payload.ResponseDescription ?? '') };
}

export async function initiateMpesa(input: { paymentId: string; bookingReference: string; amountMinor: number; phone: string }) {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  if (!shortcode || !passkey || !callbackUrl) throw new HttpError(503, 'Complete MPESA_SHORTCODE, MPESA_PASSKEY and MPESA_CALLBACK_URL before using M-Pesa.');
  if (process.env.MPESA_ENVIRONMENT === 'production' && !callbackUrl.startsWith('https://')) throw new HttpError(500, 'The production M-Pesa callback URL must use HTTPS.');
  const { base, token } = await mpesaToken();
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const amount = Math.ceil(input.amountMinor / 100);
  if (amount < 1) throw new HttpError(400, 'M-Pesa requires an amount of at least KES 1.');
  const phone = normalizeKenyanPhone(input.phone);
  const response = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode, Password: password, Timestamp: timestamp, TransactionType: process.env.MPESA_TRANSACTION_TYPE ?? 'CustomerPayBillOnline',
      Amount: amount, PartyA: phone, PartyB: shortcode, PhoneNumber: phone,
      CallBackURL: callbackUrl, AccountReference: input.bookingReference.slice(0, 12), TransactionDesc: `AeroNexa ${input.bookingReference}`.slice(0, 13),
    }),
  });
  const payload = await response.json() as Record<string, any>;
  if (!response.ok || payload.ResponseCode !== '0' || !payload.CheckoutRequestID) throw new HttpError(502, payload.errorMessage ?? payload.ResponseDescription ?? 'M-Pesa STK Push could not be initiated.');
  return { checkoutRequestId: String(payload.CheckoutRequestID), merchantRequestId: String(payload.MerchantRequestID ?? ''), customerMessage: String(payload.CustomerMessage ?? 'Check your phone to complete the M-Pesa payment.') };
}

export async function initiateStripe(input: { paymentId: string; bookingId: string; amountMinor: number; currency: string; description: string; customerEmail?: string }) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const successUrl = process.env.STRIPE_SUCCESS_URL;
  const cancelUrl = process.env.STRIPE_CANCEL_URL;
  if (!secret || !successUrl || !cancelUrl) throw new HttpError(503, 'Card payments are not configured. Add Stripe secret key and success/cancel URLs.');
  const form = new URLSearchParams({
    mode: 'payment', success_url: successUrl, cancel_url: cancelUrl,
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(input.amountMinor),
    'line_items[0][price_data][product_data][name]': input.description,
    'metadata[paymentId]': input.paymentId, 'metadata[bookingId]': input.bookingId,
  });
  if (input.customerEmail) form.set('customer_email', input.customerEmail);
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const payload = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !payload.id || !payload.url) throw new HttpError(502, payload.error?.message ?? 'Stripe Checkout could not be created.');
  return { sessionId: payload.id, checkoutUrl: payload.url };
}

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const parts = signatureHeader.split(',').reduce<Record<string, string[]>>((acc, item) => {
    const [key, value] = item.split('=', 2);
    if (key && value) (acc[key] ??= []).push(value);
    return acc;
  }, {});
  const timestamp = parts.t?.[0];
  const signature = parts.v1?.[0];
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(signature, 'hex');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function updatePaymentProviderStatus(db: Firestore, paymentId: string, status: string, providerReference?: string) {
  await db.collection('payments').doc(paymentId).update({ status, providerReference: providerReference ?? null, updatedAt: FieldValue.serverTimestamp() });
}
