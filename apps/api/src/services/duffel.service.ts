import { HttpError } from '../shared/http.js';

const DUFFEL_URL = 'https://api.duffel.com';

type DuffelOffer = Record<string, any>;

async function duffelRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.DUFFEL_ACCESS_TOKEN;
  if (!token) throw new HttpError(503, 'External flight search is not configured. Add DUFFEL_ACCESS_TOKEN on the API server.');
  const response = await fetch(`${DUFFEL_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'Duffel-Version': 'v2',
      Authorization: `Bearer ${token}`, ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as { data?: any; errors?: Array<{ message?: string }> };
  if (!response.ok) throw new HttpError(response.status >= 500 ? 502 : 422, payload.errors?.[0]?.message ?? 'The external flight supplier could not complete the request.');
  return payload as T;
}

export async function searchDuffelOffers(input: {
  origin: string; destination: string; departureDate: string; returnDate?: string;
  adults: number; cabinClass: string;
}) {
  const slices = [{ origin: input.origin.toUpperCase(), destination: input.destination.toUpperCase(), departure_date: input.departureDate }];
  if (input.returnDate) slices.push({ origin: input.destination.toUpperCase(), destination: input.origin.toUpperCase(), departure_date: input.returnDate });
  const request = await duffelRequest<{ data: { id: string; offers?: DuffelOffer[] } }>('/air/offer_requests?return_offers=true', {
    method: 'POST', body: JSON.stringify({ data: {
      slices,
      passengers: Array.from({ length: input.adults }, () => ({ type: 'adult' })),
      cabin_class: input.cabinClass,
    } }),
  });
  const offers = request.data.offers ?? [];
  return offers.map((offer) => {
    const segments = (offer.slices ?? []).flatMap((slice: any) => slice.segments ?? []);
    const first = segments[0];
    const last = segments[segments.length - 1];
    return {
      id: offer.id,
      source: 'duffel',
      offerRequestId: request.data.id,
      airline: first?.marketing_carrier?.name ?? first?.operating_carrier?.name ?? 'Airline',
      airlineCode: first?.marketing_carrier?.iata_code ?? '',
      flightNumber: first?.marketing_carrier_flight_number ?? '',
      origin: first?.origin?.iata_code ?? input.origin.toUpperCase(),
      destination: last?.destination?.iata_code ?? input.destination.toUpperCase(),
      departureTime: first?.departing_at ?? null,
      arrivalTime: last?.arriving_at ?? null,
      duration: offer.total_duration ?? null,
      stops: Math.max(0, segments.length - (offer.slices?.length ?? 1)),
      amount: Number.parseFloat(offer.total_amount ?? '0'),
      currency: offer.total_currency ?? 'USD',
      expiresAt: offer.expires_at ?? null,
      paymentRequiresInstant: offer.payment_requirements?.requires_instant_payment ?? true,
      bookable: false,
      providerMessage: 'Supplier fare displayed. Direct supplier settlement must be enabled before checkout.',
    };
  });
}

export async function getDuffelOffer(offerId: string) {
  const result = await duffelRequest<{ data: DuffelOffer }>(`/air/offers/${encodeURIComponent(offerId)}`);
  return result.data;
}

export async function createDuffelHoldOrder(input: { offerId: string; passengers: Array<Record<string, unknown>> }) {
  const offer = await getDuffelOffer(input.offerId);
  if (offer.payment_requirements?.requires_instant_payment !== false) {
    throw new HttpError(422, 'This supplier offer requires instant supplier payment and cannot be placed on a customer payment hold.');
  }
  const passengers = input.passengers.map((passenger) => ({
    type: 'adult', title: passenger.title ?? 'mr', given_name: passenger.givenName,
    family_name: passenger.familyName, born_on: passenger.dateOfBirth,
    email: passenger.email, phone_number: passenger.phoneNumber,
  }));
  const result = await duffelRequest<{ data: Record<string, any> }>('/air/orders', {
    method: 'POST', body: JSON.stringify({ data: { type: 'hold', selected_offers: [input.offerId], passengers } }),
  });
  return result.data;
}

export async function payDuffelOrderFromBalance(orderId: string) {
  const result = await duffelRequest<{ data: Record<string, any> }>(`/air/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST', body: JSON.stringify({ data: { type: 'balance' } }),
  });
  return result.data;
}
