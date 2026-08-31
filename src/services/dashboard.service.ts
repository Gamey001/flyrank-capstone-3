import type { Submission, SubmissionStatus } from '../domain/models.js';
import { AppError } from '../lib/errors.js';
import { statsRepository } from '../repositories/stats.repository.js';
import { submissionsRepository } from '../repositories/submissions.repository.js';
import { widgetsRepository } from '../repositories/widgets.repository.js';

export interface SubmissionQuery {
  widgetId?: string;
  status?: SubmissionStatus;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface StatsQuery {
  days: number;
  granularity: 'hour' | 'day';
}

export const dashboardService = {
  async listSubmissions(
    tenantId: string,
    query: SubmissionQuery,
  ): Promise<{ items: Submission[]; total: number }> {
    // Filtering by a widget that is not yours must 404 rather than silently
    // return an empty page — the tenant check happens before the query, and
    // again inside it.
    if (query.widgetId) {
      const widget = await widgetsRepository.findByIdForTenant(query.widgetId, tenantId);
      if (!widget) throw AppError.notFound('Widget not found');
    }
    return submissionsRepository.listForTenant({ tenantId, ...query });
  },

  async getSubmission(tenantId: string, submissionId: string): Promise<Submission> {
    const submission = await submissionsRepository.findByIdForTenant(submissionId, tenantId);
    if (!submission) throw AppError.notFound('Submission not found');
    return submission;
  },

  async stats(tenantId: string, query: StatsQuery) {
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

    // Four independent aggregations over the same window — issued together so
    // the dashboard costs one round trip's latency, not four.
    const [totals, timeseries, perWidget, geo] = await Promise.all([
      statsRepository.totals(tenantId, since),
      statsRepository.timeseries(tenantId, { since, granularity: query.granularity }),
      statsRepository.perWidget(tenantId, since),
      statsRepository.geoBreakdown(tenantId, { since, limit: 20 }),
    ]);

    return {
      window: { since: since.toISOString(), days: query.days, granularity: query.granularity },
      totals: {
        submissions: totals.total,
        stored: totals.stored,
        spam: totals.spam,
        enriched: totals.enriched,
        last24h: totals.last_24h,
      },
      timeseries,
      widgets: perWidget.map((row) => ({
        widgetId: row.widget_id,
        name: row.widget_name,
        publicId: row.public_id,
        stored: row.stored,
        spam: row.spam,
        lastSubmissionAt: row.last_submission_at,
      })),
      geo: geo.map((row) => ({
        countryCode: row.country_code,
        country: row.country,
        submissions: row.submissions,
      })),
    };
  },
};
