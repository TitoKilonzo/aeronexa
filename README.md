# AeroNexa

AeroNexa is a multi-organization flight booking and travel operations platform for travellers, airlines and travel agencies. It combines an installable Progressive Web App (PWA), a React workspace, a server-authorized Express API and Firebase services.

> **Release status — functional development release, not yet approved for commercial production.** The internal single-leg booking flow, payment initiation, callback-driven ticket creation, organization onboarding and PWA shell are implemented. External supplier search is read-only, and several carrier / provider processes still require live account onboarding and integration testing. Do not accept public money or make commercial travel promises until the deployment checklist and provider certification in this README have been completed.

## Technology

- **Web:** React 19, TypeScript, Vite, React Router, Tailwind CSS 4, Lucide React
- **API:** Node.js 22+, Express 5, TypeScript
- **Identity and data:** Firebase Authentication, Cloud Firestore, Firebase Storage, Firebase Admin SDK
- **Background work:** Firebase Cloud Functions v2
- **Payments:** Safaricom Daraja STK Push (M-Pesa) and Stripe Checkout (card)
- **Supplier discovery:** Duffel offer search adapter (external offers are quote-only in this release)
- **Hosting:** Vercel for the web app; Cloud Run or another Node host for the Express API
- **PWA:** Web app manifest, app icons, service worker, offline fallback and in-app **Install App** button

## What is implemented

### Customer experience

- Public Home, About, Destinations and Contact pages.
- Firebase email/password registration and sign-in, protected workspace, profile settings and sign-out.
- Search by origin, destination, date, passenger count and cabin.
- Search published internal schedules and optionally retrieve external Duffel offers.
- Passenger profiles, bookings, payment history, e-tickets, notifications and private travel-document uploads.
- Internal flight booking creates a 15-minute seat hold in a Firestore transaction; competing requests cannot oversell the same inventory document.
- Booking payment is initiated on the API. M-Pesa callbacks are matched to a payment record, reconciled against an STK Query response and compared to the expected amount. Stripe webhooks are checked using the signature header and raw request body.
- Tickets are created idempotently after a successful payment confirmation. Failed, pending and review-required states remain visible in payment history.

### Organization and operations

- Users can create airline or travel-agency organizations. New organizations start in `pending` state and require platform-admin approval before publishing inventory.
- Organization admins can create time-limited invitations for members. Acceptance requires sign-in using the invited email address.
- Role-aware membership checks are enforced by the API, not by front-end navigation.
- Organization flight operations can publish an internal scheduled flight and its seat/fare inventory, list flights and update flight status.
- A scheduled Cloud Function releases expired seat holds and creates a user notification.
- Platform administrators can inspect and approve pending organizations from the Organizations workspace.

### PWA and offline behavior

- `apps/web/public/manifest.webmanifest` defines the app name, standalone display mode, theme, icons and launch route.
- The production app registers `apps/web/public/sw.js`.
- The **Install App** button is shown in the public navigation and signed-in workspace. Where the browser exposes `beforeinstallprompt`, it opens the native install prompt. On iOS and other browsers without that event, it opens browser-specific Add to Home Screen / Install instructions.
- The service worker caches the static app shell and same-origin static assets, and serves an offline fallback when navigation cannot reach the network.
- **Offline is read-only shell support.** Flight search, booking, payment, account authentication and document transfer require a connection. Authenticated API responses and personal documents are deliberately not cached.

## Important product boundaries

These limits are intentional and must be understood before deployment:

1. **Internal booking scope:** one-way, single-leg flights created by an approved AeroNexa organization can be held and paid. Multi-leg, codeshare, round-trip pairing, seat maps, fare rules, ancillary services, cancellations/refunds and rebooking are not implemented.
2. **External suppliers:** Duffel search is implemented for live offer discovery. External offers are marked not bookable. Supplier order creation, ticket issuance, post-booking changes and settlement with Duffel are not exposed as a live checkout flow yet.
3. **M-Pesa:** Daraja STK Push initiation and callback + STK Query reconciliation are implemented, but must be tested with your own Safaricom sandbox and production shortcode, passkey, callback URL and approved application. A real callback endpoint must be public HTTPS.
4. **Cards:** Stripe Checkout Session creation and `checkout.session.completed` webhook handling are implemented. Enable the currency and settlement configuration supported by your Stripe account, register the webhook and complete test-mode verification before enabling live mode.
5. **Payment recovery:** uncertain or late provider outcomes need finance reconciliation. The platform does not yet implement refunds, chargebacks, provider settlement reporting or a human reconciliation console.
6. **Airline check-in:** the current customer check-in action updates AeroNexa's ticket status only. It does not contact an airline departure-control system, allocate a carrier seat, issue a regulated boarding pass or authorize boarding.
7. **Invitations and notices:** invitations are generated and can be shared as a link; outbound email/SMS is not configured. The notification trigger currently logs an event; configure an email/push provider to deliver messages.
8. **Identity documents:** private Firebase Storage objects use short-lived signed URLs. Configure retention, legal basis, access auditing and regional data-protection controls before storing real passports or visas.

