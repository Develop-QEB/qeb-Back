import { poolWrite, queryWrite } from '../db.js';

/**
 * Objetivos/metas del equipo, guardados en la BD propia ESCRIBIBLE (Hostinger).
 * Antes vivían en localStorage (por navegador); aquí quedan compartidos y permanentes.
 *  - objetivo_mensual: meta global por mes (paso 1).
 *  - objetivo_asesor:  reparto del objetivo anual por asesor (paso 2).
 */
export interface ObjetivosData {
  anio: number;
  mensual: Record<number, number>;
  asesores: Record<string, number>;
}

let listo = false;
async function ensureTablas(): Promise<void> {
  if (listo || !poolWrite) return;
  await poolWrite.query(`CREATE TABLE IF NOT EXISTS objetivo_mensual (
    anio INT NOT NULL,
    mes TINYINT NOT NULL,
    monto DECIMAL(18,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (anio, mes)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await poolWrite.query(`CREATE TABLE IF NOT EXISTS objetivo_asesor (
    anio INT NOT NULL,
    asesor VARCHAR(191) NOT NULL,
    monto DECIMAL(18,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (anio, asesor)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  listo = true;
}

const nMonto = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export async function getObjetivos(anio: number): Promise<ObjetivosData> {
  await ensureTablas();
  const mens = await queryWrite<{ mes: number; monto: string }>('SELECT mes, monto FROM objetivo_mensual WHERE anio = :anio', { anio });
  const ase = await queryWrite<{ asesor: string; monto: string }>('SELECT asesor, monto FROM objetivo_asesor WHERE anio = :anio', { anio });
  const mensual: Record<number, number> = {};
  for (const r of mens) mensual[Number(r.mes)] = Number(r.monto);
  const asesores: Record<string, number> = {};
  for (const r of ase) asesores[r.asesor] = Number(r.monto);
  return { anio, mensual, asesores };
}

export async function setMensual(anio: number, mes: number, monto: number): Promise<void> {
  await ensureTablas();
  await queryWrite(
    'INSERT INTO objetivo_mensual (anio, mes, monto) VALUES (:anio,:mes,:monto) ON DUPLICATE KEY UPDATE monto = VALUES(monto)',
    { anio, mes, monto: nMonto(monto) }
  );
}

export async function setMensualBulk(anio: number, montos: number[]): Promise<void> {
  await ensureTablas();
  for (let i = 0; i < 12; i++) await setMensual(anio, i + 1, nMonto(montos[i] ?? 0));
}

export async function setAsesor(anio: number, asesor: string, monto: number): Promise<void> {
  await ensureTablas();
  await queryWrite(
    'INSERT INTO objetivo_asesor (anio, asesor, monto) VALUES (:anio,:asesor,:monto) ON DUPLICATE KEY UPDATE monto = VALUES(monto)',
    { anio, asesor: asesor.slice(0, 191), monto: nMonto(monto) }
  );
}

export async function setAsesorBulk(anio: number, montos: Record<string, number>): Promise<void> {
  await ensureTablas();
  for (const [asesor, monto] of Object.entries(montos)) {
    if (asesor.trim()) await setAsesor(anio, asesor.trim(), nMonto(monto));
  }
}

export async function limpiarMensual(anio: number): Promise<void> {
  await ensureTablas();
  await queryWrite('DELETE FROM objetivo_mensual WHERE anio = :anio', { anio });
}

export async function limpiarAsesores(anio: number): Promise<void> {
  await ensureTablas();
  await queryWrite('DELETE FROM objetivo_asesor WHERE anio = :anio', { anio });
}
