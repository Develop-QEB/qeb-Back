// Vigencia de los bloqueos administrativos de inventario. Columnas
// `inventarios.bloqueo_*` (schema.prisma).
//
// Reglas (rediseño 2026-11-27):
//   - 'No Disponible' lleva vigencia [fecha_inicio, fecha_fin] (ambas
//     inclusivas). Bloquea SOLO ese rango: fuera de él la pieza se puede
//     reservar (la regla vive en inventario-bloqueo.service.ts →
//     inventarioNoUtilizableEnRango / sqlInventarioNoUtilizableEnRango).
//       · fecha_inicio: hoy (o sin fecha) = se aplica de inmediato. Futura =
//         bloqueo PROGRAMADO: el estatus sigue Disponible hasta ese día (lo
//         aplica el job), pero el rango ya queda bloqueado desde que se captura.
//       · fecha_fin: NULL = indefinido (hasta habilitar a mano).
//   - 'Inhabilitado' NO lleva vigencia: bloquea todas las fechas, se aplica de
//     inmediato y solo se quita a mano.
//   - Al bloquear (inmediato o programado) se liberan las reservas que se
//     traslapan con el rango. Si el rango toca aunque sea un día de una
//     catorcena, esa reserva se libera.
//
// Job diario `procesarVigenciasBloqueo` (server.ts: 00:00 CDMX + al arrancar,
// idempotente):
//   1. Aplica el estatus de los bloqueos programados cuya fecha de inicio llegó.
//   2. Los bloqueos cuya fecha fin ya pasó (fin < hoy) regresan SOLOS a
//      Disponible y a quien bloqueó le llega una notificación informativa.

import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../utils/prisma';
import {
  ESTATUS_INVENTARIO_BLOQUEO,
  ESTATUS_INVENTARIO_BLOQUEO_SQL,
  ESTATUS_INVENTARIO_BLOQUEO_RANGO,
  TipoBloqueoInventario,
} from './inventario-bloqueo.service';

type TxClient = PrismaClient | Prisma.TransactionClient;

/** `tareas.tipo` de las tareas que creaba la versión anterior al cumplirse la
 *  vigencia (rehabilitar a mano). Ya no se crean; se conserva porque el front
 *  todavía pinta las que existan. */
export const TAREA_TIPO_VIGENCIA_BLOQUEO = 'Vigencia Bloqueo Inventario';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Estatus de reserva que se liberan al bloquear (todo lo que aparta o vende la pieza). */
const ESTATUS_RESERVA_LIBERABLES = [
  'Reservado', 'Bonificado', 'Reservado Bloqueado', 'Bonificado Bloqueado',
  'Vendido', 'Vendido bonificado', 'Con Arte', 'Sin Arte',
];
const ESTATUS_RESERVA_LIBERABLES_SQL = ESTATUS_RESERVA_LIBERABLES.map((e) => `'${e}'`).join(',');

