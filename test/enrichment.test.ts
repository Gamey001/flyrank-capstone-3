import { describe, expect, it, vi } from 'vitest';
import { enrichWithGeo } from '../src/services/geo/enrichment.service.js';
import type { GeoProvider } from '../src/services/geo/provider.js';
import { isPrivateIp } from '../src/lib/net.js';

/**
 * The fallback chain, proved deterministically with stub providers.
 *
 * A test that depended on ip-api.com actually being down would not be a test —
 * it would be a coin flip. These providers answer or throw on command, so the
 * degradation behaviour is pinned exactly.
 */

const working = (name: string, city: string): GeoProvider => ({
  name,
  lookup: async () => ({ country: 'Testland', countryCode: 'TL', region: 'Region', city, latitude: 1, longitude: 2 }),
});

const down = (name: string): GeoProvider => ({
  name,
  lookup: async () => {
    throw new Error(`${name} is unreachable`);
  },
});

const slow = (name: string, delayMs: number): GeoProvider => ({
  name,
  lookup: (_ip, timeoutMs) =>
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), delayMs);
    }),
});

const PUBLIC_IP = '8.8.8.8';

describe('geo enrichment fallback chain', () => {
  it('uses provider A when it answers, and never calls provider B', async () => {
    const providerB = { name: 'b', lookup: vi.fn() };
    const result = await enrichWithGeo(PUBLIC_IP, {
      providers: [working('a', 'Berlin'), providerB as unknown as GeoProvider],
    });

    expect(result).toMatchObject({ provider: 'a', status: 'enriched', city: 'Berlin' });
    expect(providerB.lookup).not.toHaveBeenCalled();
  });

  it('falls through to provider B when A is down', async () => {
    const result = await enrichWithGeo(PUBLIC_IP, { providers: [down('a'), working('b', 'Lisbon')] });
    expect(result).toMatchObject({ provider: 'b', status: 'enriched', city: 'Lisbon' });
  });

  it('still succeeds — without geo — when every provider is down', async () => {
    const result = await enrichWithGeo(PUBLIC_IP, { providers: [down('a'), down('b')] });

    // Degrade, never fail: the caller gets a usable result, not an exception.
    expect(result.status).toBe('unavailable');
    expect(result.country).toBeNull();
    expect(result.city).toBeNull();
  });

  it('treats a hung provider as down rather than waiting on it', async () => {
    const started = Date.now();
    const result = await enrichWithGeo(PUBLIC_IP, {
      providers: [slow('a', 50), working('b', 'Madrid')],
      timeoutMs: 30,
    });

    expect(result).toMatchObject({ provider: 'b', status: 'enriched' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('honours GEO_FORCE_DOWN, which is how the fallback is demonstrated', async () => {
    const result = await enrichWithGeo(PUBLIC_IP, {
      providers: [working('mock-a', 'Berlin'), working('mock-b', 'Lisbon')],
      forceDown: ['mock-a'],
    });
    expect(result).toMatchObject({ provider: 'mock-b', status: 'enriched', city: 'Lisbon' });

    const bothDown = await enrichWithGeo(PUBLIC_IP, {
      providers: [working('mock-a', 'Berlin'), working('mock-b', 'Lisbon')],
      forceDown: ['mock-a', 'mock-b'],
    });
    expect(bothDown.status).toBe('unavailable');
  });

  it('skips lookups for addresses no provider could resolve', async () => {
    const providers = [{ name: 'a', lookup: vi.fn() } as unknown as GeoProvider];

    for (const ip of ['127.0.0.1', '::1', '10.0.0.4', '192.168.1.20', '172.16.9.9', '::ffff:127.0.0.1', null]) {
      const result = await enrichWithGeo(ip, { providers });
      expect(result.status).toBe('skipped');
    }
    expect((providers[0]!.lookup as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('never throws, whatever a provider does', async () => {
    const hostile: GeoProvider = {
      name: 'hostile',
      lookup: async () => {
        throw Object.assign(new Error('boom'), { name: 'WeirdError' });
      },
    };
    await expect(enrichWithGeo(PUBLIC_IP, { providers: [hostile] })).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(enrichWithGeo(PUBLIC_IP, { providers: [] })).resolves.toMatchObject({ status: 'unavailable' });
  });
});

describe('private address detection', () => {
  it('classifies addresses a geo provider cannot resolve', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.20.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // just outside the private range
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(true); // unusable, so treated as unresolvable
  });
});
