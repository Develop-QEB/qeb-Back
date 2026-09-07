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
import nodemailer from 'nodemailer';
import { prisma as defaultPrisma } from '../utils/prisma';
import { emitToAll, emitToPropuesta, SOCKET_EVENTS } from '../config/socket';
import { registrarReservaCreada } from './conflictos-live.service';

// Transporter para avisar por correo a los asesores cuando les desplazan reservas.
// Misma config que el resto del sistema (env SMTP_*). Fail-soft: si no hay SMTP o
// falla el envío, NO rompe el desplazamiento.
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

/** Correo a los asesores dueños de una propuesta a la que le desplazaron reservas. */
async function enviarCorreoDesplazamiento(
  asesorIds: number[],
  idquote: string,
  cuantas: number,
  periodoTxt: string,
  articuloTxt: string,
  codigos: (string | null)[],
): Promise<void> {
  try {
    if (!process.env.SMTP_USER) return; // sin config SMTP → no-op silencioso
    const users = await defaultPrisma.usuario.findMany({
      where: { id: { in: asesorIds }, deleted_at: null },
      select: { correo_electronico: true },
    });
    const to = users.map(u => u.correo_electronico).filter(Boolean);
    if (to.length === 0) return;
    const cods = codigos.filter((c): c is string => !!c);
    const cat = periodoTxt ? ` de la ${periodoTxt}` : '';
    const art = articuloTxt ? ` — artículo(s): ${articuloTxt}` : '';
    const piezas = cods.length ? `\n\nPiezas: ${cods.slice(0, 60).join(', ')}` : '';
    await mailTransporter.sendMail({
      from: process.env.SMTP_FROM || '"QEB Sistema" <no-reply@qeb.mx>',
      to,
      subject: `Reservas desplazadas — propuesta ${idquote}`,
      text: `Se desplazaron ${cuantas} reserva(s)${cat}${art} de la propuesta ${idquote}. Hay que volver a reservarlas.${piezas}`,
    });
  } catch (e) {
    console.error('[desplazamiento] no se pudo enviar correo a asesores', e);
  }
}

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
       -- IM (impresión) no ocupa el espacio físico → no bloquea.
       AND (sc.articulo IS NULL OR sc.articulo NOT LIKE 'IM-%')
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
             AND (sc.articulo IS NULL OR sc.articulo NOT LIKE 'IM-%')
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

    // Observador de conflictos: anota el sitio para que la verificacion
    // dirigida (debounced) corra tras la rafaga. Nunca interviene en la reserva.
    // Solo creaciones FIRMES: las tentativas de propuestas pueden encimarse por
    // diseño y el detector no las cuenta — registrarlas seria correr en vano.
    if (esEstatusFirme(String(data.estatus ?? ''))) {
      registrarReservaCreada(reserva.invId);
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// GUARDIÁN DE VENTA (reemplaza al stored proc `actualizar_reservas`).
//
// Al aprobar una propuesta sus reservas tentativas se vuelven firmes:
//   Reservado  → Vendido      ·      Bonificado → Vendido bonificado
//
// Pero ANTES de flipar cada pieza TRADICIONAL (no IM, no digital) se bloquea su
// espacio (SELECT … FOR UPDATE) y se verifica que ninguna OTRA cotización la
// tenga ya FIRME en el período. Si alguna choca, se lanza VentaConflictoError:
// la transacción de aprobación se revierte y NO se flipa nada, para que el
// usuario re-edite. Así nunca se crean dos ventas de la misma pieza tradicional
// en la misma catorcena.
//
// Gana quien flipa primero: el FOR UPDATE serializa aprobaciones simultáneas.
// Digital (spots ilimitados) e IM (impresión, no ocupa) se flipan sin chequear.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConflictoVenta {
  reservaId: number;
  espacioId: number;
  codigoUnico: string | null;
  inicioPeriodo: string; // YYYY-MM-DD
  finPeriodo: string;
}

export class VentaConflictoError extends Error {
  conflictos: ConflictoVenta[];
  constructor(conflictos: ConflictoVenta[]) {
    super(`VENTA_CONFLICTO: ${conflictos.length} pieza(s) ya vendida(s) en el período`);
    this.name = 'VentaConflictoError';
    this.conflictos = conflictos;
  }
}

