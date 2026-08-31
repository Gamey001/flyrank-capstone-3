import { AppError } from '../../lib/errors.js';
import { fetchWithTimeout } from '../../lib/http-client.js';
import { submissionsRepository } from '../../repositories/submissions.repository.js';
import type { SubmissionWebhookPayload } from '../types.js';

const WEBHOOK_TIMEOUT_MS = 5_000;

// Retried by the worker on failure, so the delivery header carries the
// submission id for a receiver to de-duplicate on.
export const submissionWebhookHandler = async (payload: SubmissionWebhookPayload): Promise<void> => {
  const submission = await submissionsRepository.findByIdForTenant(payload.submissionId, payload.tenantId);
  if (!submission) return;

  const response = await fetchWithTimeout(payload.url, {
    method: 'POST',
    timeoutMs: WEBHOOK_TIMEOUT_MS,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'flyrank-widget-platform/1.0',
      'x-flyrank-event': 'submission.created',
      'x-flyrank-delivery': submission.id,
    },
    body: JSON.stringify({
      event: 'submission.created',
      submission: {
        id: submission.id,
        widgetId: submission.widgetId,
        createdAt: submission.createdAt,
        data: submission.data,
        geo: {
          status: submission.geoStatus,
          provider: submission.geoProvider,
          country: submission.country,
          countryCode: submission.countryCode,
          city: submission.city,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`webhook ${payload.url} responded ${response.status}`);
  }
};

export const assertWebhookPayload = (payload: Record<string, unknown>): SubmissionWebhookPayload => {
  if (typeof payload.submissionId !== 'string' || typeof payload.url !== 'string') {
    throw AppError.badRequest('submission.webhook job has a malformed payload');
  }
  return payload as SubmissionWebhookPayload;
};
