import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import { logHistorial } from '../utils/historial';

// Filtro Autorizacion "Quitar Posteo" — flujo:
//   Comercial (nota inicio) -> Filtro GC (check) -> Facturacion (aprueba/rechaza) -> TI (ejecuta unmarkPostedAPS)
//
// Cada intento crea una fila nueva en desposteo_solicitudes (auditoria por intento).
// El hilo de notas se acumula por (campania_id, aps) — se listan todas las notas
// de todas las solicitudes previas para el mismo par, en orden cronologico.
//
// Escalado por monto via desposteo_tabuladores (Fase 1: infra vacia, Jos define).

// ─── Tipos ───────────────────────────────────────────────────────────────

export type EstatusDesposteo =
  | 'solicitado'          // recien creado, esperando GC
  | 'filtro_aprobado'     // GC dio check, esperando facturacion
  | 'aprobado'            // facturacion aprobo, esperando TI ejecute
  | 'rechazado'           // rechazado por GC o facturacion (terminal)
  | 'ejecutado';          // TI ejecuto unmarkPostedAPS (terminal)

export type TipoNota =
  | 'inicio'
  | 'ajuste'
  | 'aprobacion_gerente'
  | 'rechazo_gerente'
  | 'aprobacion_facturacion'
  | 'rechazo_facturacion'
  | 'ejecucion';

export interface ActorInfo {
  id: number;
  nombre: string;
}

// ─── Roles ───────────────────────────────────────────────────────────────

// Espejo del filtro DG. Reusa los mismos roles ya que el GC "responsable
// del asesor" es el mismo actor comercial, aunque el proposito del equipo
// (filtro_desposteo vs filtro_autorizacion) sea distinto.
const GERENTE_COMERCIAL_ROLES = [
  'Gerente Comercial Vía Pública',
  'Gerente Comercial Via Publica',
  'Gerente Comercial Plazas',
  'Gerente Comercial (Plazas)',
  'Gerente Comercial',
];

// Facturacion — aprueba o rechaza el desposteo. Dos roles coordinadores
// que confirmaron Jos/negocio como firmantes.
const FACTURACION_ROLES = [
  'Coordinador de Facturación y Cobranza',
  'Coordinador de Facturación',
];

const TI_ROLES = ['Gerente de TI', 'Especialista de TI', 'Analista de TI'];

const ROLES_SOLICITA_DESPOSTEO = new Set([
  'Asesor Comercial',
  'Asesor Comercial Aeropuerto',
  'Administrador',
  'DEV',
]);

const ROLES_BYPASS_TI = new Set(['Administrador', 'DEV']);

export function puedeSolicitarDesposteo(rol: string | null | undefined): boolean {
  return !!rol && ROLES_SOLICITA_DESPOSTEO.has(rol);
}

export function esRolTI(rol: string | null | undefined): boolean {
  return !!rol && TI_ROLES.includes(rol);
}

export function puedeBypassearDesposteo(rol: string | null | undefined): boolean {
  return !!rol && ROLES_BYPASS_TI.has(rol);
}

// ─── Resolucion de actores ───────────────────────────────────────────────

/**
 * Busca al Gerente Comercial responsable del asesor via equipos.
 * Estrategia:
 *   1. Equipos con proposito='filtro_desposteo' (nuevo, especifico para este flujo).
 *   2. Fallback: proposito='filtro_autorizacion' (reusa el mapeo del filtro DG).
 * Devuelve null si el asesor no tiene GC asignado en ninguno.
 */
export async function getGerenteDesposteoParaAsesor(asesorId: number): Promise<ActorInfo | null> {
  const buscarPorProposito = async (proposito: string): Promise<ActorInfo | null> => {
    const equipos = await prisma.usuario_equipo.findMany({
      where: {
        usuario_id: asesorId,
        equipo: { deleted_at: null, proposito },
      },
      select: { equipo_id: true },
    });
    for (const eq of equipos) {
      const gc = await prisma.usuario_equipo.findFirst({
        where: {
          equipo_id: eq.equipo_id,
          usuario: {
            deleted_at: null,
            user_role: { in: GERENTE_COMERCIAL_ROLES },
          },
        },
        include: { usuario: { select: { id: true, nombre: true } } },
      });
      if (gc?.usuario) return { id: gc.usuario.id, nombre: gc.usuario.nombre };
    }
    return null;
  };

  const propio = await buscarPorProposito('filtro_desposteo');
  if (propio) return propio;
  return await buscarPorProposito('filtro_autorizacion');
}

