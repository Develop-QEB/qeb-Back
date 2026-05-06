// Lógica compartida para detectar qué espacios físicos (espacio_inventario.id)
// están BLOQUEADOS en un rango de calendarios — usado por el endpoint de
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
  // IDs de calendario que se solapan con el período pedido.
  calendarioIds: number[];
  // solicitudCaras_id que pertenecen a la propuesta/campaña actual — se excluyen
  // del bloqueo (para no chocar con reservas propias al re-guardar).
  excludeCaraIds?: number[];
  // Cliente prisma o transacción opcional. Default: instancia global.
  tx?: TxClient;
}

/**
 * Devuelve el set de `espacio_inventario.id` que están bloqueados en el rango
 * de calendarios dado, EXCLUYENDO los que corresponden a inventarios digitales
 * (los digitales tienen spots ilimitados — varias campañas comparten pantalla).
 */
export async function getEspaciosBloqueados(
  args: GetEspaciosBloqueadosArgs
): Promise<Set<number>> {
  const { calendarioIds, excludeCaraIds, tx } = args;
  if (calendarioIds.length === 0) return new Set();

  const client = tx ?? defaultPrisma;

  const reservasExistentes = await client.reservas.findMany({
    where: {
      deleted_at: null,
      calendario_id: { in: calendarioIds },
      estatus: { in: [...ESTATUS_QUE_BLOQUEAN] },
      ...(excludeCaraIds && excludeCaraIds.length > 0
        ? { solicitudCaras_id: { notIn: excludeCaraIds } }
        : {}),
    },
    select: { inventario_id: true },
  });

  const espacioIdsExistentes = [...new Set(reservasExistentes.map(r => r.inventario_id))];
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
