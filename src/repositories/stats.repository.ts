import { pool, type Queryable } from '../db/pool.js';

export interface TotalsRow {
  total: number;
  stored: number;
  spam: number;
  enriched: number;
  last_24h: number;
}

export interface TimeseriesPoint {
  bucket: string;
  stored: number;
  spam: number;
}

export interface WidgetStatsRow {
  widget_id: string;
  widget_name: string;
  public_id: string;
  stored: number;
  spam: number;
  last_submission_at: Date | null;
}

export interface GeoBreakdownRow {
  country_code: string | null;
  country: string | null;
  submissions: number;
}

export const statsRepository = {
  async totals(tenantId: string, since: Date, db: Queryable = pool): Promise<TotalsRow> {
    const { rows } = await db.query<TotalsRow>(
      `SELECT
         count(*)::bigint                                                    AS total,
         count(*) FILTER (WHERE status = 'stored')::bigint                   AS stored,
         count(*) FILTER (WHERE status = 'spam')::bigint                     AS spam,
         count(*) FILTER (WHERE geo_status = 'enriched')::bigint             AS enriched,
         count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::bigint AS last_24h
       FROM submissions
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, since],
    );
    return rows[0] ?? { total: 0, stored: 0, spam: 0, enriched: 0, last_24h: 0 };
  },

  async timeseries(
    tenantId: string,
    options: { since: Date; granularity: 'hour' | 'day' },
    db: Queryable = pool,
  ): Promise<TimeseriesPoint[]> {
    // Interpolated, not parameterised, because date_trunc's unit cannot be a
    // bind parameter. Safe only because this ternary can yield two literals.
    const unit = options.granularity === 'hour' ? 'hour' : 'day';
    const { rows } = await db.query<{ bucket: Date; stored: number; spam: number }>(
      `SELECT date_trunc('${unit}', created_at) AS bucket,
              count(*) FILTER (WHERE status = 'stored')::bigint AS stored,
              count(*) FILTER (WHERE status = 'spam')::bigint   AS spam
       FROM submissions
       WHERE tenant_id = $1 AND created_at >= $2
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [tenantId, options.since],
    );
    return rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      stored: row.stored,
      spam: row.spam,
    }));
  },

  async perWidget(tenantId: string, since: Date, db: Queryable = pool): Promise<WidgetStatsRow[]> {
    // LEFT JOIN so a widget with no submissions still appears, with zeros.
    const { rows } = await db.query<WidgetStatsRow>(
      `SELECT w.id  AS widget_id,
              w.name AS widget_name,
              w.public_id,
              count(s.id) FILTER (WHERE s.status = 'stored')::bigint AS stored,
              count(s.id) FILTER (WHERE s.status = 'spam')::bigint   AS spam,
              max(s.created_at)                                      AS last_submission_at
       FROM widgets w
       LEFT JOIN submissions s ON s.widget_id = w.id AND s.created_at >= $2
       WHERE w.tenant_id = $1 AND w.deleted_at IS NULL
       GROUP BY w.id, w.name, w.public_id
       ORDER BY stored DESC, w.created_at DESC`,
      [tenantId, since],
    );
    return rows;
  },

  async geoBreakdown(
    tenantId: string,
    options: { since: Date; limit: number },
    db: Queryable = pool,
  ): Promise<GeoBreakdownRow[]> {
    const { rows } = await db.query<GeoBreakdownRow>(
      `SELECT country_code, max(country) AS country, count(*)::bigint AS submissions
       FROM submissions
       WHERE tenant_id = $1 AND created_at >= $2 AND status = 'stored'
       GROUP BY country_code
       ORDER BY submissions DESC
       LIMIT $3`,
      [tenantId, options.since, options.limit],
    );
    return rows;
  },
};
