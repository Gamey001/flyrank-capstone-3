import { env } from '../../config/env.js';
import type { GeoResult } from '../../domain/models.js';
import { isPrivateIp } from '../../lib/net.js';
import { logger } from '../../lib/logger.js';
import type { GeoProvider } from './provider.js';
import { PROVIDER_REGISTRY } from './providers.js';

export interface EnrichmentOptions {
  providers?: GeoProvider[];
  forceDown?: string[];
  timeoutMs?: number;
}

const NO_GEO = (status: GeoResult['status'], provider = 'none'): GeoResult => ({
  provider,
  status,
  country: null,
  countryCode: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
});

export const resolveProviderChain = (names: string[]): GeoProvider[] => {
  const chain: GeoProvider[] = [];
  for (const name of names) {
    const provider = PROVIDER_REGISTRY[name];
    if (!provider) {
      logger.warn({ provider: name }, 'unknown geo provider in GEO_PROVIDERS, skipping');
      continue;
    }
    chain.push(provider);
  }
  return chain;
};

/**
 * Turns an IP into a location by trying providers in order.
 *
 * The whole point of this function is that it never throws. A submission is the
 * visitor's data; geo is something we bolt on afterwards. Every failure mode —
 * every provider down, a timeout, a garbage response, no providers configured
 * at all — resolves to `status: 'unavailable'` and the submission proceeds.
 */
export const enrichWithGeo = async (
  ip: string | null,
  options: EnrichmentOptions = {},
): Promise<GeoResult> => {
  if (!ip || isPrivateIp(ip)) {
    // Private and loopback addresses have no public location. Asking a provider
    // burns quota to be told so.
    return NO_GEO('skipped');
  }

  const forceDown = new Set(options.forceDown ?? env.GEO_FORCE_DOWN);
  const timeoutMs = options.timeoutMs ?? env.GEO_TIMEOUT_MS;
  const chain = options.providers ?? resolveProviderChain(env.GEO_PROVIDERS);

  if (chain.length === 0) return NO_GEO('unavailable');

  const failures: { provider: string; error: string }[] = [];

  for (const provider of chain) {
    if (forceDown.has(provider.name)) {
      failures.push({ provider: provider.name, error: 'forced down via GEO_FORCE_DOWN' });
      continue;
    }
    try {
      const location = await provider.lookup(ip, timeoutMs);
      if (failures.length > 0) {
        logger.info({ provider: provider.name, failures }, 'geo enrichment recovered via fallback provider');
      }
      return { provider: provider.name, status: 'enriched', ...location };
    } catch (error) {
      failures.push({ provider: provider.name, error: (error as Error).message });
    }
  }

  // Chain exhausted. Degrade, never fail.
  logger.warn({ failures }, 'geo enrichment unavailable; storing submission without geo data');
  return NO_GEO('unavailable');
};
