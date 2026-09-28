import mysql from 'mysql2/promise';
import { env } from './env.js';

/**
 * Pool único a QEB. La app SOLO hace SELECT sobre las vistas productivas
 * (V_APS_Globales, etc.). La única escritura permitida es sobre la tabla
 * nueva y aislada `bi_presupuesto` (ver presupuesto.service.ts).
 */
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
  connectionLimit: 8,
  connectTimeout: 20000,
  namedPlaceholders: true,
});

export async function query<T = any>(sql: string, params?: Record<string, unknown> | unknown[]): Promise<T[]> {
  const [rows] = await pool.query(sql, params as any);
  return rows as T[];
}

/**
 * Pool a la BD propia ESCRIBIBLE (Hostinger) — aquí sí creamos tablas y guardamos
 * lo que captura el equipo (objetivos). Es null si no está configurada (WDB_*).
 */
export const poolWrite = env.dbWrite.enabled
  ? mysql.createPool({
      host: env.dbWrite.host,
      port: env.dbWrite.port,
      user: env.dbWrite.user,
      password: env.dbWrite.password,
      database: env.dbWrite.database,
      connectionLimit: 4,
      connectTimeout: 15000,
      namedPlaceholders: true,
    })
  : null;

export async function queryWrite<T = any>(sql: string, params?: Record<string, unknown> | unknown[]): Promise<T[]> {
  if (!poolWrite) throw new Error('BD escribible no configurada (define WDB_HOST/WDB_USER/WDB_PASSWORD/WDB_NAME).');
  const [rows] = await poolWrite.query(sql, params as any);
  return rows as T[];
}
