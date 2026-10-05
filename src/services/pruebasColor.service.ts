import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import { logHistorial } from '../utils/historial';

// Servicio de pruebas de color — feedback 2026-08-15.
// Punto de entrada desde: (a) botones de accion del renglón de propuestas,
// (b) botones de accion del renglón de campañas, (c) screen gestion de artes
// en detalle de campaña. Los tres usan el mismo modal y la misma tabla.
//
// Fase 1 (este servicio): CRUD + hooks de vinculacion. Solo notificacion
// interna a Produccion — el envio de correo al proveedor se pospone a Fase 2
// porque hoy no existe una relacion proveedor <-> circuito en el schema.

// Estados del flujo de prueba de color. Feedback Jos 2026-09-25:
//   revision_artes → arte_aprobado → enviada_proveedor → aprobada
//                                                     ↘ rechazada
//   revision_artes → rechazada (rechazo directo en revisión)
//
// - revision_artes: estado inicial, existe tarea "Revisión de artes" activa
//   para el equipo de Diseño.
// - arte_aprobado: revisión aprobada, se crea tarea "Seguimiento Prueba de
//   color" para el analista/creador para gestionar el envío al proveedor.
// - enviada_proveedor: analista/producción marcó que se envió al proveedor.
// - aprobada: analista finalizó la tarea de Seguimiento; terminal.
// - rechazada: terminal, la siguiente iteración se resuelve creando v2.
//
// Compat: 'solicitada' se acepta como sinónimo de 'revision_artes' para no
// romper pruebas viejas ya guardadas. Las nuevas siempre nacen en
// 'revision_artes'.
export type EstatusPruebaColor =
  | 'solicitada'
  | 'revision_artes'
  | 'arte_aprobado'
  | 'enviada_proveedor'
  | 'aprobada'
  | 'rechazada';

const ESTATUS_VALIDOS: EstatusPruebaColor[] = [
  'solicitada',
  'revision_artes',
  'arte_aprobado',
  'enviada_proveedor',
  'aprobada',
  'rechazada',
];

const TRANSICIONES: Record<EstatusPruebaColor, EstatusPruebaColor[]> = {
  // 'solicitada' se mantiene por compat: se comporta como revision_artes.
  solicitada: ['arte_aprobado', 'enviada_proveedor', 'aprobada', 'rechazada'],
  revision_artes: ['arte_aprobado', 'rechazada'],
  arte_aprobado: ['enviada_proveedor', 'aprobada', 'rechazada'],
  enviada_proveedor: ['aprobada', 'rechazada'],
  aprobada: [],
  rechazada: [],
};

// Roles con permiso para solicitar / editar estatus de pruebas de color.
export const ROLES_PRUEBA_COLOR = new Set([
  'Coordinador de Diseño',
  'Coordinador de Diseno',
  'Diseñador',
  'Diseñadores',
  'Encargado de Producción',
  'Coordinador de Producción',
  'Producción',
  'Asesor Comercial',
  'Asesor Comercial Aeropuerto',
  'Administrador',
  'DEV',
]);

export function puedeGestionarPruebaColor(rol: string | null | undefined): boolean {
  return !!rol && ROLES_PRUEBA_COLOR.has(rol);
}

interface CrearPruebaInput {
  propuestaId: number;
  scId: number;
  archivo: string;
  archivo_data?: string | null;
  nombre_arte?: string | null;
  notas?: string | null;
  createdBy: number;
  createdByNombre: string;
}

/**
 * Determina la siguiente version disponible para (propuesta_id, sc_id) y
 * crea el registro. Si campania_id ya existe para esa propuesta, tambien
 * queda vinculado desde el inicio. Feedback 2026-08-15.
 */
