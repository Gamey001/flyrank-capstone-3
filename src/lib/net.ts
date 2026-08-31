import { isIP } from 'node:net';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

// Note an unparseable address answers `true`: callers use this to decide
// whether a geo lookup is worth attempting, and garbage never is.
export const isPrivateIp = (ip: string): boolean => {
  const version = isIP(ip);
  if (version === 0) return true;
  if (version === 4) return PRIVATE_V4.some((pattern) => pattern.test(ip));

  const normalised = ip.toLowerCase();
  if (normalised === '::1' || normalised === '::') return true;
  if (normalised.startsWith('fc') || normalised.startsWith('fd')) return true; // unique local
  if (normalised.startsWith('fe80')) return true; // link local
  if (normalised.startsWith('::ffff:')) return isPrivateIp(normalised.slice(7));
  return false;
};

export const isValidIp = (ip: string): boolean => isIP(ip) !== 0;
