import { fetchWithTimeout } from '../../lib/http-client.js';
import type { GeoLookup, GeoProvider } from './provider.js';

// Answers 200 with `{"status":"fail"}` rather than an HTTP error status, so the
// body has to be inspected and not just `response.ok`.
export const ipApiProvider: GeoProvider = {
  name: 'ip-api',
  async lookup(ip, timeoutMs) {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon`;
    const response = await fetchWithTimeout(url, { timeoutMs, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`ip-api responded ${response.status}`);

    const body = (await response.json()) as Record<string, unknown>;
    if (body.status !== 'success') {
      throw new Error(`ip-api lookup failed: ${String(body.message ?? 'unknown reason')}`);
    }
    return {
      country: (body.country as string) ?? null,
      countryCode: (body.countryCode as string) ?? null,
      region: (body.regionName as string) ?? null,
      city: (body.city as string) ?? null,
      latitude: typeof body.lat === 'number' ? body.lat : null,
      longitude: typeof body.lon === 'number' ? body.lon : null,
    };
  },
};

export const ipapiCoProvider: GeoProvider = {
  name: 'ipapi-co',
  async lookup(ip, timeoutMs) {
    const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
    const response = await fetchWithTimeout(url, { timeoutMs, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`ipapi.co responded ${response.status}`);

    const body = (await response.json()) as Record<string, unknown>;
    if (body.error) throw new Error(`ipapi.co lookup failed: ${String(body.reason ?? 'unknown reason')}`);

    return {
      country: (body.country_name as string) ?? null,
      countryCode: (body.country_code as string) ?? null,
      region: (body.region as string) ?? null,
      city: (body.city as string) ?? null,
      latitude: typeof body.latitude === 'number' ? body.latitude : null,
      longitude: typeof body.longitude === 'number' ? body.longitude : null,
    };
  },
};

// Deterministic stand-ins for the fallback proof: a demonstration that depends
// on a third party actually being down is a coin flip, not a proof.
const mockProvider = (name: string, location: GeoLookup): GeoProvider => ({
  name,
  lookup: async () => location,
});

export const mockAProvider = mockProvider('mock-a', {
  country: 'Germany',
  countryCode: 'DE',
  region: 'Berlin',
  city: 'Berlin',
  latitude: 52.52,
  longitude: 13.405,
});

export const mockBProvider = mockProvider('mock-b', {
  country: 'Portugal',
  countryCode: 'PT',
  region: 'Lisboa',
  city: 'Lisbon',
  latitude: 38.7223,
  longitude: -9.1393,
});

export const PROVIDER_REGISTRY: Record<string, GeoProvider> = {
  'ip-api': ipApiProvider,
  'ipapi-co': ipapiCoProvider,
  'mock-a': mockAProvider,
  'mock-b': mockBProvider,
};
