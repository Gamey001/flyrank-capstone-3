import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l/1/0/o — read aloud safely

/**
 * Public widget id. It travels in a <script src> on someone else's website, so
 * it must be short, URL-safe, and unguessable enough that nobody can enumerate
 * another tenant's widget config.
 */
export const publicWidgetId = (length = 16): string => {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
};

export const uuid = (): string => randomUUID();
