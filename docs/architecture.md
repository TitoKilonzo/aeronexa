# AeroNexa architecture

## Architecture

A modular monolith is used initially: React PWA client, one versioned Express API and Firebase managed services. This keeps transactional business logic central while maintaining clear modules that can later be extracted.

## Trust boundaries

1. **Browser:** untrusted. Firebase client SDK handles identity only. Prices, roles, payment state and inventory are not authoritative in the browser.
2. **API:** trusted application boundary. It verifies tokens, validates input, checks record ownership and tenant membership, calls provider APIs and writes operational records.
3. **Firestore / Storage:** operational source of truth. Firestore rules restrict direct client access; API credentials and Cloud Functions manage protected records.
4. **External providers:** independent systems. Duffel owns its external inventory; Safaricom and Stripe own their payment outcomes. Firestore transactions cannot lock external records.

## Tenant model

Organizations represent airlines and travel agencies. Users can belong to multiple organizations. A member record carries an active status and role. New organizations are pending platform approval; only approved organizations can publish internal schedules. Invitations are time limited and email bound.

## Internal flight and booking flow

1. An approved airline operator publishes a flight document and a matching inventory document.
2. Public search returns eligible flights with enough seats for the requested passenger count and the selected cabin.
3. An authenticated customer submits passenger records. A Firestore transaction reads flight and inventory, validates schedule and stock, decrements available seats, and creates a 15-minute held booking.
4. Payment initiation acquires a per-booking payment lock in a transaction. The API calls Daraja STK Push or creates a Stripe Checkout Session.
5. The provider callback/webhook is matched to the payment. M-Pesa status is queried through Daraja; Stripe signature is verified against the raw request body.
6. A Firestore transaction validates payment amount, currency, booking state and hold expiry, updates the payment and booking, creates ticket records and adds a notification. The operation is idempotent.
7. A scheduled Cloud Function expires unpaid holds and returns held seats to inventory.

## Hybrid supplier model

Duffel offer search is separated from internal inventory. External offers are currently read-only. An external booking flow needs an order/hold lifecycle, supplier payment or balance settlement, ticketing, asynchronous order status reconciliation and compensation paths. It must not reuse internal Firestore seat holds as if they reserved supplier inventory.

## PWA and offline boundary

The PWA manifest controls app identity and standalone display. A service worker caches the public static shell, icons and same-origin static assets. Navigations can fall back to the offline page. API, auth, payment, booking and private document data stay network-only to avoid stale financial data and private-data leakage.

## Scale path

Add cursor pagination, outbox/queue processing for provider retries, observability and ledger-based reconciliation. Move heavy reporting to BigQuery or another analytics warehouse as operational load grows. Add external supplier adapters behind a shared supplier interface.
