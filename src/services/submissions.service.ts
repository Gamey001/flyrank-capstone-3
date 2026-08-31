import { z } from 'zod';
import { withTransaction } from '../db/pool.js';
import type { GeoResult, Submission, Widget, WidgetField } from '../domain/models.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { jobsRepository } from '../repositories/jobs.repository.js';
import { submissionsRepository } from '../repositories/submissions.repository.js';
import { widgetsRepository } from '../repositories/widgets.repository.js';
import { JOB_TYPES } from '../jobs/types.js';
import { enrichWithGeo } from './geo/enrichment.service.js';
import { spamService } from './spam.service.js';

const DEFAULT_MAX_FIELD_LENGTH = 2_000;
const TEXTAREA_MAX_LENGTH = 5_000;

export interface SubmitInput {
  widgetPublicId: string;
  data: Record<string, unknown>;
  elapsedMs?: number;
  pageUrl?: string;
  context: {
    ip: string | null;
    userAgent: string | null;
    origin: string | null;
    referer: string | null;
  };
  idempotencyKey?: string | null;
}

export interface SubmitResult {
  status: 'accepted' | 'duplicate';
  submission: Submission | null;
  message: string;
}

/**
 * Builds a validator from the widget's own field definitions.
 *
 * Validation is data-driven because the shape of a submission is data: each
 * tenant defines their own fields. `.strict()` is the important part — a
 * payload carrying keys the widget never declared is rejected rather than
 * quietly stored, so nobody can stuff arbitrary JSON into the database.
 */
export const buildSubmissionSchema = (widget: Widget): z.ZodType<Record<string, unknown>> => {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of widget.fields) {
    shape[field.name] = fieldSchema(field);
  }

  // The honeypot is accepted (a bot must be able to fill it) but never stored.
  shape[widget.honeypotField] = z.string().max(500).optional();

  return z.object(shape).strict();
};

const fieldSchema = (field: WidgetField): z.ZodTypeAny => {
  const maxLength =
    field.maxLength ?? (field.type === 'textarea' ? TEXTAREA_MAX_LENGTH : DEFAULT_MAX_FIELD_LENGTH);

  // An unticked checkbox is `false`, not a missing value, so consent-style
  // required checkboxes must be `true` specifically.
  if (field.type === 'checkbox') {
    return field.required
      ? z.literal(true, { errorMap: () => ({ message: `${field.label} is required` }) })
      : z.boolean().optional();
  }

  let schema: z.ZodTypeAny;

  if (field.type === 'select' && field.options && field.options.length > 0) {
    schema = z.enum(field.options as [string, ...string[]]);
  } else {
    let text = z.string().trim().max(maxLength, `Must be at most ${maxLength} characters`);
    if (field.required) text = text.min(1, `${field.label} is required`);

    if (field.type === 'email') text = text.max(320).email('Must be a valid email address').toLowerCase();
    else if (field.type === 'tel') {
      text = text.max(40).regex(/^[+()\-.\s\d]{5,40}$/, 'Must be a valid phone number');
    }
    schema = text;
  }

  if (field.required) return schema;

  // Browsers post untouched inputs as "", which is not the same as "the
  // visitor left this optional field out". Normalise before validating, or an
  // empty optional email would fail the email check.
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
};

const originMatches = (allowed: string[], origin: string | null): boolean => {
  // No allow-list = a widget meant for any site, which is the normal case for
  // an embeddable widget. A non-empty list is an explicit lock-down.
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.some((entry) => entry === '*' || entry.toLowerCase() === origin.toLowerCase());
};

