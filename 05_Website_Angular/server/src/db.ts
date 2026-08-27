/* ============================================================
   Linaw PH — database layer (Supabase / PostgreSQL)
   ------------------------------------------------------------
   Thin wrapper over node-postgres. Query call sites keep using
   MySQL-style `?` placeholders; toPg() rewrites them to Postgres
   `$1, $2, …` so the rest of the codebase reads the same. INSERTs
   that need the new row's id add `RETURNING <id_col>`, and exec()
   surfaces it as `insertId`.
   ============================================================ */
import { Pool, PoolClient, types } from 'pg';
import { DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, DB_SSL } from './config';

// Return DATE columns (OID 1082) as the raw 'YYYY-MM-DD' string rather
// than a JS Date, so posting deadlines stay date-only through the API.
// TIMESTAMP/TIMESTAMPTZ stay as JS Date objects; serializers' ts() reads them.
types.setTypeParser(1082, (v) => v);

let pool: Pool | null = null;

export function db(): Pool {
  if (!pool) {
    const ssl = DB_SSL ? { rejectUnauthorized: false } : undefined;
    pool = DATABASE_URL
      ? new Pool({ connectionString: DATABASE_URL, ssl, max: 10 })
      : new Pool({ host: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASS, ssl, max: 10 });
  }
  return pool;
}

/** Rewrite `?` placeholders to Postgres `$1, $2, …`. None of this
 *  codebase's SQL contains a literal `?` inside a string, so a plain
 *  positional replace is safe. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** SELECT helper — returns rows as plain objects. */
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await db().query(toPg(sql), params);
  return res.rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE helper. For an INSERT whose new id you need,
 *  end the SQL with `RETURNING <id_col>` — insertId is the first column
 *  of the first returned row. affectedRows is the row count. */
export async function exec(sql: string, params: any[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const res = await db().query(toPg(sql), params);
  const first = res.rows && res.rows[0];
  const insertId = first ? Number(Object.values(first)[0]) : 0;
  return { insertId, affectedRows: res.rowCount ?? 0 };
}

/** A transaction. The callback gets `tx` with the same query/exec
 *  helpers, all running on one dedicated connection between BEGIN and
 *  COMMIT (ROLLBACK on throw). */
export interface Tx {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  exec(sql: string, params?: any[]): Promise<{ insertId: number; affectedRows: number }>;
}

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolClient = await db().connect();
  const tx: Tx = {
    async query<R = any>(sql: string, params: any[] = []): Promise<R[]> {
      const res = await client.query(toPg(sql), params);
      return res.rows as R[];
    },
    async queryOne<R = any>(sql: string, params: any[] = []): Promise<R | null> {
      const rows = await tx.query<R>(sql, params);
      return rows.length ? rows[0] : null;
    },
    async exec(sql: string, params: any[] = []) {
      const res = await client.query(toPg(sql), params);
      const first = res.rows && res.rows[0];
      const insertId = first ? Number(Object.values(first)[0]) : 0;
      return { insertId, affectedRows: res.rowCount ?? 0 };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
