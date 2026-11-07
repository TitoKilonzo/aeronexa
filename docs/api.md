# API reference

Base path: `/api/v1`. Protected routes require `Authorization: Bearer <Firebase ID token>`. JSON errors use the API error middleware format.

## Health and identity

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | Public | API and Firebase readiness |
| GET | `/me` | User | Current profile |
| PATCH | `/profile` | User | Update display name and phone |
| GET | `/dashboard/summary` | User | Customer dashboard counts |

## Flights and organizations

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/airports?q=` | Public | Airport catalogue search |
| GET | `/flights/search` | Public | Internal schedule + configured Duffel offer search |
| GET | `/flights/:flightId` | Public | Internal flight and inventory details |
| POST | `/flights` | Organization admin / operations manager | Publish an internal flight and inventory record |
| PATCH | `/flights/:flightId/status` | Owning organization admin / operations manager | Update flight state |
| GET | `/organizations/mine` | User | Current memberships |
| POST | `/organizations` | User | Create pending airline / agency |
| GET | `/organizations/:orgId/flights` | Authorized organization member | List organization schedules |
| POST | `/organizations/:orgId/invitations` | Organization admin | Create seven-day invitation |
| POST | `/organizations/invitations/:inviteId/accept` | Matching signed-in email | Accept invitation |
| PATCH | `/organizations/:orgId/members/:uid` | Organization admin | Change member role |
| GET | `/platform/organizations/pending` | Platform admin | Approval queue |
| POST | `/platform/organizations/:orgId/approve` | Platform admin | Approve or suspend organization |

## Booking, passenger, payment and ticket flows

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/bookings` | User | Create 15-minute internal seat hold |
| GET | `/bookings` | User | Own bookings |
| GET | `/bookings/:bookingId` | Owner | Booking detail |
| POST | `/bookings/:bookingId/cancel` | Owner | Cancel unpaid hold (not payment-in-progress) |
| GET / POST | `/passengers` | User | List / save passenger profiles |
| DELETE | `/passengers/:passengerId` | Owner | Delete saved profile |
| POST | `/payments` | Owner | Initiate `mpesa` or `card` payment |
| GET | `/payments` | User | Own payment history |
| GET | `/payments/:paymentId` | Owner | Payment status |
| POST | `/payments/mpesa/callback` | Provider callback | Daraja callback + STK Query reconciliation |
| POST | `/payments/stripe/webhook` | Stripe signature | Stripe Checkout webhook |
| GET | `/tickets` | User | Issued e-tickets |
| POST | `/tickets/:ticketId/check-in` | Ticket owner | AeroNexa check-in state update (not airline DCS check-in) |

## Operations and documents

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/notifications` | User | Own notification feed |
| POST | `/notifications/:notificationId/read` | Owner | Mark notification as read |
| GET | `/travel-documents` | User | Own document metadata |
| POST | `/travel-documents/upload-url` | User | Create short-lived private upload URL |
| POST | `/travel-documents/:documentId/complete` | Owner | Validate and complete upload |
| GET | `/travel-documents/:documentId/download-url` | Owner | Create short-lived private download URL |
| DELETE | `/travel-documents/:documentId` | Owner | Delete document and object |
| GET | `/organizations/:orgId/operations/overview` | Authorized organization member | Flight, booking and revenue summary |

## Important conventions

- Money is stored in integer minor units. Currency is carried with every booking and payment.
- Only internal AeroNexa flights are currently bookable. Duffel search results are quote-only.
- Seat inventory is decremented inside a Firestore transaction when the booking is created; a scheduled function releases expired holds.
- A ticket is only created after payment confirmation. Payment-provider callbacks must be idempotent and are reconciled against the stored payment record.
- The API uses bounded collection reads; production workloads should add cursor pagination before datasets approach the current page caps.
