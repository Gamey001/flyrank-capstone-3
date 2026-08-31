import type { GeoResult } from '../../domain/models.js';

export type GeoLookup = Omit<GeoResult, 'provider' | 'status'>;

export interface GeoProvider {
  readonly name: string;
  /**
   * Resolves an IP to a location, or throws. Throwing is the contract for
   * "this provider is unavailable" — the chain catches it and moves on.
   */
  lookup(ip: string, timeoutMs: number): Promise<GeoLookup>;
}
