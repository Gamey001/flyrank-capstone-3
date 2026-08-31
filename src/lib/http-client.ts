import { AppError } from './errors.js';

/**
 * `fetch` with a hard deadline. Every outbound call in this codebase goes
 * through it: a third party that never answers must not hold a request (or a
 * worker slot) open indefinitely.
 */
export const fetchWithTimeout = async (
  url: string,
  options: RequestInit & { timeoutMs: number },
): Promise<Response> => {
  const { timeoutMs, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError(504, 'upstream_timeout', `Request to ${new URL(url).host} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
