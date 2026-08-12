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
import { emitToAll, SOCKET_EVENTS } from '../config/socket';

// ─────────────────────────────────────────────────────────────────────────────
// FUENTE CENTRAL de qué OCUPA un espacio físico tradicional en un período.
//
// Modelo (2026-08): la ocupación se parte en dos niveles según el estatus de la
// reserva:
//   • FIRME (vendido)  → OCUPA: bloquea a TODOS (propuestas y campañas).
//   • TENTATIVO (hold de propuesta) → NO ocupa: varias propuestas pueden apartar
//     la misma pieza; se resuelve al vender (pase a ventas / aprobar).
//
// Exenciones de ocupación (no bloquean el espacio tradicional):
//   • Digital: spots ilimitados (se filtra por inventarios.tradicional_digital).
//   • IM- (impresión): es producción, no renta de la cara — usar
//     articuloOcupaInventario().
//
// PASO 1 (este commit): solo se DEFINE la partición. `ESTATUS_QUE_BLOQUEAN`
// queda como la UNIÓN firme+tentativo → mismo comportamiento que antes. El
// bloqueo se apuntará solo a FIRME en el paso 2.
// ─────────────────────────────────────────────────────────────────────────────

// FIRME = vendido: ocupa el espacio, bloquea a todos.
export const ESTATUS_FIRME = [
  'Vendido',
  'Vendido bonificado',
  // 'Con Arte'/'Sin Arte' = reserva ya VENDIDA con (o sin) arte; el cliente SIGUE
  // teniendo el espacio, así que ocupan igual. Su estatus_original es
  // Vendido/Vendido bonificado; migrarán cuando se limpie la columna estatus
  // (el estado del arte vive aparte, en reservas.arte_aprobado).
  'Con Arte',
  'Sin Arte',
] as const;

// TENTATIVO = hold de propuesta: NO ocupa, no bloquea (permite duplicados).
export const ESTATUS_TENTATIVO = [
  'Reservado',
  'Bonificado',
] as const;

// Estatus que HOY impiden reusar un espacio físico tradicional en el mismo
// período. Unión firme+tentativo = lista histórica → comportamiento sin cambios.
// IMPORTANTE: alinear con `getDisponibles` en inventarios.controller.ts.
export const ESTATUS_QUE_BLOQUEAN = [
  ...ESTATUS_FIRME,
  ...ESTATUS_TENTATIVO,
] as const;

// Listas listas para interpolar en SQL raw (valores constantes → sin inyección).
export const ESTATUS_FIRME_SQL = ESTATUS_FIRME.map((e) => `'${e}'`).join(',');
export const ESTATUS_QUE_BLOQUEAN_SQL = ESTATUS_QUE_BLOQUEAN.map((e) => `'${e}'`).join(',');

/** ¿El estatus de una reserva OCUPA físicamente el espacio (venta firme)? */
export function esEstatusFirme(estatus: string | null | undefined): boolean {
  return !!estatus && (ESTATUS_FIRME as readonly string[]).includes(estatus);
}

/** ¿El estatus es un hold tentativo de propuesta (no ocupa)? */
export function esEstatusTentativo(estatus: string | null | undefined): boolean {
  return !!estatus && (ESTATUS_TENTATIVO as readonly string[]).includes(estatus);
}

/**
 * ¿El artículo de la cara ocupa el espacio físico? Los IM- (impresión) NO
 * ocupan (son producción); el resto (RT/BF/CF/CT/IN) sí. Digital se exenta
 * aparte por inventarios.tradicional_digital.
 */
export function articuloOcupaInventario(articulo: string | null | undefined): boolean {
  if (!articulo) return true; // conservador: sin artículo, asumimos que ocupa
  return !/^\s*IM-/i.test(articulo);
}

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
 * Solo cuenta reservas FIRMES (vendidas): las tentativas de propuesta
 * (Reservado/Bonificado) NO bloquean — varias propuestas pueden apartar la
 * misma pieza; el ganador se define al vender (ver guardián de aprobación).
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
       AND rv.estatus IN (${ESTATUS_FIRME_SQL})
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

/**
 * Crea una reserva con protección anti-doble-booking concurrente.
 *
 * Antes el flujo era: leer espaciosBloqueados → check in-memory → INSERT.
 * Eso permitía que 3 usuarios simultáneos pasaran el check al mismo tiempo
 * (cada uno con su snapshot) y los 3 inserts triunfaran → triple booking.
 *
 * Ahora: dentro de una transacción se hace `SELECT ... FOR UPDATE` sobre
 * el `espacio_inventario` específico — esto serializa intentos concurrentes
 * sobre el mismo espacio. Después se re-chequea si alguien ya tomó el
 * espacio para el período pedido; si no, INSERT. Si sí, retorna OCCUPIED.
 *
 * Digital se considera infinito (no chequea conflicto).
 */
