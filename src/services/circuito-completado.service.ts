// Versionado de circuitos completados (para la Vista Compartir).
//
// Un circuito (fila de solicitudCaras) esta "completado" cuando tiene tantas
// reservas activas como caras esperadas (caras + bonificacion): el N/N verde de
// Propuestas. Cada vez que eso ocurre con un CONJUNTO DISTINTO de reservas se
// guarda una version nueva:
//
//   circuito_completado          (cabecera: sc, version, fecha_completado)
//   circuito_completado_reserva  (la "foto": reservas/piezas que lo integraban)
//
// La Vista Compartir (interna, publica y mapa) pinta SIEMPRE la ultima version
// completada. Si despues una pieza se desplaza (multireservas) o se quita a
// mano, sigue saliendo pero en gris (ver inventario-propuesta.service.ts).
//
// Idempotente: si el circuito esta completo y la foto es identica a la ultima
// version, no escribe nada. Nunca lanza desde `evaluarCompletadoSeguro` (los
// controladores lo llaman despues de crear reservas y no debe romper el flujo).
import prisma from '../utils/prisma';

export interface CompletadoContexto {
  usuarioId?: number;
  usuarioNombre?: string;
  /** De donde vino la evaluacion (createReservas, toggleReserva, backfill...). */
  origen?: string;
  /** Backfill: fechar la version con la ultima fecha_reserva activa en vez de NOW(). */
  usarFechaUltimaReserva?: boolean;
}

interface ScRow { id: number; caras: number | null; bonificacion: unknown; articulo: string | null; idquote: string | null }
interface RsvRow {
  id: number; solicitudCaras_id: number; espacio_id: number;
  inventario_id: number | null; estatus: string | null; fecha_reserva: Date | null;
}
interface VerRow { id: number; solicitud_caras_id: number; version: number }
interface DetRow { completado_id: number; reserva_id: number }

// Cache del check de tablas. `true` es definitivo; `false` se reintenta cada
// minuto para que baste correr la migracion sin reiniciar el server.
let tablasOk: boolean | null = null;
let ultimoCheckFallido = 0;

