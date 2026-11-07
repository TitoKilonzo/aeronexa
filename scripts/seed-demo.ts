import dotenv from 'dotenv';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const apiDirectory = resolve(process.cwd());
dotenv.config({ path: resolve(apiDirectory, '.env.local') });
dotenv.config({ path: resolve(apiDirectory, '.env') });

const projectId = process.env.FIREBASE_PROJECT_ID;
const configuredCredentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
if (!projectId && !configuredCredentialPath && !process.env.FIREBASE_CONFIG) throw new Error('Set FIREBASE_PROJECT_ID and configure GOOGLE_APPLICATION_CREDENTIALS or Google Application Default Credentials before seeding.');
if (configuredCredentialPath) {
  const credentialPath = isAbsolute(configuredCredentialPath) ? configuredCredentialPath : resolve(apiDirectory, configuredCredentialPath);
  if (!existsSync(credentialPath) || !statSync(credentialPath).isFile()) {
    throw new Error('The GOOGLE_APPLICATION_CREDENTIALS file was not found. Use an absolute path or a path relative to apps/api, such as ../../service-account.json.');
  }
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
}
if (!getApps().length) initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}), ...(process.env.FIREBASE_STORAGE_BUCKET ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET } : {}) });
const auth = getAuth();
const db = getFirestore();
const config = (() => {
  const email = process.env.DEMO_ADMIN_EMAIL;
  const password = process.env.DEMO_ADMIN_PASSWORD;
  const airlineIata = process.env.DEMO_AIRLINE_IATA?.trim().toUpperCase();
  const airlineName = process.env.DEMO_AIRLINE_NAME?.trim();
  const airlineLogoUrl = process.env.DEMO_AIRLINE_LOGO_URL?.trim();
  if (!email || !password || password.length < 6) throw new Error('Set DEMO_ADMIN_EMAIL and a DEMO_ADMIN_PASSWORD with at least 6 characters.');
  if (!airlineIata || !/^[A-Z]{2}$/.test(airlineIata)) throw new Error('Set DEMO_AIRLINE_IATA to a valid two-letter airline code.');
  if (!airlineName) throw new Error('Set DEMO_AIRLINE_NAME to the demo airline name.');
  const isAppAssetPath = Boolean(airlineLogoUrl && /^\/[A-Za-z0-9/_-]+(?:\.[A-Za-z0-9]+)?$/.test(airlineLogoUrl));
  const isHttpsUrl = Boolean(airlineLogoUrl && URL.canParse(airlineLogoUrl) && new URL(airlineLogoUrl).protocol === 'https:');
  if (!isAppAssetPath && !isHttpsUrl) throw new Error('Set DEMO_AIRLINE_LOGO_URL to a root-relative app asset path or a valid HTTPS URL.');
  return { email, password, airlineIata, airlineName, airlineLogoUrl };
})();

const airports = [
  ['NBO', 'Jomo Kenyatta International Airport', 'Nairobi', 'Kenya'],
  ['MBA', 'Moi International Airport', 'Mombasa', 'Kenya'],
  ['KIS', 'Kisumu International Airport', 'Kisumu', 'Kenya'],
  ['ELD', 'Eldoret International Airport', 'Eldoret', 'Kenya'],
  ['WIL', 'Wilson Airport', 'Nairobi', 'Kenya'],
  ['DAR', 'Julius Nyerere International Airport', 'Dar es Salaam', 'Tanzania'],
  ['JRO', 'Kilimanjaro International Airport', 'Kilimanjaro', 'Tanzania'],
  ['ZNZ', 'Abeid Amani Karume International Airport', 'Zanzibar', 'Tanzania'],
  ['KGL', 'Kigali International Airport', 'Kigali', 'Rwanda'],
  ['ADD', 'Addis Ababa Bole International Airport', 'Addis Ababa', 'Ethiopia'],
  ['DXB', 'Dubai International Airport', 'Dubai', 'United Arab Emirates'],
  ['LHR', 'Heathrow Airport', 'London', 'United Kingdom'],
  ['CPT', 'Cape Town International Airport', 'Cape Town', 'South Africa'],
];