interface TentativaRow {
  reserva_id: number;
  espacio_id: number;
  estatus: string;
  inicio: Date;
  fin: Date;
  es_digital: number; // 0/1
  es_im: number;      // 0/1
  codigo_unico: string | null;
}

// Info de una reserva de OTRA propuesta que se desplaza (pierde la pieza) porque
// esta propuesta la vendió. La consume el controlador para notificar al dueño.
export interface DesplazadaInfo {
  reservaId: number;
  idquotePerdedora: string; // cotización/propuesta que pierde la pieza
  espacioId: number;
  codigoUnico: string | null;
  inicioPeriodo: string;
  finPeriodo: string;
}

interface EvictRow {
  reserva_id: number;
  idquote: string;
  ini: Date;
  fin: Date;
}

/**
 * Convierte las reservas tentativas (Reservado/Bonificado) de una propuesta en
 * firmes (Vendido / Vendido bonificado), con guardián de colisión sobre las
 * piezas tradicionales. DEBE llamarse DENTRO de la transacción de aprobación
 * (necesita mantener los locks hasta el commit).
 *
 * Lanza VentaConflictoError si alguna pieza tradicional (no IM) ya está vendida
 * por otra cotización en el período → no flipa nada (la tx se revierte).
 */
export async function venderReservasPropuestaConGuardian(
  tx: Prisma.TransactionClient,
  propuestaId: number,
): Promise<{ vendidas: number; desplazadas: DesplazadaInfo[] }> {
  // Reservas tentativas de la propuesta. `reservas.inventario_id` es polimórfico
  // (espacio_inventario.id o inventarios.id) → se resuelve por COALESCE para
  // saber si es Digital y su codigo_unico. ORDER BY espacio para bloquear siempre
  // en el mismo orden (evita deadlocks entre aprobaciones concurrentes).
  const tentativas = await tx.$queryRawUnsafe<TentativaRow[]>(
    `SELECT r.id AS reserva_id, r.inventario_id AS espacio_id, r.estatus,
            sc.inicio_periodo AS inicio, sc.fin_periodo AS fin,
            (COALESCE(invE.tradicional_digital, invD.tradicional_digital) = 'Digital') AS es_digital,
            (sc.articulo LIKE 'IM-%') AS es_im,
            COALESCE(invE.codigo_unico, invD.codigo_unico) AS codigo_unico
     FROM reservas r
     INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
     LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
     LEFT JOIN inventarios invE ON invE.id = ei.inventario_id
     LEFT JOIN inventarios invD ON invD.id = r.inventario_id
     WHERE sc.idquote = CAST(? AS CHAR)
       AND r.deleted_at IS NULL
       AND r.estatus IN ('Reservado','Bonificado')
     ORDER BY r.inventario_id`,
    propuestaId,
  );

  // Flip para TODAS las tentativas (digital/IM también se venden; solo no ocupan
  // ni participan del guardián). ocupaEspacios = piezas TRADICIONALES (no IM/digital).
  const idsVendido: number[] = [];
  const idsVendidoBon: number[] = [];
  const ocupaEspacios = new Set<number>();
  for (const t of tentativas) {
    if (t.estatus === 'Bonificado') idsVendidoBon.push(t.reserva_id);
    else idsVendido.push(t.reserva_id);
    if (!Number(t.es_digital) && !Number(t.es_im)) ocupaEspacios.add(t.espacio_id);
  }

  const desplazadas: DesplazadaInfo[] = [];
  const idsAEvictar: number[] = [];

  // BATCH: en vez de 3 queries por reserva (lock+check+evict) en serie —que a 120
  // reservas contra BD remota revienta los 30s de la tx— hacemos ~3 queries TOTAL.
  if (ocupaEspacios.size > 0) {
    const espacioList = [...ocupaEspacios];
    const ph = espacioList.map(() => '?').join(',');
    // 1) Lock masivo de los espacios tradicionales (1 query). ORDER BY id para
    //    bloquear siempre en el mismo orden (deadlock-safe) y serializar aprobaciones.
    await tx.$executeRawUnsafe(
      `SELECT id FROM espacio_inventario WHERE id IN (${ph}) ORDER BY id FOR UPDATE`,
      ...espacioList,
    );

    // 2) Conflictos (1 query, self-join): tentativas tradicionales de esta propuesta
    //    cuya pieza YA está firme por OTRA cotización en el período (traslape).
    const conflictRows = await tx.$queryRawUnsafe<{
      reserva_id: number; espacio_id: number; inicio: string; fin: string; codigo_unico: string | null;
    }[]>(
      `SELECT DISTINCT r.id AS reserva_id, r.inventario_id AS espacio_id,
              DATE_FORMAT(sc.inicio_periodo, '%Y-%m-%d') AS inicio,
              DATE_FORMAT(sc.fin_periodo, '%Y-%m-%d') AS fin,
              COALESCE(invE.codigo_unico, invD.codigo_unico) AS codigo_unico
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
       LEFT JOIN inventarios invE ON invE.id = ei.inventario_id
       LEFT JOIN inventarios invD ON invD.id = r.inventario_id
       INNER JOIN reservas r2 ON r2.inventario_id = r.inventario_id
         AND r2.deleted_at IS NULL AND r2.estatus IN (${ESTATUS_FIRME_SQL})
       INNER JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
         AND sc2.idquote <> CAST(? AS CHAR)
         AND sc2.inicio_periodo <= sc.fin_periodo AND sc2.fin_periodo >= sc.inicio_periodo
       WHERE sc.idquote = CAST(? AS CHAR)
         AND r.deleted_at IS NULL AND r.estatus IN ('Reservado','Bonificado')
         AND COALESCE(invE.tradicional_digital, invD.tradicional_digital) = 'Tradicional'
         AND (sc.articulo IS NULL OR sc.articulo NOT LIKE 'IM-%')`,
      propuestaId, propuestaId,
    );

    // Fail-closed: cualquier conflicto aborta TODA la venta (la tx se revierte).
    if (conflictRows.length > 0) {
      throw new VentaConflictoError(conflictRows.map(x => ({
        reservaId: x.reserva_id,
        espacioId: x.espacio_id,
        codigoUnico: x.codigo_unico,
        inicioPeriodo: String(x.inicio),
        finPeriodo: String(x.fin),
      })));
    }

    // 3) Desplazamiento (1 query): tentativas de OTRAS propuestas sobre las piezas
    //    ganadas → se soft-deletean y se devuelven para notificar.
    const evictRows = await tx.$queryRawUnsafe<{
      reserva_id: number; idquote: string; ini: string; fin: string; codigo_unico: string | null; espacio_id: number;
    }[]>(
      `SELECT DISTINCT r2.id AS reserva_id, sc2.idquote AS idquote,
              DATE_FORMAT(sc2.inicio_periodo, '%Y-%m-%d') AS ini,
              DATE_FORMAT(sc2.fin_periodo, '%Y-%m-%d') AS fin,
              COALESCE(invE.codigo_unico, invD.codigo_unico) AS codigo_unico,
              r.inventario_id AS espacio_id
       FROM reservas r
       INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
       LEFT JOIN espacio_inventario ei ON ei.id = r.inventario_id
       LEFT JOIN inventarios invE ON invE.id = ei.inventario_id
       LEFT JOIN inventarios invD ON invD.id = r.inventario_id
       INNER JOIN reservas r2 ON r2.inventario_id = r.inventario_id
         AND r2.deleted_at IS NULL AND r2.estatus IN ('Reservado','Bonificado')
       INNER JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
         AND sc2.idquote <> CAST(? AS CHAR)
         AND sc2.inicio_periodo <= sc.fin_periodo AND sc2.fin_periodo >= sc.inicio_periodo
       WHERE sc.idquote = CAST(? AS CHAR)
         AND r.deleted_at IS NULL AND r.estatus IN ('Reservado','Bonificado')
         AND COALESCE(invE.tradicional_digital, invD.tradicional_digital) = 'Tradicional'
         AND (sc.articulo IS NULL OR sc.articulo NOT LIKE 'IM-%')`,
      propuestaId, propuestaId,
    );
    const evictSeen = new Set<number>();
    for (const e of evictRows) {
      if (evictSeen.has(e.reserva_id)) continue;
      evictSeen.add(e.reserva_id);
      idsAEvictar.push(e.reserva_id);
      desplazadas.push({
        reservaId: e.reserva_id,
        idquotePerdedora: String(e.idquote),
        espacioId: e.espacio_id,
        codigoUnico: e.codigo_unico,
        inicioPeriodo: String(e.ini),
        finPeriodo: String(e.fin),
      });
    }
  }

  // Flip (batch) + soft-delete de desplazadas (batch).
  if (idsVendido.length > 0) {
    await tx.reservas.updateMany({ where: { id: { in: idsVendido } }, data: { estatus: 'Vendido' } });
  }
  if (idsVendidoBon.length > 0) {
    await tx.reservas.updateMany({ where: { id: { in: idsVendidoBon } }, data: { estatus: 'Vendido bonificado' } });
  }
  if (idsAEvictar.length > 0) {
    await tx.reservas.updateMany({ where: { id: { in: idsAEvictar } }, data: { deleted_at: new Date() } });
  }

  return { vendidas: idsVendido.length + idsVendidoBon.length, desplazadas };
}

