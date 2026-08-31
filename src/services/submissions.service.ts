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

// `.strict()` is load-bearing: without it a public endpoint would accept and
// store any extra keys the caller invented.
export const buildSubmissionSchema = (widget: Widget): z.ZodType<Record<string, unknown>> => {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of widget.fields) {
    shape[field.name] = fieldSchema(field);
  }

  // Accepted so a bot can fill it, stripped before storage.
  shape[widget.honeypotField] = z.string().max(500).optional();

  return z.object(shape).strict();
};

const fieldSchema = (field: WidgetField): z.ZodTypeAny => {
  const maxLength =
    field.maxLength ?? (field.type === 'textarea' ? TEXTAREA_MAX_LENGTH : DEFAULT_MAX_FIELD_LENGTH);

  // An unticked box posts `false`, not nothing, so a required consent checkbox
  // has to demand `true` specifically rather than merely being present.
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

  // Browsers post an untouched input as "", so without this an optional email
  // left blank would fail the email check.
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );
};

const originMatches = (allowed: string[], origin: string | null): boolean => {
  // An empty list means any origin — the normal case for a widget meant to be
  // pasted anywhere. A non-empty list is an explicit lock-down.
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

    const { [widget.honeypotField]: _honeypot, ...clean } = parsed.data;

    // Stored rather than dropped, and the caller returns the same 202 a human
    // gets: a bot that can detect it was filtered is a bot that can iterate.
    if (verdict.isSpam) {
      logger.info(
        { widgetId: widget.id, reason: verdict.reason, ip: input.context.ip },
        'submission classified as spam',
      );
      await this.store(widget, clean, input, { provider: 'none', status: 'skipped' }, verdict.reason ?? 'spam');
      return { status: 'accepted', submission: null, message: widget.successMessage };
    }

    // enrichWithGeo never throws, so nothing here can stop the row being written.
    const geo = await enrichWithGeo(input.context.ip);

    const submission = await this.store(widget, clean, input, geo, null);
    return { status: 'accepted', submission, message: widget.successMessage };
  },

  // Side effects are enqueued here, never invoked. That is what makes a failing
  // email or webhook harmless: this path only writes rows.
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
      // 23505 here means two requests raced on the same idempotency key and the
      // unique index rejected the loser. Return what the winner stored.
      if ((error as { code?: string }).code === '23505' && input.idempotencyKey) {
        const existing = await submissionsRepository.findByIdempotencyKey(widget.id, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  },
};