export async function crearPruebaColor(input: CrearPruebaInput) {
  const { propuestaId, scId, archivo, archivo_data, nombre_arte, notas, createdBy, createdByNombre } = input;

  // Validar propuesta y circuito
  const sc = await prisma.solicitudCaras.findFirst({
    where: { id: scId, idquote: String(propuestaId) },
    select: { id: true, articulo: true, formato: true, ciudad: true },
  });
  if (!sc) throw new Error('Circuito no encontrado en la propuesta');

  // Ultima version del circuito
  const ultima = await prisma.pruebas_color.findFirst({
    where: { propuesta_id: propuestaId, sc_id: scId, deleted_at: null },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (ultima?.version ?? 0) + 1;

  // Buscar campania_id si la propuesta ya avanzó (no obligatorio)
  const campaniaId = await resolverCampaniaIdDePropuesta(propuestaId);

  const prueba = await prisma.pruebas_color.create({
    data: {
      propuesta_id: propuestaId,
      sc_id: scId,
      campania_id: campaniaId,
      reserva_id: null,
      archivo,
      archivo_data: archivo_data || null,
      nombre_arte: nombre_arte || null,
      notas: notas || null,
      estatus: 'revision_artes',
      version: nextVersion,
      created_by: createdBy,
      created_by_nombre: createdByNombre,
    },
  });

  // Efectos secundarios: si alguno falla, log y sigue. La prueba ya se
  // guardó y no queremos regresar 500 al usuario por una tarea/historial
  // colgado. Cada uno tiene su propio try/catch para no cortar los otros.
  try {
    await crearTareaRevisionArte(prueba.id, propuestaId, scId, sc.articulo || null, sc.formato || null, sc.ciudad || null, createdByNombre, createdBy);
  } catch (e) {
    console.error('[pruebasColor.crear] crearTareaRevisionArte falló:', e);
  }

  try {
    await logHistorial({
      tipo: 'Propuesta',
      refId: propuestaId,
      accion: `Solicitó prueba de color v${nextVersion} para circuito #${scId}`,
      usuario: createdByNombre,
      usuarioId: createdBy,
      origen: 'pruebas_color',
      extras: { pruebaId: prueba.id, scId, articulo: sc.articulo, formato: sc.formato, ciudad: sc.ciudad, campaniaId },
    });
  } catch (e) {
    console.error('[pruebasColor.crear] logHistorial falló:', e);
  }

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: prueba.id,
      tipo: 'Prueba de Color',
      propuestaId,
      scId,
    });
  } catch (e) {
    console.error('[pruebasColor.crear] emitToAll falló:', e);
  }

  return prueba;
}