async function getUsuariosFacturacion(): Promise<ActorInfo[]> {
  const users = await prisma.usuario.findMany({
    where: { deleted_at: null, user_role: { in: FACTURACION_ROLES } },
    select: { id: true, nombre: true },
  });
  return users;
}

async function getUsuariosTI(): Promise<ActorInfo[]> {
  const users = await prisma.usuario.findMany({
    where: { deleted_at: null, user_role: { in: TI_ROLES } },
    select: { id: true, nombre: true },
  });
  return users;
}

// ─── Snapshot del APS a desposteo ────────────────────────────────────────

interface SnapshotAPS {
  aps: number;
  campania_id: number;
  campania_nombre: string;
  cliente_nombre: string | null;
  razon_social: string | null;
  post_log_id: number | null;
  posted_at: string | null;
  doc_entry: number | null;
  doc_num: number | null;
  monto_estimado: number;
  circuitos: Array<{
    id: number;
    articulo: string | null;
    formato: string | null;
    ciudad: string | null;
    costo: number;
  }>;
}

/**
 * Congela los datos del APS al momento de solicitar. Si despues cambia la
 * campaña, gerente/facturacion siguen viendo lo que estaba al inicio.
 */
async function armarSnapshot(campaniaId: number, aps: number): Promise<{
  snapshot: SnapshotAPS;
  postLogId: number | null;
}> {
  const campania = await prisma.campania.findFirst({
    where: { id: campaniaId },
    select: { id: true, nombre: true, cliente_id: true },
  });
  if (!campania) throw new Error(`Campana #${campaniaId} no encontrada`);

  const cliente = await prisma.cliente.findFirst({
    where: { id: campania.cliente_id },
    select: { T0_U_Cliente: true, T0_U_RazonSocial: true },
  });

  // Ultimo POST exitoso para (campania, aps). El de mayor id es el activo.
  const postLog = await prisma.campania_post_log.findFirst({
    where: { campania_id: campaniaId, aps, success: true },
    orderBy: { id: 'desc' },
    select: {
      id: true, posted_at: true, doc_entry: true, doc_num: true,
      razon_social: true, cliente_nombre: true, solicitud_caras_ids: true,
    },
  });

  const ids = (postLog?.solicitud_caras_ids || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);

  let circuitos: SnapshotAPS['circuitos'] = [];
  let monto = 0;
  if (ids.length > 0) {
    const rows = await prisma.solicitudCaras.findMany({
      where: { id: { in: ids } },
      select: { id: true, articulo: true, formato: true, ciudad: true, costo: true },
    });
    circuitos = rows.map(r => ({
      id: r.id,
      articulo: r.articulo || null,
      formato: r.formato || null,
      ciudad: r.ciudad || null,
      costo: Number(r.costo || 0),
    }));
    monto = circuitos.reduce((acc, c) => acc + (c.costo || 0), 0);
  }

  const snapshot: SnapshotAPS = {
    aps,
    campania_id: campaniaId,
    campania_nombre: campania.nombre,
    cliente_nombre: postLog?.cliente_nombre || cliente?.T0_U_Cliente || null,
    razon_social: postLog?.razon_social || cliente?.T0_U_RazonSocial || null,
    post_log_id: postLog?.id ?? null,
    posted_at: postLog?.posted_at ? postLog.posted_at.toISOString() : null,
    doc_entry: postLog?.doc_entry ?? null,
    doc_num: postLog?.doc_num ?? null,
    monto_estimado: monto,
    circuitos,
  };

  return { snapshot, postLogId: postLog?.id ?? null };
}

// ─── Helpers internos ────────────────────────────────────────────────────

function ahoraMx(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
}

function fechaFinDias(dias: number): Date {
  const f = ahoraMx();
  f.setDate(f.getDate() + dias);
  return f;
}

