export type OrganizationType = 'airline' | 'travel_agency';
export type PlatformRole = 'platform_admin' | 'organization_admin' | 'operations_manager' | 'booking_officer' | 'finance_officer' | 'checkin_officer' | 'travel_agent' | 'customer';
export type FlightStatus = 'scheduled' | 'boarding' | 'departed' | 'arrived' | 'delayed' | 'cancelled';
export type BookingStatus = 'pending' | 'held' | 'confirmed' | 'cancelled' | 'expired' | 'ticketing_failed' | 'ticketed';
export interface Organization { id: string; name: string; type: OrganizationType; country: string; currency: string; status: 'pending' | 'active' | 'suspended'; createdAt: string; }
export interface FlightSearchRequest { origin: string; destination: string; departureDate: string; returnDate?: string; adults: number; cabinClass: 'economy' | 'premium_economy' | 'business' | 'first'; }
export interface Money { amountMinor: number; currency: string; }
