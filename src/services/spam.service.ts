import { env } from '../config/env.js';
import type { Widget } from '../domain/models.js';

export interface SpamVerdict {
  isSpam: boolean;
  reason?: string;
}

const CLEAN: SpamVerdict = { isSpam: false };

export interface SpamCheckInput {
  widget: Widget;
  /** Raw submitted fields, before the honeypot field is stripped. */
  data: Record<string, unknown>;
  /** Milliseconds between the widget rendering and the visitor submitting. */
  elapsedMs?: number;
  userAgent?: string | null;
}

// Bots that announce themselves. A determined attacker changes the UA, which is
// exactly why this is one signal of three rather than the whole defence.
const BOT_USER_AGENTS = /(curlbot|python-requests|scrapy|httpclient|bot\/|spider|crawler|headlesschrome)/i;

const LINK_PATTERN = /https?:\/\//gi;

/**
 * Layered spam detection. Each check is cheap, runs before anything touches the
 * database, and returns a reason so the dashboard can show *why* something was
 * classed as spam rather than just a count.
 */
export const spamService = {
  check(input: SpamCheckInput): SpamVerdict {
    const { widget, data } = input;

    // 1. Honeypot. A field the widget renders hidden and off-screen: a human
    //    never sees it, an automated form filler fills every input it finds.
    const honeypotValue = data[widget.honeypotField];
    if (typeof honeypotValue === 'string' && honeypotValue.trim() !== '') {
      return { isSpam: true, reason: 'honeypot_filled' };
    }

    // 2. Time-to-fill. Real people take seconds to type; a script posts the
    //    form the instant it loads.
    if (
      env.SPAM_MIN_FILL_MS > 0 &&
      typeof input.elapsedMs === 'number' &&
      Number.isFinite(input.elapsedMs) &&
      input.elapsedMs >= 0 &&
      input.elapsedMs < env.SPAM_MIN_FILL_MS
    ) {
      return { isSpam: true, reason: 'submitted_too_fast' };
    }

    // 3. Content heuristics: link-stuffing is the signature of comment spam.
    const textValues = Object.entries(data)
      .filter(([key]) => key !== widget.honeypotField)
      .map(([, value]) => (typeof value === 'string' ? value : ''))
      .join(' ');

    const linkCount = textValues.match(LINK_PATTERN)?.length ?? 0;
    if (linkCount >= 3) return { isSpam: true, reason: 'excessive_links' };

    if (input.userAgent && BOT_USER_AGENTS.test(input.userAgent)) {
      return { isSpam: true, reason: 'bot_user_agent' };
    }

    return CLEAN;
  },
};