async function agregarNota(
  desposteoId: number,
  actor: ActorInfo,
  tipo: TipoNota,
  nota: string,
): Promise<void> {
  await prisma.desposteo_notas.create({
    data: {
      desposteo_id: desposteoId,
      usuario_id: actor.id,
      usuario_nombre: actor.nombre,
      tipo,
      nota,
    },
  });
}

interface CrearTareaInput {
  tipo: string;
  titulo: string;
  descripcion: string;
  responsable: ActorInfo;
  asignados: ActorInfo[];
  campaniaId: number;
  desposteoId: number;
}

async function crearTareaDesposteo(input: CrearTareaInput): Promise<void> {
  const now = ahoraMx();
  await prisma.tareas.create({
    data: {
      tipo: input.tipo,
      titulo: input.titulo,
      descripcion: input.descripcion,
      estatus: 'Pendiente',
      id_responsable: input.responsable.id,
      responsable: input.responsable.nombre,
      id_solicitud: '',
      id_propuesta: null,
      campania_id: input.campaniaId,
      id_asignado: input.asignados.map(a => a.id).join(','),
      asignado: input.asignados.map(a => a.nombre).join(', '),
      contenido: JSON.stringify({ desposteoId: input.desposteoId }),
      fecha_inicio: now,
      fecha_fin: fechaFinDias(7),
    },
  });
}

async function notificarUsuarios(
  destinatarios: ActorInfo[],
  campaniaId: number,
  desposteoId: number,
  titulo: string,
  mensaje: string,
): Promise<void> {
  if (destinatarios.length === 0) return;
  const now = ahoraMx();
  await prisma.$transaction(
    destinatarios.map(u =>
      prisma.tareas.create({
        data: {
          tipo: 'Notificación',
          categoria: 'desposteo',
          titulo,
          descripcion: mensaje,
          estatus: 'Pendiente',
          id_responsable: u.id,
          responsable: u.nombre,
          id_solicitud: '',
          id_propuesta: null,
          campania_id: campaniaId,
          id_asignado: String(u.id),
          asignado: u.nombre,
          contenido: JSON.stringify({ desposteoId }),
          fecha_inicio: now,
          fecha_fin: fechaFinDias(7),
        },
      })
    )
  );
}

// ─── Crear solicitud ─────────────────────────────────────────────────────

export interface CrearInput {
  campaniaId: number;
  aps: number;
  nota: string;
  asesor: ActorInfo;
}

export async function crearSolicitudDesposteo(input: CrearInput) {
  const { campaniaId, aps, nota, asesor } = input;
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al iniciar el flujo');

  // Bloquear duplicados: si ya hay una solicitud "en vuelo" (no terminal)
  // para el mismo (campania, aps), no permitir otra.
  const enVuelo = await prisma.desposteo_solicitudes.findFirst({
    where: {
      campania_id: campaniaId,
      aps,
      deleted_at: null,
      estatus: { in: ['solicitado', 'filtro_aprobado', 'aprobado'] },
    },
    select: { id: true, estatus: true },
  });
  if (enVuelo) {
    throw new Error(
      `Ya existe una solicitud activa #${enVuelo.id} (estatus: ${enVuelo.estatus}) para APS ${aps} de la campana #${campaniaId}. Espera a que se cierre para iniciar otra.`
    );
  }

  const { snapshot, postLogId } = await armarSnapshot(campaniaId, aps);

  const gc = await getGerenteDesposteoParaAsesor(asesor.id);

  const solicitud = await prisma.desposteo_solicitudes.create({
    data: {
      campania_id: campaniaId,
      aps,
      post_log_id: postLogId,
      snapshot_aps: JSON.stringify(snapshot),
      estatus: 'solicitado',
      solicitado_por_id: asesor.id,
      solicitado_por_nombre: asesor.nombre,
    },
  });

  await agregarNota(solicitud.id, asesor, 'inicio', notaLimpia);

  if (gc) {
    await crearTareaDesposteo({
      tipo: 'Filtro Desposteo',
      titulo: `Filtro desposteo APS ${aps} - ${snapshot.campania_nombre}`,
      descripcion:
        `${asesor.nombre} solicito el desposteo del APS ${aps} de la campana "${snapshot.campania_nombre}"` +
        (snapshot.razon_social ? ` (${snapshot.razon_social})` : '') +
        `. Monto estimado $${snapshot.monto_estimado.toFixed(2)}. Da tu check o rechaza con motivo.`,
      responsable: gc,
      asignados: [gc],
      campaniaId,
      desposteoId: solicitud.id,
    });
  } else {
    console.warn(
      `[desposteo.crear] Asesor #${asesor.id} (${asesor.nombre}) sin GC de desposteo asignado. La solicitud #${solicitud.id} queda sin tarea Filtro — asignar equipo con proposito='filtro_desposteo' o 'filtro_autorizacion'.`
    );
  }

  try {
    await logHistorial({
      tipo: 'Campaña',
      refId: campaniaId,
      accion: `Solicito desposteo APS ${aps} (solicitud #${solicitud.id})`,
      usuario: asesor.nombre,
      usuarioId: asesor.id,
      origen: 'desposteo',
      extras: { desposteoId: solicitud.id, aps, postLogId },
    });
  } catch (e) {
    console.error('[desposteo.crear] logHistorial fallo:', e);
  }

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: solicitud.id,
      tipo: 'Filtro Desposteo',
      campaniaId,
      aps,
    });
  } catch (e) {
    console.error('[desposteo.crear] emitToAll fallo:', e);
  }

  return solicitud;
}

