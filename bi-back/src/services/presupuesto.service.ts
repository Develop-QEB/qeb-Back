import { pool, query } from '../db.js';
import { env } from '../env.js';
import type { BaseDatos, PresupuestoMes } from '../types.js';

/**
 * Tabla NUEVA y aislada `bi_presupuesto`: la "meta" mensual que pone IMU (editable
 * con el lapicito del front). Es la ÚNICA escritura del back; no toca datos productivos.
 * base='ALL' = meta global del mes (sin desglose por base).
 */
const TABLA = `\`${env.writeDb}\`.\`bi_presupuesto\``;
const BASES_VALIDAS = new Set(['ALL', 'CIMU', 'TRADE', 'SAP']);

/** null (todas) -> 'ALL'; 'Trade' -> 'TRADE'; etc. */
export function baseToDb(base: BaseDatos | null): string {
  if (!base) return 'ALL';
  return base.toUpperCase();
}
function dbToBase(b: string): BaseDatos | null {
  if (b === 'ALL') return null;
  if (b === 'TRADE') return 'Trade';
  return b as BaseDatos;
}

let asegurada = false;
/** Crea la tabla SOLO si BI_ALLOW_CREATE=true. Si no, no toca la base. */
export async function ensureTable(): Promise<void> {
  if (asegurada || !env.allowCreate) return;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLA} (
      anio INT NOT NULL,
      mes TINYINT NOT NULL,
      base VARCHAR(10) NOT NULL DEFAULT 'ALL',
      monto DECIMAL(19,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (anio, mes, base)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  asegurada = true;
}

/** Devuelve las 12 metas del año para una base (con fallback a la meta global 'ALL'). */
export async function getPresupuesto(anio: number, base: BaseDatos | null): Promise<PresupuestoMes[]> {
  await ensureTable();
  const bdb = baseToDb(base);
  let rows: { mes: number; base: string; monto: string }[] = [];
  try {
    rows = await query<{ mes: number; base: string; monto: string }>(
      `SELECT mes, base, monto FROM ${TABLA} WHERE anio = :anio AND base IN ('ALL', :bdb)`,
      { anio, bdb }
    );
  } catch (e: any) {
    // Tabla aún no existe (BI_ALLOW_CREATE=false y sin migrar): presupuesto = 0, sin romper.
    if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  // base específica gana sobre 'ALL'
  const porMes = new Map<number, number>();
  for (const r of rows) if (r.base === 'ALL' && !porMes.has(r.mes)) porMes.set(r.mes, Number(r.monto));
  for (const r of rows) if (r.base === bdb) porMes.set(r.mes, Number(r.monto));
  const out: PresupuestoMes[] = [];
  for (let mes = 1; mes <= 12; mes++) out.push({ anio, mes, base, monto: porMes.get(mes) ?? 0 });
  return out;
}

/** Mapa mes->monto para el cálculo del resumen. */
export async function mapaPresupuesto(anio: number, base: BaseDatos | null): Promise<Map<number, number>> {
  const filas = await getPresupuesto(anio, base);
  return new Map(filas.map((f) => [f.mes, f.monto]));
}

/** Upsert de una meta (el lapicito). */
export async function upsertPresupuesto(
  anio: number,
  mes: number,
  base: BaseDatos | null,
  monto: number
): Promise<PresupuestoMes> {
  if (!env.allowCreate) {
    // Sin permiso de creación no podemos garantizar la tabla; evitamos un error críptico.
    throw new Error(
      'Edición deshabilitada: pon BI_ALLOW_CREATE=true (crea la tabla aislada bi_presupuesto) o corre sql/bi_presupuesto.sql'
    );
  }
  await ensureTable();
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error('anio inválido');
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw new Error('mes inválido (1-12)');
  if (!Number.isFinite(monto) || monto < 0) throw new Error('monto inválido');
  const bdb = baseToDb(base);
  if (!BASES_VALIDAS.has(bdb)) throw new Error('base inválida');
  await pool.query(
    `INSERT INTO ${TABLA} (anio, mes, base, monto) VALUES (:anio, :mes, :bdb, :monto)
     ON DUPLICATE KEY UPDATE monto = VALUES(monto)`,
    { anio, mes, bdb, monto }
  );
  return { anio, mes, base: dbToBase(bdb), monto };
}