export async function createReservaConLock(
  data: Prisma.reservasUncheckedCreateInput,
  fechaInicio: Date,
  fechaFin: Date,
  excludeCaraIds?: number[],
  // OPCIONAL: inventario_id padre del espacio, ya precalculado por el caller en
  // bulk. Si viene, evita el SELECT extra dentro de la transacción (solo se usa
  // para el payload del emit, no afecta la correctitud de la reserva). Si no
  // viene (undefined), se consulta como antes — los callers viejos no cambian.
  cachedInvId?: number | null,
): Promise<{ ok: true; reserva: { id: number } } | { ok: false; reason: 'OCCUPIED' }> {
  const espacioId = Number(data.inventario_id);
  try {
    const reserva = await defaultPrisma.$transaction(async (tx) => {
      // Lock de fila sobre el espacio. Concurrentes en mismo espacio esperan.
      await tx.$executeRawUnsafe('SELECT id FROM espacio_inventario WHERE id = ? FOR UPDATE', espacioId);

      // Si el inventario es Digital, no aplica conflicto (es infinito).
      const invRow = await tx.$queryRawUnsafe<{ td: string | null }[]>(
        `SELECT i.tradicional_digital AS td
         FROM espacio_inventario ei
         INNER JOIN inventarios i ON i.id = ei.inventario_id
         WHERE ei.id = ? LIMIT 1`,
        espacioId
      );
      const isDigital = invRow[0]?.td === 'Digital';

      if (!isDigital) {
        const excludeFilter = excludeCaraIds && excludeCaraIds.length > 0
          ? `AND rv.solicitudCaras_id NOT IN (${excludeCaraIds.map(() => '?').join(',')})`
          : '';
        // Solo choca contra reservas FIRMES (vendidas). Las tentativas de otras
        // propuestas (Reservado/Bonificado) NO bloquean → se permiten duplicados
        // en propuestas; el ganador se resuelve al vender.
        const conflict = await tx.$queryRawUnsafe<{ c: bigint }[]>(
          `SELECT COUNT(*) c FROM reservas rv
           INNER JOIN solicitudCaras sc ON sc.id = rv.solicitudCaras_id
           WHERE rv.inventario_id = ?
             AND rv.deleted_at IS NULL
             AND rv.estatus IN (${ESTATUS_FIRME_SQL})
             AND sc.inicio_periodo <= ?
             AND sc.fin_periodo >= ?
             ${excludeFilter}`,
          espacioId, fechaFin, fechaInicio, ...(excludeCaraIds || [])
        );
        if (Number(conflict[0].c) > 0) {
          throw new Error('ESPACIO_OCUPADO');
        }
      }

      const created = await tx.reservas.create({ data, select: { id: true } });

      // Para el evento socket: inventarios.id padre del espacio. Si el caller ya
      // lo precalculó en bulk (cachedInvId !== undefined) lo usamos y evitamos el
      // round-trip; si no, lo consultamos como siempre.
      let invId: number | null;
      if (cachedInvId !== undefined) {
        invId = cachedInvId;
      } else {
        const invParentRow = await tx.$queryRawUnsafe<{ inv_id: number | null }[]>(
          `SELECT inventario_id AS inv_id FROM espacio_inventario WHERE id = ? LIMIT 1`,
          espacioId
        );
        invId = invParentRow[0]?.inv_id ?? null;
      }

      return {
        reserva: created,
        invId,
      };
      // maxWait alto: bajo el paralelismo de reservas (lotes) + la carga concurrente
      // del front (getDisponibles/reservas-modal), conseguir una conexión del pool
      // puede tardar más de los 2s default. Esperamos hasta 20s para NO soltar items
      // por un P2028 ("unable to start a transaction in the given time"). timeout =
      // tope de EJECUCIÓN de la transacción una vez iniciada.
    }, { timeout: 10000, maxWait: 20000 });

    // Emitir evento real-time para que otros buscadores de inventario en
    // vivo quiten este espacio de su listado de disponibles.
    // Se hace fuera de la transacción para no bloquear el commit.
    try {
      emitToAll(SOCKET_EVENTS.INVENTARIO_OCUPADO, {
        espacioId,
        inventarioId: reserva.invId,
        fechaInicio: fechaInicio.toISOString(),
        fechaFin: fechaFin.toISOString(),
      });
    } catch (emitErr) {
      console.error('Error emitiendo INVENTARIO_OCUPADO:', emitErr);
    }

    return { ok: true, reserva: reserva.reserva };
  } catch (err) {
    if ((err as Error).message === 'ESPACIO_OCUPADO') {
      return { ok: false, reason: 'OCCUPIED' };
    }
    throw err;
  }
}