/** Hoy en CDMX como 'YYYY-MM-DD' (la zona del server puede diferir). */
export function hoyCDMX(): string {
  const nowMx = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return `${nowMx.getFullYear()}-${String(nowMx.getMonth() + 1).padStart(2, '0')}-${String(nowMx.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → Date a medianoche UTC. Así Prisma la guarda en la columna
 *  DATE sin corrimiento (MySQL DATE no tiene zona). */
export function fechaADate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Date/string de una columna DATE → 'YYYY-MM-DD' (o null). */
export function dateAFecha(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa' para textos de tareas/historial. */
export function fechaCorta(ymd: string | null | undefined): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export interface VigenciaBloqueo {
  /** 'YYYY-MM-DD'. Nunca menor a hoy (se recorta). */
  fecha_inicio: string;
  /** 'YYYY-MM-DD' o null = indefinido. */
  fecha_fin: string | null;
}

function esTipoConVigencia(tipo: string): boolean {
  return (ESTATUS_INVENTARIO_BLOQUEO_RANGO as readonly string[]).includes(tipo);
}

/**
 * Valida el body de toggleBlock ({ fecha_inicio?, fecha_fin? }). Sin fechas →
 * vigencia desde hoy e indefinida. 'Inhabilitado' no acepta fechas. Devuelve
 * `error` con el mensaje para 400.
 */
export function parseVigenciaBody(body: unknown, tipo: TipoBloqueoInventario): { vigencia: VigenciaBloqueo; error?: undefined } | { vigencia?: undefined; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const hoy = hoyCDMX();
  const rawInicio = b.fecha_inicio;
  const rawFin = b.fecha_fin;
  const vacio = (v: unknown) => v === undefined || v === null || v === '';

  if (!esTipoConVigencia(tipo)) {
    if (!vacio(rawInicio) || !vacio(rawFin)) {
      return { error: `${tipo} no lleva vigencia: bloquea todas las fechas hasta que se habilite manualmente.` };
    }
    return { vigencia: { fecha_inicio: hoy, fecha_fin: null } };
  }

  let inicio = hoy;
  if (!vacio(rawInicio)) {
    if (typeof rawInicio !== 'string' || !RE_FECHA.test(rawInicio)) {
      return { error: 'fecha_inicio inválida. Formato esperado: YYYY-MM-DD' };
    }
    // Una fecha pasada no tiene sentido como "programado": se recorta a hoy
    // (cubre también al usuario en otra zona horaria que ya cambió de día).
    inicio = rawInicio < hoy ? hoy : rawInicio;
  }

  let fin: string | null = null;
  if (!vacio(rawFin)) {
    if (typeof rawFin !== 'string' || !RE_FECHA.test(rawFin)) {
      return { error: 'fecha_fin inválida. Formato esperado: YYYY-MM-DD' };
    }
    if (rawFin < inicio) {
      return { error: 'fecha_fin no puede ser menor a fecha_inicio' };
    }
    fin = rawFin;
  }

  return { vigencia: { fecha_inicio: inicio, fecha_fin: fin } };
}

/** Texto humano de una vigencia para historial / descripciones. */
export function describirVigencia(v: { fecha_inicio?: string | null; fecha_fin?: string | null }): string {
  if (!v.fecha_fin) {
    return v.fecha_inicio ? `desde ${fechaCorta(v.fecha_inicio)}, indefinida (hasta habilitar manualmente)` : 'indefinida (hasta habilitar manualmente)';
  }
  return v.fecha_inicio
    ? `del ${fechaCorta(v.fecha_inicio)} al ${fechaCorta(v.fecha_fin)}`
    : `hasta ${fechaCorta(v.fecha_fin)}`;
}

function verboDeAccion(accion: string): string {
  return accion === 'Bloqueado' ? 'bloqueó'
    : accion === 'No Disponible' ? 'marcó como No Disponible'
    : accion === 'Inhabilitado' ? 'inhabilitó'
    : accion === 'Habilitado' ? 'habilitó'
    : 'desbloqueó';
}

/**
 * Soft-delete de las reservas de la pieza que se traslapan con la vigencia.
 * Nunca toca reservas que ya terminaron (el límite inferior es
 * max(fecha_inicio, hoy)), para no borrar historial de pautas vencidas. El
 * estatus de la reserva se preserva para auditoría; solo `deleted_at` la saca
 * del flujo. Al desbloquear NO se restauran.
 */
export async function liberarReservasEnVigencia(tx: TxClient, inventarioId: number, vigencia: VigenciaBloqueo): Promise<number> {
  const hoy = hoyCDMX();
  const desde = vigencia.fecha_inicio > hoy ? vigencia.fecha_inicio : hoy;
  if (vigencia.fecha_fin && vigencia.fecha_fin < desde) return 0;
  // r.inventario_id puede apuntar a inventarios.id o a espacio_inventario.id
  // (polimórfico). Soft-delete ambos casos.
  const result = await tx.$executeRawUnsafe(
    `UPDATE reservas r
     LEFT JOIN espacio_inventario ein ON ein.id = r.inventario_id
     INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
     SET r.deleted_at = NOW()
     WHERE COALESCE(ein.inventario_id, r.inventario_id) = ?
       AND r.deleted_at IS NULL
       AND r.estatus IN (${ESTATUS_RESERVA_LIBERABLES_SQL})
       AND sc.fin_periodo >= ?
       AND (? IS NULL OR sc.inicio_periodo <= ?)`,
    inventarioId,
    fechaADate(desde),
    vigencia.fecha_fin ? fechaADate(vigencia.fecha_fin) : null,
    vigencia.fecha_fin ? fechaADate(vigencia.fecha_fin) : null
  );
  return Number(result) || 0;
}

interface AplicarBloqueoArgs {
  id: number;
  codigo: string | null;
  tipo: TipoBloqueoInventario;
  vigencia: VigenciaBloqueo;
  usuarioId: number | null;
  userName: string;
  /** Texto extra para el historial (ej. "(bloqueo programado)"). */
  nota?: string;
}

/**
 * Aplica el bloqueo a una pieza: libera reservas en el rango, estatus = tipo,
 * columnas de vigencia e historial. Compartido por toggleBlock (bloqueo
 * inmediato) y por el job diario (bloqueo programado). Debe ir dentro de una
 * transacción (recibe `tx`).
 */
export async function aplicarBloqueoInventario(tx: TxClient, args: AplicarBloqueoArgs): Promise<{ liberadas: number }> {
  const { id, codigo, tipo, usuarioId, userName, nota } = args;
  // Inhabilitado no lleva vigencia (aunque venga de un programado viejo).
  const vigencia: VigenciaBloqueo = esTipoConVigencia(tipo) ? args.vigencia : { fecha_inicio: args.vigencia.fecha_inicio, fecha_fin: null };

  const liberadas = await liberarReservasEnVigencia(tx, id, vigencia);

  await tx.inventarios.update({
    where: { id },
    data: {
      estatus: tipo,
      // Ya aplicado, el tipo vive en `estatus`. Se deja NULL a propósito:
      // `bloqueo_tipo` lleno + estatus no bloqueado es lo que el job y el front
      // leen como "programado pendiente".
      bloqueo_tipo: null,
      bloqueo_fecha_inicio: fechaADate(vigencia.fecha_inicio),
      bloqueo_fecha_fin: vigencia.fecha_fin ? fechaADate(vigencia.fecha_fin) : null,
      bloqueo_usuario_id: usuarioId,
      bloqueo_aviso_at: null,
    },
  });

  const partes = [
    `${userName} ${verboDeAccion(tipo)} el inventario ${codigo || id}`,
    nota || null,
    esTipoConVigencia(tipo) ? `— vigencia ${describirVigencia(vigencia)}` : '— sin vigencia (todas las fechas)',
    liberadas > 0 ? `— ${liberadas} reservas liberadas` : null,
  ].filter(Boolean);

  await tx.historial.create({
    data: {
      tipo: 'Inventario',
      ref_id: id,
      accion: tipo,
      fecha_hora: new Date(),
      detalles: partes.join(' '),
    },
  });

  return { liberadas };
}

/**
 * Deja la pieza como programada: guarda tipo + vigencia + usuario SIN tocar el
 * estatus. El rango ya queda bloqueado para reservar y las reservas que se
 * traslapan se liberan desde ahora. El job diario pone el estatus el día de
 * fecha_inicio.
 */
export async function programarBloqueoInventario(tx: TxClient, args: Omit<AplicarBloqueoArgs, 'nota'>): Promise<{ liberadas: number }> {
  const { id, codigo, tipo, vigencia, usuarioId, userName } = args;
  const liberadas = await liberarReservasEnVigencia(tx, id, vigencia);
  await tx.inventarios.update({
    where: { id },
    data: {
      bloqueo_tipo: tipo,
      bloqueo_fecha_inicio: fechaADate(vigencia.fecha_inicio),
      bloqueo_fecha_fin: vigencia.fecha_fin ? fechaADate(vigencia.fecha_fin) : null,
      bloqueo_usuario_id: usuarioId,
      bloqueo_aviso_at: null,
    },
  });
  await tx.historial.create({
    data: {
      tipo: 'Inventario',
      ref_id: id,
      accion: 'Bloqueo programado',
      fecha_hora: new Date(),
      detalles: [
        `${userName} programó el inventario ${codigo || id} como ${tipo} — vigencia ${describirVigencia(vigencia)}`,
        liberadas > 0 ? `— ${liberadas} reservas liberadas` : null,
      ].filter(Boolean).join(' '),
    },
  });
  return { liberadas };
}

/** Limpia las columnas de vigencia (al habilitar o al cancelar un programado). */
export function datosLimpiarVigencia(): Prisma.inventariosUpdateInput {
  return {
    bloqueo_tipo: null,
    bloqueo_fecha_inicio: null,
    bloqueo_fecha_fin: null,
    bloqueo_usuario_id: null,
    bloqueo_aviso_at: null,
  };
}

interface FilaVigencia {
  id: number;
  codigo_unico: string | null;
  ubicacion: string | null;
  plaza: string | null;
  estatus: string | null;
  bloqueo_tipo: string | null;
  bloqueo_fecha_inicio: Date | string | null;
  bloqueo_fecha_fin: Date | string | null;
  bloqueo_usuario_id: number | null;
}

const SELECT_FILA = `SELECT id, codigo_unico, ubicacion, plaza, estatus, bloqueo_tipo,
         bloqueo_fecha_inicio, bloqueo_fecha_fin, bloqueo_usuario_id
  FROM inventarios`;

const BLOQUEO_RANGO_SQL = ESTATUS_INVENTARIO_BLOQUEO_RANGO.map((e) => `'${e}'`).join(',');

async function nombreUsuario(id: number | null): Promise<string> {
  if (!id) return 'Sistema';
  const u = await prisma.usuario.findUnique({ where: { id }, select: { nombre: true } });
  return u?.nombre || `Usuario #${id}`;
}