## Repository layout

```text
aeronexa/
├── apps/web/                 # React PWA and customer/organization workspace
├── apps/api/                 # Express API and server-side business rules
├── packages/shared/          # Shared TypeScript domain contracts
├── functions/                # Firebase Cloud Functions v2
├── scripts/seed-demo.ts      # Development-only airport, admin and flight seed
├── firebase/                 # Firestore rules, indexes and Storage rules
├── docs/                     # Architecture, API and security notes
├── firebase.json
└── package.json
```

## Prerequisites

- Node.js 22 LTS or newer
- npm 10+
- Firebase project with Email/Password Authentication, Firestore and Storage enabled
- Firebase CLI: `npm install -g firebase-tools`
- Safaricom Daraja credentials for M-Pesa testing (optional until checkout testing)
- Stripe test-mode secret and webhook secret for card checkout testing (optional until checkout testing)
- Duffel access token for external offer search (optional)

## Local setup

1. Install packages at the monorepo root:

   ```bash
   npm install
   ```

2. Copy the environment templates:

   ```bash
   cp apps/web/.env.example apps/web/.env.local
   cp apps/api/.env.example apps/api/.env
   ```

   Windows PowerShell: `Copy-Item apps/web/.env.example apps/web/.env.local` and `Copy-Item apps/api/.env.example apps/api/.env`.

3. Create a Firebase Web App and set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` and `VITE_API_URL` in `apps/web/.env.local`. In Firebase Console, open **Authentication** and complete setup; under **Sign-in method**, enable **Email/Password**. Add `localhost` under **Authorized domains** for local development. The web app's Firebase project ID must match the API's `FIREBASE_PROJECT_ID`.

4. Configure the API service identity. For local use, download a Firebase service-account JSON outside source control and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in `apps/api/.env.local`. Relative credential paths are resolved from `apps/api`, regardless of the command's working directory; for a development-only credential stored at the repository root, use `GOOGLE_APPLICATION_CREDENTIALS=../../service-account.json`. Alternatively, use Application Default Credentials with `gcloud auth application-default login`. Set `FIREBASE_PROJECT_ID` and `FIREBASE_STORAGE_BUCKET` in `apps/api/.env.local`.

5. Ensure `WEB_ORIGIN=http://localhost:5173` is in the API environment. Add provider values only when you are ready to test the matching integration.

6. Deploy Firestore and Storage rules / indexes (or use the Firebase Emulator Suite during development):

   ```bash
   firebase login
   firebase use YOUR_FIREBASE_PROJECT_ID
   firebase deploy --only firestore:rules,firestore:indexes,storage
   ```

7. Start both applications:

   ```bash
   npm run dev
   ```

   - Web app: `http://localhost:5173`
   - API health: `http://localhost:4000/api/v1/health`

8. Register an account at `/register`. The public registration flow grants a customer account only; it never grants an organization or platform-admin role.

## Development seed data

The seed script creates airport catalogue entries, an active demonstration airline, sample internal schedules for future dates, and a platform-admin Firebase Auth user. Configure these variables in `apps/api/.env` first:

```dotenv
DEMO_ADMIN_EMAIL=admin@aeronexa.com
DEMO_ADMIN_PASSWORD=<your-demo-only-password>
DEMO_AIRLINE_IATA=AN
DEMO_AIRLINE_NAME=AeroNexa Airlines
DEMO_AIRLINE_LOGO_URL=/icons/aeronexa-512.png
```

The logo path uses the app's AeroNexa icon at `apps/web/public/icons/aeronexa-512.png`. The seed reads `apps/api/.env.local` first, then `apps/api/.env`. Use a password accepted by your Firebase project's password policy (at least 6 characters); demo credentials are for disposable development/staging projects only and must never be reused in production.

Then run:

```bash
npm run seed:demo
```

After seeding, sign out and back in so the Firebase ID token refreshes and receives its `platformRole` custom claim. The seed modifies Firestore inventory and must be used only in a disposable development or staging project. Do not point it at production data.

## Environment variables

See `.env.example`, `apps/web/.env.example` and `apps/api/.env.example`.

