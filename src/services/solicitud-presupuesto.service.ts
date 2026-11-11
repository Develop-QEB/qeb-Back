// Jos 2026-11-10 (ticket #516, Elvia #81488): el campo `solicitud.presupuesto`
// se poblaba al crear/editar la solicitud pero no se re-sincronizaba cuando
// desde Propuestas se agregaban, quitaban o modificaban circuitos. El 34% de
// las solicitudes del año quedó con el valor desfasado. El listado (ya
// corregido en solicitudes.controller.ts getAll) suma en vivo, pero el valor
// guardado en DB también se mantiene actualizado por este helper para:
//   - Historial de cambios (logHistorial compara contra solicitud.presupuesto)
//   - Contexto del chatbot QEBooh
//   - Cualquier consumo futuro que use el campo directo.
//
// Idempotente y tolerante: si el id no mapea a una solicitud o no hay caras,
// no explota. Se llama "después de" la mutación — nunca dentro de la misma
// transacción, para que el presupuesto refleje el estado ya persistido.
import prisma from '../utils/prisma';

export async function recalcularPresupuestoSolicitud(idquote: string | number | null | undefined): Promise<void> {
  if (idquote == null) return;
  const idNum = Number(idquote);
  if (!Number.isFinite(idNum) || idNum <= 0) return;
  try {
    const sumRows = await prisma.$queryRawUnsafe<{ suma: number | string | null }[]>(
      `SELECT COALESCE(SUM(costo), 0) AS suma FROM solicitudCaras WHERE idquote = ?`,
      String(idNum)
    );
    const suma = Number(sumRows?.[0]?.suma ?? 0);
    // No tocar si la solicitud quedó sin caras (caso raro) — así preservamos
    // el valor original para el historial.
    if (suma === 0) return;
    await prisma.solicitud.updateMany({
      where: { id: idNum, deleted_at: null },
      data: { presupuesto: suma },
    });
  } catch (e) {
    // Fire-and-forget: no romper el flujo principal si falla el recálculo.
    // El listado ya suma en vivo, así que una falla aquí solo deja el campo
    // guardado un poco desfasado — el próximo cambio lo corrige.
    console.error('[recalcularPresupuestoSolicitud] fallo para idquote=' + idquote, e);
  }
}

// Variante bulk cuando tenemos varios idquote (p.ej. al eliminar muchas caras
// de solicitudes distintas desde un endpoint único). Deduplica y procesa en
// paralelo.
export async function recalcularPresupuestoMultiple(idquotes: Array<string | number | null | undefined>): Promise<void> {
  const unicos = Array.from(new Set(idquotes.map(i => (i == null ? '' : String(i))).filter(Boolean)));
  if (unicos.length === 0) return;
  await Promise.all(unicos.map(id => recalcularPresupuestoSolicitud(id)));
}
