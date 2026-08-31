import { fetchWithTimeout } from '../../lib/http-client.js';
import type { GeoLookup, GeoProvider } from './provider.js';

/**
 * ip-api.com — free, no key, 45 requests/minute from one IP.
 * Note it answers 200 with `{"status":"fail"}` rather than an HTTP error, so
 * the body has to be inspected, not just the status code.
 */
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

/** ipapi.co — free tier, ~1,000 lookups/day, no card. Second in the chain. */
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

/**
 * Deterministic providers used to prove the fallback chain.
 *
 * The brief asks for the fallback proof to be reproducible, and a proof that
 * depends on a third party being down is not a proof. These answer instantly
 * and can be switched off with GEO_FORCE_DOWN, so probe 4 gives the same
 * result on every machine, offline included.
 */
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