const emailFromData = (widget: Widget, data: Record<string, unknown>): string | null => {
  const emailField = widget.fields.find((field) => field.type === 'email');
  const value = emailField ? data[emailField.name] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const submissionsService = {
  /** Resolves the widget a public request is for, or 404s. */
  async requireActiveWidget(publicId: string): Promise<Widget> {
    const widget = await widgetsRepository.findActiveByPublicId(publicId);
    if (!widget) throw AppError.notFound('Widget not found or inactive');
    return widget;
  },

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const widget = await this.requireActiveWidget(input.widgetPublicId);

    if (!originMatches(widget.allowedOrigins, input.context.origin)) {
      throw AppError.forbidden('This widget does not accept submissions from that origin');
    }

    // Idempotency (shared requirement #5). A retried POST — the visitor's
    // network dropped, the widget resent — must not create a second lead.
    if (input.idempotencyKey) {
      const existing = await submissionsRepository.findByIdempotencyKey(widget.id, input.idempotencyKey);
      if (existing) {
        return { status: 'duplicate', submission: existing, message: widget.successMessage };
      }
    }

    const parsed = buildSubmissionSchema(widget).safeParse(input.data);
    if (!parsed.success) {
      throw AppError.unprocessable(
        'Some fields are invalid',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    const verdict = spamService.check({
      widget,
      data: parsed.data,
      elapsedMs: input.elapsedMs,
      userAgent: input.context.userAgent,
    });

    // The honeypot value never reaches storage — its only job was to be filled.
    const { [widget.honeypotField]: _honeypot, ...clean } = parsed.data;

    // Spam is stored, not discarded: it is classified, counted in the
    // dashboard, and answered with the same 202 a real visitor gets, so a bot
    // learns nothing about why it was dropped.
    if (verdict.isSpam) {
      logger.info(
        { widgetId: widget.id, reason: verdict.reason, ip: input.context.ip },
        'submission classified as spam',
      );
      await this.store(widget, clean, input, { provider: 'none', status: 'skipped' }, verdict.reason ?? 'spam');
      return { status: 'accepted', submission: null, message: widget.successMessage };
    }

    // Enrichment is best-effort by construction: enrichWithGeo never throws, so
    // there is no failure here that could stop the row being written.
    const geo = await enrichWithGeo(input.context.ip);

    const submission = await this.store(widget, clean, input, geo, null);
    return { status: 'accepted', submission, message: widget.successMessage };
  },

  /**
   * Writes the submission and enqueues its side effects in one transaction.
   *
   * The email and the webhook go into the `jobs` table rather than being fired
   * here. That is what makes a failing side effect harmless: the request path
   * only writes rows, and anything that can fail happens later, with retries,
   * in the worker.
   */
  async store(
    widget: Widget,
    data: Record<string, unknown>,
    input: SubmitInput,
    geo: GeoResult,
    spamReason: string | null,
  ): Promise<Submission> {
    try {
      return await withTransaction(async (client) => {
        const submission = await submissionsRepository.create(
          {
            widgetId: widget.id,
            tenantId: widget.tenantId,
            status: spamReason ? 'spam' : 'stored',
            spamReason,
            data,
            email: emailFromData(widget, data),
            ipAddress: input.context.ip,
            userAgent: input.context.userAgent,
            origin: input.context.origin,
            referer: input.context.referer,
            pageUrl: input.pageUrl ?? null,
            geo,
            idempotencyKey: input.idempotencyKey ?? null,
          },
          client,
        );

        // Spam does not deserve a notification email.
        if (!spamReason) {
          if (widget.notifyEmail) {
            await jobsRepository.enqueue(
              {
                type: JOB_TYPES.submissionEmail,
                payload: {
                  submissionId: submission.id,
                  widgetId: widget.id,
                  tenantId: widget.tenantId,
                  to: widget.notifyEmail,
                  widgetName: widget.name,
                },
              },
              client,
            );
          }
          if (widget.webhookUrl) {
            await jobsRepository.enqueue(
              {
                type: JOB_TYPES.submissionWebhook,
                payload: {
                  submissionId: submission.id,
                  widgetId: widget.id,
                  tenantId: widget.tenantId,
                  url: widget.webhookUrl,
                },
              },
              client,
            );
          }
        }

        return submission;
      });
    } catch (error) {
      // Two requests raced with the same idempotency key: the unique index did
      // its job. Return the row the winner stored.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        const existing = await submissionsRepository.findByIdempotencyKey(widget.id, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  },
};
