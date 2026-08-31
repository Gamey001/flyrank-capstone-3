import { pool, type Queryable } from '../db/pool.js';
import type { Widget, WidgetDisplay, WidgetField, WidgetStatus, WidgetType } from '../domain/models.js';
import { toWidget, type WidgetRow } from './rows.js';

const COLUMNS = `id, tenant_id, public_id, name, type, status, title, description, button_text,
                 success_message, fields, display, honeypot_field, allowed_origins, webhook_url,
                 notify_email, revision, created_at, updated_at`;

export interface CreateWidgetInput {
  tenantId: string;
  publicId: string;
  name: string;
  type: WidgetType;
  status?: WidgetStatus;
  title: string;
  description?: string | null;
  buttonText?: string;
  successMessage?: string;
  fields: WidgetField[];
  display?: WidgetDisplay;
  honeypotField?: string;
  allowedOrigins?: string[];
  webhookUrl?: string | null;
  notifyEmail?: string | null;
}

export type UpdateWidgetInput = Partial<Omit<CreateWidgetInput, 'tenantId' | 'publicId'>>;

// The allow-list that makes the dynamic SET clause below safe: a key absent
// from this map can never reach the SQL.
const UPDATABLE_COLUMNS: Record<keyof UpdateWidgetInput, string> = {
  name: 'name',
  type: 'type',
  status: 'status',
  title: 'title',
  description: 'description',
  buttonText: 'button_text',
  successMessage: 'success_message',
  fields: 'fields',
  display: 'display',
  honeypotField: 'honeypot_field',
  allowedOrigins: 'allowed_origins',
  webhookUrl: 'webhook_url',
  notifyEmail: 'notify_email',
};

const JSON_COLUMNS = new Set(['fields', 'display']);

export const widgetsRepository = {
  // The enum casts are required: COALESCE with a NULL parameter infers text,
  // which Postgres will not implicitly coerce to an enum column.
  async create(input: CreateWidgetInput, db: Queryable = pool): Promise<Widget> {
    const { rows } = await db.query<WidgetRow>(
      `INSERT INTO widgets (tenant_id, public_id, name, type, status, title, description, button_text,
                            success_message, fields, display, honeypot_field, allowed_origins,
                            webhook_url, notify_email)
       VALUES ($1, $2, $3, $4::widget_type, COALESCE($5::widget_status, 'active'), $6, $7, COALESCE($8, 'Submit'),
               COALESCE($9, 'Thanks! We will be in touch.'), $10::jsonb, $11::jsonb,
               COALESCE($12, 'company_website'), COALESCE($13::text[], '{}'), $14, $15)
       RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.publicId,
        input.name,
        input.type,
        input.status ?? null,
        input.title,
        input.description ?? null,
        input.buttonText ?? null,
        input.successMessage ?? null,
        JSON.stringify(input.fields),
        JSON.stringify(input.display ?? {}),
        input.honeypotField ?? null,
        input.allowedOrigins ?? null,
        input.webhookUrl ?? null,
        input.notifyEmail ?? null,
      ],
    );
    return toWidget(rows[0]!);
  },

  // tenantId is a required argument on every read below, so a cross-tenant leak
  // has to be written deliberately rather than forgotten.
  async findByIdForTenant(id: string, tenantId: string, db: Queryable = pool): Promise<Widget | null> {
    const { rows } = await db.query<WidgetRow>(
      `SELECT ${COLUMNS} FROM widgets WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId],
    );
    return rows[0] ? toWidget(rows[0]) : null;
  },

  async listForTenant(
    tenantId: string,
    options: { limit: number; offset: number },
    db: Queryable = pool,
  ): Promise<{ items: Widget[]; total: number }> {
    const [items, total] = await Promise.all([
      db.query<WidgetRow>(
        `SELECT ${COLUMNS} FROM widgets
         WHERE tenant_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, options.limit, options.offset],
      ),
      db.query<{ count: number }>(
        'SELECT count(*)::bigint AS count FROM widgets WHERE tenant_id = $1 AND deleted_at IS NULL',
        [tenantId],
      ),
    ]);
    return { items: items.rows.map(toWidget), total: total.rows[0]?.count ?? 0 };
  },

  // The one unauthenticated read in this repository — named so the absence of a
  // tenant check is obvious at the call site.
  async findActiveByPublicId(publicId: string, db: Queryable = pool): Promise<Widget | null> {
    const { rows } = await db.query<WidgetRow>(
      `SELECT ${COLUMNS} FROM widgets
       WHERE public_id = $1 AND status = 'active' AND deleted_at IS NULL`,
      [publicId],
    );
    return rows[0] ? toWidget(rows[0]) : null;
  },

  async update(
    id: string,
    tenantId: string,
    patch: UpdateWidgetInput,
    db: Queryable = pool,
  ): Promise<Widget | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS) as [keyof UpdateWidgetInput, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      values.push(JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
      assignments.push(`${column} = $${values.length}${JSON_COLUMNS.has(column) ? '::jsonb' : ''}`);
    }

    if (assignments.length === 0) {
      return this.findByIdForTenant(id, tenantId, db);
    }

    // The public config ETag is derived from this, so an edit invalidates a
    // browser's cached config instead of being served stale indefinitely.
    assignments.push('revision = revision + 1');
    values.push(id, tenantId);

    const { rows } = await db.query<WidgetRow>(
      `UPDATE widgets SET ${assignments.join(', ')}
       WHERE id = $${values.length - 1} AND tenant_id = $${values.length} AND deleted_at IS NULL
       RETURNING ${COLUMNS}`,
      values,
    );
    return rows[0] ? toWidget(rows[0]) : null;
  },

  // Soft, so deleting a widget does not cascade away the leads it collected.
  async softDelete(id: string, tenantId: string, db: Queryable = pool): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE widgets SET deleted_at = now(), status = 'paused'
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  },
};