function esTipoBloqueo(v: string | null): v is TipoBloqueoInventario {
  return !!v && (ESTATUS_INVENTARIO_BLOQUEO as readonly string[]).includes(v);
}

function lineasInventario(inv: FilaVigencia): string[] {
  return [
    `Inventario: #${inv.id}${inv.codigo_unico ? ` — ${inv.codigo_unico}` : ''}`,
    inv.ubicacion ? `Ubicación: ${inv.ubicacion}` : null,
    inv.plaza ? `Plaza: ${inv.plaza}` : null,
  ].filter((v): v is string => v !== null);
}

/**
 * Job diario. Idempotente: los programados se aplican una sola vez (al
 * aplicarse el estatus ya es de bloqueo y salen del filtro); los vencidos se
 * regresan a Disponible y salen del filtro.
 */
export async function procesarVigenciasBloqueo(): Promise<{ aplicados: number; liberados: number }> {
  const hoy = hoyCDMX();
  let aplicados = 0;
  let liberados = 0;

  // ── 1) Bloqueos programados cuya fecha de inicio ya llegó ────────────────
  // Si el server estuvo abajo y el programado ya venció (fin < hoy), no se
  // aplica: el paso 2 no lo vería (sigue Disponible), así que solo se limpia.
  const programados = await prisma.$queryRawUnsafe<FilaVigencia[]>(
    `${SELECT_FILA}
     WHERE bloqueo_tipo IS NOT NULL
       AND bloqueo_fecha_inicio IS NOT NULL
       AND bloqueo_fecha_inicio <= ?
       AND (estatus IS NULL OR estatus NOT IN (${ESTATUS_INVENTARIO_BLOQUEO_SQL}))`,
    hoy
  );

  for (const inv of programados) {
    if (!esTipoBloqueo(inv.bloqueo_tipo)) continue;
    const tipo = inv.bloqueo_tipo;
    const vigencia: VigenciaBloqueo = {
      fecha_inicio: dateAFecha(inv.bloqueo_fecha_inicio) || hoy,
      fecha_fin: dateAFecha(inv.bloqueo_fecha_fin),
    };
    try {
      if (vigencia.fecha_fin && vigencia.fecha_fin < hoy) {
        await prisma.inventarios.update({ where: { id: inv.id }, data: datosLimpiarVigencia() });
        continue;
      }
      const userName = await nombreUsuario(inv.bloqueo_usuario_id);
      const { liberadas } = await prisma.$transaction(tx =>
        aplicarBloqueoInventario(tx, {
          id: inv.id,
          codigo: inv.codigo_unico,
          tipo,
          vigencia,
          usuarioId: inv.bloqueo_usuario_id,
          userName,
          nota: '(bloqueo programado, aplicado automáticamente)',
        })
      );
      aplicados += 1;

      if (inv.bloqueo_usuario_id) {
        await prisma.tareas.create({
          data: {
            titulo: `Bloqueo programado aplicado — #${inv.id}${inv.codigo_unico ? ` ${inv.codigo_unico}` : ''}`,
            descripcion: [
              ...lineasInventario(inv),
              `Tipo: ${tipo}`,
              `Vigencia: ${describirVigencia(vigencia)}`,
              liberadas > 0 ? `Reservas liberadas hoy: ${liberadas}` : null,
            ].filter(Boolean).join('\n'),
            tipo: 'Notificación',
            categoria: 'cambio_estatus',
            estatus: 'Pendiente',
            id_responsable: inv.bloqueo_usuario_id,
            responsable: '',
            asignado: 'Sistema',
            id_asignado: '',
            id_solicitud: '',
          },
        });
      }
    } catch (err) {
      console.error(`[VigenciaBloqueos] Error aplicando bloqueo programado del inventario ${inv.id}:`, err);
    }
  }

  // ── 2) Vigencias cumplidas: la pieza regresa sola a Disponible ───────────
  // fecha_fin es inclusiva: el día fin sigue bloqueada; al día siguiente se libera.
  const vencidos = await prisma.$queryRawUnsafe<FilaVigencia[]>(
    `${SELECT_FILA}
     WHERE estatus IN (${BLOQUEO_RANGO_SQL})
       AND bloqueo_fecha_fin IS NOT NULL
       AND bloqueo_fecha_fin < ?`,
    hoy
  );

  for (const inv of vencidos) {
    const fechaInicio = dateAFecha(inv.bloqueo_fecha_inicio);
    const fechaFin = dateAFecha(inv.bloqueo_fecha_fin);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.inventarios.update({
          where: { id: inv.id },
          data: { estatus: 'Disponible', ...datosLimpiarVigencia() },
        });
        await tx.historial.create({
          data: {
            tipo: 'Inventario',
            ref_id: inv.id,
            accion: 'Vigencia cumplida',
            fecha_hora: new Date(),
            detalles: `Se cumplió la vigencia del bloqueo del inventario ${inv.codigo_unico || inv.id} (${describirVigencia({ fecha_inicio: fechaInicio, fecha_fin: fechaFin })}); regresó automáticamente a Disponible`,
          },
        });
      });
      liberados += 1;

      if (inv.bloqueo_usuario_id) {
        await prisma.tareas.create({
          data: {
            titulo: `Inventario Disponible otra vez — #${inv.id}${inv.codigo_unico ? ` ${inv.codigo_unico}` : ''}`,
            descripcion: [
              ...lineasInventario(inv),
              `Vigencia: ${describirVigencia({ fecha_inicio: fechaInicio, fecha_fin: fechaFin })}`,
              '',
              `La vigencia del bloqueo terminó el ${fechaCorta(fechaFin)} y la pieza regresó automáticamente a Disponible.`,
            ].join('\n'),
            tipo: 'Notificación',
            categoria: 'cambio_estatus',
            estatus: 'Pendiente',
            id_responsable: inv.bloqueo_usuario_id,
            responsable: '',
            asignado: 'Sistema',
            id_asignado: '',
            id_solicitud: '',
          },
        });
      }
    } catch (err) {
      console.error(`[VigenciaBloqueos] Error regresando a Disponible el inventario ${inv.id}:`, err);
    }
  }

  console.log(`[VigenciaBloqueos] hoy CDMX ${hoy}: programados aplicados=${aplicados} (de ${programados.length}), vencidos a Disponible=${liberados} (de ${vencidos.length})`);
  return { aplicados, liberados };
}
