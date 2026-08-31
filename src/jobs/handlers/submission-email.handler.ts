import { AppError } from '../../lib/errors.js';
import { submissionsRepository } from '../../repositories/submissions.repository.js';
import { mailer } from '../../services/mailer.js';
import type { SubmissionEmailPayload } from '../types.js';

export const submissionEmailHandler = async (payload: SubmissionEmailPayload): Promise<void> => {
  const submission = await submissionsRepository.findByIdForTenant(payload.submissionId, payload.tenantId);
  // The row is gone (widget or tenant deleted). Retrying cannot bring it back,
  // so this is done rather than failed.
  if (!submission) return;

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
