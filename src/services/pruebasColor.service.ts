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
// Feedback Jos 2026-10-02: habilitar también a Analista de Servicio al
// Cliente — este rol es quien manejaria el flujo de prueba de color desde
// la propuesta (como lo hacen hoy con gestor de artes).
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
  'Analista de Servicio al Cliente',
  'Administrador',
  'DEV',
]);

export function puedeGestionarPruebaColor(rol: string | null | undefined): boolean {
  return !!rol && ROLES_PRUEBA_COLOR.has(rol);
}

// Jos 2026-10-12: separar permisos.
// CREAR / SOLICITAR / REENVIAR: solo analistas y administradores.
const ROLES_CREAR_PRUEBA_COLOR = new Set<string>([
  'Analista de Servicio al Cliente',
  'Administrador',
  'DEV',
]);
// APROBAR / RECHAZAR tarea de Revisión: solo área de Diseño.
const ROLES_REVISAR_PRUEBA_COLOR = new Set<string>([
  'Coordinador de Diseño',
  'Coordinador de Diseno',
  'Diseñador',
  'Diseñadores',
  'Administrador',
  'DEV',
]);
export function puedeCrearPruebaColor(rol: string | null | undefined): boolean {
  return !!rol && ROLES_CREAR_PRUEBA_COLOR.has(rol);
}
export function puedeRevisarPruebaColor(rol: string | null | undefined): boolean {
  return !!rol && ROLES_REVISAR_PRUEBA_COLOR.has(rol);
}

// Jos 2026-10-23: expansion del modulo "Prueba de Color" a "Revision de Artes
// Anticipada". Dos flujos conviven en la misma tabla, se distinguen por `tipo`.
//   'prueba_color'       -> flujo original (default)
//   'revision_anticipada'-> arte revisado antes de pisada; al aprobar se vincula
//                           a la biblioteca de artes con badge "RA vN".
export type TipoPrueba = 'prueba_color' | 'revision_anticipada';

const TIPOS_VALIDOS: TipoPrueba[] = ['prueba_color', 'revision_anticipada'];

export function esTipoPruebaValido(v: unknown): v is TipoPrueba {
  return typeof v === 'string' && (TIPOS_VALIDOS as string[]).includes(v);
}

interface CrearPruebaInput {
  propuestaId: number;
  scId: number;
  // Archivo: URL del upload (opcional si viene enlace_externo).
  archivo: string;
  archivo_data?: string | null;
  // Jos 2026-10-12: link externo (Drive, Dropbox, etc.). Puede venir junto
  // al archivo o en lugar del archivo. Al menos uno debe existir.
  enlace_externo?: string | null;
  nombre_arte?: string | null;
  notas?: string | null;
  tipo?: TipoPrueba;
  createdBy: number;
  createdByNombre: string;
}

/**
 * Determina la siguiente version disponible para (propuesta_id, sc_id) y
 * crea el registro. Si campania_id ya existe para esa propuesta, tambien
 * queda vinculado desde el inicio. Feedback 2026-08-15.
 */
