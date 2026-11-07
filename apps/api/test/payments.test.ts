import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKenyanPhone } from '../src/services/payments.service.js';
import { createBookingReference } from '../src/services/booking-lifecycle.js';

test('normalizes common Kenyan M-Pesa number formats', () => {
  assert.equal(normalizeKenyanPhone('0712 345 678'), '254712345678');
  assert.equal(normalizeKenyanPhone('+254 712 345 678'), '254712345678');
  assert.equal(normalizeKenyanPhone('712345678'), '254712345678');
});

test('rejects unsupported phone formats', () => {
  assert.throws(() => normalizeKenyanPhone('123456'), /valid Kenyan M-Pesa number/);
});

test('creates unique readable booking references', () => {
  const first = createBookingReference();
  const second = createBookingReference();
  assert.match(first, /^ANX-\d{4}-[A-F0-9]{8}$/);
  assert.notEqual(first, second);
});
