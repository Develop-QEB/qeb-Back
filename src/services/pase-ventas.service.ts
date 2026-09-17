// Origen del inventario de una campaña: ¿se vino de la propuesta en el pase a
// ventas, o se agrego despues ya dentro de la campaña?
//
// Al aprobar, venderReservasPropuestaConGuardian voltea las reservas tentativas
// (Reservado/Bonificado) a firmes (Vendido/Vendido bonificado). ESE conjunto es
// "lo que se vino de la propuesta" y se guarda aqui (tabla pase_ventas_reserva).
// Todo lo que aparezca despues en la campaña y NO este en la foto = agregado en
// campaña. Es justo el caso del pase a ventas INCOMPLETO: se pierden piezas
// contra otra campaña firme y el asesor las repone dentro de la campaña.
//
// Por que una foto y no una heuristica por fecha: `reservas.fecha_reserva` es
// DATE (sin hora) y lo normal es reponer las faltantes el MISMO dia del pase a
// ventas, que es precisamente el caso que hay que distinguir.
import prisma from '../utils/prisma';

export type OrigenReserva = 'propuesta' | 'campana';

export interface PaseVentasContexto {
  campaniaId?: number | null;
  usuarioId?: number;
  usuarioNombre?: string;
  /** 'aprobacion' (exacto) | 'backfill' (aproximado por fecha). */
  origen?: string;
}

// Cache del check de tabla. `true` es definitivo; `false` se reintenta cada
// minuto para que baste correr la migracion sin reiniciar el server.
let tablaOk: boolean | null = null;
let ultimoCheckFallido = 0;

export async function tablaPaseVentasDisponible(): Promise<boolean> {
  if (tablaOk === true) return true;
  if (tablaOk === false && Date.now() - ultimoCheckFallido < 60_000) return false;
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'pase_ventas_reserva'`
    );
    tablaOk = Number(rows[0]?.n) === 1;
  } catch {
    tablaOk = false;
  }
  if (!tablaOk) {
    ultimoCheckFallido = Date.now();
    console.warn('[pase-ventas] tabla no encontrada; correr scripts/add_tabla_pase_ventas_reserva.cjs');
  }
  return tablaOk;
}

/**
 * Guarda la foto de las reservas que cruzaron en el pase a ventas.
 * INSERT IGNORE sobre UNIQUE(reserva_id): re-aprobar no duplica ni pisa lo ya
 * registrado. Devuelve cuantas filas nuevas se escribieron.
 */
export async function registrarPaseVentas(
  propuestaId: number,
  reservaIds: number[],
  ctx: PaseVentasContexto = {},
): Promise<number> {
  const ids = [...new Set(reservaIds.map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return 0;
  if (!(await tablaPaseVentasDisponible())) return 0;

  const ph = ids.map(() => '?').join(',');
  const info = await prisma.$queryRawUnsafe<{
    id: number; solicitudCaras_id: number | null; espacio_id: number | null;
    inventario_id: number | null; estatus: string | null;
  }[]>(
    `SELECT r.id, r.solicitudCaras_id, r.inventario_id AS espacio_id,
            ei.inventario_id AS inventario_id, r.estatus
       FROM reservas r
       LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
      WHERE r.id IN (${ph})`,
    ...ids,
  );
  if (info.length === 0) return 0;

  let escritas = 0;
  const CHUNK = 400;
  for (let i = 0; i < info.length; i += CHUNK) {
    const parte = info.slice(i, i + CHUNK);
    const values = parte.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(',');
    const params = parte.flatMap(r => [
      propuestaId,
      ctx.campaniaId ?? null,
      Number(r.id),
      r.solicitudCaras_id === null ? null : Number(r.solicitudCaras_id),
      r.espacio_id === null ? null : Number(r.espacio_id),
      r.inventario_id === null ? null : Number(r.inventario_id),
      r.estatus ?? null,
      ctx.origen ?? 'aprobacion',
    ]);
    escritas += await prisma.$executeRawUnsafe(
      `INSERT IGNORE INTO pase_ventas_reserva
         (propuesta_id, campania_id, reserva_id, solicitud_caras_id, espacio_inventario_id, inventario_id, estatus, origen)
       VALUES ${values}`,
      ...params,
    );
  }
  return escritas;
}

/**
 * Version que NUNCA lanza: se llama DESPUES del commit de la aprobacion, asi
 * que un fallo aqui no debe tumbar el pase a ventas. Si no se escribe, la Vista
 * Compartir simplemente no colorea por origen (y el backfill puede repararlo).
 */
export async function registrarPaseVentasSeguro(
  propuestaId: number,
  reservaIds: number[],
  ctx: PaseVentasContexto = {},
): Promise<number> {
  try {
    const n = await registrarPaseVentas(propuestaId, reservaIds, ctx);
    if (n > 0) console.log(`[pase-ventas] propuesta ${propuestaId}: ${n} reserva(s) registradas como "vienen de propuesta"`);
    return n;
  } catch (e) {
    console.error(`[pase-ventas] error registrando propuesta ${propuestaId}:`, e);
    return 0;
  }
}

/**
 * Ids de reservas que se vinieron de la propuesta.
 * `null` = esta propuesta NO tiene foto de pase a ventas (nunca se aprobo, o es
 * anterior a la feature): el consumidor NO debe clasificar por origen.
 */
export async function getReservasDePropuesta(propuestaId: number): Promise<Set<number> | null> {
  if (!(await tablaPaseVentasDisponible())) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<{ reserva_id: number }[]>(
      'SELECT reserva_id FROM pase_ventas_reserva WHERE propuesta_id = ?',
      propuestaId,
    );
    if (rows.length === 0) return null;
    return new Set(rows.map(r => Number(r.reserva_id)));
  } catch (e) {
    console.error(`[pase-ventas] error leyendo propuesta ${propuestaId}:`, e);
    return null;
  }
}