async function main() {
  let adminUser;
  try { adminUser = await auth.getUserByEmail(config.email); }
  catch { adminUser = await auth.createUser({ email: config.email, password: config.password, displayName: 'AeroNexa Demo Administrator', emailVerified: true, disabled: false }); }
  await auth.updateUser(adminUser.uid, { password: config.password, displayName: 'AeroNexa Demo Administrator', disabled: false });
  await auth.setCustomUserClaims(adminUser.uid, { platformRole: 'platform_admin' });
  await db.collection('users').doc(adminUser.uid).set({ uid: adminUser.uid, email: config.email, displayName: 'AeroNexa Demo Administrator', status: 'active', updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  const airportBatch = db.batch();
  for (const [code, name, city, country] of airports) airportBatch.set(db.collection('airports').doc(code), { code, name, city, country, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await airportBatch.commit();

  const orgId = 'aeronexa-demo-airline';
  await db.collection('organizations').doc(orgId).set({ name: config.airlineName, logoUrl: config.airlineLogoUrl, type: 'airline', country: 'Kenya', currency: 'KES', status: 'active', ownerUid: adminUser.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('organizations').doc(orgId).collection('members').doc(adminUser.uid).set({ uid: adminUser.uid, email: config.email, role: 'organization_admin', status: 'active', joinedAt: FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('users').doc(adminUser.uid).set({ organizationIds: FieldValue.arrayUnion(orgId) }, { merge: true });

  const routes = [
    { flightNumber: 'ANX204', origin: 'NBO', destination: 'MBA', hours: 7, minutes: 15, duration: 75, fare: 1250000, currency: 'KES', seats: 120 },
    { flightNumber: 'ANX206', origin: 'NBO', destination: 'MBA', hours: 14, minutes: 30, duration: 80, fare: 1390000, currency: 'KES', seats: 88 },
    { flightNumber: 'ANX205', origin: 'MBA', destination: 'NBO', hours: 17, minutes: 0, duration: 75, fare: 1270000, currency: 'KES', seats: 96 },
    { flightNumber: 'ANX310', origin: 'NBO', destination: 'KGL', hours: 9, minutes: 20, duration: 95, fare: 1820000, currency: 'KES', seats: 110 },
    { flightNumber: 'ANX412', origin: 'NBO', destination: 'DAR', hours: 11, minutes: 10, duration: 95, fare: 1680000, currency: 'KES', seats: 104 },
    { flightNumber: 'ANX520', origin: 'NBO', destination: 'DXB', hours: 22, minutes: 0, duration: 300, fare: 3850000, currency: 'KES', seats: 160 },
    { flightNumber: 'ANX620', origin: 'NBO', destination: 'ADD', hours: 6, minutes: 40, duration: 150, fare: 2420000, currency: 'KES', seats: 128 },
  ];
  const base = new Date(); base.setUTCDate(base.getUTCDate() + 30); base.setUTCHours(0, 0, 0, 0);
  let created = 0;
  for (let day = 0; day < 5; day += 1) {
    for (const route of routes) {
      const departure = new Date(base.getTime() + day * 86400000 + route.hours * 3600000 + route.minutes * 60000);
      const arrival = new Date(departure.getTime() + route.duration * 60000);
      const flightId = `demo-${route.flightNumber}-${departure.toISOString().slice(0, 10)}`;
      const batch = db.batch();
      batch.set(db.collection('flights').doc(flightId), {
        organizationId: orgId, flightNumber: route.flightNumber, airlineName: config.airlineName, airlineCode: config.airlineIata,
        originCode: route.origin, destinationCode: route.destination,
        departureTime: departure.toISOString(), arrivalTime: arrival.toISOString(), durationMinutes: route.duration,
        stops: 0, status: 'scheduled', visibility: 'public', updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      const inventoryRef = db.collection('flight_inventory').doc(flightId);
      const existingInventory = await inventoryRef.get();
      if (existingInventory.exists) {
        batch.set(inventoryRef, { flightId, organizationId: orgId, seatCapacity: route.seats, cabinClass: 'economy', fareAmountMinor: route.fare, currency: route.currency, status: 'active', visibility: 'public', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      } else {
        batch.create(inventoryRef, { flightId, organizationId: orgId, seatCapacity: route.seats, availableSeats: route.seats, cabinClass: 'economy', fareAmountMinor: route.fare, currency: route.currency, status: 'active', visibility: 'public', updatedAt: FieldValue.serverTimestamp() });
      }
      await batch.commit(); created += 1;
    }
  }
  console.log(`AeroNexa demo data seeded. Admin: ${config.email} (${adminUser.uid}); organization: ${orgId}; demo schedules written: ${created}.`);
  console.log('Store the admin password in your approved password manager. Do not use the demo admin account for production business data.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