| Variable group | Variables | Notes |
|---|---|---|
| Web Firebase | `VITE_FIREBASE_*`, `VITE_API_URL` | Public client configuration only |
| Firebase Admin | `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS` | Server-only identity and private Storage bucket |
| Platform roles | `PLATFORM_ADMIN_UIDS` | Optional emergency allowlist; prefer custom claims provisioned by a trusted operator |
| Duffel | `DUFFEL_ACCESS_TOKEN` | Server-side offer search; no supplier booking flow yet |
| M-Pesa | `MPESA_ENVIRONMENT`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_URL`, `MPESA_TRANSACTION_TYPE` | Never expose these values to Vite/browser |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | Use test keys first and register the webhook endpoint |

**Never put provider secrets, service-account credentials, private keys, or admin allowlists in `VITE_*` variables.** Vite variables are bundled into the browser.

## Scripts

```bash
npm run dev          # start web + API
npm run dev:web      # web only
npm run dev:api      # API only
npm run typecheck    # API + web TypeScript checks
npm run build        # shared + API + web production builds
npm run test         # API tests
npm run seed:demo    # development-only Firestore seed
```

## Deployment

### Web application on Vercel

- Import the repository and use the repository root as the project root so the npm workspace can resolve.
- Build command: `npm run build --workspace @aeronexa/web`.
- Output directory: `apps/web/dist`.
- Set all required `VITE_*` variables in the Vercel project.
- Use the included `vercel.json` SPA rewrite so routes such as `/app/bookings` and `/app/invitations/:inviteId` resolve to the React application.
- Serve over HTTPS. Browser PWA installation requires a secure context in production.

### Express API

Deploy `apps/api` to Cloud Run or another Node.js 22+ host. Configure the service identity with Firestore, Firebase Authentication and Storage permissions. Set `PORT`, `WEB_ORIGIN` (include every trusted deployed web origin), `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET` and provider secrets in the hosting platform's secret manager. Do not upload a service-account JSON file to the source repository.

### Cloud Functions

The `expireBookingHolds` scheduled function runs every minute to release expired seat holds. Deploy with:

```bash
cd functions
npm install
npm run build
cd ..
firebase deploy --only functions
```

Scheduled Functions require a Firebase/GCP billing-enabled project and the appropriate service permissions. Validate the function against the Firebase Emulator Suite before production use.

### Payment provider configuration

- **M-Pesa:** configure the Daraja app, shortcode, passkey, environment and a public HTTPS callback URL pointing to `/api/v1/payments/mpesa/callback`. Test successful, cancelled, timeout, duplicate and amount-mismatch outcomes in the Safaricom sandbox. The API runs an STK Query before booking is ticketed.
- **Stripe:** set the secret key and success/cancel URLs. Register `https://YOUR_API_HOST/api/v1/payments/stripe/webhook` for `checkout.session.completed`, store the webhook signing secret server-side, and verify both test-mode and live-mode flows. Make sure the chosen currency is enabled for your Stripe account and settlement setup.

## Operational acceptance checklist

Before any live users or real payments:

- Install dependencies and obtain clean `npm run typecheck`, `npm run build`, `npm run test` and `npm audit` results in CI.
- Run Firebase Rules unit tests and Emulator Suite tests for customer, organization member, cross-tenant and platform-admin access.
- Verify Firestore composite indexes are deployed and confirm every collection query has bounded pagination.
- Load-test seat holds and payment race conditions; test expired holds, duplicate callbacks and provider timeouts.
- Configure M-Pesa and Stripe webhooks, test reconciliation, chargebacks, refunds and operational escalation paths.
- Integrate and test the external supplier order and ticketing workflow before displaying supplier offers as bookable.
- Integrate airline check-in / departure-control APIs before describing AeroNexa tickets as boarding passes.
- Configure email/SMS delivery, support escalation, monitoring, backups, log redaction and incident procedures.
- Complete privacy, data-protection, retention and independent security reviews for the target markets.

## Security principles

- Firebase ID tokens are verified by the API; revoked tokens are rejected.
- Organization membership and roles are read from server-owned documents. Client payloads cannot grant roles.
- Financial, booking, inventory, ticket and notification records are server-owned by Firestore rules.
- Each customer API query checks ownership; organization operations check active membership and role.
- Use provider-hosted payment collection. AeroNexa does not collect or store card PAN/CVV or M-Pesa PINs.
- Travel documents have owner-bound metadata and short-lived signed access URLs.
- Secrets stay in server environment variables or managed secret storage. Use HTTPS, restricted CORS origins and least-privilege service accounts.

## License

Proprietary project. Add the appropriate license before distributing the source.