export async function crearPruebaColor(input: CrearPruebaInput) {
  const { propuestaId, scId, archivo, archivo_data, enlace_externo, nombre_arte, notas, createdBy, createdByNombre } = input;
  const tipo: TipoPrueba = input.tipo || 'prueba_color';
  // Al menos uno de archivo o enlace_externo debe existir.
  if ((!archivo || !archivo.trim()) && (!enlace_externo || !enlace_externo.trim())) {
    throw new Error('Debes subir un archivo o pegar un link del arte');
  }

  // Validar propuesta y circuito
  const sc = await prisma.solicitudCaras.findFirst({
    where: { id: scId, idquote: String(propuestaId) },
    select: { id: true, articulo: true, formato: true, ciudad: true },
  });
  if (!sc) throw new Error('Circuito no encontrado en la propuesta');

  // Ultima version del circuito dentro del MISMO tipo. Jos 2026-10-23: PC y RA
  // llevan numeracion independiente para que las etiquetas "PC v1/v2" y
  // "RA v1/v2" no se mezclen en biblioteca ni en tareas.
  const ultima = await prisma.pruebas_color.findFirst({
    where: { propuesta_id: propuestaId, sc_id: scId, tipo, deleted_at: null },
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
      archivo: archivo || '',
      archivo_data: archivo_data || null,
      enlace_externo: enlace_externo || null,
      nombre_arte: nombre_arte || null,
      notas: notas || null,
      estatus: 'revision_artes',
      tipo,
      version: nextVersion,
      created_by: createdBy,
      created_by_nombre: createdByNombre,
    },
  });

  // Efectos secundarios: si alguno falla, log y sigue. La prueba ya se
  // guardó y no queremos regresar 500 al usuario por una tarea/historial
  // colgado. Cada uno tiene su propio try/catch para no cortar los otros.
  try {
    await crearTareaRevisionArte(prueba.id, propuestaId, scId, sc.articulo || null, sc.formato || null, sc.ciudad || null, createdByNombre, createdBy, archivo, nombre_arte || null);
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

// Reenviar prueba rechazada — Jos 2026-10-12: en lugar de crear una v2
// nueva, el analista edita la MISMA prueba rechazada subiendo nuevo arte
// (y opcionalmente nuevo nombre/notas). La prueba vuelve a 'revision_artes'
// y se crea una nueva tarea de Revisión para los mismos reviewers.
// El historial del rechazo anterior queda intacto (ya quedó registrado
// cuando se rechazó).
export async function reenviarPruebaRechazada(input: {
  pruebaId: number;
  archivo: string;
  archivo_data?: string | null;
  enlace_externo?: string | null;
  nombre_arte?: string | null;
  notas?: string | null;
  userId: number;
  userNombre: string;
}) {
  const { pruebaId, archivo, archivo_data, enlace_externo, nombre_arte, notas, userId, userNombre } = input;
  if ((!archivo || !archivo.trim()) && (!enlace_externo || !enlace_externo.trim())) {
    throw new Error('Debes subir un archivo o pegar un link del arte');
  }

  const prueba = await prisma.pruebas_color.findFirst({
    where: { id: pruebaId, deleted_at: null },
  });
  if (!prueba) throw new Error('Prueba no encontrada');
  if (prueba.estatus !== 'rechazada') {
    throw new Error(`Solo se puede reenviar una prueba rechazada (estatus actual: ${prueba.estatus})`);
  }

  // Sobreescribe en sitio: archivo, nombre, notas, y vuelve a revision_artes.
  const updated = await prisma.pruebas_color.update({
    where: { id: pruebaId },
    data: {
      archivo: archivo || '',
      archivo_data: archivo_data || null,
      enlace_externo: enlace_externo || null,
      nombre_arte: nombre_arte || prueba.nombre_arte,
      notas: notas != null ? notas : prueba.notas,
      estatus: 'revision_artes',
    },
  });

  // Datos del circuito para la nueva tarea de Revisión.
  const sc = await prisma.solicitudCaras.findFirst({ where: { id: prueba.sc_id } });

  try {
    await crearTareaRevisionArte(
      prueba.id,
      prueba.propuesta_id,
      prueba.sc_id,
      sc?.articulo || null,
      sc?.formato || null,
      sc?.ciudad || null,
      userNombre,
      userId,
      archivo,
      updated.nombre_arte,
    );
  } catch (e) {
    console.error('[pruebasColor.reenviar] crearTareaRevisionArte falló:', e);
  }

  try {
    await logHistorial({
      tipo: 'Propuesta',
      refId: prueba.propuesta_id,
      accion: `Reenvió prueba de color v${prueba.version} para re-revisión (circuito #${prueba.sc_id})`,
      usuario: userNombre,
      usuarioId: userId,
      origen: 'pruebas_color',
      cambios: [{ campo: 'estatus', label: 'Estatus prueba color', antes: 'rechazada', despues: 'revision_artes' }],
      extras: { pruebaId: prueba.id, scId: prueba.sc_id },
    });
  } catch (e) {
    console.error('[pruebasColor.reenviar] logHistorial falló:', e);
  }

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: prueba.id,
      tipo: 'Prueba de Color',
      propuestaId: prueba.propuesta_id,
      scId: prueba.sc_id,
    });
  } catch (e) {
    console.error('[pruebasColor.reenviar] emitToAll falló:', e);
  }

  return updated;
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
// Feedback Jos 2026-10-02: mientras la prueba vive en propuesta las tareas
// NO deben aparecer en el gestor de artes de la campaña (que aún no
// existe); se consumen desde la ventana de prueba de color via los
// endpoints de aprobar/rechazar/finalizar que leen la tarea por
// contenido.pruebaColorId. Por eso `campania_id` queda null al crear y
// solo se sincroniza cuando la propuesta avanza (ver sincronizarTareasConCampania).
async function crearTareaRevisionArte(
  pruebaId: number,
  propuestaId: number,
  scId: number,
  articulo: string | null,
  formato: string | null,
  ciudad: string | null,
  solicitanteNombre: string,
  solicitanteId: number,
  arteUrl: string,
  nombreArte: string | null,
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

  const nombreArteSafe = nombreArte || 'sin nombre';
  const descripcion = [
    `${solicitanteNombre} solicitó una prueba de color para el circuito #${scId} (${detalleCircuito}).`,
    `Arte: ${nombreArteSafe}.`,
    arteUrl ? `URL del arte: ${arteUrl}.` : null,
    `Revisar el arte y aprobar o rechazar antes de enviar al proveedor.`,
  ].filter(Boolean).join(' ');

  await prisma.tareas.create({
    data: {
      tipo: 'Revisión de artes',
      titulo: `Revisión de arte para prueba de color - Propuesta #${propuestaId}`,
      descripcion,
      estatus: 'Pendiente',
      id_responsable: responsable.id,
      responsable: responsable.nombre,
      id_solicitud: '',
      id_propuesta: String(propuestaId),
      // Feedback Jos 2026-10-02: mientras es propuesta la tarea no se
      // vincula a la campaña aunque exista. Se sincronizará vía hook
      // cuando la propuesta avance a campaña definitiva.
      campania_id: null,
      // Archivo del arte queda accesible desde la tarea para que el
      // revisor pueda abrirlo directo sin volver al modal.
      archivo: arteUrl || null,
      id_asignado: usuariosDiseno.map(u => u.id).join(','),
      asignado: usuariosDiseno.map(u => u.nombre).join(', '),
      contenido: JSON.stringify({
        pruebaColorId: pruebaId,
        scId,
        propuestaId,
        solicitanteId,
        arte: arteUrl || null,
        nombreArte: nombreArte || null,
        origen: 'prueba_color_revision',
      }),
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
  // Comentario opcional (ej. motivo de rechazo capturado desde el modal).
  // Se concatena a la accion del historial para que quede trazabilidad.
  comentario?: string;
  // Jos 2026-10-12: al rechazar se pueden adjuntar archivo/link para dar
  // mas contexto al creador en la notificacion.
  archivo_adjunto?: string | null;
  enlace_adjunto?: string | null;
}

export async function actualizarEstatusPruebaColor(input: ActualizarEstatusInput) {
  const { pruebaId, nuevoEstatus, userId, userNombre, comentario, archivo_adjunto, enlace_adjunto } = input;
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

  const comentarioTrim = (comentario || '').trim();
  const accionHistorial = comentarioTrim
    ? `Prueba de color v${prueba.version} → '${nuevoEstatus}' (circuito #${prueba.sc_id}) — Motivo: ${comentarioTrim}`
    : `Prueba de color v${prueba.version} → '${nuevoEstatus}' (circuito #${prueba.sc_id})`;

  await logHistorial({
    tipo: 'Propuesta',
    refId: prueba.propuesta_id,
    accion: accionHistorial,
    usuario: userNombre,
    usuarioId: userId,
    origen: 'pruebas_color',
    cambios: [{ campo: 'estatus', label: 'Estatus prueba color', antes: actual, despues: nuevoEstatus }],
    extras: { pruebaId, scId: prueba.sc_id, ...(comentarioTrim ? { comentario: comentarioTrim } : {}) },
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
  // Jos 2026-10-12: incluir el motivo del rechazo para que el creador no
  // tenga que entrar al modal a buscarlo.
  await notificarActualizacionEstatus({
    prueba,
    nuevoEstatus,
    actor: userNombre,
    actorId: userId,
    comentario: comentarioTrim,
    archivo_adjunto,
    enlace_adjunto,
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
  // Motivo capturado al rechazar (opcional). Se incluye en la descripcion
  // de la tarea del creador y en el contenido JSON para que el frontend
  // pueda renderizar un flujo de 'subir nueva version' con el contexto.
  comentario?: string;
  // Jos 2026-10-12: adjuntos opcionales del rechazo (archivo/link).
  archivo_adjunto?: string | null;
  enlace_adjunto?: string | null;
}) {
  const { prueba, nuevoEstatus, actor, actorId, comentario, archivo_adjunto, enlace_adjunto } = input;
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

  const motivoTrim = (comentario || '').trim();
  const esRechazo = nuevoEstatus === 'rechazada';
  const descripcionBase = `${actor} marcó la prueba de color v${prueba.version} del circuito #${prueba.sc_id} como ${labelEstatus[nuevoEstatus]}.`;
  const descripcion = esRechazo && motivoTrim
    ? `${descripcionBase}\nMotivo: ${motivoTrim}\nAbre la tarea para subir una nueva versión del arte.`
    : esRechazo
      ? `${descripcionBase}\nAbre la tarea para subir una nueva versión del arte.`
      : descripcionBase;

  await prisma.tareas.create({
    data: {
      tipo: 'Prueba de Color',
      titulo: esRechazo
        ? `Prueba de color rechazada - Propuesta #${prueba.propuesta_id} (subir nueva versión)`
        : `Prueba de color ${labelEstatus[nuevoEstatus]} - Propuesta #${prueba.propuesta_id}`,
      descripcion,
      estatus: 'Pendiente',
      id_responsable: prueba.created_by,
      responsable: prueba.created_by_nombre,
      id_solicitud: '',
      id_propuesta: String(prueba.propuesta_id),
      id_asignado: String(prueba.created_by),
      asignado: prueba.created_by_nombre,
      contenido: JSON.stringify({
        pruebaColorId: prueba.id,
        scId: prueba.sc_id,
        propuestaId: prueba.propuesta_id,
        version: prueba.version,
        estatus: nuevoEstatus,
        // Flags para el drawer de notificaciones (front)
        origen: esRechazo ? 'prueba_color_rechazo' : 'prueba_color_estatus',
        requiereNuevaVersion: esRechazo,
        ...(motivoTrim ? { motivoRechazo: motivoTrim } : {}),
        // Adjuntos opcionales del rechazo (archivo/link). Si existen, el
        // drawer del creador los muestra junto al motivo.
        ...(archivo_adjunto ? { archivoAdjunto: archivo_adjunto } : {}),
        ...(enlace_adjunto ? { enlaceAdjunto: enlace_adjunto } : {}),
      }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

export interface ListarFiltro {
  propuesta_id?: number;
  campania_id?: number;
  sc_id?: number;
  // Jos 2026-10-23: opcional. Si no viene, devuelve ambos tipos; el modal
  // filtra en front por pestana activa. Mantener opcional evita tener que
  // tocar los callers que ya consumen /pruebas-color.
  tipo?: TipoPrueba;
}

export async function listarPruebasColor(filtro: ListarFiltro) {
  return prisma.pruebas_color.findMany({
    where: {
      deleted_at: null,
      ...(filtro.propuesta_id ? { propuesta_id: filtro.propuesta_id } : {}),
      ...(filtro.campania_id ? { campania_id: filtro.campania_id } : {}),
      ...(filtro.sc_id ? { sc_id: filtro.sc_id } : {}),
      ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
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
 * Feedback Jos 2026-10-02: también se sincronizan las tareas asociadas
 * (Revisión de artes y Seguimiento Prueba de color) actualizando su
 * campania_id para que empiecen a verse en el gestor de artes de la
 * campaña (sin dejar de ser visibles desde la ventana de prueba de color).
 */
export async function vincularPruebasConCampania(propuestaId: number, campaniaId: number): Promise<number> {
  const r = await prisma.pruebas_color.updateMany({
    where: { propuesta_id: propuestaId, campania_id: null, deleted_at: null },
    data: { campania_id: campaniaId },
  });
  if (r.count > 0) {
    console.log(`[pruebasColor.vincularConCampania] Propuesta #${propuestaId} → Campaña #${campaniaId}: ${r.count} prueba(s) vinculadas`);
  }

  // Sincronizar tareas asociadas: filtrar por id_propuesta + tipo relevante +
  // sin campania_id, y actualizar en bloque. La relación semántica real está
  // en contenido.pruebaColorId, pero id_propuesta + tipo basta para delimitar
  // el conjunto correcto sin tener que parsear JSON de cada fila.
  try {
    const sync = await prisma.tareas.updateMany({
      where: {
        id_propuesta: String(propuestaId),
        tipo: { in: ['Revisión de artes', 'Seguimiento Prueba de color'] },
        campania_id: null,
      },
      data: { campania_id: campaniaId },
    });
    if (sync.count > 0) {
      console.log(`[pruebasColor.vincularConCampania] ${sync.count} tarea(s) de prueba de color sincronizadas con campaña #${campaniaId}`);
    }
  } catch (e) {
    console.error('[pruebasColor.vincularConCampania] fallo sincronizando tareas:', e);
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

  // Feedback Jos 2026-10-02: la tarea queda sin campania_id al crear;
  // se sincroniza vía hook (sincronizarTareasConCampania) cuando la
  // propuesta avanza a campaña. Mientras tanto es consumible solo desde
  // la ventana de prueba de color.
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
      campania_id: null,
      archivo: prueba.archivo || null,
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
 * Lista las tareas asociadas a una prueba de color específica. Las tareas
 * se asocian via contenido JSON (pruebaColorId). Feedback Jos 2026-10-02:
 * la ventana de prueba de color muestra estas tareas para que el analista
 * las consuma sin ir al módulo de Tareas.
 */
export async function listarTareasAsociadas(pruebaId: number) {
  // Pre-filtrar por tipos relevantes para no scanear toda la tabla tareas.
  const tareas = await prisma.tareas.findMany({
    where: {
      tipo: { in: ['Revisión de artes', 'Seguimiento Prueba de color'] },
    },
    orderBy: { id: 'desc' },
    take: 100,
  });
  return tareas.filter(t => {
    if (!t.contenido) return false;
    try {
      const c = JSON.parse(t.contenido);
      return Number(c.pruebaColorId) === pruebaId;
    } catch { return false; }
  });
}

/**
 * Resuelve una tarea asociada a una prueba de color desde el modal.
 * Soporta las transiciones:
 *   - 'aprobar' sobre Revisión de artes → marca tarea Atendido + llama al
 *     flujo de arte_aprobado (crea tarea Seguimiento).
 *   - 'rechazar' sobre Revisión de artes → marca tarea Rechazado + llama
 *     al flujo rechazada (crea v2 implícita el siguiente POST).
 *   - 'finalizar' sobre Seguimiento Prueba de color → marca tarea
 *     Finalizada + llama al hook que pone prueba en 'aprobada'.
 */
export async function resolverTareaAsociada(input: {
  pruebaId: number;
  tareaId: number;
  accion: 'aprobar' | 'rechazar' | 'finalizar';
  comentario?: string;
  // Jos 2026-10-12: al rechazar se pueden adjuntar archivo o link para que
  // el revisor justifique mejor y el creador vea referencia en su notif.
  archivo_adjunto?: string | null;
  enlace_adjunto?: string | null;
  userId: number;
  userNombre: string;
}): Promise<{ tareaId: number; nuevoEstatus: string }> {
  const { pruebaId, tareaId, accion, comentario, archivo_adjunto, enlace_adjunto, userId, userNombre } = input;

  const tarea = await prisma.tareas.findUnique({ where: { id: tareaId } });
  if (!tarea) throw new Error('Tarea no encontrada');
  // Validar que la tarea pertenece a la prueba (anti-tampering).
  const contenido = tarea.contenido ? (() => {
    try { return JSON.parse(tarea.contenido); } catch { return null; }
  })() : null;
  if (!contenido || Number(contenido.pruebaColorId) !== pruebaId) {
    throw new Error('La tarea no pertenece a esta prueba de color');
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));

  // Helper: persiste el comentario de resolucion (y/o adjuntos opcionales)
  // en tarea.evidencia (JSON). Si no hay nada que persistir devuelve undefined.
  const buildEvidenciaConComentario = (): string | undefined => {
    const texto = (comentario || '').trim();
    if (!texto && !archivo_adjunto && !enlace_adjunto) return undefined;
    const base: Record<string, unknown> = (() => {
      if (!tarea.evidencia) return {};
      try { return JSON.parse(tarea.evidencia); } catch { return {}; }
    })();
    if (texto) base[accion === 'rechazar' ? 'motivoRechazo' : 'comentarioResolucion'] = texto;
    base.resueltaPor = userNombre;
    base.resueltaPorId = userId;
    base.resueltaAt = now.toISOString();
    if (archivo_adjunto) base.archivoAdjunto = archivo_adjunto;
    if (enlace_adjunto) base.enlaceAdjunto = enlace_adjunto;
    return JSON.stringify(base);
  };

  if (accion === 'aprobar' && tarea.tipo === 'Revisión de artes') {
    // Marcar la tarea de revisión como Atendido y transicionar la prueba
    // al estado arte_aprobado (que a su vez crea tarea Seguimiento).
    const evidenciaNueva = buildEvidenciaConComentario();
    await prisma.tareas.update({
      where: { id: tareaId },
      data: {
        estatus: 'Atendido',
        fecha_fin: now,
        ...(evidenciaNueva ? { evidencia: evidenciaNueva } : {}),
      },
    });
    await actualizarEstatusPruebaColor({
      pruebaId,
      nuevoEstatus: 'arte_aprobado',
      userId,
      userNombre,
      comentario,
    });
    return { tareaId, nuevoEstatus: 'Atendido' };
  }

  if (accion === 'rechazar' && tarea.tipo === 'Revisión de artes') {
    const evidenciaNueva = buildEvidenciaConComentario();
    await prisma.tareas.update({
      where: { id: tareaId },
      data: {
        estatus: 'Rechazado',
        fecha_fin: now,
        ...(evidenciaNueva ? { evidencia: evidenciaNueva } : {}),
      },
    });
    await actualizarEstatusPruebaColor({
      pruebaId,
      nuevoEstatus: 'rechazada',
      userId,
      userNombre,
      comentario,
      archivo_adjunto,
      enlace_adjunto,
    });
    return { tareaId, nuevoEstatus: 'Rechazado' };
  }

  if (accion === 'finalizar' && tarea.tipo === 'Seguimiento Prueba de color') {
    await prisma.tareas.update({
      where: { id: tareaId },
      data: { estatus: 'Finalizada', fecha_fin: now },
    });
    // Hook: pasa la prueba a aprobada.
    await onFinalizarTareaSeguimiento(
      { id: tarea.id, tipo: tarea.tipo, contenido: tarea.contenido },
      userId,
      userNombre,
    );
    return { tareaId, nuevoEstatus: 'Finalizada' };
  }

  throw new Error(`Acción '${accion}' inválida para tarea tipo '${tarea.tipo}'`);
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
