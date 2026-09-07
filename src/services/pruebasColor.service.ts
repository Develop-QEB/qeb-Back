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

export type EstatusPruebaColor = 'solicitada' | 'enviada_proveedor' | 'aprobada' | 'rechazada';

const ESTATUS_VALIDOS: EstatusPruebaColor[] = ['solicitada', 'enviada_proveedor', 'aprobada', 'rechazada'];

// Transiciones legítimas del estatus. Una vez aprobada, no se puede mover.
// Si se rechaza, la siguiente accion es crear una nueva version (nuevo registro).
const TRANSICIONES: Record<EstatusPruebaColor, EstatusPruebaColor[]> = {
  solicitada: ['enviada_proveedor', 'aprobada', 'rechazada'],
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
      estatus: 'solicitada',
      version: nextVersion,
      created_by: createdBy,
      created_by_nombre: createdByNombre,
    },
  });

  // Notificacion interna a Produccion — crea una tarea que aparece en su
  // bandeja de notificaciones. Fase 2: enviar correo al proveedor.
  await notificarProduccion(prueba.id, propuestaId, scId, sc.articulo || null, createdByNombre);

  await logHistorial({
    tipo: 'Propuesta',
    refId: propuestaId,
    accion: `Solicitó prueba de color v${nextVersion} para circuito #${scId}`,
    usuario: createdByNombre,
    usuarioId: createdBy,
    origen: 'pruebas_color',
    extras: { pruebaId: prueba.id, scId, articulo: sc.articulo, formato: sc.formato, ciudad: sc.ciudad, campaniaId },
  });

  emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
    tareaId: prueba.id,
    tipo: 'Prueba de Color',
    propuestaId,
    scId,
  });

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

async function notificarProduccion(
  pruebaId: number,
  propuestaId: number,
  scId: number,
  articulo: string | null,
  solicitanteNombre: string,
) {
  const usuariosProduccion = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { user_role: 'Encargado de Producción' },
        { user_role: 'Coordinador de Producción' },
        { user_role: 'Producción' },
      ],
    },
    select: { id: true, nombre: true },
  });
  if (usuariosProduccion.length === 0) {
    console.warn('[pruebasColor] Sin usuarios de Producción configurados — solo se guarda la prueba.');
    return;
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 7);

  await prisma.tareas.create({
    data: {
      tipo: 'Prueba de Color',
      titulo: `Prueba de color solicitada - Propuesta #${propuestaId}`,
      descripcion: `${solicitanteNombre} solicitó una prueba de color para el circuito #${scId}${articulo ? ` (${articulo})` : ''} de la propuesta #${propuestaId}. Gestionar envio al proveedor.`,
      estatus: 'Pendiente',
      id_responsable: usuariosProduccion[0].id,
      responsable: usuariosProduccion[0].nombre,
      id_solicitud: '',
      id_propuesta: String(propuestaId),
      id_asignado: usuariosProduccion.map(u => u.id).join(','),
      asignado: usuariosProduccion.map(u => u.nombre).join(', '),
      contenido: JSON.stringify({ pruebaColorId: pruebaId, scId }),
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
    solicitada: 'solicitada',
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
