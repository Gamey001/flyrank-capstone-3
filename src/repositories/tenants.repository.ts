import { pool, type Queryable } from '../db/pool.js';
import type { Tenant, TenantWithSecret } from '../domain/models.js';
import { toTenant, toTenantWithSecret, type TenantRow } from './rows.js';

const COLUMNS = 'id, email, name, password_hash, created_at';

export const tenantsRepository = {
  async create(
    input: { email: string; name: string; passwordHash: string },
    db: Queryable = pool,
  ): Promise<Tenant> {
    const { rows } = await db.query<TenantRow>(
      `INSERT INTO tenants (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [input.email, input.name, input.passwordHash],
    );
    return toTenant(rows[0]!);
  },

  async findByEmail(email: string, db: Queryable = pool): Promise<TenantWithSecret | null> {
    const { rows } = await db.query<TenantRow>(
      `SELECT ${COLUMNS} FROM tenants WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? toTenantWithSecret(rows[0]) : null;
  },

  async findById(id: string, db: Queryable = pool): Promise<Tenant | null> {
    const { rows } = await db.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE id = $1`, [id]);
    return rows[0] ? toTenant(rows[0]) : null;
  },
};
