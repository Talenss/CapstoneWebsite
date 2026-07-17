import mysql from 'mysql2/promise';
import { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS } from './config';

let pool: mysql.Pool | null = null;

export function db(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password: DB_PASS,
      charset: 'utf8mb4_unicode_ci',
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true, // DATETIME/TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' strings, matching PHP's PDO behavior
    });
  }
  return pool;
}

/** SELECT helper — returns rows as plain objects. */
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await db().query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE helper. */
export async function exec(sql: string, params: any[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const [result]: any = await db().query(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}
