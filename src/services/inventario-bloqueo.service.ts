// Lógica compartida para detectar qué espacios físicos (espacio_inventario.id)
// están BLOQUEADOS en un rango de fechas — usado por el endpoint de
// disponibles, los endpoints de creación de reservas (propuestas / campañas) y
// la asignación manual.
//
// Histórico (2026-05-06): se centraliza acá porque el filtro estaba duplicado
// en 3+ lugares con divergencias que generaron 6,240 dupes en producción:
//   - Algunos sitios listaban solo 3 estatus (`Reservado/Bonificado/Vendido`)
//     y se les escapaban las reservas con `Vendido bonificado` y `Con Arte`
//     (~46k reservas).
//   - El SQL para detectar "digitales con spots ilimitados" usaba
//     `i.tradicional_digital = 'Digital' OR i.total_espacios > 0`. Como TODOS
//     los tradicionales tienen `total_espacios = 1`, el OR los marcaba como
//     "digitales" y los excluía del bloqueo.
//
// 2026-05-08: el filtro original cruzaba por `reservas.calendario_id IN
// (calendariosOverlap)`. Eso falla en datos sucios: ~1,800 reservas tienen
// `calendario_id = 0` y ~400 apuntan a un calendario que no se solapa con el
// `solicitudCaras.inicio_periodo` real. Esas reservas no se detectaban como
// bloqueantes y dejaban entrar dupes (caso F1 OOH cam 80578, BIG MIX cam 80060,
// SEPHORA COMPLEMENTO cam 80511, etc). Ahora el helper toma directamente el
// rango `fechaInicio/fechaFin` y JOINea con `solicitudCaras` filtrando por
// `sc.inicio_periodo`/`sc.fin_periodo` — la fuente de verdad del período de
// la reserva. Funciona igual para catorcena que para mensual: ambos guardan
// el rango como FECHAS reales en el SC.
//
// Ahora todo pasa por `getEspaciosBloqueados` y comparte la misma constante
// de estatus.

import { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../utils/prisma';

// Estatus que IMPIDEN reusar un espacio físico tradicional en el mismo período.
// IMPORTANTE: alinear con `getDisponibles` en inventarios.controller.ts — si
// agregas un estatus ahí, también va aquí.
export const ESTATUS_QUE_BLOQUEAN = [
  'Reservado',
  'Bonificado',
  'Vendido',
  'Vendido bonificado',
  'Con Arte',
] as const;

type TxClient = PrismaClient | Prisma.TransactionClient;

interface GetEspaciosBloqueadosArgs {
  // Rango del período pedido (catorcena, mensual, o lo que sea).
  fechaInicio: Date;
  fechaFin: Date;
  // solicitudCaras_id que pertenecen a la propuesta/campaña actual — se excluyen
  // del bloqueo (para no chocar con reservas propias al re-guardar).
  excludeCaraIds?: number[];
  // Cliente prisma o transacción opcional. Default: instancia global.
  tx?: TxClient;
}

/**
 * Devuelve el set de `espacio_inventario.id` que están bloqueados en el rango
 * de fechas dado, EXCLUYENDO los que corresponden a inventarios digitales
 * (los digitales tienen spots ilimitados — varias campañas comparten pantalla).
 *
 * Filtra por `solicitudCaras.inicio_periodo`/`fin_periodo` (no por
 * `reservas.calendario_id`) — eso evita que reservas con calendario huérfano
 * o desincronizado escapen al check.
 */
export async function getEspaciosBloqueados(
  args: GetEspaciosBloqueadosArgs
): Promise<Set<number>> {
  const { fechaInicio, fechaFin, excludeCaraIds, tx } = args;
  const client = tx ?? defaultPrisma;

  const excludeFilter = excludeCaraIds && excludeCaraIds.length > 0
    ? `AND rv.solicitudCaras_id NOT IN (${excludeCaraIds.map(() => '?').join(',')})`
    : '';

  const reservasExistentes = await client.$queryRawUnsafe<{ inventario_id: number }[]>(
    `SELECT DISTINCT rv.inventario_id
     FROM reservas rv
     INNER JOIN solicitudCaras sc ON sc.id = rv.solicitudCaras_id
     WHERE rv.deleted_at IS NULL
       AND rv.estatus IN ('Reservado','Bonificado','Vendido','Vendido bonificado','Con Arte')
       AND sc.inicio_periodo <= ?
       AND sc.fin_periodo >= ?
       ${excludeFilter}`,
    fechaFin,
    fechaInicio,
    ...(excludeCaraIds || [])
  );

  const espacioIdsExistentes = [...new Set(reservasExistentes.map(r => Number(r.inventario_id)))];
  if (espacioIdsExistentes.length === 0) return new Set();

  // Identificar cuáles de esos espacios corresponden a inventarios DIGITALES
  // para excluirlos. Confiamos solo en `inventarios.tradicional_digital`:
  // `total_espacios > 0` NO es un discriminador válido (tradicionales también
  // tienen total_espacios=1).
  const phDig = espacioIdsExistentes.map(() => '?').join(',');
  const digitalRows = await client.$queryRawUnsafe<{ id: number }[]>(
    `SELECT ei.id FROM espacio_inventario ei
     JOIN inventarios i ON i.id = ei.inventario_id
     WHERE ei.id IN (${phDig})
       AND i.tradicional_digital = 'Digital'`,
    ...espacioIdsExistentes
  );
  const digitalEspacioIds = new Set(digitalRows.map(r => Number(r.id)));

  return new Set(
    espacioIdsExistentes.filter(id => !digitalEspacioIds.has(id))
  );
}