// ─── Filtro GC ───────────────────────────────────────────────────────────

async function requireSolicitud(id: number) {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: { id, deleted_at: null },
  });
  if (!s) throw new Error(`Solicitud desposteo #${id} no encontrada`);
  return s;
}

export async function aprobarFiltroGerente(id: number, gc: ActorInfo, nota?: string | null) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'solicitado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'solicitado' (actual: ${s.estatus})`);
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'filtro_aprobado',
      filtro_gc_id: gc.id,
      filtro_gc_nombre: gc.nombre,
      filtro_gc_at: ahoraMx(),
    },
  });

  await agregarNota(id, gc, 'aprobacion_gerente', (nota || '').trim() || 'Check gerente comercial');

  const facturacion = await getUsuariosFacturacion();
  if (facturacion.length === 0) {
    console.warn(`[desposteo.aprobarFiltroGerente] Sin usuarios de Facturacion configurados — solicitud #${id} queda sin tarea a Facturacion.`);
  } else {
    const snapshot = parseSnapshot(s.snapshot_aps);
    await crearTareaDesposteo({
      tipo: 'Autorización Desposteo',
      titulo: `Autorizacion desposteo APS ${s.aps} - ${snapshot?.campania_nombre || `campana #${s.campania_id}`}`,
      descripcion:
        `${gc.nombre} aprobo el filtro para desposteo del APS ${s.aps}. ` +
        (snapshot?.razon_social ? `Cliente: ${snapshot.razon_social}. ` : '') +
        `Monto $${(snapshot?.monto_estimado || 0).toFixed(2)}. ` +
        `Aprueba o rechaza con motivo.`,
      responsable: facturacion[0],
      asignados: facturacion,
      campaniaId: s.campania_id,
      desposteoId: id,
    });
  }

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: id, tipo: 'Autorización Desposteo', campaniaId: s.campania_id, aps: s.aps,
    });
  } catch (e) { console.error('[desposteo.aprobarFiltroGerente] emitToAll:', e); }

  return upd;
}

export async function rechazarFiltroGerente(id: number, gc: ActorInfo, nota: string) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'solicitado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'solicitado' (actual: ${s.estatus})`);
  }
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al rechazar');

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'rechazado',
      filtro_gc_id: gc.id,
      filtro_gc_nombre: gc.nombre,
      filtro_gc_at: ahoraMx(),
    },
  });

  await agregarNota(id, gc, 'rechazo_gerente', notaLimpia);

  await notificarUsuarios(
    [{ id: s.solicitado_por_id, nombre: s.solicitado_por_nombre }],
    s.campania_id,
    id,
    `Desposteo rechazado por gerente - APS ${s.aps}`,
    `${gc.nombre} rechazo tu solicitud de desposteo del APS ${s.aps}. Motivo: ${notaLimpia}`,
  );

  return upd;
}

// ─── Facturacion ─────────────────────────────────────────────────────────