/**
 * Desplaza (soft-delete) las reservas TENTATIVAS (Reservado/Bonificado) de OTRAS
 * cotizaciones sobre las piezas físicas `espacioIds` que solapan [fechaInicio, fechaFin].
 * Se usa cuando una campaña FIRMA inventario directamente (createReservas) y debe
 * "robarle" la pieza a las propuestas que solo la tenían tentativa —el mismo desalojo
 * que hace el guardián al aprobar, pero para el alta directa en campaña.
 * Solo aplica a inventario Tradicional (digital comparte; IM no ocupa).
 * Devuelve las desplazadas para notificar a sus dueños.
 */
export async function desplazarTentativasEnEspacios(
  client: TxClient,
  espacioIds: number[],
  fechaInicio: Date,
  fechaFin: Date,
  excludeIdquote: string,
): Promise<DesplazadaInfo[]> {
  const espacios = [...new Set(espacioIds.map(Number).filter(n => !Number.isNaN(n)))];
  if (espacios.length === 0) return [];
  const ph = espacios.map(() => '?').join(',');
  // El propio idquote de la campaña NO se filtra en SQL (sus reservas son firmes, no
  // entran en el IN de tentativas); se descarta en JS por seguridad, evitando además
  // riesgo de colación al comparar idquote contra un parámetro.
  const rows = await client.$queryRawUnsafe<Array<{
    reserva_id: number; idquote: string; ini: string; fin: string;
    codigo_unico: string | null; espacio_id: number;
  }>>(
    `SELECT DISTINCT r2.id AS reserva_id, sc2.idquote AS idquote,
            DATE_FORMAT(sc2.inicio_periodo, '%Y-%m-%d') AS ini,
            DATE_FORMAT(sc2.fin_periodo, '%Y-%m-%d') AS fin,
            COALESCE(invE.codigo_unico, invD.codigo_unico) AS codigo_unico,
            r2.inventario_id AS espacio_id
     FROM reservas r2
     INNER JOIN solicitudCaras sc2 ON sc2.id = r2.solicitudCaras_id
     LEFT JOIN espacio_inventario ei ON ei.id = r2.inventario_id
     LEFT JOIN inventarios invE ON invE.id = ei.inventario_id
     LEFT JOIN inventarios invD ON invD.id = r2.inventario_id
     WHERE r2.inventario_id IN (${ph})
       AND r2.deleted_at IS NULL
       AND r2.estatus IN ('Reservado', 'Bonificado')
       AND sc2.inicio_periodo <= ? AND sc2.fin_periodo >= ?
       AND COALESCE(invE.tradicional_digital, invD.tradicional_digital) = 'Tradicional'
       AND (sc2.articulo IS NULL OR sc2.articulo NOT LIKE 'IM-%')`,
    ...espacios, fechaFin, fechaInicio,
  );
  if (rows.length === 0) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  const desplazadas: DesplazadaInfo[] = [];
  for (const r of rows) {
    if (String(r.idquote) === String(excludeIdquote)) continue;
    if (seen.has(r.reserva_id)) continue;
    seen.add(r.reserva_id);
    ids.push(r.reserva_id);
    desplazadas.push({
      reservaId: r.reserva_id,
      idquotePerdedora: String(r.idquote),
      espacioId: Number(r.espacio_id),
      codigoUnico: r.codigo_unico,
      inicioPeriodo: String(r.ini),
      finPeriodo: String(r.fin),
    });
  }
  if (ids.length === 0) return [];
  await client.reservas.updateMany({ where: { id: { in: ids } }, data: { deleted_at: new Date() } });
  return desplazadas;
}

