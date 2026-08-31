import { pool, type Queryable } from '../db/pool.js';
import type { GeoResult, Submission, SubmissionStatus } from '../domain/models.js';
import { toSubmission, type SubmissionRow } from './rows.js';

const COLUMNS = `id, widget_id, tenant_id, status, spam_reason, data, email, host(ip_address) AS ip_address,
                 user_agent, origin, referer, page_url, geo_provider, geo_status, country, country_code,
                 region, city, latitude, longitude, idempotency_key, created_at`;

export interface CreateSubmissionInput {
  widgetId: string;
  tenantId: string;
  status: SubmissionStatus;
  spamReason?: string | null;
  data: Record<string, unknown>;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  referer?: string | null;
  pageUrl?: string | null;
  geo: GeoResult;
  idempotencyKey?: string | null;
}

export interface ListSubmissionsFilter {
  tenantId: string;
  widgetId?: string;
  status?: SubmissionStatus;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export const submissionsRepository = {
  async create(input: CreateSubmissionInput, db: Queryable = pool): Promise<Submission> {
    const { rows } = await db.query<SubmissionRow>(
      `INSERT INTO submissions (widget_id, tenant_id, status, spam_reason, data, email, ip_address,
                                user_agent, origin, referer, page_url, geo_provider, geo_status,
                                country, country_code, region, city, latitude, longitude, idempotency_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::inet, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING ${COLUMNS}`,
      [
        input.widgetId,
        input.tenantId,
        input.status,
        input.spamReason ?? null,
        JSON.stringify(input.data),
        input.email ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.origin ?? null,
        input.referer ?? null,
        input.pageUrl ?? null,
        input.geo.provider,
        input.geo.status,
        input.geo.country ?? null,
        input.geo.countryCode ?? null,
        input.geo.region ?? null,
        input.geo.city ?? null,
        input.geo.latitude ?? null,
        input.geo.longitude ?? null,
        input.idempotencyKey ?? null,
      ],
    );
    return toSubmission(rows[0]!);
  },

  /** Idempotency lookup: the row a previous request with this key already stored. */
  async findByIdempotencyKey(
    widgetId: string,
    idempotencyKey: string,
    db: Queryable = pool,
  ): Promise<Submission | null> {
    const { rows } = await db.query<SubmissionRow>(
      `SELECT ${COLUMNS} FROM submissions WHERE widget_id = $1 AND idempotency_key = $2`,
      [widgetId, idempotencyKey],
    );
    return rows[0] ? toSubmission(rows[0]) : null;
  },

  async findByIdForTenant(id: string, tenantId: string, db: Queryable = pool): Promise<Submission | null> {
    const { rows } = await db.query<SubmissionRow>(
      `SELECT ${COLUMNS} FROM submissions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toSubmission(rows[0]) : null;
  },

  async listForTenant(
    filter: ListSubmissionsFilter,
    db: Queryable = pool,
  ): Promise<{ items: Submission[]; total: number }> {
    // The tenant predicate is always $1 and is never optional — every other
    // filter is appended after it.
    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [filter.tenantId];

    const add = (sql: string, value: unknown): void => {
      values.push(value);
      conditions.push(sql.replace('?', `$${values.length}`));
    };

    if (filter.widgetId) add('widget_id = ?', filter.widgetId);
    if (filter.status) add('status = ?', filter.status);
    if (filter.from) add('created_at >= ?', filter.from);
    if (filter.to) add('created_at <= ?', filter.to);

    const where = conditions.join(' AND ');

    const [items, total] = await Promise.all([
      db.query<SubmissionRow>(
        `SELECT ${COLUMNS} FROM submissions WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, filter.limit, filter.offset],
      ),
      db.query<{ count: number }>(`SELECT count(*)::bigint AS count FROM submissions WHERE ${where}`, values),
    ]);

    return { items: items.rows.map(toSubmission), total: total.rows[0]?.count ?? 0 };
  },
};
