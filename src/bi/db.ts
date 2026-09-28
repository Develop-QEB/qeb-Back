import mysql from 'mysql2/promise';
import { getBiConfig } from './config';

/**
 * Pools del BI, PEREZOSOS: se crean en la primera consulta, así que importar este
 * módulo no abre conexiones. Son independientes del Prisma de qeb-Back.
 *
 * Como el BI corre dentro del proceso de qeb-Back, cada conexión lleva su listener de
 * 'error': una conexión inactiva cortada por el servidor (wait_timeout, ECONNRESET)
 * emitiría un 'error' sin listener y el uncaughtException de server.ts tumbaría todo.
 */

/** Tope de espera por consulta (ms). Al vencer se descarta la conexión (MySQL puede seguir la consulta). */
const QUERY_TIMEOUT_MS = 120000;

type Params = Record<string, unknown> | unknown[];

/**
 * Ejecuta SIEMPRE sobre una conexión explícita del pool. Con pool.query(), mysql2 relanza
 * dentro de un callback los errores síncronos de format() (p. ej. un parámetro que es un
 * objeto con toString inválido) y eso sería un uncaughtException que tumba qeb-Back.
 * PoolConnection.query() los convierte en un rechazo normal de la promesa.
 */
async function consultar<T>(p: mysql.Pool, sql: string, params?: Params): Promise<T[]> {
  const c = await p.getConnection();
  let descartar = false;
  try {
    const [rows] = await c.query({ sql, timeout: QUERY_TIMEOUT_MS }, params as any);
    return rows as T[];
  } catch (e) {
    descartar = (e as { code?: string }).code === 'PROTOCOL_SEQUENCE_TIMEOUT';
    throw e;
  } finally {
    if (descartar) c.destroy();
    else c.release();
  }
}

function conListeners(p: mysql.Pool, nombre: string): mysql.Pool {
  p.pool.on('connection', (c) => {
    c.on('error', (e: NodeJS.ErrnoException) => console.error(`[BI-DB] ${nombre}:`, e.code || e.message));
  });
  return p;
}

let pool: mysql.Pool | null = null;

/**
 * Pool a la BD de ventas de QEB. El BI SOLO hace SELECT sobre las vistas
 * (V_APS_Globales, etc.). La única escritura permitida es sobre la tabla
 * nueva y aislada `bi_presupuesto` (ver presupuesto.service.ts).
 */
export function getPool(): mysql.Pool {
  if (!pool) {
    const { db } = getBiConfig();
    pool = conListeners(
      mysql.createPool({
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
        ssl: db.ssl ? { rejectUnauthorized: false } : undefined,
        connectionLimit: 8,
        queueLimit: 50,
        maxIdle: 2,
        idleTimeout: 60000,
        enableKeepAlive: true,
        connectTimeout: 20000,
        namedPlaceholders: true,
      }),
      'ventas'
    );
  }
  return pool;
}

export async function query<T = any>(sql: string, params?: Params): Promise<T[]> {
  return consultar<T>(getPool(), sql, params);
}

let poolWrite: mysql.Pool | null = null;

/**
 * Pool a la BD propia ESCRIBIBLE (Hostinger) — aquí sí creamos tablas y guardamos
 * lo que captura el equipo (objetivos). Es null si no está configurada (BI_WDB_*).
 */
export function getPoolWrite(): mysql.Pool | null {
  const { dbWrite } = getBiConfig();
  if (!dbWrite.enabled) return null;
  if (!poolWrite) {
    poolWrite = conListeners(
      mysql.createPool({
        host: dbWrite.host,
        port: dbWrite.port,
        user: dbWrite.user,
        password: dbWrite.password,
        database: dbWrite.database,
        connectionLimit: 4,
        queueLimit: 50,
        maxIdle: 1,
        idleTimeout: 60000,
        enableKeepAlive: true,
        connectTimeout: 15000,
        namedPlaceholders: true,
      }),
      'qebi'
    );
  }
  return poolWrite;
}

export async function queryWrite<T = any>(sql: string, params?: Params): Promise<T[]> {
  const pw = getPoolWrite();
  if (!pw) throw new Error('BD escribible no configurada (define BI_WDB_HOST/BI_WDB_USER/BI_WDB_PASSWORD/BI_WDB_NAME).');
  return consultar<T>(pw, sql, params);
}