export async function aprobarFacturacion(id: number, actor: ActorInfo, nota?: string | null) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'filtro_aprobado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'filtro_aprobado' (actual: ${s.estatus})`);
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'aprobado',
      facturacion_id: actor.id,
      facturacion_nombre: actor.nombre,
      facturacion_at: ahoraMx(),
    },
  });

  await agregarNota(id, actor, 'aprobacion_facturacion', (nota || '').trim() || 'Aprobado por facturacion');

  // Notificar a TI que hay solicitud aprobada pendiente de ejecutar.
  const ti = await getUsuariosTI();
  const snap = parseSnapshot(s.snapshot_aps);
  await notificarUsuarios(
    ti,
    s.campania_id,
    id,
    `Desposteo aprobado listo para ejecutar - APS ${s.aps}`,
    `Solicitud #${id} aprobada por ${actor.nombre}. ` +
      `Ya puedes cancelar el POST a SAP del APS ${s.aps} en la campana ${snap?.campania_nombre || `#${s.campania_id}`} desde el detalle de campana.`,
  );

  // Tambien avisar al asesor y GC que su solicitud avanzo.
  const otros: ActorInfo[] = [{ id: s.solicitado_por_id, nombre: s.solicitado_por_nombre }];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    otros.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  await notificarUsuarios(
    otros,
    s.campania_id,
    id,
    `Desposteo aprobado por facturacion - APS ${s.aps}`,
    `${actor.nombre} aprobo el desposteo. TI proximamente lo ejecutara.`,
  );

  return upd;
}

export async function rechazarFacturacion(id: number, actor: ActorInfo, nota: string) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'filtro_aprobado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'filtro_aprobado' (actual: ${s.estatus})`);
  }
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al rechazar');

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'rechazado',
      facturacion_id: actor.id,
      facturacion_nombre: actor.nombre,
      facturacion_at: ahoraMx(),
    },
  });

  await agregarNota(id, actor, 'rechazo_facturacion', notaLimpia);

  const otros: ActorInfo[] = [{ id: s.solicitado_por_id, nombre: s.solicitado_por_nombre }];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    otros.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  await notificarUsuarios(
    otros,
    s.campania_id,
    id,
    `Desposteo rechazado por facturacion - APS ${s.aps}`,
    `${actor.nombre} rechazo el desposteo. Motivo: ${notaLimpia}`,
  );

  return upd;
}

// ─── TI / cierre por ejecucion ───────────────────────────────────────────

/**
 * Verifica si existe una solicitud aprobada (no ejecutada) para (campania, aps).
 * Usado por unmarkPostedAPS antes de permitir la cancelacion.
 */
export async function verificarAutorizacionEjecucion(
  campaniaId: number,
  aps: number,
): Promise<{ ok: true; solicitudId: number } | { ok: false; motivo: string }> {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: {
      campania_id: campaniaId,
      aps,
      deleted_at: null,
      estatus: 'aprobado',
    },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  if (!s) {
    return {
      ok: false,
      motivo: `No hay solicitud de desposteo aprobada para el APS ${aps} de la campana #${campaniaId}. Pide autorizacion primero (Comercial - Filtro Gerente - Facturacion).`,
    };
  }
  return { ok: true, solicitudId: s.id };
}

/**
 * Cierra una solicitud aprobada marcando la ejecucion. Se llama desde
 * unmarkPostedAPS cuando TI cancela el POST exitosamente.
 */
export async function cerrarPorEjecucion(
  solicitudId: number,
  ti: ActorInfo,
  notaAdicional?: string | null,
) {
  const s = await requireSolicitud(solicitudId);
  if (s.estatus !== 'aprobado') {
    console.warn(
      `[desposteo.cerrarPorEjecucion] Solicitud #${solicitudId} en estatus '${s.estatus}' (esperado 'aprobado'). No se cierra pero se registra ejecucion.`
    );
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id: solicitudId },
    data: {
      estatus: 'ejecutado',
      ti_ejecutor_id: ti.id,
      ti_ejecutor_nombre: ti.nombre,
      ti_ejecutor_at: ahoraMx(),
    },
  });

  await agregarNota(
    solicitudId,
    ti,
    'ejecucion',
    (notaAdicional || '').trim() || `Desposteo ejecutado en SAP por ${ti.nombre}`,
  );

  const dest: ActorInfo[] = [{ id: s.solicitado_por_id, nombre: s.solicitado_por_nombre }];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    dest.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  if (s.facturacion_id && s.facturacion_nombre) {
    dest.push({ id: s.facturacion_id, nombre: s.facturacion_nombre });
  }
  await notificarUsuarios(
    dest,
    s.campania_id,
    solicitudId,
    `Desposteo ejecutado - APS ${s.aps}`,
    `${ti.nombre} ejecuto el desposteo del APS ${s.aps} en SAP.`,
  );

  return upd;
}

