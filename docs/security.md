# Security controls and release checklist

## Identity and authorization

- Firebase Authentication is the identity provider. The API validates Firebase ID tokens and checks revocation.
- A newly registered account receives customer access only. No self-service client request can assign a staff or platform-admin role.
- Platform administration is granted by a trusted Firebase custom claim or a server environment UID allowlist.
- Organization membership and active role are checked from Firestore for every tenant-scoped API route.
- Customer booking, payment, ticket, passenger, notification and document endpoints check record ownership.

## Data access

- Firestore rules deny direct client writes to operational collections, including bookings, payments, flight inventory, tickets, organizations and notifications.
- Firebase Admin SDK bypasses Firestore Rules; API-level authorization and validation are mandatory.
- Travel document metadata is owner-scoped. Storage objects use private paths and five-minute signed URLs.
- Do not cache API responses, authentication state, ticket data or travel documents in the service worker.

## Payments

- Use hosted Stripe Checkout; never store PAN/CVV.
- M-Pesa secrets and Stripe keys remain server-side.
- Match provider identifiers to an existing pending payment and compare amounts/currencies before issuing tickets.
- M-Pesa callback handling additionally queries the STK request and requires a successful provider result before ticketing.
- Stripe webhook handling validates the signature using the exact raw request body and timestamp tolerance.
- Duplicate provider events must be idempotent. Late payments, amount mismatches and unverifiable events require manual reconciliation.
- Implement refunds, disputes, reconciliation reports and finance controls before commercial operation.

## API and infrastructure

- Helmet, strict CORS allowlists, JSON payload caps and rate limits are configured.
- Use HTTPS, least-privilege service identities, managed secret storage and redacted logs.
- Use the Firebase Emulator Suite to test rules, membership boundaries and scheduled functions.
- Run dependency scans, secret scans, load tests and an independent security assessment before launch.

## Privacy and operations

- Obtain a legal basis and consent for passenger information and identity documents.
- Define retention and secure deletion schedules for passports, visas and other sensitive documents.
- Configure access auditing, alerting, backups, incident response and support escalation.
- The current airline check-in action changes AeroNexa's internal ticket status only; it is not an airline departure-control or boarding authorization service.