/** Contexto opcional del desplazamiento, para el historial (quién movió qué a dónde). */
export interface DesplazamientoContexto {
  usuarioNombre?: string;
  usuarioId?: number;
  campanaId?: number;      // campaña/propuesta GANADORA (a donde se fueron las piezas)
  campanaNombre?: string;
  origen?: 'campana' | 'aprobacion';
}

/**
 * Al desplazar reservas tentativas de otras propuestas (por pase a ventas o por alta
 * directa en campaña) esta función, por cada propuesta perdedora:
 *  - (R3) crea la tarea "Reserva desplazada" a sus asesores (id_asignado) Y a Tráfico;
 *  - (R4) la deja en estatus "Ajuste Inventario" (bloquea edición de circuitos a asesores);
 *  - emite RESERVA_ELIMINADA para que, si está abierta, se refresque sola;
 *  - (R1) registra en su historial el desplazamiento SIN el usuario, con el id de la
 *         ganadora y el motivo "…por el pase a ventas".
 * Y una vez, (R2) registra en el historial de la GANADORA (campaña o propuesta) que se
 * quedó con ubicaciones de otras propuestas.
 * Compartido por el approve (#4b) y por createReservas de campañas.
 */
export async function notificarReservasDesplazadas(
  desplazadas: DesplazadaInfo[],
  ctx: DesplazamientoContexto = {},
): Promise<void> {
  if (desplazadas.length === 0) return;
  const porPropuesta = new Map<string, DesplazadaInfo[]>();
  for (const d of desplazadas) {
    const arr = porPropuesta.get(d.idquotePerdedora) || [];
    arr.push(d);
    porPropuesta.set(d.idquotePerdedora, arr);
  }

  // Ganadora: campaña (alta directa) o propuesta (pase a ventas). Solo se usa para
  // el historial de la GANADORA (R2). En el de la PERDEDORA (R1) NO se revela quién
  // se quedó las reservas — instrucción del jefe: "que no sepan a dónde se fueron".
  const ganadorEsCampana = (ctx.origen ?? 'campana') === 'campana';

  // (R3) Usuarios de Tráfico (una sola consulta) para avisarles además de los asesores.
  let traficoIds: number[] = [];
  try {
    const trafico = await defaultPrisma.usuario.findMany({
      where: {
        OR: [
          { puesto: { contains: 'Tráfico' } }, { puesto: { contains: 'Trafico' } },
          { area: { contains: 'Tráfico' } }, { area: { contains: 'Trafico' } },
        ],
        deleted_at: null,
        NOT: { user_role: 'Coordinador de Diseño' },
      },
      select: { id: true },
    });
    traficoIds = trafico.map(u => u.id);
  } catch { /* noop */ }

  const now = new Date();
  const fin = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // Estatus "muertos": la propuesta ya no se trabaja, no tiene sentido mandarla a ajuste.
  // (Aprobada / Pase a ventas SÍ pasan a "Ajuste Inventario" cuando les roban reservas —
  //  instrucción del jefe: "cuando a una propuesta le roban reservas, cambia a Ajuste Inventario".)
  const estatusTerminal = ['Cancelada', 'Descartada', 'Rechazada', 'Liberada'];
  let totalDesplazadas = 0;
  const perdedorasResumen: string[] = [];

  for (const [idquote, items] of porPropuesta) {
    const prop = await defaultPrisma.propuesta.findUnique({ where: { id: parseInt(idquote) } });
    if (!prop || prop.deleted_at) continue;
    const owners = (prop.id_asignado || '')
      .split(',').map(s => parseInt(s.trim())).filter(n => !Number.isNaN(n));
    const codigos = [...new Set(items.map(i => i.codigoUnico).filter(Boolean))];
    totalDesplazadas += items.length;
    perdedorasResumen.push(`#${idquote} (${items.length})`);

    // Catorcena/periodo del desplazamiento (para textos).
    const ini = items[0]?.inicioPeriodo;
    let periodoTxt = ini && items[0]?.finPeriodo ? `${ini} a ${items[0].finPeriodo}` : '';
    if (ini) {
      try {
        const cat = await defaultPrisma.catorcenas.findFirst({
          where: { fecha_inicio: { lte: new Date(ini) }, fecha_fin: { gte: new Date(ini) } },
          select: { numero_catorcena: true, a_o: true },
        });
        if (cat?.numero_catorcena != null) periodoTxt = `cat ${cat.numero_catorcena}${cat.a_o ? '/' + cat.a_o : ''}`;
      } catch { /* deja el rango de fechas */ }
    }

    // Artículo(s) de las piezas desplazadas (para el historial de la perdedora).
    let articuloTxt = '';
    try {
      const reservaIds = items.map(i => i.reservaId).filter(n => Number.isFinite(n));
      if (reservaIds.length) {
        const artRows = await defaultPrisma.$queryRawUnsafe<{ articulo: string | null }[]>(
          `SELECT DISTINCT sc.articulo AS articulo
             FROM reservas r
             INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
            WHERE r.id IN (${reservaIds.map(() => '?').join(',')})`,
          ...reservaIds,
        );
        articuloTxt = [...new Set(artRows.map(a => a.articulo).filter(Boolean))].join(', ');
      }
    } catch { /* noop */ }

    // (R4) La propuesta perdedora pasa a "Ajuste Inventario" para que reasignen y se
    //      bloquee la edición de circuitos a los asesores (guards en el controller).
    const estatusAnterior = prop.status || '';
    let estatusCambiado = false;
    if (!estatusTerminal.includes(estatusAnterior) && estatusAnterior !== 'Ajuste Inventario') {
      try {
        await defaultPrisma.propuesta.update({ where: { id: parseInt(idquote) }, data: { status: 'Ajuste Inventario' } });
        estatusCambiado = true;
      } catch (e) {
        // Ya NO en silencio: si esto falla, quedó rastro en logs para diagnosticar.
        console.error('[desplazamiento] no se pudo poner "Ajuste Inventario" en propuesta', idquote, e);
      }
    }

    // (R3) Alertas DIFERENCIADAS (instrucción del jefe):
    //   - Asesores dueños de la propuesta  -> TAREA accionable (tipo != 'Notificación'):
    //     aparece en su lista de tareas con fecha, la tienen que marcar Atendida.
    //   - Tráfico                          -> NOTIFICACIÓN informativa (tipo 'Notificación'):
    //     solo aviso, no una tarea que deban cerrar.
    const descBase = `${items.length} ubicación(es) de la propuesta ${idquote} se desplazaron${periodoTxt ? ' (' + periodoTxt + ')' : ''}.`;
    const piezasTxt = codigos.length ? `Piezas: ${codigos.join(', ')}` : '';
    const camposComunes = {
      categoria: 'general',
      estatus: 'Pendiente',
      responsable: '',
      id_solicitud: String(prop.solicitud_id),
      id_propuesta: idquote,
      campania_id: parseInt(idquote),
      fecha_inicio: now,
      fecha_fin: fin,
      asignado: '',
      id_asignado: '',
    };

    const asesorIds = [...new Set(owners)];
    const traficoDestIds = [...new Set(traficoIds)].filter(id => !owners.includes(id));

    // Asesores -> TAREA
    for (const destId of asesorIds) {
      await defaultPrisma.tareas.create({
        data: {
          titulo: 'Reservar ubicaciones desplazadas',
          descripcion: `${descBase} Hay que volver a reservarlas.`,
          contenido: piezasTxt,
          tipo: 'Propuesta',
          id_responsable: destId,
          ...camposComunes,
        },
      });
    }

    // Tráfico -> NOTIFICACIÓN (excluye a quien ya sea dueño para no duplicarle el aviso)
    for (const destId of traficoDestIds) {
      await defaultPrisma.tareas.create({
        data: {
          titulo: 'Reservas desplazadas',
          descripcion: `Aviso: ${descBase} Los asesores de la propuesta ${idquote} tienen que volver a reservarlas.`,
          contenido: piezasTxt,
          tipo: 'Notificación',
          id_responsable: destId,
          ...camposComunes,
        },
      });
    }

    // POPUP EN VIVO: un solo emit DIRIGIDO (con `destinatarios`) para que el front
    // dispare el toast SOLO a asesores + Tráfico. Categoría 'reserva_desplazada'
    // salta las preferencias opt-in (igual que 'conflicto_ocupacion') → el aviso
    // NO se pierde en silencio. (El bug anterior: emit sin `destinatarios` +
    // `tareaId` en vez de `tarea_id` → `paraMi=false` → nunca había popup.)
    const destinatariosPopup = [...asesorIds, ...traficoDestIds];
    if (destinatariosPopup.length) {
      try {
        emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
          tipo: 'Notificación',
          clase: 'notificacion',
          categoria: 'reserva_desplazada',
          titulo: 'Reservas desplazadas',
          descripcion: `${descBase} Hay que volver a reservarlas.`,
          destinatarios: destinatariosPopup,
        });
      } catch { /* noop */ }
    }

    // CORREO a los asesores dueños de la propuesta (fail-soft, no bloquea).
    if (asesorIds.length) {
      void enviarCorreoDesplazamiento(asesorIds, idquote, items.length, periodoTxt, articuloTxt, codigos);
    }

    // Refresco en vivo de la propuesta abierta (reservas + historial).
    try {
      emitToPropuesta(parseInt(idquote), SOCKET_EVENTS.RESERVA_ELIMINADA, { propuestaId: parseInt(idquote) });
    } catch { /* noop */ }

    // (R1) Historial de la propuesta perdedora — SIN usuario y SIN revelar a dónde se
    //      fueron las reservas: solo cuántas, de qué catorcena y qué artículo.
    try {
      await defaultPrisma.historial.create({
        data: {
          tipo: 'Propuesta',
          ref_id: parseInt(idquote),
          accion: 'Reservas desplazadas',
          fecha_hora: now,
          detalles: JSON.stringify({
            reservas_eliminadas: items.length,
            motivo: `Se desplazaron ${items.length} reserva(s)${periodoTxt ? ' de la ' + periodoTxt : ''}.`,
            ...(articuloTxt ? { articulo: articuloTxt } : {}),
            codigos: codigos.slice(0, 60),
            ...(estatusCambiado ? { estatus_anterior: estatusAnterior, estatus_nuevo: 'Ajuste Inventario' } : {}),
          }),
        },
      });
    } catch { /* noop */ }
  }

  // (R2) Historial en la GANADORA: registra que se quedó con ubicaciones de otras propuestas.
  if (ctx.campanaId) {
    try {
      await defaultPrisma.historial.create({
        data: {
          tipo: ganadorEsCampana ? 'Campaña' : 'Propuesta',
          ref_id: ctx.campanaId,
          accion: 'Reservas ganadas',
          fecha_hora: now,
          detalles: JSON.stringify({
            reservas_eliminadas: totalDesplazadas,
            motivo: ganadorEsCampana
              ? `Se reservaron ${totalDesplazadas} ubicación(es) que tenían otras propuestas (${perdedorasResumen.join(', ')}), desplazándolas.`
              : `El pase a ventas tomó ${totalDesplazadas} ubicación(es) que tenían otras propuestas (${perdedorasResumen.join(', ')}), desplazándolas.`,
          }),
        },
      });
    } catch { /* noop */ }
  }
}
