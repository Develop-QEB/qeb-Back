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
  'Asesor Analista',
  'Analista de Servicio al Cliente',
  'Administrador',
  'DEV',
]);

export function puedeGestionarPruebaColor(rol: string | null | undefined): boolean {
  return !!rol && ROLES_PRUEBA_COLOR.has(rol);
}

// Jos 2026-10-12: separar permisos.
// CREAR / SOLICITAR / REENVIAR: solo analistas y administradores.
// Jos 2026-11-24: ampliar a Asesores Comerciales — ellos tambien manejan el flujo
// de pruebas de color y revisiones anticipadas desde propuestas.
const ROLES_CREAR_PRUEBA_COLOR = new Set<string>([
  'Analista de Servicio al Cliente',
  'Asesor Comercial',
  'Asesor Comercial Aeropuerto',
  'Asesor Analista',
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
    const tareaId = await crearTareaRevisionArte(prueba.id, propuestaId, scId, sc.articulo || null, sc.formato || null, sc.ciudad || null, createdByNombre, createdBy, archivo, nombre_arte || null);
    // Jos 2026-11-27: enlaza la prueba a su tarea de Revisión activa para que
    // el front pueda agrupar (batch) y no se vean cards duplicadas.
    if (tareaId) {
      try {
        await prisma.pruebas_color.update({ where: { id: prueba.id }, data: { tarea_revision_id: tareaId } });
      } catch (e) {
        console.error('[pruebasColor.crear] enlazar tarea_revision_id falló:', e);
      }
    }
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

// Jos 2026-11-24: crea N pruebas de color en batch para UNA misma tarea de
// Revisión. Antes el front hacía N POST individuales y se generaban N tareas
// separadas; ahora se agrupan en UNA sola tarea cuyo contenido lleva
// `pruebaColorIds` array. Diseño las aprueba/rechaza individual o masivo y
// la tarea solo se cierra cuando TODAS están resueltas.
//
// Cada input es similar a `crearPruebaColor` individual. Todos los inputs
// deben compartir propuesta_id y tipo. sc_id puede variar (N artes × M
// circuitos se envían como N*M inputs y se agrupan por sc_id en una tarea
// por circuito — cada circuito tiene su propia tarea agrupada).
export async function crearPruebaColorBatch(input: {
  propuestaId: number;
  tipo?: TipoPrueba;
  createdBy: number;
  createdByNombre: string;
  // Array de artes. Cada arte lleva su propio sc_id → se agrupa en UNA
  // tarea por circuito (sc_id) con todos sus artes.
  artes: Array<{
    scId: number;
    archivo: string;
    archivo_data?: string | null;
    enlace_externo?: string | null;
    nombre_arte?: string | null;
    notas?: string | null;
  }>;
}) {
  const { propuestaId, createdBy, createdByNombre, artes } = input;
  const tipo: TipoPrueba = input.tipo || 'prueba_color';
  if (!artes || artes.length === 0) throw new Error('Debes enviar al menos un arte');
  for (const a of artes) {
    if ((!a.archivo || !a.archivo.trim()) && (!a.enlace_externo || !a.enlace_externo.trim())) {
      throw new Error('Cada arte debe tener archivo o enlace');
    }
  }

  // Agrupar inputs por sc_id — cada circuito recibe su propia tarea con los
  // artes que le correspondan.
  const porCircuito = new Map<number, typeof artes>();
  for (const a of artes) {
    const arr = porCircuito.get(a.scId) || [];
    arr.push(a);
    porCircuito.set(a.scId, arr);
  }

  const campaniaId = await resolverCampaniaIdDePropuesta(propuestaId);
  const resultados: Array<{ scId: number; pruebas: Array<{ id: number }> ; tareaId: number | null }> = [];

  for (const [scId, artesDeCircuito] of porCircuito.entries()) {
    const sc = await prisma.solicitudCaras.findFirst({
      where: { id: scId, idquote: String(propuestaId) },
      select: { id: true, articulo: true, formato: true, ciudad: true },
    });
    if (!sc) throw new Error(`Circuito #${scId} no encontrado en la propuesta`);

    // Numeración: siguiente version para el primer arte; los demás del mismo
    // batch comparten "lote" pero cada prueba sigue teniendo su version
    // individual incremental para preservar trazabilidad.
    const ultima = await prisma.pruebas_color.findFirst({
      where: { propuesta_id: propuestaId, sc_id: scId, tipo, deleted_at: null },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    let next = (ultima?.version ?? 0) + 1;

    const pruebasCreadas: Array<{ id: number }> = [];
    for (const a of artesDeCircuito) {
      const p = await prisma.pruebas_color.create({
        data: {
          propuesta_id: propuestaId,
          sc_id: scId,
          campania_id: campaniaId,
          reserva_id: null,
          archivo: a.archivo || '',
          archivo_data: a.archivo_data || null,
          enlace_externo: a.enlace_externo || null,
          nombre_arte: a.nombre_arte || null,
          notas: a.notas || null,
          estatus: 'revision_artes',
          tipo,
          version: next,
          created_by: createdBy,
          created_by_nombre: createdByNombre,
        },
        select: { id: true },
      });
      pruebasCreadas.push(p);
      next += 1;
    }

    // Una sola tarea para todas las pruebas del circuito. El arte primario
    // (visible en la tabla de tareas y el correo) es el primero del batch.
    const primero = artesDeCircuito[0];
    let tareaId: number | null = null;
    try {
      tareaId = await crearTareaRevisionArte(
        pruebasCreadas[0].id,
        propuestaId,
        scId,
        sc.articulo || null,
        sc.formato || null,
        sc.ciudad || null,
        createdByNombre,
        createdBy,
        primero.archivo || '',
        primero.nombre_arte || null,
        { pruebaIdsBatch: pruebasCreadas.map(p => p.id) },
      );
      // Jos 2026-11-27: enlaza las N pruebas del batch a la tarea compartida
      // para que el front las colapse en UNA sola card con N artes.
      if (tareaId) {
        try {
          await prisma.pruebas_color.updateMany({
            where: { id: { in: pruebasCreadas.map(p => p.id) } },
            data: { tarea_revision_id: tareaId },
          });
        } catch (e) {
          console.error('[pruebasColor.crearBatch] enlazar tarea_revision_id falló:', e);
        }
      }
    } catch (e) {
      console.error('[pruebasColor.crearBatch] crearTareaRevisionArte falló:', e);
    }

    try {
      await logHistorial({
        tipo: 'Propuesta',
        refId: propuestaId,
        accion: `Solicitó revisión de ${artesDeCircuito.length} arte(s) para circuito #${scId}`,
        usuario: createdByNombre,
        usuarioId: createdBy,
        origen: 'pruebas_color',
        extras: {
          pruebaIds: pruebasCreadas.map(p => p.id),
          scId,
          articulo: sc.articulo,
          formato: sc.formato,
          ciudad: sc.ciudad,
          campaniaId,
          tareaId,
        },
      });
    } catch (e) {
      console.error('[pruebasColor.crearBatch] logHistorial falló:', e);
    }

    try {
      emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
        tareaId: pruebasCreadas[0].id,
        tipo: 'Prueba de Color',
        propuestaId,
        scId,
      });
    } catch (e) {
      console.error('[pruebasColor.crearBatch] emitToAll falló:', e);
    }

    resultados.push({ scId, pruebas: pruebasCreadas, tareaId });
  }

  return resultados;
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
    const nuevaTareaId = await crearTareaRevisionArte(
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
    // Jos 2026-11-27: enlazar al reenviar — pero SOLO si la prueba no ya
    // pertenecía a un batch (tarea_revision_id del lote original). Si sí
    // pertenecía, mantenemos el id original para que el front siga
    // agrupando v1+v2 en el mismo lote y el drawer de hermanas encuentre
    // la nueva Revisión via el pruebaColorId en contenido. Para pruebas
    // individuales (sin batch) sí seteamos el nuevo id.
    if (nuevaTareaId && !prueba.tarea_revision_id) {
      try {
        await prisma.pruebas_color.update({ where: { id: prueba.id }, data: { tarea_revision_id: nuevaTareaId } });
      } catch (e) {
        console.error('[pruebasColor.reenviar] enlazar tarea_revision_id falló:', e);
      }
    }
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

  // Jos 2026-11-27: al reenviar, cerrar la tarea 'Corrección' pendiente
  // (aviso de rechazo que el asesor venía atendiendo) — ya hay una nueva
  // Revisión de artes para Diseño que la reemplaza en el flujo.
  try {
    await cerrarTareaAsociada(prueba.id, 'Corrección', userNombre);
    // Compat: tareas viejas que aún estén como 'Prueba de Color'.
    await cerrarTareaAsociada(prueba.id, 'Prueba de Color', userNombre);
  } catch (e) {
    console.error('[pruebasColor.reenviar] cerrar tarea Corrección falló:', e);
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
// Jos 2026-11-24: soporta N artes por tarea (batch). Si llega 1 arte, el
// contenido usa `pruebaColorId` singular (compat flujo individual). Si
// llegan N, usa `pruebaColorIds` array + `pruebaColorId = ids[0]` (compat
// con queries existentes que solo esperan singular). Se devuelve el id
// de la tarea creada para que el caller pueda devolverlo al front.
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
  extras?: { pruebaIdsBatch?: number[] },
): Promise<number | null> {
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
    return null;
  }

  // Responsable = primer Coordinador de Diseño; si no hay, primer Diseñador.
  const coordinador = usuariosDiseno.find(u => u.user_role === 'Coordinador de Diseño' || u.user_role === 'Coordinador de Diseno');
  const responsable = coordinador || usuariosDiseno[0];

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 3);

  const detalleCircuito = [articulo, formato, ciudad].filter(Boolean).join(' · ') || `#${scId}`;

  const nombreArteSafe = nombreArte || 'sin nombre';
  const pruebaIdsBatch = extras?.pruebaIdsBatch && extras.pruebaIdsBatch.length > 1
    ? extras.pruebaIdsBatch
    : null;
  const esBatch = !!pruebaIdsBatch;
  const nTotal = pruebaIdsBatch ? pruebaIdsBatch.length : 1;

  const descripcion = esBatch
    ? [
        `${solicitanteNombre} solicitó una revisión de artes para el circuito #${scId} (${detalleCircuito}).`,
        `${nTotal} artes para revisar.`,
        `Revisa cada arte individualmente — aprueba o rechaza los que correspondan antes de cerrar la tarea.`,
      ].filter(Boolean).join(' ')
    : [
        `${solicitanteNombre} solicitó una prueba de color para el circuito #${scId} (${detalleCircuito}).`,
        `Arte: ${nombreArteSafe}.`,
        arteUrl ? `URL del arte: ${arteUrl}.` : null,
        `Revisar el arte y aprobar o rechazar antes de enviar al proveedor.`,
      ].filter(Boolean).join(' ');

  const contenidoJson = {
    // pruebaColorId singular = primer id del batch (o el único cuando N=1).
    // Compat con queries existentes que solo esperan singular.
    pruebaColorId: pruebaId,
    // Solo cuando N>1 incluimos el array. El resolver detecta array y exige
    // el id especifico a resolver via `pruebaIdObjetivo`.
    ...(pruebaIdsBatch ? { pruebaColorIds: pruebaIdsBatch } : {}),
    scId,
    propuestaId,
    solicitanteId,
    arte: arteUrl || null,
    nombreArte: nombreArte || null,
    origen: 'prueba_color_revision',
  };

  const tarea = await prisma.tareas.create({
    data: {
      tipo: 'Revisión de artes',
      titulo: esBatch
        ? `Revisión de ${nTotal} artes - Propuesta #${propuestaId}`
        : `Revisión de arte para prueba de color - Propuesta #${propuestaId}`,
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
      contenido: JSON.stringify(contenidoJson),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
  return tarea.id;
}

interface ActualizarEstatusInput {
  pruebaId: number;
  nuevoEstatus: EstatusPruebaColor;
  userId: number;
  userNombre: string;
  // Jos 2026-11-27: cuando la prueba pertenece a un batch de Revisión con
  // artes aún pendientes, diferimos los side-effects (crear Seguimiento,
  // vincular biblioteca, notificar, emit) hasta que TODAS las pruebas del
  // batch estén resueltas. Se dispara `aplicarHooksEstatus` por cada una al
  // cerrar la tarea batch.
  diferirHooks?: boolean;
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

  // Jos 2026-11-27: side-effects (crear Seguimiento, cerrar tareas, vincular
  // biblioteca, notificar creador, emit socket) se extraen a una función
  // reutilizable. En resoluciones de batch los diferimos hasta que TODAS las
  // pruebas del batch estén resueltas, para no generar la tarea Seguimiento
  // de una prueba cuando otras del mismo batch siguen pendientes.
  if (!input.diferirHooks) {
    await aplicarHooksEstatus(prueba, nuevoEstatus, {
      userId,
      userNombre,
      comentario: comentarioTrim,
      archivo_adjunto,
      enlace_adjunto,
    });
  }

  return upd;
}

// Jos 2026-11-27: dispara los side-effects asociados a un cambio de estatus
// de prueba (crear Seguimiento, cerrar Revisión, vincular biblioteca RA,
// notificar creador, emit socket). Se llama al final de
// `actualizarEstatusPruebaColor` y, para batches, se difiere hasta cerrar la
// tarea de Revisión agrupada para que no haya artefactos a medias.
export async function aplicarHooksEstatus(
  prueba: {
    id: number;
    tipo: string | null;
    propuesta_id: number;
    sc_id: number;
    campania_id: number | null;
    archivo: string;
    enlace_externo: string | null;
    nombre_arte: string | null;
    version: number;
    created_by: number;
    created_by_nombre: string;
  },
  nuevoEstatus: EstatusPruebaColor,
  input: {
    userId: number;
    userNombre: string;
    comentario?: string;
    archivo_adjunto?: string | null;
    enlace_adjunto?: string | null;
    // Jos 2026-11-27: en batch, las tareas Seguimiento (aprobadas) y
    // Prueba de Color aviso (rechazadas) NO se crean 1-a-1 por prueba —
    // resolverEnBatch las crea AGRUPADAS por estatus al final para evitar
    // ruido (N artes aprobados → 1 Seguimiento con los N, no N tareas).
    skipTareasAgregadas?: boolean;
  },
) {
  const { userId, userNombre, comentario, archivo_adjunto, enlace_adjunto, skipTareasAgregadas } = input;
  const comentarioTrim = (comentario || '').trim();
  const pruebaId = prueba.id;

  // Hook 1: al aprobar el arte se cierra la tarea Revisión y se abre la
  // tarea Seguimiento para el analista/creador (Feedback Jos 2026-09-25).
  if (nuevoEstatus === 'arte_aprobado') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Revisión de artes', userNombre);
      if (!skipTareasAgregadas) {
        await crearTareaSeguimiento(prueba, userNombre, {
          comentario: comentarioTrim,
          archivo_adjunto,
          enlace_adjunto,
        });
      }
      // Jos 2026-11-12: cerrar notificaciones Pendientes asociadas a esta
      // prueba — ya hay Seguimiento que las reemplaza. Cubre 'Prueba de Color'
      // (aviso informativo) y 'Corrección' (aviso de rechazo renombrado).
      await cerrarTareaAsociada(pruebaId, 'Prueba de Color', userNombre);
      await cerrarTareaAsociada(pruebaId, 'Corrección', userNombre);
    } catch (e) {
      console.error('[pruebasColor.aplicarHooks] arte_aprobado falló:', e);
    }
    if (prueba.tipo === 'revision_anticipada' && prueba.campania_id) {
      try {
        await vincularArteAprobadoABibliotecaCampania(prueba as any);
      } catch (e) {
        console.error('[pruebasColor.aplicarHooks] vincular RA (arte_aprobado) falló:', e);
      }
    }
  }

  if (nuevoEstatus === 'aprobada') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Seguimiento Prueba de color', userNombre);
    } catch (e) {
      console.error('[pruebasColor.aplicarHooks] aprobada falló:', e);
    }
    if (prueba.tipo === 'revision_anticipada' && prueba.campania_id) {
      try {
        await vincularArteAprobadoABibliotecaCampania(prueba as any);
      } catch (e) {
        console.error('[pruebasColor.aplicarHooks] vincular RA (aprobada) falló:', e);
      }
    }
  }

  if (nuevoEstatus === 'rechazada') {
    try {
      await cerrarTareaAsociada(pruebaId, 'Revisión de artes', userNombre);
      await cerrarTareaAsociada(pruebaId, 'Seguimiento Prueba de color', userNombre);
    } catch (e) {
      console.error('[pruebasColor.aplicarHooks] rechazada falló:', e);
    }
  }

  if (!skipTareasAgregadas) {
    await notificarActualizacionEstatus({
      prueba,
      nuevoEstatus,
      actor: userNombre,
      actorId: userId,
      comentario: comentarioTrim,
      archivo_adjunto,
      enlace_adjunto,
    });
  }

  emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
    tareaId: pruebaId,
    tipo: 'Prueba de Color',
    estatus: nuevoEstatus,
  });
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
  // Jos 2026-11-27: en rechazos siempre se crea la tarea de aviso al creador
  // (aunque el revisor sea el mismo que la creó — p.ej. al probar), para que
  // quede en Mis Tareas la acción "subir nueva versión". En otros estatus se
  // mantiene el skip para no auto-notificar al creador.
  if (prueba.created_by === actorId && nuevoEstatus !== 'rechazada') return;

  // Jos 2026-11-12: al pasar a 'arte_aprobado' el hook ya crea la tarea
  // Seguimiento (es la que el creador debe atender). La notificación
  // 'Prueba de Color' tipo "arte aprobado" queda redundante y se veía
  // colgada en Mis Tareas (feedback Akary). Se omite para evitar duplicados.
  if (nuevoEstatus === 'arte_aprobado') return;

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

  // Jos 2026-11-27: la tarea de RECHAZO debe ser tipo 'Corrección' (el que
  // ya se usaba antes en el gestor de artes) — "Prueba de Color" confunde
  // porque sugiere crear una prueba, no corregir el arte. Los estatus
  // informativos (no rechazo) siguen usando 'Prueba de Color'.
  const tipoTarea = esRechazo ? 'Corrección' : 'Prueba de Color';
  await prisma.tareas.create({
    data: {
      tipo: tipoTarea,
      titulo: esRechazo
        ? `Corrección de arte - Propuesta #${prueba.propuesta_id} (subir nueva versión)`
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

  // Jos 2026-11-12: al borrar una prueba de color, cerrar también todas las
  // tareas asociadas (Revisión / Seguimiento / Impresión / Recepción /
  // notificación "Prueba de Color") de ESA versión específica para que no
  // queden huérfanas en Mis Tareas (feedback Akary). Cada cerrarTareaAsociada
  // filtra por pruebaColorId en contenido, así que no toca tareas de otras
  // versiones de la misma propuesta/circuito.
  for (const tipoTarea of ['Revisión de artes', 'Seguimiento Prueba de color', 'Impresión', 'Recepción', 'Prueba de Color', 'Corrección']) {
    try {
      await cerrarTareaAsociada(pruebaId, tipoTarea, userNombre);
    } catch (e) {
      console.error(`[pruebasColor.eliminar] cerrar tareas tipo '${tipoTarea}' falló:`, e);
    }
  }

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
  prueba: { id: number; propuesta_id: number; sc_id: number; version: number; created_by: number; created_by_nombre: string; archivo: string; nombre_arte: string | null; tipo?: string | null },
  actorNombre: string,
  // Jos 2026-10-29: motivo + archivo + enlace de la aprobacion RA (si vienen)
  // para que el analista los vea en la tarea Seguimiento.
  aprobacion?: { comentario?: string; archivo_adjunto?: string | null; enlace_adjunto?: string | null },
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

  const motivoAprobacion = (aprobacion?.comentario || '').trim();
  const descripcion = [
    `${actorNombre} aprobó el arte de la prueba de color v${prueba.version}.`,
    `Arte: ${prueba.nombre_arte || 'sin nombre'} (${prueba.archivo}).`,
    `Circuito #${prueba.sc_id} — ${detalleCircuito}.`,
    motivoAprobacion ? `Motivo de aprobación: ${motivoAprobacion}.` : null,
    'Gestiona el envío al proveedor y finaliza esta tarea cuando la prueba esté aprobada.',
  ].filter(Boolean).join(' ');

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
        // Jos 2026-10-29: motivo de aprobacion + adjuntos (solo en RA)
        ...(motivoAprobacion ? { motivoAprobacion } : {}),
        ...(aprobacion?.archivo_adjunto ? { aprobacionArchivo: aprobacion.archivo_adjunto } : {}),
        ...(aprobacion?.enlace_adjunto ? { aprobacionEnlace: aprobacion.enlace_adjunto } : {}),
      }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

// Jos 2026-11-27: crea UNA sola tarea Seguimiento para N pruebas aprobadas
// en el mismo batch. El contenido lleva `pruebaColorIds` (array) para que
// el front pueda renderizar la lista de artes a atender.
async function crearTareaSeguimientoAgrupada(
  pruebas: Array<{
    id: number; propuesta_id: number; sc_id: number; version: number;
    created_by: number; created_by_nombre: string; archivo: string;
    nombre_arte: string | null;
  }>,
  actorNombre: string,
  resoluciones: Record<string, unknown>,
) {
  // Caso borde: 1 prueba → degenera al flujo legacy para reutilizar UI.
  if (pruebas.length === 1) {
    const p = pruebas[0];
    const r = (resoluciones[String(p.id)] as Record<string, unknown> | undefined) || undefined;
    return crearTareaSeguimiento(p as any, actorNombre, {
      comentario: typeof r?.comentario === 'string' ? r.comentario as string : undefined,
      archivo_adjunto: typeof r?.archivoAdjunto === 'string' ? r.archivoAdjunto as string : null,
      enlace_adjunto: typeof r?.enlaceAdjunto === 'string' ? r.enlaceAdjunto as string : null,
    });
  }

  const ref = pruebas[0];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 5);

  const detallePorPrueba = pruebas.map(p => {
    const r = (resoluciones[String(p.id)] as Record<string, unknown> | undefined) || {};
    return {
      pruebaColorId: p.id,
      version: p.version,
      scId: p.sc_id,
      nombreArte: p.nombre_arte,
      arte: p.archivo,
      motivoAprobacion: typeof r?.comentario === 'string' ? (r.comentario as string).trim() || null : null,
      aprobacionArchivo: typeof r?.archivoAdjunto === 'string' ? r.archivoAdjunto as string : null,
      aprobacionEnlace: typeof r?.enlaceAdjunto === 'string' ? r.enlaceAdjunto as string : null,
    };
  });

  const descripcion = [
    `${actorNombre} aprobó ${pruebas.length} artes de la propuesta #${ref.propuesta_id}.`,
    `Artes: ${pruebas.map(p => `v${p.version} (${p.nombre_arte || 'sin nombre'})`).join(', ')}.`,
    'Gestiona el envío al proveedor y finaliza esta tarea cuando las pruebas estén aprobadas.',
  ].join(' ');

  await prisma.tareas.create({
    data: {
      tipo: 'Seguimiento Prueba de color',
      titulo: `Seguimiento de ${pruebas.length} artes aprobados - Propuesta #${ref.propuesta_id}`,
      descripcion,
      estatus: 'Pendiente',
      id_responsable: ref.created_by,
      responsable: ref.created_by_nombre,
      id_solicitud: '',
      id_propuesta: String(ref.propuesta_id),
      campania_id: null,
      archivo: ref.archivo || null,
      id_asignado: String(ref.created_by),
      asignado: ref.created_by_nombre,
      contenido: JSON.stringify({
        pruebaColorIds: pruebas.map(p => p.id),
        propuestaId: ref.propuesta_id,
        scId: ref.sc_id,
        origen: 'prueba_color_seguimiento',
        esBatch: true,
        artes: detallePorPrueba,
      }),
      fecha_inicio: now,
      fecha_fin: fechaFin,
    },
  });
}

// Jos 2026-11-27: crea UNA sola tarea Prueba de Color (aviso de rechazo)
// para N pruebas rechazadas en el mismo batch. El front renderiza la lista
// de artes con su motivo y botón "Subir nueva versión" por cada uno.
async function crearTareaRechazoAgrupada(
  pruebas: Array<{
    id: number; propuesta_id: number; sc_id: number; version: number;
    created_by: number; created_by_nombre: string; archivo: string;
    nombre_arte: string | null;
  }>,
  actorNombre: string,
  actorId: number,
  resoluciones: Record<string, unknown>,
) {
  // Caso borde: 1 prueba → degenera al flujo legacy (notificarActualizacionEstatus).
  if (pruebas.length === 1) {
    const p = pruebas[0];
    const r = (resoluciones[String(p.id)] as Record<string, unknown> | undefined) || undefined;
    return notificarActualizacionEstatus({
      prueba: p as any,
      nuevoEstatus: 'rechazada',
      actor: actorNombre,
      actorId,
      comentario: typeof r?.comentario === 'string' ? r.comentario as string : undefined,
      archivo_adjunto: typeof r?.archivoAdjunto === 'string' ? r.archivoAdjunto as string : null,
      enlace_adjunto: typeof r?.enlaceAdjunto === 'string' ? r.enlaceAdjunto as string : null,
    });
  }

  const ref = pruebas[0];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const fechaFin = new Date(now); fechaFin.setDate(fechaFin.getDate() + 7);

  const detallePorPrueba = pruebas.map(p => {
    const r = (resoluciones[String(p.id)] as Record<string, unknown> | undefined) || {};
    return {
      pruebaColorId: p.id,
      version: p.version,
      scId: p.sc_id,
      nombreArte: p.nombre_arte,
      arte: p.archivo,
      motivoRechazo: typeof r?.comentario === 'string' ? (r.comentario as string).trim() || null : null,
      archivoAdjunto: typeof r?.archivoAdjunto === 'string' ? r.archivoAdjunto as string : null,
      enlaceAdjunto: typeof r?.enlaceAdjunto === 'string' ? r.enlaceAdjunto as string : null,
    };
  });

  const descripcion = [
    `${actorNombre} rechazó ${pruebas.length} artes de la propuesta #${ref.propuesta_id}.`,
    `Artes: ${pruebas.map(p => `v${p.version} (${p.nombre_arte || 'sin nombre'})`).join(', ')}.`,
    'Abre la tarea para revisar motivos y subir una nueva versión de cada arte.',
  ].join(' ');

  await prisma.tareas.create({
    data: {
      // Jos 2026-11-27: tareas de RECHAZO van como 'Corrección' (tipo que
      // ya existía) para no confundir con las informativas de 'Prueba de Color'.
      tipo: 'Corrección',
      titulo: `Corrección de ${pruebas.length} artes - Propuesta #${ref.propuesta_id} (subir nueva versión)`,
      descripcion,
      estatus: 'Pendiente',
      id_responsable: ref.created_by,
      responsable: ref.created_by_nombre,
      id_solicitud: '',
      id_propuesta: String(ref.propuesta_id),
      id_asignado: String(ref.created_by),
      asignado: ref.created_by_nombre,
      contenido: JSON.stringify({
        pruebaColorIds: pruebas.map(p => p.id),
        propuestaId: ref.propuesta_id,
        scId: ref.sc_id,
        origen: 'prueba_color_rechazo',
        requiereNuevaVersion: true,
        esBatch: true,
        artes: detallePorPrueba,
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
      estatus: { in: ['Pendiente', 'En proceso', 'En Proceso', 'Atendido'] },
    },
    select: { id: true, contenido: true },
  });
  const objetivo = tareas.filter(t => {
    if (!t.contenido) return false;
    try {
      const c = JSON.parse(t.contenido);
      // Jos 2026-11-24: tareas batch de Revisión (N pruebas en pruebaColorIds)
      // se cierran por resolverEnBatch cuando TODAS están resueltas. Evitamos
      // cerrarlas prematuramente desde el hook por cada prueba individual.
      if (Array.isArray(c.pruebaColorIds) && c.pruebaColorIds.length > 1) return false;
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
  // Jos 2026-11-27: si la prueba pertenece a un batch (tarea_revision_id),
  // el drawer muestra las tareas de TODAS las pruebas del batch (aprobadas,
  // rechazadas, etc.), no solo del representante. Así se ven en una vista
  // la Seguimiento de las aprobadas + la "Prueba de color rechazada" del
  // aviso de cada rechazo + la tarea batch de Revisión.
  const pruebaBase = await prisma.pruebas_color.findUnique({
    where: { id: pruebaId },
    select: { id: true, tarea_revision_id: true },
  });
  let pruebaIdsRelevantes: number[] = [pruebaId];
  if (pruebaBase?.tarea_revision_id) {
    const hermanas = await prisma.pruebas_color.findMany({
      where: { tarea_revision_id: pruebaBase.tarea_revision_id, deleted_at: null },
      select: { id: true },
    });
    pruebaIdsRelevantes = [...new Set([pruebaId, ...hermanas.map(h => h.id)])];
  }
  const setIds = new Set(pruebaIdsRelevantes);

  // Pre-filtrar por tipos relevantes para no scanear toda la tabla tareas.
  // Jos 2026-11-12: incluimos 'Impresión' para que el pedido de impresión
  // creado desde Seguimiento aparezca en el drawer TAREAS DE LA PRUEBA
  // (el front guarda pruebaColorId en contenido al disparar createTarea).
  const tareas = await prisma.tareas.findMany({
    where: {
      // Jos 2026-11-27: incluir 'Prueba de Color' (aviso informativo) y
      // 'Corrección' (aviso de rechazo — tipo renombrado desde 'Prueba de
      // Color' porque ese nombre confundía) para que ambas aparezcan en el
      // drawer de "Tareas de la prueba" del modal.
      tipo: { in: ['Revisión de artes', 'Seguimiento Prueba de color', 'Prueba de Color', 'Corrección', 'Impresión', 'Recepción'] },
    },
    orderBy: { id: 'desc' },
    take: 200,
  });
  return tareas.filter(t => {
    if (!t.contenido) return false;
    try {
      const c = JSON.parse(t.contenido);
      const pid = Number(c.pruebaColorId);
      if (Number.isFinite(pid) && setIds.has(pid)) return true;
      // Jos 2026-11-24: tareas batch de Revisión agrupan N pruebas en
      // `pruebaColorIds` array. Cada PruebaCard de las N pruebas debe ver
      // la misma tarea compartida en su drawer de tareas.
      if (Array.isArray(c.pruebaColorIds)) {
        return (c.pruebaColorIds as unknown[]).some(v => setIds.has(Number(v)));
      }
      return false;
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
  // Jos 2026-11-24: cuando la tarea de Revisión agrupa N pruebas (batch),
  // el revisor resuelve una a la vez — `pruebaIdObjetivo` indica cuál del
  // array. Si la tarea es individual (contenido.pruebaColorId) se ignora.
  pruebaIdObjetivo?: number;
}): Promise<{ tareaId: number; nuevoEstatus: string }> {
  const { pruebaId, tareaId, accion, comentario, archivo_adjunto, enlace_adjunto, userId, userNombre, pruebaIdObjetivo } = input;

  const tarea = await prisma.tareas.findUnique({ where: { id: tareaId } });
  if (!tarea) throw new Error('Tarea no encontrada');
  // Validar que la tarea pertenece a la prueba (anti-tampering).
  const contenido = tarea.contenido ? (() => {
    try { return JSON.parse(tarea.contenido); } catch { return null; }
  })() : null;
  if (!contenido) throw new Error('La tarea no pertenece a esta prueba de color');

  // Jos 2026-11-24: detectar si la tarea agrupa N pruebas (batch) o es individual.
  const pruebaIdsBatch: number[] | null = Array.isArray(contenido.pruebaColorIds)
    ? (contenido.pruebaColorIds as unknown[]).map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0)
    : null;
  const esBatch = pruebaIdsBatch && pruebaIdsBatch.length > 1;

  // ID específico sobre el cual se actúa:
  //   - Batch: pruebaIdObjetivo (si viene) o input.pruebaId
  //   - Individual: contenido.pruebaColorId
  const pruebaIdAccion = esBatch
    ? (pruebaIdObjetivo || pruebaId)
    : Number(contenido.pruebaColorId);

  if (esBatch) {
    if (!pruebaIdsBatch!.includes(pruebaIdAccion)) {
      throw new Error('La prueba indicada no pertenece a esta tarea agrupada');
    }
  } else {
    if (Number(contenido.pruebaColorId) !== pruebaId) {
      throw new Error('La tarea no pertenece a esta prueba de color');
    }
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

  // Jos 2026-11-24: para batch guardamos una resolucion POR prueba dentro
  // de evidencia.resolucionesPorPrueba, y actualizamos la prueba individual.
  // La tarea solo se cierra cuando TODAS las pruebas estan resueltas.
  const resolverEnBatch = async (nuevoEstatusPrueba: 'arte_aprobado' | 'rechazada'): Promise<{ tareaId: number; nuevoEstatus: string }> => {
    const evidenciaActual: Record<string, unknown> = (() => {
      if (!tarea.evidencia) return {};
      try { return JSON.parse(tarea.evidencia) as Record<string, unknown>; } catch { return {}; }
    })();
    const resoluciones: Record<string, unknown> = typeof evidenciaActual.resolucionesPorPrueba === 'object' && evidenciaActual.resolucionesPorPrueba
      ? (evidenciaActual.resolucionesPorPrueba as Record<string, unknown>)
      : {};
    resoluciones[String(pruebaIdAccion)] = {
      accion,
      comentario: (comentario || '').trim() || null,
      archivoAdjunto: archivo_adjunto || null,
      enlaceAdjunto: enlace_adjunto || null,
      resueltaPor: userNombre,
      resueltaPorId: userId,
      resueltaAt: now.toISOString(),
    };
    evidenciaActual.resolucionesPorPrueba = resoluciones;

    // Jos 2026-11-27: "reemplazar" en vez de "adjuntar" — si Diseño sube
    // archivo en la aprobacion/rechazo, ese REEMPLAZA al arte original de la
    // prueba. Asi en biblioteca_artes (RA aprobada) solo queda el archivo
    // reemplazado, no el original + el nuevo juntos (comportamiento anterior).
    const archivoReemplazo = (archivo_adjunto || '').trim();
    if (archivoReemplazo) {
      try {
        await prisma.pruebas_color.update({
          where: { id: pruebaIdAccion },
          data: { archivo: archivoReemplazo },
        });
      } catch (e) {
        console.error('[pruebasColor.resolverEnBatch] reemplazo de archivo falló:', e);
      }
    }

    // 1) Actualizar la prueba especifica (arte_aprobado o rechazada).
    // Jos 2026-11-27: diferimos los side-effects (Seguimiento, vincular
    // biblioteca, notificar) hasta que TODAS las pruebas del batch esten
    // resueltas. Asi no aparecen tareas de Seguimiento ni artes en
    // biblioteca mientras otras pruebas del mismo batch siguen pendientes.
    await actualizarEstatusPruebaColor({
      pruebaId: pruebaIdAccion,
      nuevoEstatus: nuevoEstatusPrueba,
      userId,
      userNombre,
      comentario,
      archivo_adjunto,
      enlace_adjunto,
      diferirHooks: true,
    });

    // 2) Verificar si quedan pruebas pendientes (revision_artes/solicitada).
    const pruebas = await prisma.pruebas_color.findMany({
      where: { id: { in: pruebaIdsBatch! }, deleted_at: null },
    });
    const pendientes = pruebas.filter(p => p.estatus === 'revision_artes' || p.estatus === 'solicitada');

    if (pendientes.length > 0) {
      // Aun hay pendientes: solo guardar evidencia, tarea sigue Pendiente.
      await prisma.tareas.update({
        where: { id: tareaId },
        data: { evidencia: JSON.stringify(evidenciaActual) },
      });
      return { tareaId, nuevoEstatus: `Pendiente (${pendientes.length} por resolver)` };
    }

    // Jos 2026-11-27: todas las pruebas ya están resueltas. Disparamos los
    // side-effects (cerrar Revisión, vincular RA a biblioteca, emit socket)
    // con skipTareasAgregadas=true porque las tareas Seguimiento/Prueba de
    // Color se crean AGRUPADAS por estatus al final, no 1-a-1.
    for (const p of pruebas) {
      const resPrueba = (resoluciones[String(p.id)] as Record<string, unknown> | undefined) || undefined;
      const comentarioPrueba = typeof resPrueba?.comentario === 'string' ? resPrueba.comentario as string : undefined;
      const archivoAdjPrueba = typeof resPrueba?.archivoAdjunto === 'string' ? resPrueba.archivoAdjunto as string : null;
      const enlaceAdjPrueba = typeof resPrueba?.enlaceAdjunto === 'string' ? resPrueba.enlaceAdjunto as string : null;
      try {
        await aplicarHooksEstatus(p, p.estatus as EstatusPruebaColor, {
          userId,
          userNombre,
          comentario: comentarioPrueba,
          archivo_adjunto: archivoAdjPrueba,
          enlace_adjunto: enlaceAdjPrueba,
          skipTareasAgregadas: true,
        });
      } catch (e) {
        console.error(`[pruebasColor.resolverEnBatch] hooks de prueba ${p.id} fallaron:`, e);
      }
    }

    // Jos 2026-11-27: crear las tareas AGRUPADAS por resolución.
    // - Todas aprobadas → 1 Seguimiento con los N artes.
    // - Todas rechazadas → 1 aviso Prueba de Color con los N artes.
    // - Mix → 1 Seguimiento (aprobadas) + 1 aviso (rechazadas).
    const aprobadas = pruebas.filter(p => p.estatus === 'arte_aprobado' || p.estatus === 'aprobada');
    const rechazadas = pruebas.filter(p => p.estatus === 'rechazada');
    if (aprobadas.length > 0) {
      try {
        await crearTareaSeguimientoAgrupada(aprobadas, userNombre, resoluciones);
      } catch (e) {
        console.error('[pruebasColor.resolverEnBatch] Seguimiento agrupado falló:', e);
      }
    }
    if (rechazadas.length > 0) {
      try {
        await crearTareaRechazoAgrupada(rechazadas, userNombre, userId, resoluciones);
      } catch (e) {
        console.error('[pruebasColor.resolverEnBatch] Rechazo agrupado falló:', e);
      }
    }

    // Todas resueltas: si al menos 1 rechazada -> Rechazado; si no -> Atendido.
    const algunaRechazada = pruebas.some(p => p.estatus === 'rechazada');
    const estatusFinal = algunaRechazada ? 'Rechazado' : 'Atendido';
    await prisma.tareas.update({
      where: { id: tareaId },
      data: {
        estatus: estatusFinal,
        fecha_fin: now,
        evidencia: JSON.stringify(evidenciaActual),
      },
    });
    return { tareaId, nuevoEstatus: estatusFinal };
  };

  // Jos 2026-11-27: "reemplazar" en vez de "adjuntar" — si Diseno sube
  // archivo en la aprobacion/rechazo individual, ese REEMPLAZA al arte
  // original (mismo comportamiento que en batch).
  const aplicarReemplazoSiHay = async () => {
    const archivoReemplazo = (archivo_adjunto || '').trim();
    if (!archivoReemplazo) return;
    try {
      await prisma.pruebas_color.update({
        where: { id: pruebaId },
        data: { archivo: archivoReemplazo },
      });
    } catch (e) {
      console.error('[pruebasColor.resolverTareaAsociada] reemplazo de archivo falló:', e);
    }
  };

  if (accion === 'aprobar' && tarea.tipo === 'Revisión de artes') {
    if (esBatch) return resolverEnBatch('arte_aprobado');
    // Flujo individual (hoy): marcar la tarea Atendido y transicionar la
    // prueba al estado arte_aprobado (que a su vez crea tarea Seguimiento).
    const evidenciaNueva = buildEvidenciaConComentario();
    await prisma.tareas.update({
      where: { id: tareaId },
      data: {
        estatus: 'Atendido',
        fecha_fin: now,
        ...(evidenciaNueva ? { evidencia: evidenciaNueva } : {}),
      },
    });
    await aplicarReemplazoSiHay();
    await actualizarEstatusPruebaColor({
      pruebaId,
      nuevoEstatus: 'arte_aprobado',
      userId,
      userNombre,
      comentario,
      // Jos 2026-10-29: en Revision Anticipada la aprobacion tambien lleva
      // motivo + archivo + enlace (modal igual al rechazo). Se propagan al
      // historial y a la tarea Seguimiento para que el analista los vea.
      archivo_adjunto,
      enlace_adjunto,
    });
    return { tareaId, nuevoEstatus: 'Atendido' };
  }

  if (accion === 'rechazar' && tarea.tipo === 'Revisión de artes') {
    if (esBatch) return resolverEnBatch('rechazada');
    const evidenciaNueva = buildEvidenciaConComentario();
    await prisma.tareas.update({
      where: { id: tareaId },
      data: {
        estatus: 'Rechazado',
        fecha_fin: now,
        ...(evidenciaNueva ? { evidencia: evidenciaNueva } : {}),
      },
    });
    await aplicarReemplazoSiHay();
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
  // Jos 2026-11-27: la tarea puede ser individual (pruebaColorId) o batch
  // (pruebaColorIds: array). En batch aprobamos TODAS las pruebas del grupo.
  let pruebaIds: number[] = [];
  try {
    const c = JSON.parse(tarea.contenido);
    if (c.origen !== 'prueba_color_seguimiento') return null;
    if (Array.isArray(c.pruebaColorIds)) {
      pruebaIds = (c.pruebaColorIds as unknown[])
        .map(v => Number(v))
        .filter(n => Number.isFinite(n) && n > 0);
    } else {
      const pid = Number(c.pruebaColorId);
      if (Number.isFinite(pid) && pid > 0) pruebaIds = [pid];
    }
    if (pruebaIds.length === 0) return null;
  } catch {
    return null;
  }

  let ultimoActualizado: number | null = null;
  for (const pid of pruebaIds) {
    const prueba = await prisma.pruebas_color.findFirst({
      where: { id: pid, deleted_at: null },
    });
    if (!prueba) continue;
    if (prueba.estatus === 'aprobada' || prueba.estatus === 'rechazada') continue;
    try {
      await actualizarEstatusPruebaColor({
        pruebaId: pid,
        nuevoEstatus: 'aprobada',
        userId,
        userNombre,
      });
      ultimoActualizado = pid;
    } catch (e) {
      console.error(`[pruebasColor.onFinalizarTareaSeguimiento] no se pudo aprobar prueba #${pid}:`, e);
    }
  }
  return ultimoActualizado;
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

/**
 * Jos 2026-10-29: cuando se aprueba una Revision Anticipada, el arte entra
 * a la biblioteca_artes de la campania (tab Aprobados en el Gestor de Artes
 * de Campaña) para que el analista pueda seleccionarlo sin volver a pasar
 * por revision de artes. Mismo patron INSERT ... ON DUPLICATE KEY UPDATE
 * que usa campanas.controller.handleUploadArt. Las Pruebas de Color NO
 * vinculan — solo RA.
 *
 * biblioteca_artes.archivo es NOT NULL + UNIQUE(campania_id, archivo), asi
 * que si la prueba solo tiene link (enlace_externo) sin archivo subido,
 * usamos el link como "archivo" para preservar el flujo. El tab Aprobados
 * del front ya maneja URLs externas.
 *
 * Jos 2026-11-24: cuando Diseño respondió con archivo/enlace en el comentario
 * de aprobación de la Revisión, ESE es el arte que entra a biblioteca_artes
 * (no el archivo original del asesor). Las URLs del enlace de aprobación
 * también se integran como filas adicionales. Si no hay adjuntos de Diseño,
 * fallback al comportamiento viejo (prueba.archivo o prueba.enlace_externo).
 */
async function vincularArteAprobadoABibliotecaCampania(
  prueba: {
    id: number;
    campania_id: number | null;
    archivo: string;
    enlace_externo: string | null;
    nombre_arte: string | null;
    created_by: number | null;
  },
  override?: { archivo_adjunto?: string | null; enlace_adjunto?: string | null },
) {
  if (!prueba.campania_id) return;
  const archivosAVincular: string[] = [];
  const archivoAdj = (override?.archivo_adjunto || '').trim();
  const enlaceAdj = (override?.enlace_adjunto || '').trim();
  if (archivoAdj || enlaceAdj) {
    // Prioridad al adjunto que respondió Diseño en el comentario de aprobación.
    if (archivoAdj) archivosAVincular.push(archivoAdj);
    if (enlaceAdj) archivosAVincular.push(enlaceAdj);
  } else {
    // Fallback legacy: archivo o enlace original de la prueba.
    const fallback = (prueba.archivo && prueba.archivo.trim()) || (prueba.enlace_externo && prueba.enlace_externo.trim()) || null;
    if (fallback) archivosAVincular.push(fallback);
  }
  if (archivosAVincular.length === 0) return;
  // tipo 'tradicional' por default; si el archivo trae indicio digital
  // (JPG/PNG/MP4 marcados por path), el back ya los diferencia. Para RA
  // asumimos tradicional porque es el flujo documentado de la brochita.
  const nombreArte = (prueba.nombre_arte && prueba.nombre_arte.trim()) || null;
  for (const archivo of archivosAVincular) {
    await prisma.$executeRawUnsafe(`
      INSERT INTO biblioteca_artes (campania_id, archivo, tipo, nombre_arte, nota, estatus_operaciones, nombre_generico, created_by_id)
      VALUES (?, ?, 'tradicional', ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        nombre_arte = COALESCE(VALUES(nombre_arte), nombre_arte),
        nota = COALESCE(VALUES(nota), nota)
    `, prueba.campania_id, archivo, nombreArte, `Aprobado desde Revisión Anticipada #${prueba.id}`, null, null, prueba.created_by || null);
  }
  console.log(`[pruebasColor.vincularArteAprobadoABibliotecaCampania] RA #${prueba.id} -> biblioteca_artes campania=${prueba.campania_id} archivos=${archivosAVincular.join(' | ')}`);
}

/**
 * Jos 2026-11-24: lee los adjuntos (archivo/enlace) que Diseño respondió en
 * la aprobación de la última tarea de "Revisión de artes" de esta prueba.
 * Se usa en el hook `aprobada` para mantener consistencia con lo vinculado
 * en el hook `arte_aprobado` cuando el analista finaliza Seguimiento.
 */
async function leerAdjuntosDeUltimaRevisionAprobada(pruebaId: number): Promise<{ archivo_adjunto: string | null; enlace_adjunto: string | null }> {
  type Row = { evidencia: string | null };
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT evidencia FROM tareas
     WHERE tipo = 'Revisión de artes'
       AND estatus = 'Atendido'
       AND JSON_EXTRACT(contenido, '$.pruebaColorId') = ?
     ORDER BY id DESC
     LIMIT 1`,
    pruebaId,
  );
  const evidenciaRaw = rows && rows[0]?.evidencia;
  if (!evidenciaRaw) return { archivo_adjunto: null, enlace_adjunto: null };
  try {
    const obj = JSON.parse(evidenciaRaw);
    const archivo = typeof obj?.archivoAdjunto === 'string' ? obj.archivoAdjunto : null;
    const enlace = typeof obj?.enlaceAdjunto === 'string' ? obj.enlaceAdjunto : null;
    return { archivo_adjunto: archivo, enlace_adjunto: enlace };
  } catch {
    return { archivo_adjunto: null, enlace_adjunto: null };
  }
}
