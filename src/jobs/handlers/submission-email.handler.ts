import { AppError } from '../../lib/errors.js';
import { submissionsRepository } from '../../repositories/submissions.repository.js';
import { mailer } from '../../services/mailer.js';
import type { SubmissionEmailPayload } from '../types.js';

/**
 * Notifies the widget owner that a lead arrived. Runs off the request path, so
 * a slow or broken mail provider costs the visitor nothing.
 */
export const submissionEmailHandler = async (payload: SubmissionEmailPayload): Promise<void> => {
  const submission = await submissionsRepository.findByIdForTenant(payload.submissionId, payload.tenantId);
  if (!submission) {
    // The submission is gone (widget deleted, tenant closed). Nothing to send
    // and retrying will not bring it back — treat as done, not as a failure.
    return;
  }

  const lines = Object.entries(submission.data).map(([key, value]) => `  ${key}: ${String(value)}`);
  const location = submission.city
    ? `${submission.city}, ${submission.country ?? submission.countryCode ?? 'unknown'}`
    : (submission.country ?? 'unknown');

  await mailer.send({
    to: payload.to,
    subject: `New submission on "${payload.widgetName}"`,
    text: [
      `A new submission arrived on your widget "${payload.widgetName}".`,
      '',
      ...lines,
      '',
      `Location: ${location} (source: ${submission.geoProvider ?? 'none'}/${submission.geoStatus})`,
      `Page:     ${submission.pageUrl ?? 'unknown'}`,
      `Received: ${submission.createdAt.toISOString()}`,
      `Id:       ${submission.id}`,
    ].join('\n'),
  });
};

export const assertEmailPayload = (payload: Record<string, unknown>): SubmissionEmailPayload => {
  if (typeof payload.submissionId !== 'string' || typeof payload.to !== 'string') {
    throw AppError.badRequest('submission.notify_email job has a malformed payload');
  }
  return payload as SubmissionEmailPayload;
};
