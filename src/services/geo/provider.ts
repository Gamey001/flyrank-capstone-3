import type { GeoResult } from '../../domain/models.js';

export type GeoLookup = Omit<GeoResult, 'provider' | 'status'>;

export interface GeoProvider {
  readonly name: string;
  // Throwing is the contract for "unavailable": the chain catches it and moves
  // on to the next provider.
  lookup(ip: string, timeoutMs: number): Promise<GeoLookup>;
}
