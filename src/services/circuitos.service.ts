// Auto-reserva de circuito digital.
// Dado un solicitudCara con artículo circuito, crea automáticamente las reservas
// correspondientes a los N inventarios del circuito (CTO + plaza).
//
// Uso desde el transaction context (tx) para que si algo falla, rollback completo.

import { Prisma, PrismaClient } from '@prisma/client';
import { parseCircuitoDigital } from '../lib/circuitos';

const prisma = new PrismaClient();

const PLAZA_CODE_TO_SQL_LIKE: Record<string, string> = {
  MX: 'CIUDAD DE M%',
  MTY: 'MONTERREY%',
};

export interface AutoReservarParams {
  solicitudCaraId: number;
  itemCode: string;
  clienteId: number;
  calendarioId: number | null; // puede ser null si no se ha resuelto
  fechaInicio: Date | string;
  fechaFin: Date | string;
  esBf?: boolean; // si es BF pair (no usado en circuitos pero mantiene compat)
}

export interface AutoReservarResult {
  reservadas: number;
  conflictos: Array<{ inventario_id: number; codigo_unico: string; reason: string }>;
}

/**
 * Detecta si la cara es circuito digital. Si no lo es, retorna null.
 * Si es circuito, ejecuta la auto-reserva dentro del `tx` provisto.
 *
 * Idempotente: si ya existen reservas para esta solicitudCara, no duplica.
 */
export async function autoReservarCircuitoSiAplica(
  tx: Prisma.TransactionClient,
  params: AutoReservarParams
): Promise<AutoReservarResult | null> {
  const info = parseCircuitoDigital(params.itemCode);
  if (!info) return null;

  const like = PLAZA_CODE_TO_SQL_LIKE[info.plazaCode] || `${info.plazaCode}%`;

  // 1. Obtener inventarios del circuito
  const invs = await tx.$queryRawUnsafe<{ id: number; codigo_unico: string }[]>(
    `SELECT id, codigo_unico FROM inventarios
     WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)`,
    info.ctoLabel,
    like
  );

  if (invs.length === 0) {
    throw new Error(`Circuito ${info.ctoLabel} (${info.plazaLabel}) no tiene inventarios registrados`);
  }

  // 2. Check idempotencia: ¿ya hay reservas para esta solicitudCara?
  const existing = await tx.reservas.count({
    where: { solicitudCaras_id: params.solicitudCaraId, deleted_at: null },
  });
  if (existing > 0) {
    return { reservadas: 0, conflictos: [] }; // ya reservado previamente
  }

  // 3. Obtener espacios disponibles (el primer espacio por inventario)
  const invIds = invs.map(i => i.id);
  const espaciosRaw = await tx.$queryRawUnsafe<{ inventario_id: number; id: number }[]>(
    `SELECT ei.id, ei.inventario_id
     FROM espacio_inventario ei
     WHERE ei.inventario_id IN (${invIds.map(() => '?').join(',')})
     ORDER BY ei.inventario_id, ei.numero_espacio`,
    ...invIds
  );

  // Agrupar espacios por inventario
  const espaciosPorInv = new Map<number, number[]>();
  for (const e of espaciosRaw) {
    if (!espaciosPorInv.has(e.inventario_id)) espaciosPorInv.set(e.inventario_id, []);
    espaciosPorInv.get(e.inventario_id)!.push(e.id);
  }

  // 4. Check conflictos: reservas activas en el rango para cualquier espacio del circuito
  const todosEspacios = espaciosRaw.map(e => e.id);
  if (todosEspacios.length === 0) {
    throw new Error(`Circuito ${info.ctoLabel}: los inventarios no tienen espacios creados`);
  }

  const conflictsRaw = await tx.$queryRawUnsafe<
    { inventario_id: number; codigo_unico: string; espacio_id: number }[]
  >(
    `SELECT inv.id as inventario_id, inv.codigo_unico, r.inventario_id as espacio_id
     FROM reservas r
     INNER JOIN espacio_inventario ei ON ei.id = r.inventario_id
     INNER JOIN inventarios inv ON inv.id = ei.inventario_id
     INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
     WHERE ei.id IN (${todosEspacios.map(() => '?').join(',')})
       AND r.deleted_at IS NULL
       AND r.estatus NOT IN ('eliminada', 'Eliminada', 'cancelado', 'Cancelado')
       AND NOT (sc.fin_periodo < ? OR sc.inicio_periodo > ?)`,
    ...todosEspacios,
    params.fechaInicio,
    params.fechaFin
  );

  // Mapa: inventario_id → espacios ocupados
  const ocupadosPorInv = new Map<number, Set<number>>();
  for (const c of conflictsRaw) {
    if (!ocupadosPorInv.has(c.inventario_id)) ocupadosPorInv.set(c.inventario_id, new Set());
    ocupadosPorInv.get(c.inventario_id)!.add(c.espacio_id);
  }

  // 5. Para cada inventario del circuito, seleccionar un espacio libre
  const aReservar: Array<{ inventario_id: number; codigo_unico: string; espacio_id: number }> = [];
  const conflictos: AutoReservarResult['conflictos'] = [];

  for (const inv of invs) {
    const espacios = espaciosPorInv.get(inv.id) || [];
    const ocupados = ocupadosPorInv.get(inv.id) || new Set<number>();
    const libre = espacios.find(eid => !ocupados.has(eid));
    if (!libre) {
      conflictos.push({
        inventario_id: inv.id,
        codigo_unico: inv.codigo_unico,
        reason: espacios.length === 0 ? 'sin espacios creados' : 'todos los espacios ocupados en el rango',
      });
    } else {
      aReservar.push({ inventario_id: inv.id, codigo_unico: inv.codigo_unico, espacio_id: libre });
    }
  }

  // 6. Regla "todo o nada": si hay conflictos → error
  if (conflictos.length > 0) {
    const detalle = conflictos.slice(0, 3).map(c => `${c.codigo_unico} (${c.reason})`).join(', ');
    const suffix = conflictos.length > 3 ? ` y ${conflictos.length - 3} más` : '';
    throw new Error(
      `Circuito ${info.ctoLabel} no disponible: ${conflictos.length} inventario(s) con conflicto → ${detalle}${suffix}`
    );
  }

  // 7. Determinar estatus según prefijo del artículo
  const prefijo = info.tipo;
  let estatus: string;
  if (prefijo === 'CT') estatus = 'Cortesia';
  else if (prefijo === 'BF' || prefijo === 'CF' || params.esBf) estatus = 'Bonificado';
  else estatus = 'Vendido';

  // 8. Crear las reservas en batch
  const now = new Date();
  for (const r of aReservar) {
    await tx.reservas.create({
      data: {
        inventario_id: r.espacio_id, // Nota: reservas.inventario_id = espacio_inventario.id
        calendario_id: params.calendarioId ?? 0,
        cliente_id: params.clienteId,
        solicitudCaras_id: params.solicitudCaraId,
        estatus,
        estatus_original: estatus,
        arte_aprobado: 'Pendiente',
        comentario_rechazo: '',
        fecha_testigo: now,
        imagen_testigo: '',
        instalado: false,
        tarea: '',
        grupo_completo_id: null,
      },
    });
  }

  return { reservadas: aReservar.length, conflictos: [] };
}

/**
 * Versión fuera de transacción (para uso independiente).
 */
export async function autoReservarCircuito(params: AutoReservarParams): Promise<AutoReservarResult> {
  return prisma.$transaction(async tx => {
    const r = await autoReservarCircuitoSiAplica(tx, params);
    if (!r) throw new Error('El artículo no es un circuito digital');
    return r;
  });
}
