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
  // Cantidad de inventarios a reservar. Si se omite, reserva todos los del circuito (comportamiento legacy).
  // Si se especifica (típico para RT con BF separado): reserva solo N libres.
  cantidad?: number;
  // Si la propuesta/campaña es mensual, todo cuenta como Flujo (Gran Formato rule),
  // así que NO sobreescribir caras_flujo/caras_contraflujo con el split real del circuito.
  tipoPeriodo?: 'catorcena' | 'mensual';
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
  const libres: Array<{ inventario_id: number; codigo_unico: string; espacio_id: number }> = [];
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
      libres.push({ inventario_id: inv.id, codigo_unico: inv.codigo_unico, espacio_id: libre });
    }
  }

  // 6. Regla de cantidad:
  //    - Si `cantidad` está definida (típico cuando hay BF separado): tomar solo N libres,
  //      y solo fallar si no hay suficientes libres para cubrir N.
  //    - Si `cantidad` NO está definida: comportamiento legacy "todo o nada"
  //      (todos los inventarios del circuito deben estar libres).
  const cantidadPedida = typeof params.cantidad === 'number' && params.cantidad > 0 ? params.cantidad : undefined;
  let aReservar: typeof libres;

  if (cantidadPedida !== undefined) {
    if (libres.length < cantidadPedida) {
      throw new Error(
        `Circuito ${info.ctoLabel}: solo hay ${libres.length} inventario(s) libre(s) pero se piden ${cantidadPedida}`
      );
    }
    aReservar = libres.slice(0, cantidadPedida);
  } else {
    // Legacy: todo o nada
    if (conflictos.length > 0) {
      const detalle = conflictos.slice(0, 3).map(c => `${c.codigo_unico} (${c.reason})`).join(', ');
      const suffix = conflictos.length > 3 ? ` y ${conflictos.length - 3} más` : '';
      throw new Error(
        `Circuito ${info.ctoLabel} no disponible: ${conflictos.length} inventario(s) con conflicto → ${detalle}${suffix}`
      );
    }
    aReservar = libres;
  }

  // 7. Determinar estatus según prefijo del artículo
  const prefijo = info.tipo;
  let estatus: string;
  if (prefijo === 'BF' || prefijo === 'CF' || prefijo === 'CT' || params.esBf) estatus = 'Bonificado';
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

  // 9. Actualizar caras_flujo / caras_contraflujo SOLO para RT (no para BF/CF/CT)
  //    y SOLO en catorcena. En mensual, todo cuenta como Flujo (regla Gran Formato),
  //    así que dejamos los valores que mandó el front (caras_flujo = total, contraflujo = 0).
  //    El BF guarda su cantidad en `bonificacion`; caras_flujo/contraflujo deben
  //    quedarse en 0 para no duplicar el conteo en getCaraCompletionStatus.
  const esBfArt = prefijo === 'BF' || prefijo === 'CF' || prefijo === 'CT' || params.esBf;
  if (aReservar.length > 0 && !esBfArt && params.tipoPeriodo !== 'mensual') {
    const reservadosIds = aReservar.map(r => r.inventario_id);
    const phRes = reservadosIds.map(() => '?').join(',');
    const tipos = await tx.$queryRawUnsafe<{ flujo: bigint | number; ctra: bigint | number }[]>(
      `SELECT
         SUM(CASE WHEN tipo_de_cara = 'Flujo' THEN 1 ELSE 0 END) AS flujo,
         SUM(CASE WHEN tipo_de_cara = 'Contraflujo' THEN 1 ELSE 0 END) AS ctra
       FROM inventarios WHERE id IN (${phRes})`,
      ...reservadosIds
    );
    const flujoReal = Number(tipos[0]?.flujo || 0);
    const ctraReal = Number(tipos[0]?.ctra || 0);
    await tx.solicitudCaras.update({
      where: { id: params.solicitudCaraId },
      data: { caras_flujo: flujoReal, caras_contraflujo: ctraReal },
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

/**
 * Redistribuye reservas entre el par RT/BF de un circuito digital cuando
 * se editan las cantidades. Se llama después de actualizar la cara editada.
 *
 * Lógica:
 * - Cara RT: necesita exactamente `caras` reservas con estatus 'Vendido'.
 * - Cara BF pareja (mismo grupo_rt_bf, periodo): necesita exactamente
 *   `bonificacion` reservas con estatus 'Bonificado'.
 *
 * Si el RT tiene más reservas de las pedidas, MUEVE el excedente al BF
 * (cambia solicitudCaras_id y estatus). Y al revés.
 *
 * Idempotente: si ya están en proporción correcta, no hace nada.
 */
export async function redistribuirReservasCircuito(
  tx: Prisma.TransactionClient,
  caraEditadaId: number
): Promise<{ movidas: number } | null> {
  // 1. Leer la cara editada
  const caraRow = await tx.$queryRawUnsafe<{
    id: number; articulo: string | null; caras: number; bonificacion: number | null;
    grupo_rt_bf: number | null; inicio_periodo: Date; fin_periodo: Date; idquote: string | null;
  }[]>(
    `SELECT id, articulo, caras, bonificacion, grupo_rt_bf, inicio_periodo, fin_periodo, idquote
     FROM solicitudCaras WHERE id = ?`,
    caraEditadaId
  );
  const cara = caraRow[0];
  if (!cara) return null;

  // 2. Solo aplica a circuitos digitales con par RT/BF
  if (!parseCircuitoDigital(cara.articulo || '') || !cara.grupo_rt_bf) return null;

  // 3. Encontrar la cara pareja (mismo grupo_rt_bf, periodo, distinto id)
  const parejas = await tx.$queryRawUnsafe<{
    id: number; articulo: string | null; caras: number; bonificacion: number | null;
  }[]>(
    `SELECT id, articulo, caras, bonificacion
     FROM solicitudCaras
     WHERE grupo_rt_bf = ? AND inicio_periodo = ? AND fin_periodo = ?
       AND id <> ? AND idquote = ?`,
    cara.grupo_rt_bf, cara.inicio_periodo, cara.fin_periodo, cara.id, cara.idquote
  );
  const pareja = parejas[0];
  if (!pareja) return null;

  // 4. Identificar quién es RT y quién es BF
  const esBfArt = (s: string | null | undefined) => {
    const u = (s || '').toUpperCase();
    return u.startsWith('BF') || u.startsWith('CF');
  };
  const caraEsRt = !esBfArt(cara.articulo);
  const rt = caraEsRt ? cara : pareja;
  const bf = caraEsRt ? pareja : cara;

  // 5. Cantidad esperada por cada uno
  const rtEsperado = Number(rt.caras) || 0;
  const bfEsperado = Number(bf.bonificacion) || 0;

  // 6. Reservas actuales de cada uno (activas)
  const [rtRows, bfRows] = await Promise.all([
    tx.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM reservas WHERE solicitudCaras_id = ? AND deleted_at IS NULL ORDER BY id`,
      rt.id
    ),
    tx.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM reservas WHERE solicitudCaras_id = ? AND deleted_at IS NULL ORDER BY id`,
      bf.id
    ),
  ]);
  const rtActual = rtRows.length;
  const bfActual = bfRows.length;

  // 7. Calcular movimientos
  let movidas = 0;
  if (rtActual > rtEsperado && bfActual < bfEsperado) {
    // Mover (rtActual - rtEsperado) del RT al BF (las últimas)
    const aMover = Math.min(rtActual - rtEsperado, bfEsperado - bfActual);
    if (aMover > 0) {
      const ids = rtRows.slice(rtActual - aMover).map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      await tx.$executeRawUnsafe(
        `UPDATE reservas SET solicitudCaras_id = ?, estatus = 'Bonificado', estatus_original = 'Bonificado'
         WHERE id IN (${ph})`,
        bf.id, ...ids
      );
      movidas += aMover;
    }
  } else if (bfActual > bfEsperado && rtActual < rtEsperado) {
    // Mover (bfActual - bfEsperado) del BF al RT
    const aMover = Math.min(bfActual - bfEsperado, rtEsperado - rtActual);
    if (aMover > 0) {
      const ids = bfRows.slice(bfActual - aMover).map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      await tx.$executeRawUnsafe(
        `UPDATE reservas SET solicitudCaras_id = ?, estatus = 'Vendido', estatus_original = 'Vendido'
         WHERE id IN (${ph})`,
        rt.id, ...ids
      );
      movidas += aMover;
    }
  }

  // 8. Reconciliar caras_flujo / caras_contraflujo del RT con el split real de reservas.
  //    Para circuitos digitales en CATORCENA: los inventarios reservados pueden no respetar
  //    el ratio proporcional que envió el frontend. Aquí garantizamos que los valores
  //    guardados reflejen el split real, para que getCaraCompletionStatus muestre la cara
  //    como "verde" cuando la cantidad total está completa.
  //    En MENSUAL todo cuenta como Flujo (regla Gran Formato), no sobreescribir.
  const tpRows = await tx.$queryRawUnsafe<{ tipo_periodo: string | null }[]>(
    `SELECT tipo_periodo FROM cotizacion WHERE id_propuesta = ? LIMIT 1`,
    Number(cara.idquote || 0)
  );
  const esMensual = tpRows[0]?.tipo_periodo === 'mensual';
  if (!esMensual) {
    const tipos = await tx.$queryRawUnsafe<{ flujo: bigint | number; ctra: bigint | number }[]>(
      `SELECT
         SUM(CASE WHEN i.tipo_de_cara = 'Flujo' THEN 1 ELSE 0 END) AS flujo,
         SUM(CASE WHEN i.tipo_de_cara = 'Contraflujo' THEN 1 ELSE 0 END) AS ctra
       FROM reservas r
       JOIN espacio_inventario ei ON ei.id = r.inventario_id
       JOIN inventarios i ON i.id = ei.inventario_id
       WHERE r.solicitudCaras_id = ? AND r.deleted_at IS NULL`,
      rt.id
    );
    const flujoReal = Number(tipos[0]?.flujo || 0);
    const ctraReal = Number(tipos[0]?.ctra || 0);
    await tx.solicitudCaras.update({
      where: { id: rt.id },
      data: { caras_flujo: flujoReal, caras_contraflujo: ctraReal },
    });
  } else {
    // Mensual: caras_flujo = total caras del RT, caras_contraflujo = 0
    const totalRt = Number(rt.caras) || 0;
    await tx.solicitudCaras.update({
      where: { id: rt.id },
      data: { caras_flujo: totalRt, caras_contraflujo: 0 },
    });
  }

  return { movidas };
}