async function resolverCampaniaIdDePropuesta(propuestaId: number): Promise<number | null> {
  const cot = await prisma.cotizacion.findFirst({
    where: { id_propuesta: propuestaId },
    select: { id: true },
  });
  if (!cot) return null;
  const cm = await prisma.campania.findFirst({
    where: { cotizacion_id: cot.id },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  return cm?.id ?? null;
}

// Al crear una prueba de color se dispara una tarea de tipo "Revisión de
// artes" al equipo de Diseño para que primero validen el arte cargado.
// Feedback Jos 2026-09-25: la prueba de color arranca con revisión del
// arte, y solo cuando se aprueba se genera la tarea de Seguimiento para
// el analista que la solicitó.
async function crearTareaRevisionArte(
  pruebaId: number,
  propuestaId: number,
  scId: number,
  articulo: string | null,
  formato: string | null,
  ciudad: string | null,
  solicitanteNombre: string,
  solicitanteId: number,
) {
  const usuariosDiseno = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { user_role: 'Coordinador de Diseño' },
        { user_role: 'Coordinador de Diseno' },
        { user_role: 'Diseñador' },
        { user_role: 'Diseñadores' },
      ],
    },
    select: { id: true, nombre: true, user_role: true },
  });
  if (usuariosDiseno.length === 0) {
    console.warn('[pruebasColor] Sin usuarios de Diseño configurados — solo se guarda la prueba.');
    return;
  }

  // Responsable = primer Coordinador de Diseño; si no hay, primer Diseñador.
  const coordinador = usuariosDiseno.find(u => u.user_role === 'Coordinador de Diseño' || u.user_role === 'Coordinador de Diseno');
  const responsable = coordinador || usuariosDiseno[0];

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 3);

  const detalleCircuito = [articulo, formato, ciudad].filter(Boolean).join(' · ') || `#${scId}`;
  const campaniaId = await resolverCampaniaIdDePropuesta(propuestaId);

  await prisma.tareas.create({
    data: {
      tipo: 'Revisión de artes',
      titulo: `Revisión de arte para prueba de color - Propuesta #${propuestaId}`,
      descripcion: `${solicitanteNombre} solicitó una prueba de color para el circuito #${scId} (${detalleCircuito}). Revisar el arte cargado y aprobar o rechazar antes de enviar al proveedor.`,
      estatus: 'Pendiente',
      id_responsable: responsable.id,
      responsable: responsable.nombre,
      id_solicitud: '',
      id_propuesta: String(propuestaId),
      // Si la propuesta ya avanzó a campaña, ligar la tarea a la campaña
      // para que aparezca en la tablita de tareas del gestor de artes.
      campania_id: campaniaId ?? undefined,
      id_asignado: usuariosDiseno.map(u => u.id).join(','),
      asignado: usuariosDiseno.map(u => u.nombre).join(', '),
      contenido: JSON.stringify({ pruebaColorId: pruebaId, scId, propuestaId, solicitanteId, origen: 'prueba_color_revision' }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

interface ActualizarEstatusInput {
  pruebaId: number;
  nuevoEstatus: EstatusPruebaColor;
  userId: number;
  userNombre: string;
}

export async function actualizarEstatusPruebaColor(input: ActualizarEstatusInput) {
  const { pruebaId, nuevoEstatus, userId, userNombre } = input;
  if (!ESTATUS_VALIDOS.includes(nuevoEstatus)) {
    throw new Error(`estatus invalido: ${nuevoEstatus}`);
  }
  const prueba = await prisma.pruebas_color.findFirst({
    where: { id: pruebaId, deleted_at: null },
  });
  if (!prueba) throw new Error('Prueba no encontrada');

  const actual = prueba.estatus as EstatusPruebaColor;
  const permitidas = TRANSICIONES[actual] || [];
  if (!permitidas.includes(nuevoEstatus)) {
    throw new Error(`No se puede pasar de '${actual}' a '${nuevoEstatus}'`);
  }

  const upd = await prisma.pruebas_color.update({
    where: { id: pruebaId },
    data: { estatus: nuevoEstatus },
  });

  await logHistorial({
    tipo: 'Propuesta',
    refId: prueba.propuesta_id,
    accion: `Prueba de color v${prueba.version} → '${nuevoEstatus}' (circuito #${prueba.sc_id})`,
    usuario: userNombre,
    usuarioId: userId,
    origen: 'pruebas_color',
    cambios: [{ campo: 'estatus', label: 'Estatus prueba color', antes: actual, despues: nuevoEstatus }],
    extras: { pruebaId, scId: prueba.sc_id },
  });

  // Hook 1: al aprobar el arte se cierra la tarea Revisión y se abre la
  // tarea Seguimiento para el analista/creador (Feedback Jos 2026-09-25).
  if (nuevoEstatus === 'arte_aprobado') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Revisión de artes', userNombre);
      await crearTareaSeguimiento(prueba, userNombre);
    } catch (e) {
      console.error('[pruebasColor.actualizar] hook arte_aprobado falló:', e);
    }
  }

  // Hook 2: al llegar a aprobada se cierra la tarea Seguimiento (si existe).
  if (nuevoEstatus === 'aprobada') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Seguimiento Prueba de color', userNombre);
    } catch (e) {
      console.error('[pruebasColor.actualizar] hook aprobada falló:', e);
    }
  }

  // Hook 3: al rechazar, se cierra la tarea abierta (Revisión o Seguimiento)
  // para que no quede huérfana en el módulo de tareas.
  if (nuevoEstatus === 'rechazada') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Revisión de artes', userNombre);
      await cerrarTareaAsociada(pruebaId, 'Seguimiento Prueba de color', userNombre);
    } catch (e) {
      console.error('[pruebasColor.actualizar] hook rechazada falló:', e);
    }
  }

  // Notificar al creador de la prueba con una tarea "Notificación" — asi
  // el asesor (o quien haya solicitado) se entera del avance sin depender
  // de que este mirando el modal. Feedback 2026-08-24.
  await notificarActualizacionEstatus({
    prueba,
    nuevoEstatus,
    actor: userNombre,
    actorId: userId,
  });

  emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
    tareaId: pruebaId,
    tipo: 'Prueba de Color',
    estatus: nuevoEstatus,
  });

  return upd;
}