export async function tablasCompletadoDisponibles(): Promise<boolean> {
  if (tablasOk === true) return true;
  if (tablasOk === false && Date.now() - ultimoCheckFallido < 60_000) return false;
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ('circuito_completado', 'circuito_completado_reserva')`
    );
    tablasOk = Number(rows[0]?.n) === 2;
  } catch {
    tablasOk = false;
  }
  if (!tablasOk) {
    ultimoCheckFallido = Date.now();
    console.warn('[circuito-completado] tablas no encontradas; correr scripts/add_tabla_circuito_completado.cjs');
  }
  return tablasOk;
}

function mismoConjunto(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Evalua los circuitos indicados y guarda una version nueva por cada uno que
 * este completo con una foto distinta a su ultima version.
 * Devuelve los ids de solicitudCaras que generaron version nueva.
 */
export async function evaluarCompletadoCircuitos(
  scIds: Array<number | string>,
  ctx: CompletadoContexto = {},
): Promise<number[]> {
  const ids = [...new Set(scIds.map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return [];
  if (!(await tablasCompletadoDisponibles())) return [];

  const ph = ids.map(() => '?').join(',');
  const [scs, rsvs, vers] = await Promise.all([
    prisma.$queryRawUnsafe<ScRow[]>(
      `SELECT id, caras, bonificacion, articulo, idquote FROM solicitudCaras WHERE id IN (${ph})`, ...ids),
    prisma.$queryRawUnsafe<RsvRow[]>(
      `SELECT r.id, r.solicitudCaras_id, r.inventario_id AS espacio_id,
              ei.inventario_id AS inventario_id, r.estatus, r.fecha_reserva
         FROM reservas r
         LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
        WHERE r.solicitudCaras_id IN (${ph}) AND r.deleted_at IS NULL`, ...ids),
    prisma.$queryRawUnsafe<VerRow[]>(
      `SELECT cc.id, cc.solicitud_caras_id, cc.version
         FROM circuito_completado cc
         INNER JOIN (
           SELECT solicitud_caras_id, MAX(version) AS v
             FROM circuito_completado
            WHERE solicitud_caras_id IN (${ph})
            GROUP BY solicitud_caras_id
         ) m ON m.solicitud_caras_id = cc.solicitud_caras_id AND m.v = cc.version`, ...ids),
  ]);

  const verIds = vers.map(v => Number(v.id));
  const dets = verIds.length > 0
    ? await prisma.$queryRawUnsafe<DetRow[]>(
        `SELECT completado_id, reserva_id FROM circuito_completado_reserva
          WHERE completado_id IN (${verIds.map(() => '?').join(',')})`, ...verIds)
    : [];

  const rsvBySc = new Map<number, RsvRow[]>();
  for (const r of rsvs) {
    const k = Number(r.solicitudCaras_id);
    if (!rsvBySc.has(k)) rsvBySc.set(k, []);
    rsvBySc.get(k)!.push(r);
  }
  const verBySc = new Map<number, VerRow>(vers.map(v => [Number(v.solicitud_caras_id), v]));
  const detByVer = new Map<number, Set<number>>();
  for (const d of dets) {
    const k = Number(d.completado_id);
    if (!detByVer.has(k)) detByVer.set(k, new Set());
    detByVer.get(k)!.add(Number(d.reserva_id));
  }

  const nuevos: number[] = [];
  for (const sc of scs) {
    // IM (impresion) usa reservas virtuales sin pieza fisica: no aplica.
    if (sc.articulo && /^IM-/i.test(sc.articulo)) continue;
    const esperadas = Number(sc.caras || 0) + Math.round(Number(sc.bonificacion || 0));
    if (esperadas <= 0) continue;

    const activas = rsvBySc.get(Number(sc.id)) || [];
    if (activas.length < esperadas) continue; // incompleto

    const setActual = new Set(activas.map(r => Number(r.id)));
    const ultima = verBySc.get(Number(sc.id));
    if (ultima && mismoConjunto(setActual, detByVer.get(Number(ultima.id)) || new Set())) continue;

    const version = (ultima ? Number(ultima.version) : 0) + 1;
    let fecha = new Date();
    if (ctx.usarFechaUltimaReserva) {
      const max = activas.reduce<Date | null>((acc, r) => {
        const d = r.fecha_reserva ? new Date(r.fecha_reserva) : null;
        return d && !Number.isNaN(d.getTime()) && (!acc || d > acc) ? d : acc;
      }, null);
      if (max) fecha = max;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO circuito_completado
             (solicitud_caras_id, idquote, version, fecha_completado, caras_esperadas, total_reservas, origen, usuario_id, usuario_nombre)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Number(sc.id), String(sc.idquote ?? ''), version, fecha, esperadas, activas.length,
          ctx.origen ?? null, ctx.usuarioId ?? null, ctx.usuarioNombre ?? null,
        );
        const idRows = await tx.$queryRawUnsafe<{ id: bigint | number }[]>('SELECT LAST_INSERT_ID() AS id');
        const ccId = Number(idRows[0]?.id);
        if (!ccId) throw new Error('No se obtuvo id de circuito_completado');

        const CHUNK = 500;
        for (let i = 0; i < activas.length; i += CHUNK) {
          const parte = activas.slice(i, i + CHUNK);
          const values = parte.map(() => '(?, ?, ?, ?, ?)').join(',');
          const params = parte.flatMap(r => [
            ccId, Number(r.id), Number(r.espacio_id),
            r.inventario_id === null || r.inventario_id === undefined ? null : Number(r.inventario_id),
            r.estatus ?? null,
          ]);
          await tx.$executeRawUnsafe(
            `INSERT INTO circuito_completado_reserva (completado_id, reserva_id, espacio_inventario_id, inventario_id, estatus) VALUES ${values}`,
            ...params,
          );
        }
      });
      nuevos.push(Number(sc.id));
    } catch (e: unknown) {
      // Carrera: dos evaluaciones simultaneas intentaron la misma version.
      // La UNIQUE (sc, version) la detiene; la otra ya guardo la misma foto.
      const msg = String((e as { meta?: { message?: string }; message?: string })?.meta?.message || (e as Error)?.message || '');
      if (/Duplicate entry/i.test(msg)) continue;
      throw e;
    }
  }
  return nuevos;
}

/** Evalua TODOS los circuitos de una propuesta (idquote = id de propuesta). */
export async function evaluarCompletadoPropuesta(
  propuestaId: number | string,
  ctx: CompletadoContexto = {},
): Promise<number[]> {
  const idquote = String(propuestaId);
  if (!idquote || idquote === '0' || idquote === 'NaN') return [];
  const scs = await prisma.$queryRawUnsafe<{ id: number }[]>(
    'SELECT id FROM solicitudCaras WHERE idquote = ?', idquote,
  );
  return evaluarCompletadoCircuitos(scs.map(s => Number(s.id)), ctx);
}

/**
 * Acotado a los circuitos de esas reservas, en vez de recorrer TODA la propuesta.
 * Es EXACTO (no una aproximacion): una reserva pertenece a un solo circuito, asi
 * que crear reservas solo puede completar los circuitos de esas reservas.
 *
 * Se usa en los flujos calientes (alta y toggle de reservas). En una propuesta
 * grande la evaluacion completa cuesta ~0.9 s; acotada baja a ~0.2 s.
 */
export async function evaluarCompletadoPorReservasSeguro(
  reservaIds: number[],
  ctx: CompletadoContexto = {},
): Promise<number[]> {
  const ids = [...new Set(reservaIds.map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return [];
  try {
    if (!(await tablasCompletadoDisponibles())) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = await prisma.$queryRawUnsafe<{ sc: number | null }[]>(
      `SELECT DISTINCT solicitudCaras_id AS sc FROM reservas WHERE id IN (${ph})`, ...ids,
    );
    const scIds = rows.map(r => Number(r.sc)).filter(n => Number.isFinite(n) && n > 0);
    const nuevos = await evaluarCompletadoCircuitos(scIds, ctx);
    if (nuevos.length > 0) {
      console.log(`[circuito-completado] ${nuevos.length} circuito(s) con version nueva (${ctx.origen || 'sin origen'})`);
    }
    return nuevos;
  } catch (e) {
    console.error('[circuito-completado] error evaluando por reservas:', e);
    return [];
  }
}

/**
 * Version que NUNCA lanza: para llamarla al final de los flujos que crean
 * reservas (createReservas, toggleReserva, createCara, updateCara...). Un
 * fallo aqui solo se loguea; la reserva ya quedo guardada.
 */
export async function evaluarCompletadoSeguro(
  propuestaId: number | string | null | undefined,
  ctx: CompletadoContexto = {},
): Promise<number[]> {
  if (propuestaId === null || propuestaId === undefined) return [];
  try {
    const nuevos = await evaluarCompletadoPropuesta(propuestaId, ctx);
    if (nuevos.length > 0) {
      console.log(`[circuito-completado] propuesta ${propuestaId}: ${nuevos.length} circuito(s) con version nueva (${ctx.origen || 'sin origen'})`);
    }
    return nuevos;
  } catch (e) {
    console.error(`[circuito-completado] error evaluando propuesta ${propuestaId}:`, e);
    return [];
  }
}
