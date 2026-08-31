export const JOB_TYPES = {
  submissionEmail: 'submission.notify_email',
  submissionWebhook: 'submission.webhook',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface SubmissionEmailPayload extends Record<string, unknown> {
  submissionId: string;
  widgetId: string;
  tenantId: string;
  to: string;
  widgetName: string;
}

export interface SubmissionWebhookPayload extends Record<string, unknown> {
  submissionId: string;
  widgetId: string;
  tenantId: string;
  url: string;
}