/**
 * Registra un desposteo ejecutado SIN solicitud previa (bypass DEV/Admin).
 * Crea la fila con sin_autorizacion=true y estatus='ejecutado' para dejar
 * rastro en la auditoria — nada de silenciar el bypass.
 */
export async function registrarBypass(
  campaniaId: number,
  aps: number,
  actor: ActorInfo,
  motivo: string,
) {
  const { snapshot, postLogId } = await armarSnapshot(campaniaId, aps);
  const now = ahoraMx();
  const s = await prisma.desposteo_solicitudes.create({
    data: {
      campania_id: campaniaId,
      aps,
      post_log_id: postLogId,
      snapshot_aps: JSON.stringify(snapshot),
      estatus: 'ejecutado',
      solicitado_por_id: actor.id,
      solicitado_por_nombre: actor.nombre,
      ti_ejecutor_id: actor.id,
      ti_ejecutor_nombre: actor.nombre,
      ti_ejecutor_at: now,
      sin_autorizacion: true,
    },
  });
  await agregarNota(
    s.id,
    actor,
    'ejecucion',
    `BYPASS ${actor.nombre} (${motivo || 'sin motivo especificado'}). Ejecucion sin flujo Comercial-GC-Facturacion.`,
  );
  return s;
}

// ─── Listar / detalle ────────────────────────────────────────────────────

export async function listarSolicitudes(params: {
  campaniaId?: number;
  estatus?: EstatusDesposteo;
  incluirEjecutados?: boolean;
}) {
  const where: any = { deleted_at: null };
  if (params.campaniaId) where.campania_id = params.campaniaId;
  if (params.estatus) where.estatus = params.estatus;
  if (!params.incluirEjecutados && !params.estatus) {
    where.estatus = { notIn: ['ejecutado'] };
  }
  return prisma.desposteo_solicitudes.findMany({
    where,
    orderBy: { id: 'desc' },
  });
}

export async function getDetalle(id: number) {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: { id, deleted_at: null },
  });
  if (!s) return null;
  // Todas las notas del hilo (campania, aps) — no solo de esta solicitud.
  // Feedback: el hilo persiste entre intentos.
  const solicitudesHermanas = await prisma.desposteo_solicitudes.findMany({
    where: {
      campania_id: s.campania_id,
      aps: s.aps,
      deleted_at: null,
    },
    select: { id: true },
  });
  const notas = await prisma.desposteo_notas.findMany({
    where: { desposteo_id: { in: solicitudesHermanas.map(x => x.id) } },
    orderBy: { created_at: 'asc' },
  });
  return { solicitud: s, notas };
}

/**
 * Historial de notas por (campania, aps) — para mostrar en el modal aunque
 * no exista solicitud abierta (ej. al iniciar una nueva luego de rechazo).
 */
export async function getHistorialNotas(campaniaId: number, aps: number) {
  const solicitudes = await prisma.desposteo_solicitudes.findMany({
    where: { campania_id: campaniaId, aps, deleted_at: null },
    select: { id: true },
  });
  if (solicitudes.length === 0) return [];
  return prisma.desposteo_notas.findMany({
    where: { desposteo_id: { in: solicitudes.map(x => x.id) } },
    orderBy: { created_at: 'asc' },
  });
}

// ─── Utilidades ──────────────────────────────────────────────────────────

function parseSnapshot(raw: string | null): SnapshotAPS | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as SnapshotAPS; } catch { return null; }
}

export { parseSnapshot };
export type { SnapshotAPS };