// Notifica al creador de la prueba (el asesor / diseñador que la solicito)
// cada vez que su estatus cambia. Si quien esta cambiando el estatus es el
// mismo creador (raro pero posible), no se auto-notifica.
async function notificarActualizacionEstatus(input: {
  prueba: { id: number; propuesta_id: number; sc_id: number; version: number; created_by: number; created_by_nombre: string };
  nuevoEstatus: EstatusPruebaColor;
  actor: string;
  actorId: number;
}) {
  const { prueba, nuevoEstatus, actor, actorId } = input;
  if (prueba.created_by === actorId) return; // el mismo creador no se auto-notifica

  const labelEstatus: Record<EstatusPruebaColor, string> = {
    solicitada: 'en revisión de arte',
    revision_artes: 'en revisión de arte',
    arte_aprobado: 'con arte aprobado',
    enviada_proveedor: 'enviada al proveedor',
    aprobada: 'aprobada',
    rechazada: 'rechazada',
  };
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 7);

  await prisma.tareas.create({
    data: {
      tipo: 'Prueba de Color',
      titulo: `Prueba de color ${labelEstatus[nuevoEstatus]} - Propuesta #${prueba.propuesta_id}`,
      descripcion: `${actor} marcó la prueba de color v${prueba.version} del circuito #${prueba.sc_id} como ${labelEstatus[nuevoEstatus]}.`,
      estatus: 'Pendiente',
      id_responsable: prueba.created_by,
      responsable: prueba.created_by_nombre,
      id_solicitud: '',
      id_propuesta: String(prueba.propuesta_id),
      id_asignado: String(prueba.created_by),
      asignado: prueba.created_by_nombre,
      contenido: JSON.stringify({ pruebaColorId: prueba.id, scId: prueba.sc_id, estatus: nuevoEstatus }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

export interface ListarFiltro {
  propuesta_id?: number;
  campania_id?: number;
  sc_id?: number;
}

export async function listarPruebasColor(filtro: ListarFiltro) {
  return prisma.pruebas_color.findMany({
    where: {
      deleted_at: null,
      ...(filtro.propuesta_id ? { propuesta_id: filtro.propuesta_id } : {}),
      ...(filtro.campania_id ? { campania_id: filtro.campania_id } : {}),
      ...(filtro.sc_id ? { sc_id: filtro.sc_id } : {}),
    },
    orderBy: [{ sc_id: 'asc' }, { version: 'desc' }],
  });
}

export async function eliminarPruebaColor(pruebaId: number, userId: number, userNombre: string) {
  const prueba = await prisma.pruebas_color.findFirst({
    where: { id: pruebaId, deleted_at: null },
  });
  if (!prueba) throw new Error('Prueba no encontrada');

  await prisma.pruebas_color.update({
    where: { id: pruebaId },
    data: { deleted_at: new Date() },
  });

  await logHistorial({
    tipo: 'Propuesta',
    refId: prueba.propuesta_id,
    accion: `Eliminó prueba de color v${prueba.version} (circuito #${prueba.sc_id})`,
    usuario: userNombre,
    usuarioId: userId,
    origen: 'pruebas_color',
    extras: { pruebaId },
  });
}

/**
 * Hook: al aprobar propuesta y crear campaña, ligar todas las pruebas de
 * color pendientes de esa propuesta al campania_id nuevo. Idempotente.
 */
export async function vincularPruebasConCampania(propuestaId: number, campaniaId: number): Promise<number> {
  const r = await prisma.pruebas_color.updateMany({
    where: { propuesta_id: propuestaId, campania_id: null, deleted_at: null },
    data: { campania_id: campaniaId },
  });
  if (r.count > 0) {
    console.log(`[pruebasColor.vincularConCampania] Propuesta #${propuestaId} → Campaña #${campaniaId}: ${r.count} prueba(s) vinculadas`);
  }
  return r.count;
}

// Crea la tarea "Seguimiento Prueba de color" para el analista/creador de
// la prueba una vez que Diseño aprobó el arte. Incluye arte aprobado,
// nombre, circuito, formato y detalles como pidió Jos 2026-09-25.
async function crearTareaSeguimiento(
  prueba: { id: number; propuesta_id: number; sc_id: number; version: number; created_by: number; created_by_nombre: string; archivo: string; nombre_arte: string | null },
  actorNombre: string,
) {
  const sc = await prisma.solicitudCaras.findFirst({
    where: { id: prueba.sc_id },
    select: { articulo: true, formato: true, ciudad: true, estados: true },
  });
  const detalleCircuito = sc
    ? [sc.articulo, sc.formato, sc.ciudad || sc.estados].filter(Boolean).join(' · ')
    : `#${prueba.sc_id}`;

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 5);

  const descripcion = [
    `${actorNombre} aprobó el arte de la prueba de color v${prueba.version}.`,
    `Arte: ${prueba.nombre_arte || 'sin nombre'} (${prueba.archivo}).`,
    `Circuito #${prueba.sc_id} — ${detalleCircuito}.`,
    'Gestiona el envío al proveedor y finaliza esta tarea cuando la prueba esté aprobada.',
  ].join(' ');

  const campaniaId = await resolverCampaniaIdDePropuesta(prueba.propuesta_id);

  await prisma.tareas.create({
    data: {
      tipo: 'Seguimiento Prueba de color',
      titulo: `Seguimiento prueba de color v${prueba.version} - Propuesta #${prueba.propuesta_id}`,
      descripcion,
      estatus: 'Pendiente',
      id_responsable: prueba.created_by,
      responsable: prueba.created_by_nombre,
      id_solicitud: '',
      id_propuesta: String(prueba.propuesta_id),
      campania_id: campaniaId ?? undefined,
      id_asignado: String(prueba.created_by),
      asignado: prueba.created_by_nombre,
      contenido: JSON.stringify({
        pruebaColorId: prueba.id,
        scId: prueba.sc_id,
        propuestaId: prueba.propuesta_id,
        arte: prueba.archivo,
        nombreArte: prueba.nombre_arte,
        origen: 'prueba_color_seguimiento',
      }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

// Cierra (marca como Finalizada) la tarea abierta ligada a una prueba
// de color específica. Usa el campo `contenido` (JSON) para localizarla
// por pruebaColorId. Idempotente.
async function cerrarTareaAsociada(pruebaId: number, tipo: string, actorNombre: string) {
  const tareas = await prisma.tareas.findMany({
    where: {
      tipo,
      estatus: { in: ['Pendiente', 'En proceso', 'En Proceso'] },
    },
    select: { id: true, contenido: true },
  });
  const objetivo = tareas.filter(t => {
    if (!t.contenido) return false;
    try {
      const c = JSON.parse(t.contenido);
      return c.pruebaColorId === pruebaId;
    } catch { return false; }
  });
  if (objetivo.length === 0) return;
  await prisma.tareas.updateMany({
    where: { id: { in: objetivo.map(t => t.id) } },
    data: {
      estatus: 'Finalizada',
      fecha_fin: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
    },
  });
  console.log(`[pruebasColor] ${objetivo.length} tarea(s) '${tipo}' cerradas por ${actorNombre} (prueba #${pruebaId})`);
}

/**
 * Hook inverso: cuando el analista finaliza (o marca "Finalizada") una
 * tarea de tipo 'Seguimiento Prueba de color', la prueba asociada debe
 * pasar automaticamente a estatus 'aprobada' (feedback Jos 2026-09-25).
 * Se invoca desde el controller de tareas al detectar el update.
 *
 * Devuelve el id de la prueba actualizada, o null si la tarea no era de
 * seguimiento de prueba de color o no tenia pruebaColorId valido.
 */
export async function onFinalizarTareaSeguimiento(
  tarea: { id: number; tipo: string | null; contenido: string | null },
  userId: number,
  userNombre: string,
): Promise<number | null> {
  if (tarea.tipo !== 'Seguimiento Prueba de color') return null;
  if (!tarea.contenido) return null;
  let pruebaId: number | null = null;
  try {
    const c = JSON.parse(tarea.contenido);
    if (c.origen !== 'prueba_color_seguimiento') return null;
    pruebaId = Number(c.pruebaColorId);
    if (!Number.isFinite(pruebaId) || pruebaId <= 0) return null;
  } catch {
    return null;
  }

  const prueba = await prisma.pruebas_color.findFirst({
    where: { id: pruebaId, deleted_at: null },
  });
  if (!prueba) return null;

  // Si ya está aprobada o rechazada (terminal), no hacer nada.
  if (prueba.estatus === 'aprobada' || prueba.estatus === 'rechazada') return null;

  // Transicionar a 'aprobada' respetando la validacion de estado. Como el
  // origen ya venia de arte_aprobado o enviada_proveedor la transicion
  // es legítima. Reusamos actualizarEstatusPruebaColor para el efecto
  // completo (historial + socket + notificacion al creador).
  try {
    await actualizarEstatusPruebaColor({
      pruebaId,
      nuevoEstatus: 'aprobada',
      userId,
      userNombre,
    });
    return pruebaId;
  } catch (e) {
    console.error(`[pruebasColor.onFinalizarTareaSeguimiento] no se pudo aprobar prueba #${pruebaId}:`, e);
    return null;
  }
}

/**
 * Hook: al asignar APS a reservas, ligar las pruebas de color de esos
 * circuitos al reserva_id correspondiente. Se pasa la lista de reservaIds
 * y el servicio se encarga del match por sc_id.
 */
export async function vincularPruebasConReservas(reservaIds: number[]): Promise<number> {
  if (reservaIds.length === 0) return 0;
  const reservas = await prisma.reservas.findMany({
    where: { id: { in: reservaIds }, deleted_at: null },
    select: { id: true, solicitudCaras_id: true },
  });
  let vinculadas = 0;
  for (const r of reservas) {
    if (!r.solicitudCaras_id) continue;
    const upd = await prisma.pruebas_color.updateMany({
      where: { sc_id: r.solicitudCaras_id, reserva_id: null, deleted_at: null },
      data: { reserva_id: r.id },
    });
    vinculadas += upd.count;
  }
  if (vinculadas > 0) {
    console.log(`[pruebasColor.vincularConReservas] Vinculadas ${vinculadas} prueba(s) a ${reservas.length} reserva(s)`);
  }
  return vinculadas;
}
