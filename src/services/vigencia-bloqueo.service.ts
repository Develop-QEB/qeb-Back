// Vigencia de los bloqueos administrativos de inventario (No Disponible /
// Inhabilitado). Columnas `inventarios.bloqueo_*` (schema.prisma).
//
// Al bloquear una pieza (toggleBlock) se puede capturar un periodo opcional:
//   - fecha_inicio: desde cuándo. Hoy (o sin fecha) = se aplica de inmediato.
//     Futura = bloqueo PROGRAMADO: el estatus NO cambia hasta esa fecha; lo
//     aplica el job diario y entre tanto la pieza sigue reservable.
//   - fecha_fin: hasta cuándo. NULL = indefinido, se queda bloqueado hasta que
//     alguien lo habilite a mano.
//   - bloqueo_usuario_id: quién bloqueó. Es a quien le llega la tarea al
//     cumplirse la vigencia.
//
// Job diario `procesarVigenciasBloqueo` (server.ts: 00:00 CDMX + al arrancar,
// idempotente):
//   1. Aplica los bloqueos programados cuya fecha de inicio ya llegó (libera
//      reservas vigentes igual que un bloqueo manual) y avisa al usuario.
//   2. Para los bloqueos cuya fecha fin ya se cumplió y aún no se avisó, crea
//      una tarea 'Vigencia Bloqueo Inventario' al usuario que bloqueó. Desde la
//      tarea (NotificacionesPage) se puede rehabilitar la pieza con un clic.
//      El bloqueo NO se levanta solo: la decisión es del usuario.

import { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../utils/prisma';
import {
  ESTATUS_INVENTARIO_BLOQUEO,
  ESTATUS_INVENTARIO_BLOQUEO_SQL,
  TipoBloqueoInventario,
} from './inventario-bloqueo.service';

type TxClient = PrismaClient | Prisma.TransactionClient;

/** `tareas.tipo` de la tarea que se crea al cumplirse la vigencia. Espejo en
 *  el front: lib/bloqueoInventario.ts (TAREA_TIPO_VIGENCIA_BLOQUEO). */
export const TAREA_TIPO_VIGENCIA_BLOQUEO = 'Vigencia Bloqueo Inventario';

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Valida el body de toggleBlock ({ fecha_inicio?, fecha_fin? }). Sin fechas →
 * vigencia desde hoy e indefinida. Devuelve `error` con el mensaje para 400.
 */
export function parseVigenciaBody(body: unknown): { vigencia: VigenciaBloqueo; error?: undefined } | { vigencia?: undefined; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const hoy = hoyCDMX();
  const rawInicio = b.fecha_inicio;
  const rawFin = b.fecha_fin;

  let inicio = hoy;
  if (rawInicio !== undefined && rawInicio !== null && rawInicio !== '') {
    if (typeof rawInicio !== 'string' || !RE_FECHA.test(rawInicio)) {
      return { error: 'fecha_inicio inválida. Formato esperado: YYYY-MM-DD' };
    }
    // Una fecha pasada no tiene sentido como "programado": se recorta a hoy
    // (cubre también al usuario en otra zona horaria que ya cambió de día).
    inicio = rawInicio < hoy ? hoy : rawInicio;
  }

  let fin: string | null = null;
  if (rawFin !== undefined && rawFin !== null && rawFin !== '') {
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
 * Aplica el bloqueo a una pieza: soft-delete de sus reservas vigentes, estatus
 * = tipo, columnas de vigencia e historial. Compartido por toggleBlock (bloqueo
 * inmediato) y por el job diario (bloqueo programado). Debe ir dentro de una
 * transacción (recibe `tx`).
 *
 * Solo se liberan reservas ACTUALES o FUTURAS (`sc.fin_periodo >= CURDATE()`):
 * las pasadas se conservan para no borrar historial de pautas vencidas. El
 * estatus de la reserva se preserva para auditoría; solo `deleted_at` la saca
 * del flujo. Al desbloquear NO se restauran: eso lo decide el asesor con las
 * tareas que genera el front.
 */
export async function aplicarBloqueoInventario(tx: TxClient, args: AplicarBloqueoArgs): Promise<{ liberadas: number }> {
  const { id, codigo, tipo, vigencia, usuarioId, userName, nota } = args;

  // r.inventario_id puede apuntar a inventarios.id o a espacio_inventario.id
  // (polimórfico). Soft-delete ambos casos.
  const result = await tx.$executeRawUnsafe(
    `UPDATE reservas r
     LEFT JOIN espacio_inventario ein ON ein.id = r.inventario_id
     INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
     SET r.deleted_at = NOW()
     WHERE COALESCE(ein.inventario_id, r.inventario_id) = ?
       AND r.deleted_at IS NULL
       AND r.estatus IN ('Reservado','Bonificado','Vendido','Vendido bonificado','Con Arte','Sin Arte')
       AND sc.fin_periodo >= CURDATE()`,
    id
  );
  const liberadas = Number(result) || 0;

  await tx.inventarios.update({
    where: { id },
    data: {
      estatus: tipo,
      // Ya aplicado, el tipo vive en `estatus`. Se deja NULL a propósito:
      // `bloqueo_tipo` lleno + estatus no bloqueado es lo que el job y el front
      // leen como "programado pendiente". Si alguien después pone la pieza en
      // Disponible por otra vía (formulario de edición, CSV), no debe quedar
      // como programada ni volver a bloquearse sola.
      bloqueo_tipo: null,
      bloqueo_fecha_inicio: fechaADate(vigencia.fecha_inicio),
      bloqueo_fecha_fin: vigencia.fecha_fin ? fechaADate(vigencia.fecha_fin) : null,
      bloqueo_usuario_id: usuarioId,
      // Nueva vigencia → nuevo aviso al vencer.
      bloqueo_aviso_at: null,
    },
  });

  const partes = [
    `${userName} ${verboDeAccion(tipo)} el inventario ${codigo || id}`,
    nota || null,
    `— vigencia ${describirVigencia(vigencia)}`,
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
 * estatus ni las reservas. El job diario la aplicará el día de fecha_inicio.
 */
export async function programarBloqueoInventario(tx: TxClient, args: Omit<AplicarBloqueoArgs, 'nota'>): Promise<void> {
  const { id, codigo, tipo, vigencia, usuarioId, userName } = args;
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
      detalles: `${userName} programó el inventario ${codigo || id} como ${tipo} — vigencia ${describirVigencia(vigencia)}`,
    },
  });
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

async function nombreUsuario(id: number | null): Promise<string> {
  if (!id) return 'Sistema';
  const u = await prisma.usuario.findUnique({ where: { id }, select: { nombre: true } });
  return u?.nombre || `Usuario #${id}`;
}

function esTipoBloqueo(v: string | null): v is TipoBloqueoInventario {
  return !!v && (ESTATUS_INVENTARIO_BLOQUEO as readonly string[]).includes(v);
}

/**
 * Job diario. Idempotente: los programados se aplican una sola vez (al
 * aplicarse el estatus ya es de bloqueo y salen del filtro); los vencidos se
 * avisan una sola vez (`bloqueo_aviso_at`).
 */
export async function procesarVigenciasBloqueo(): Promise<{ aplicados: number; avisados: number }> {
  const hoy = hoyCDMX();
  let aplicados = 0;
  let avisados = 0;

  // ── 1) Bloqueos programados cuya fecha de inicio ya llegó ────────────────
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
              `Inventario: #${inv.id}${inv.codigo_unico ? ` — ${inv.codigo_unico}` : ''}`,
              inv.ubicacion ? `Ubicación: ${inv.ubicacion}` : null,
              inv.plaza ? `Plaza: ${inv.plaza}` : null,
              `Tipo: ${tipo}`,
              `Vigencia: ${describirVigencia(vigencia)}`,
              liberadas > 0 ? `Reservas liberadas: ${liberadas}` : 'Sin reservas vigentes que liberar.',
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

  // ── 2) Bloqueos cuya vigencia ya se cumplió y aún no se avisó ────────────
  const vencidos = await prisma.$queryRawUnsafe<FilaVigencia[]>(
    `${SELECT_FILA}
     WHERE estatus IN (${ESTATUS_INVENTARIO_BLOQUEO_SQL})
       AND bloqueo_fecha_fin IS NOT NULL
       AND bloqueo_fecha_fin <= ?
       AND bloqueo_aviso_at IS NULL
       AND bloqueo_usuario_id IS NOT NULL`,
    hoy
  );

  for (const inv of vencidos) {
    const usuarioId = inv.bloqueo_usuario_id as number;
    const fechaInicio = dateAFecha(inv.bloqueo_fecha_inicio);
    const fechaFin = dateAFecha(inv.bloqueo_fecha_fin);
    try {
      const nombre = await nombreUsuario(usuarioId);
      const etiqueta = inv.estatus === 'Inhabilitado' ? 'Habilitar' : 'Marcar Disponible';
      await prisma.tareas.create({
        data: {
          titulo: `Vigencia cumplida — #${inv.id}${inv.codigo_unico ? ` ${inv.codigo_unico}` : ''}`,
          descripcion: [
            `Inventario: #${inv.id}${inv.codigo_unico ? ` — ${inv.codigo_unico}` : ''}`,
            inv.ubicacion ? `Ubicación: ${inv.ubicacion}` : null,
            inv.plaza ? `Plaza: ${inv.plaza}` : null,
            `Estatus actual: ${inv.estatus}`,
            `Vigencia: ${describirVigencia({ fecha_inicio: fechaInicio, fecha_fin: fechaFin })}`,
            '',
            `La vigencia del bloqueo terminó el ${fechaCorta(fechaFin)}. La pieza sigue como ${inv.estatus}: revisa y, si procede, usa "${etiqueta}" desde esta tarea para rehabilitarla.`,
          ].filter(v => v !== null).join('\n'),
          tipo: TAREA_TIPO_VIGENCIA_BLOQUEO,
          estatus: 'Pendiente',
          id_responsable: usuarioId,
          responsable: nombre,
          id_asignado: String(usuarioId),
          asignado: nombre,
          id_solicitud: '',
          // Lo lee el front (NotificacionesPage) para pintar la pieza y el botón
          // de rehabilitar sin parsear la descripción.
          contenido: JSON.stringify({
            inventario_id: inv.id,
            codigo_unico: inv.codigo_unico,
            ubicacion: inv.ubicacion,
            plaza: inv.plaza,
            tipo: inv.estatus,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
          }),
        },
      });
      await prisma.inventarios.update({ where: { id: inv.id }, data: { bloqueo_aviso_at: new Date() } });
      await prisma.historial.create({
        data: {
          tipo: 'Inventario',
          ref_id: inv.id,
          accion: 'Vigencia cumplida',
          fecha_hora: new Date(),
          detalles: `Se cumplió la vigencia del bloqueo del inventario ${inv.codigo_unico || inv.id} (${fechaCorta(fechaFin)}); tarea enviada a ${nombre}`,
        },
      });
      avisados += 1;
    } catch (err) {
      console.error(`[VigenciaBloqueos] Error avisando vencimiento del inventario ${inv.id}:`, err);
    }
  }

  console.log(`[VigenciaBloqueos] hoy CDMX ${hoy}: programados aplicados=${aplicados} (de ${programados.length}), vencimientos avisados=${avisados} (de ${vencidos.length})`);
  return { aplicados, avisados };
}
