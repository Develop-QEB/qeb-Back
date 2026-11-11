// Almacen Artes — logica central del inventario de artes fisicos.
// Fase 1 MVP (feedback Jos 2026-11-05).
//
// Stock por `biblioteca_artes_id`. Disponible = inicial + recibida - instalada
// - salidas_manuales.
//
// Entradas automaticas:
//   - alta_inicial: al crear un arte en biblioteca_artes con cantidad_inicial.
//   - entrada_recepcion: al atender una tarea 'Recepción' el back suma
//     (num_impresiones - faltantes) a cantidad_recibida por cada arte.
// Salidas automaticas:
//   - salida_instalacion: al marcar reservas como instaladas el back suma
//     1 a cantidad_instalada por reserva/arte.
// Manuales (endpoints dedicados):
//   - entrada_manual / salida_manual / ajuste.

import { PrismaClient, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

type MovimientoTipo =
  | 'alta_inicial'
  | 'entrada_recepcion'
  | 'salida_instalacion'
  | 'entrada_manual'
  | 'salida_manual'
  | 'ajuste';

interface RegistrarMovimientoInput {
  biblioteca_artes_id: number;
  campania_id: number;
  tipo: MovimientoTipo;
  cantidad: number; // positivo entrada, negativo salida
  tarea_id?: number | null;
  reserva_id?: number | null;
  usuario_id?: number | null;
  usuario_nombre?: string | null;
  nota?: string | null;
}

/**
 * Garantiza que exista una fila `almacen_artes_stock` para el arte.
 * Idempotente — devuelve la existente si ya está.
 */
export async function ensureStock(
  tx: Tx,
  biblioteca_artes_id: number,
  campania_id: number
) {
  const existente = await tx.almacen_artes_stock.findUnique({
    where: { biblioteca_artes_id },
  });
  if (existente) return existente;
  return tx.almacen_artes_stock.create({
    data: { biblioteca_artes_id, campania_id },
  });
}

/**
 * Registra un movimiento y ajusta el stock consolidado en la misma transaccion.
 * El llamador decide la transaccion (hook en controller o endpoint manual).
 */
export async function registrarMovimiento(
  tx: Tx,
  input: RegistrarMovimientoInput
) {
  await ensureStock(tx, input.biblioteca_artes_id, input.campania_id);

  // Actualiza los contadores del stock segun tipo.
  const updateData: Prisma.almacen_artes_stockUpdateInput = {};
  const absCant = Math.abs(input.cantidad);
  switch (input.tipo) {
    case 'alta_inicial':
      updateData.cantidad_inicial = { increment: absCant };
      break;
    case 'entrada_recepcion':
      updateData.cantidad_recibida = { increment: absCant };
      break;
    case 'salida_instalacion':
      updateData.cantidad_instalada = { increment: absCant };
      break;
    case 'entrada_manual':
      updateData.cantidad_recibida = { increment: absCant };
      break;
    case 'salida_manual':
      updateData.cantidad_salidas_manuales = { increment: absCant };
      break;
    case 'ajuste':
      // Ajuste va a 'inicial' con signo real (puede ser negativo).
      updateData.cantidad_inicial = { increment: input.cantidad };
      break;
  }
  await tx.almacen_artes_stock.update({
    where: { biblioteca_artes_id: input.biblioteca_artes_id },
    data: updateData,
  });

  // Log de movimiento (cantidad con signo: positivo entrada, negativo salida).
  const signedCant =
    input.tipo.startsWith('salida') ? -absCant
    : input.tipo === 'ajuste' ? input.cantidad
    : absCant;

  return tx.almacen_artes_movimientos.create({
    data: {
      biblioteca_artes_id: input.biblioteca_artes_id,
      campania_id: input.campania_id,
      tipo: input.tipo,
      cantidad: signedCant,
      tarea_id: input.tarea_id ?? null,
      reserva_id: input.reserva_id ?? null,
      usuario_id: input.usuario_id ?? null,
      usuario_nombre: input.usuario_nombre ?? null,
      nota: input.nota ?? null,
    },
  });
}

/**
 * Hook para el flujo de Recepcion. Para cada arte involucrado en la tarea,
 * calcula `recibidos = num_impresiones_del_arte - cantidad_faltante` y suma
 * a cantidad_recibida. Si la recepcion es "normal" (sin faltantes) usa el
 * total completo. Idempotente por tarea_id: si ya se registro una entrada
 * de esta tarea para el arte, no se duplica.
 *
 * @param faltantesPorArte  evidencia.faltantesPorArte (opcional)
 * @param numImpresiones    total de la tarea (tareas.num_impresiones)
 * @param idsReservas       reservas afectadas por la tarea (para mapear arte)
 */
export async function aplicarHookRecepcion(
  tx: Tx,
  opts: {
    tareaId: number;
    campaniaId: number;
    numImpresiones: number;
    idsReservas: number[];
    faltantesPorArte?: Array<{ arte: string; cantidad_faltante: number }>;
    usuarioId?: number | null;
    usuarioNombre?: string | null;
  }
) {
  if (!opts.idsReservas.length || opts.numImpresiones <= 0) return;

  // Mapeo arte(archivo) -> biblioteca_artes_id para la campaña.
  const biblio = await tx.biblioteca_artes.findMany({
    where: { campania_id: opts.campaniaId },
    select: { id: true, archivo: true },
  });
  const artePorArchivo = new Map<string, number>();
  for (const b of biblio) artePorArchivo.set(b.archivo, b.id);

  // Cuenta cuantas reservas usan cada archivo (artes_tradicionales).
  // No hay relacion Prisma formal entre reservas y artes_tradicionales,
  // se consulta por id_reserva IN (...) manualmente.
  const artesReservas = await tx.artes_tradicionales.findMany({
    where: { id_reserva: { in: opts.idsReservas } },
    select: { archivo: true },
  });
  const reservasPorArchivo = new Map<string, number>();
  for (const at of artesReservas) {
    if (!at.archivo) continue;
    reservasPorArchivo.set(at.archivo, (reservasPorArchivo.get(at.archivo) || 0) + 1);
  }

  // num_impresiones global / total reservas afectadas = impresiones por reserva.
  const impresionesPorReserva = opts.numImpresiones / Math.max(opts.idsReservas.length, 1);

  // Idempotencia: ver que archivos ya tienen entrada_recepcion para esta tarea.
  const yaRegistradas = await tx.almacen_artes_movimientos.findMany({
    where: { tarea_id: opts.tareaId, tipo: 'entrada_recepcion' },
    select: { biblioteca_artes_id: true },
  });
  const yaSet = new Set(yaRegistradas.map(m => m.biblioteca_artes_id));

  const faltantesMap = new Map<string, number>();
  for (const f of opts.faltantesPorArte || []) {
    faltantesMap.set(f.arte, (faltantesMap.get(f.arte) || 0) + (Number(f.cantidad_faltante) || 0));
  }

  for (const [archivo, nReservas] of reservasPorArchivo.entries()) {
    const bibId = artePorArchivo.get(archivo);
    if (!bibId || yaSet.has(bibId)) continue;
    const esperado = Math.round(impresionesPorReserva * nReservas);
    const faltan = faltantesMap.get(archivo) || 0;
    const recibidos = Math.max(0, esperado - faltan);
    if (recibidos <= 0) continue;
    await registrarMovimiento(tx, {
      biblioteca_artes_id: bibId,
      campania_id: opts.campaniaId,
      tipo: 'entrada_recepcion',
      cantidad: recibidos,
      tarea_id: opts.tareaId,
      usuario_id: opts.usuarioId ?? null,
      usuario_nombre: opts.usuarioNombre ?? null,
      nota: `Entrada automatica por tarea Recepción #${opts.tareaId}`,
    });
  }
}

/**
 * Hook para el flujo de Instalacion. Para cada reserva marcada como instalada
 * en la tarea, suma 1 a cantidad_instalada del arte correspondiente.
 * Idempotente por (tarea, reserva, biblioteca_arte).
 */
export async function aplicarHookInstalacion(
  tx: Tx,
  opts: {
    tareaId: number;
    campaniaId: number;
    idsReservas: number[];
    usuarioId?: number | null;
    usuarioNombre?: string | null;
  }
) {
  if (!opts.idsReservas.length) return;

  const biblio = await tx.biblioteca_artes.findMany({
    where: { campania_id: opts.campaniaId },
    select: { id: true, archivo: true },
  });
  const artePorArchivo = new Map<string, number>();
  for (const b of biblio) artePorArchivo.set(b.archivo, b.id);

  const artesReservas = await tx.artes_tradicionales.findMany({
    where: { id_reserva: { in: opts.idsReservas } },
    select: { id_reserva: true, archivo: true },
  });

  // Idempotencia: cuales (reserva, arte) ya se contabilizaron en esta tarea.
  const yaRegistradas = await tx.almacen_artes_movimientos.findMany({
    where: { tarea_id: opts.tareaId, tipo: 'salida_instalacion' },
    select: { biblioteca_artes_id: true, reserva_id: true },
  });
  const yaSet = new Set(yaRegistradas.map(m => `${m.reserva_id}-${m.biblioteca_artes_id}`));

  for (const at of artesReservas) {
    if (!at.archivo) continue;
    const bibId = artePorArchivo.get(at.archivo);
    if (!bibId) continue;
    const key = `${at.id_reserva}-${bibId}`;
    if (yaSet.has(key)) continue;
    await registrarMovimiento(tx, {
      biblioteca_artes_id: bibId,
      campania_id: opts.campaniaId,
      tipo: 'salida_instalacion',
      cantidad: 1,
      tarea_id: opts.tareaId,
      reserva_id: at.id_reserva,
      usuario_id: opts.usuarioId ?? null,
      usuario_nombre: opts.usuarioNombre ?? null,
      nota: `Salida automatica por instalación de reserva #${at.id_reserva}`,
    });
  }
}
