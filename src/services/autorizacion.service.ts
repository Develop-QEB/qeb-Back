import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: { rejectUnauthorized: false },
});

// Plazas principales - todo lo demás es "OTRAS"
const PLAZAS_PRINCIPALES = ['CIUDAD DE MEXICO', 'GUADALAJARA', 'MONTERREY'];

// Formatos que requieren autorización
const FORMATOS_CON_CRITERIOS = ['PARABUS', 'COLUMNA'];

export interface CaraData {
  ciudad?: string | null;
  estado?: string | null;  // Estado para determinar la plaza
  formato?: string;
  tipo?: string | null;
  caras: number;
  bonificacion?: number | null;
  costo: number;
  tarifa_publica?: number;
}

export interface EstadoAutorizacionResult {
  autorizacion_dg: 'aprobado' | 'pendiente' | 'rechazado';
  autorizacion_dcm: 'aprobado' | 'pendiente' | 'rechazado';
  motivo_dg?: string;
  motivo_dcm?: string;
  tarifa_efectiva?: number;
  total_caras?: number;
}

/**
 * Quita acentos de un string para comparaciones
 */
function quitarAcentos(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normaliza el nombre de la plaza para buscar en criterios
 * Para Ciudad de México usa el estado (porque las ciudades son alcaldías)
 * Para las demás plazas usa la ciudad directamente
 */
function normalizarPlaza(ciudad: string | null | undefined, estado: string | null | undefined): string {
  // Caso especial: Ciudad de México - verificar por estado
  // porque las ciudades son alcaldías (Álvaro Obregón, Azcapotzalco, etc.)
  if (estado) {
    const estadoNorm = quitarAcentos(estado.toUpperCase().trim());
    console.log('[normalizarPlaza] Estado normalizado:', estadoNorm);
    if (estadoNorm.includes('CIUDAD DE MEXICO') || estadoNorm.includes('CDMX') ||
        estadoNorm === 'DISTRITO FEDERAL' || estadoNorm === 'DF') {
      return 'CIUDAD DE MEXICO';
    }
  }

  // Para las demás plazas, usar ciudad
  if (!ciudad) return 'OTRAS';
  const ciudadNorm = quitarAcentos(ciudad.toUpperCase().trim());

  // Verificar si es una plaza principal
  for (const plaza of PLAZAS_PRINCIPALES) {
    if (ciudadNorm.includes(plaza) || plaza.includes(ciudadNorm)) {
      return plaza;
    }
  }

  // Casos especiales por ciudad
  if (ciudadNorm.includes('CDMX') || ciudadNorm.includes('MEXICO')) {
    return 'CIUDAD DE MEXICO';
  }
  if (ciudadNorm.includes('GDL')) {
    return 'GUADALAJARA';
  }
  if (ciudadNorm.includes('MTY')) {
    return 'MONTERREY';
  }

  return 'OTRAS';
}

/**
 * Normaliza el formato para buscar en criterios
 */
function normalizarFormato(formato: string | null | undefined): string | null {
  if (!formato) return null;
  const formatoUpper = formato.toUpperCase().trim();

  // Buscar el formato que coincida
  for (const f of FORMATOS_CON_CRITERIOS) {
    if (formatoUpper.includes(f)) {
      return f;
    }
  }

  return null; // No tiene criterios definidos
}

/**
 * Normaliza el tipo (Tradicional/Digital)
 */
function normalizarTipo(tipo: string | null | undefined): string {
  if (!tipo) return 'Tradicional';
  const tipoUpper = tipo.toUpperCase().trim();

  if (tipoUpper.includes('DIGITAL') || tipoUpper.includes('DIG')) {
    return 'Digital';
  }

  return 'Tradicional';
}

/**
 * Calcula el estado de autorización de una cara
 * Ahora retorna dos estados independientes: autorizacion_dg y autorizacion_dcm
 */
export async function calcularEstadoAutorizacion(cara: CaraData): Promise<EstadoAutorizacionResult> {
  console.log('[calcularEstadoAutorizacion] Datos recibidos:', {
    ciudad: cara.ciudad,
    estado: cara.estado,
    formato: cara.formato,
    tipo: cara.tipo,
    caras: cara.caras,
    bonificacion: cara.bonificacion,
    costo: cara.costo,
    tarifa_publica: cara.tarifa_publica
  });

  // Calcular tarifa efectiva y total caras
  const totalCaras = cara.caras + (Number(cara.bonificacion) || 0);
  const tarifaEfectiva = totalCaras > 0 ? cara.costo / totalCaras : 0;

  console.log('[calcularEstadoAutorizacion] Valores calculados:', {
    totalCaras,
    tarifaEfectiva
  });

  // Normalizar datos para búsqueda
  const formatoNormalizado = normalizarFormato(cara.formato);

  // Si el formato no tiene criterios definidos, aprobar automáticamente ambos
  if (!formatoNormalizado) {
    return {
      autorizacion_dg: 'aprobado',
      autorizacion_dcm: 'aprobado',
      tarifa_efectiva: tarifaEfectiva,
      total_caras: totalCaras
    };
  }

  const plazaNormalizada = normalizarPlaza(cara.ciudad, cara.estado);
  const tipoNormalizado = normalizarTipo(cara.tipo);

  console.log('[calcularEstadoAutorizacion] Buscando criterio con:', {
    formatoNormalizado,
    tipoNormalizado,
    plazaNormalizada
  });

  // Buscar criterio en la base de datos
  const criterio = await prisma.criterios_autorizacion.findFirst({
    where: {
      formato: formatoNormalizado,
      tipo: tipoNormalizado,
      plaza: plazaNormalizada,
      activo: true
    }
  });

  console.log('[calcularEstadoAutorizacion] Criterio encontrado:', criterio);

  // Si no hay criterio definido, aprobar automáticamente ambos
  if (!criterio) {
    console.log('[calcularEstadoAutorizacion] No hay criterio, aprobando automáticamente');
    return {
      autorizacion_dg: 'aprobado',
      autorizacion_dcm: 'aprobado',
      tarifa_efectiva: tarifaEfectiva,
      total_caras: totalCaras
    };
  }

  // Evaluar si requiere DG
  let requiereDg = false;
  let motivoDg = '';

  const tarifaMaxDg = criterio.tarifa_max_dg ? Number(criterio.tarifa_max_dg) : null;
  const carasMaxDg = criterio.caras_max_dg;

  console.log('[calcularEstadoAutorizacion] Evaluando DG:', {
    tarifaMaxDg,
    carasMaxDg,
    tarifaEfectiva,
    totalCaras,
    tarifaCheck: tarifaMaxDg !== null ? `${tarifaEfectiva} <= ${tarifaMaxDg} = ${tarifaEfectiva <= tarifaMaxDg}` : 'N/A',
    carasCheck: carasMaxDg !== null ? `${totalCaras} <= ${carasMaxDg} = ${totalCaras <= carasMaxDg}` : 'N/A'
  });

  if (tarifaMaxDg !== null && tarifaEfectiva <= tarifaMaxDg) {
    requiereDg = true;
    motivoDg = `Tarifa efectiva $${tarifaEfectiva.toFixed(2)} <= $${tarifaMaxDg} (límite DG)`;
  }
  if (carasMaxDg !== null && totalCaras <= carasMaxDg) {
    requiereDg = true;
    if (motivoDg) motivoDg += '; ';
    motivoDg += `Total caras ${totalCaras} <= ${carasMaxDg} (límite DG)`;
  }

  // Evaluar si requiere DCM
  let requiereDcm = false;
  let motivoDcm = '';

  const tarifaMinDcm = criterio.tarifa_min_dcm ? Number(criterio.tarifa_min_dcm) : null;
  const tarifaMaxDcm = criterio.tarifa_max_dcm ? Number(criterio.tarifa_max_dcm) : null;
  const carasMinDcm = criterio.caras_min_dcm;
  const carasMaxDcm = criterio.caras_max_dcm;

  console.log('[calcularEstadoAutorizacion] Evaluando DCM:', {
    tarifaMinDcm,
    tarifaMaxDcm,
    carasMinDcm,
    carasMaxDcm,
    tarifaCheck: tarifaMinDcm !== null && tarifaMaxDcm !== null
      ? `${tarifaEfectiva} >= ${tarifaMinDcm} && ${tarifaEfectiva} <= ${tarifaMaxDcm} = ${tarifaEfectiva >= tarifaMinDcm && tarifaEfectiva <= tarifaMaxDcm}`
      : 'N/A',
    carasCheck: carasMinDcm !== null && carasMaxDcm !== null
      ? `${totalCaras} >= ${carasMinDcm} && ${totalCaras} <= ${carasMaxDcm} = ${totalCaras >= carasMinDcm && totalCaras <= carasMaxDcm}`
      : 'N/A'
  });

  if (tarifaMinDcm !== null && tarifaMaxDcm !== null &&
      tarifaEfectiva >= tarifaMinDcm && tarifaEfectiva <= tarifaMaxDcm) {
    requiereDcm = true;
    motivoDcm = `Tarifa efectiva $${tarifaEfectiva.toFixed(2)} en rango DCM ($${tarifaMinDcm}-$${tarifaMaxDcm})`;
  }
  if (carasMinDcm !== null && carasMaxDcm !== null &&
      totalCaras >= carasMinDcm && totalCaras <= carasMaxDcm) {
    requiereDcm = true;
    if (motivoDcm) motivoDcm += '; ';
    motivoDcm += `Total caras ${totalCaras} en rango DCM (${carasMinDcm}-${carasMaxDcm})`;
  }

  const resultado = {
    autorizacion_dg: requiereDg ? 'pendiente' : 'aprobado',
    autorizacion_dcm: requiereDcm ? 'pendiente' : 'aprobado',
    motivo_dg: motivoDg || undefined,
    motivo_dcm: motivoDcm || undefined,
    tarifa_efectiva: tarifaEfectiva,
    total_caras: totalCaras
  };

  console.log('[calcularEstadoAutorizacion] Resultado final:', resultado);

  return resultado as EstadoAutorizacionResult;
}

/**
 * Verifica si una solicitud tiene caras pendientes de autorización
 * Ahora verifica ambas columnas: autorizacion_dg y autorizacion_dcm
 */
export async function verificarCarasPendientes(idquote: string): Promise<{
  tienePendientes: boolean;
  pendientesDg: number[];
  pendientesDcm: number[];
}> {
  console.log('[verificarCarasPendientes] Buscando caras con idquote:', idquote);

  const caras = await prisma.solicitudCaras.findMany({
    where: { idquote },
    select: { id: true, autorizacion_dg: true, autorizacion_dcm: true }
  });

  console.log('[verificarCarasPendientes] Caras encontradas:', caras);

  // Caras que tienen DG pendiente
  const pendientesDg = caras
    .filter(c => c.autorizacion_dg === 'pendiente')
    .map(c => c.id);

  // Caras que tienen DCM pendiente
  const pendientesDcm = caras
    .filter(c => c.autorizacion_dcm === 'pendiente')
    .map(c => c.id);

  return {
    tienePendientes: pendientesDg.length > 0 || pendientesDcm.length > 0,
    pendientesDg,
    pendientesDcm
  };
}

/**
 * Crea tareas de autorización para DG y/o DCM
 */
export async function crearTareasAutorizacion(
  solicitudId: number,
  propuestaId: number | null,
  responsableId: number,
  responsableNombre: string,
  pendientesDg: number[],
  pendientesDcm: number[]
): Promise<void> {
  console.log('[crearTareasAutorizacion] Iniciando con:', {
    solicitudId,
    propuestaId,
    pendientesDg,
    pendientesDcm
  });

  // Obtener usuarios DG y DCM
  const usuariosDg = await prisma.usuario.findMany({
    where: {
      puesto: { contains: 'DG' },
      deleted_at: null
    },
    select: { id: true, nombre: true, correo_electronico: true }
  });

  const usuariosDcm = await prisma.usuario.findMany({
    where: {
      puesto: { contains: 'DCM' },
      deleted_at: null
    },
    select: { id: true, nombre: true }
  });

  console.log('[crearTareasAutorizacion] Usuarios encontrados:', {
    usuariosDg,
    usuariosDcm
  });

  const fechaFin = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  fechaFin.setDate(fechaFin.getDate() + 7); // 7 días para aprobar

  // Verificar si ya existen tareas pendientes para evitar duplicados
  const tareasExistentes = await prisma.tareas.findMany({
    where: {
      id_solicitud: solicitudId.toString(),
      tipo: { contains: 'Autorización' },
      estatus: 'Pendiente'
    },
    select: { tipo: true }
  });

  const existeTareaDg = tareasExistentes.some(t => t.tipo === 'Autorización DG');
  const existeTareaDcm = tareasExistentes.some(t => t.tipo === 'Autorización DCM');

  // Crear tarea para DG si hay pendientes y no existe ya una tarea
  if (pendientesDg.length > 0 && usuariosDg.length > 0 && !existeTareaDg) {
    const tareaDg = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DG',
        titulo: `Autorización requerida - Solicitud #${solicitudId}`,
        descripcion: `Se requiere autorización de Dirección General para ${pendientesDg.length} cara(s) de la solicitud #${solicitudId}`,
        estatus: 'Pendiente',
        id_responsable: responsableId,
        responsable: responsableNombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        id_asignado: usuariosDg.map(u => u.id).join(','),
        asignado: usuariosDg.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación y tarea creada via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDg.id,
      tipo: 'Autorización DG',
      solicitudId
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: tareaDg.id,
      tipo: 'Autorización DG',
      solicitudId
    });

    // Enviar correo a usuarios DG
    for (const usuario of usuariosDg) {
      if (usuario.correo_electronico) {
        enviarCorreoAutorizacion(
          tareaDg.id,
          `Autorización requerida - Solicitud #${solicitudId}`,
          `Se requiere autorización de Dirección General para ${pendientesDg.length} cara(s) de la solicitud #${solicitudId}`,
          usuario.correo_electronico,
          usuario.nombre,
          responsableNombre
        ).catch(err => console.error('Error enviando correo autorización DG:', err));
      }
    }
  }

  // Crear tarea para DCM si hay pendientes y no existe ya una tarea
  if (pendientesDcm.length > 0 && usuariosDcm.length > 0 && !existeTareaDcm) {
    const tareaDcm = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DCM',
        titulo: `Autorización requerida - Solicitud #${solicitudId}`,
        descripcion: `Se requiere autorización de Dirección Comercial para ${pendientesDcm.length} cara(s) de la solicitud #${solicitudId}`,
        estatus: 'Pendiente',
        id_responsable: responsableId,
        responsable: responsableNombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        id_asignado: usuariosDcm.map(u => u.id).join(','),
        asignado: usuariosDcm.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación y tarea creada via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDcm.id,
      tipo: 'Autorización DCM',
      solicitudId
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: tareaDcm.id,
      tipo: 'Autorización DCM',
      solicitudId
    });
  }
}

/**
 * Aprueba las caras pendientes de un tipo específico
 * Ahora actualiza la columna correspondiente: autorizacion_dg o autorizacion_dcm
 */
export async function aprobarCaras(
  idquote: string,
  tipoAutorizacion: 'dg' | 'dcm',
  aprobadorId: number,
  aprobadorNombre: string
): Promise<{ carasAprobadas: number }> {
  const columna = tipoAutorizacion === 'dg' ? 'autorizacion_dg' : 'autorizacion_dcm';

  // Actualizar caras pendientes a aprobado en la columna correspondiente
  const result = await prisma.solicitudCaras.updateMany({
    where: {
      idquote,
      [columna]: 'pendiente'
    },
    data: {
      [columna]: 'aprobado'
    }
  });

  // Verificar si quedan pendientes
  const { tienePendientes, pendientesDg, pendientesDcm } = await verificarCarasPendientes(idquote);

  // El idquote es el ID de propuesta, usarlo para buscar tareas
  const propuestaId = idquote;

  // Si ya no hay pendientes de ningún tipo, marcar TODAS las tareas de autorización como atendidas
  if (!tienePendientes) {
    await prisma.tareas.updateMany({
      where: {
        id_propuesta: propuestaId,
        tipo: { contains: 'Autorización' },
        estatus: 'Pendiente'
      },
      data: {
        estatus: 'Atendido'
      }
    });
  } else {
    // Marcar solo la tarea del tipo específico como atendida SI ya no hay pendientes de ese tipo
    const tipoTarea = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';
    const pendientesDelTipo = tipoAutorizacion === 'dg' ? pendientesDg : pendientesDcm;

    // Solo marcar como atendida si ya no hay más pendientes de este tipo
    if (pendientesDelTipo.length === 0) {
      await prisma.tareas.updateMany({
        where: {
          id_propuesta: propuestaId,
          tipo: tipoTarea,
          estatus: 'Pendiente'
        },
        data: {
          estatus: 'Atendido'
        }
      });
    }
  }

  // Crear notificación de aprobación para el creador de la solicitud
  const propuesta = await prisma.propuesta.findFirst({
    where: { id: parseInt(propuestaId) },
    select: { solicitud_id: true }
  });

  if (propuesta) {
    const solicitud = await prisma.solicitud.findUnique({
      where: { id: propuesta.solicitud_id },
      select: { usuario_id: true, nombre_usuario: true }
    });

    if (solicitud?.usuario_id) {
      const tipoLabel = tipoAutorizacion === 'dg' ? 'Dirección General' : 'Dirección Comercial';
      const notifAprobacion = await prisma.tareas.create({
        data: {
          tipo: `Aprobación ${tipoAutorizacion.toUpperCase()}`,
          titulo: `Solicitud #${propuesta.solicitud_id} - Aprobación ${tipoAutorizacion.toUpperCase()}`,
          descripcion: `${result.count} cara(s) de tu solicitud han sido aprobadas por ${tipoLabel} (${aprobadorNombre}).`,
          estatus: 'Pendiente',
          id_responsable: solicitud.usuario_id,
          responsable: solicitud.nombre_usuario || '',
          id_solicitud: propuesta.solicitud_id.toString(),
          id_propuesta: propuestaId,
          id_asignado: solicitud.usuario_id.toString(),
          asignado: solicitud.nombre_usuario || '',
          fecha_inicio: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
          fecha_fin: (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); d.setDate(d.getDate() + 7); return d; })(),
        }
      });

      // Emitir notificación via WebSocket
      emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
        tareaId: notifAprobacion.id,
        tipo: `Aprobación ${tipoAutorizacion.toUpperCase()}`,
        solicitudId: propuesta.solicitud_id
      });
      emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
        tareaId: notifAprobacion.id,
        tipo: `Aprobación ${tipoAutorizacion.toUpperCase()}`,
        solicitudId: propuesta.solicitud_id
      });
    }
  }

  return { carasAprobadas: result.count };
}

/**
 * Rechaza las caras de una solicitud para un tipo específico de autorización
 * Solo marca la columna correspondiente como rechazada (autorizacion_dg o autorizacion_dcm)
 */
export async function rechazarSolicitud(
  idquote: string,
  solicitudId: number,
  rechazadorId: number,
  rechazadorNombre: string,
  comentario: string,
  tipoAutorizacion: 'dg' | 'dcm'
): Promise<void> {
  const columna = tipoAutorizacion === 'dg' ? 'autorizacion_dg' : 'autorizacion_dcm';

  // Marcar solo las caras con autorización pendiente del tipo correspondiente como rechazadas
  // NO cambiamos el status de la solicitud, solo de las caras
  await prisma.solicitudCaras.updateMany({
    where: {
      idquote,
      [columna]: 'pendiente'
    },
    data: {
      [columna]: 'rechazado'
    }
  });

  // Marcar solo la tarea del tipo específico como atendida
  const tipoTarea = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';
  await prisma.tareas.updateMany({
    where: {
      id_solicitud: solicitudId.toString(),
      tipo: tipoTarea,
      estatus: 'Pendiente'
    },
    data: {
      estatus: 'Atendido'
    }
  });

  // Crear notificación para el creador de la solicitud
  const tipoLabel = tipoAutorizacion === 'dg' ? 'Dirección General' : 'Dirección Comercial';
  const solicitud = await prisma.solicitud.findUnique({
    where: { id: solicitudId },
    select: { usuario_id: true, nombre_usuario: true }
  });

  if (solicitud?.usuario_id) {
    const notifRechazo = await prisma.tareas.create({
      data: {
        tipo: `Rechazo ${tipoAutorizacion.toUpperCase()}`,
        titulo: `Solicitud #${solicitudId} - Rechazo ${tipoAutorizacion.toUpperCase()}`,
        descripcion: `Tu solicitud ha sido rechazada por ${tipoLabel} (${rechazadorNombre}). Motivo: ${comentario}. Haz clic para editar la solicitud y corregir las caras.`,
        estatus: 'Pendiente',
        id_responsable: solicitud.usuario_id,
        responsable: solicitud.nombre_usuario || '',
        id_solicitud: solicitudId.toString(),
        id_asignado: solicitud.usuario_id.toString(),
        asignado: solicitud.nombre_usuario || '',
        fecha_inicio: new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
        fecha_fin: (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })); d.setDate(d.getDate() + 7); return d; })(),
      }
    });

    // Emitir notificación via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: notifRechazo.id,
      tipo: 'Rechazo Autorización',
      solicitudId
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: notifRechazo.id,
      tipo: 'Rechazo Autorización',
      solicitudId
    });
  }
}

/**
 * Obtiene el resumen de autorización de una solicitud
 * Ahora verifica ambas columnas: autorizacion_dg y autorizacion_dcm
 */
export async function obtenerResumenAutorizacion(idquote: string): Promise<{
  totalCaras: number;
  aprobadas: number;
  pendientesDg: number;
  pendientesDcm: number;
  rechazadas: number;
  puedeContinuar: boolean;
}> {
  const caras = await prisma.solicitudCaras.findMany({
    where: { idquote },
    select: { autorizacion_dg: true, autorizacion_dcm: true }
  });

  // Una cara está completamente aprobada si ambas autorizaciones están aprobadas
  const aprobadas = caras.filter(c =>
    c.autorizacion_dg === 'aprobado' && c.autorizacion_dcm === 'aprobado'
  ).length;

  // Caras con DG pendiente
  const pendientesDg = caras.filter(c => c.autorizacion_dg === 'pendiente').length;

  // Caras con DCM pendiente
  const pendientesDcm = caras.filter(c => c.autorizacion_dcm === 'pendiente').length;

  // Una cara está rechazada si cualquiera de las dos está rechazada
  const rechazadas = caras.filter(c =>
    c.autorizacion_dg === 'rechazado' || c.autorizacion_dcm === 'rechazado'
  ).length;

  const conteo = {
    totalCaras: caras.length,
    aprobadas,
    pendientesDg,
    pendientesDcm,
    rechazadas,
    puedeContinuar: pendientesDg === 0 && pendientesDcm === 0 && rechazadas === 0
  };

  return conteo;
}

async function enviarCorreoAutorizacion(
  tareaId: number,
  titulo: string,
  descripcion: string,
  destinatarioEmail: string,
  destinatarioNombre: string,
  solicitadoPor: string
): Promise<void> {
  const htmlBody = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
      <tr>
        <td align="center">
          <table width="500" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <tr>
              <td style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 32px 40px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">QEB</h1>
                <p style="color: rgba(255,255,255,0.85); margin: 6px 0 0 0; font-size: 13px; font-weight: 500;">OOH Management</p>
              </td>
            </tr>
            <tr>
              <td style="padding: 40px;">
                <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Autorización Requerida</h2>
                <p style="color: #6b7280; margin: 0 0 12px 0; font-size: 15px; line-height: 1.5;">
                  Hola <strong style="color: #374151;">${destinatarioNombre}</strong>, se requiere tu autorización.
                </p>
                <div style="background-color: #f5f3ff; border-left: 4px solid #8b5cf6; padding: 14px 16px; border-radius: 0 8px 8px 0; margin: 0 0 24px 0;">
                  <p style="color: #6b7280; margin: 0 0 4px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Detalle</p>
                  <p style="color: #1f2937; margin: 0; font-size: 16px; font-weight: 600;">${descripcion}</p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 28px;">
                  <tr>
                    <td style="padding: 12px 0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="24" valign="top">
                            <div style="width: 20px; height: 20px; background-color: #ede9fe; border-radius: 6px; text-align: center; line-height: 20px; font-size: 12px;">👤</div>
                          </td>
                          <td style="padding-left: 12px;">
                            <p style="color: #9ca3af; margin: 0; font-size: 12px; font-weight: 500; text-transform: uppercase;">Solicitado por</p>
                            <p style="color: #374151; margin: 2px 0 0 0; font-size: 14px; font-weight: 500;">${solicitadoPor}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="https://app.qeb.mx/tareas?viewId=${tareaId}" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Tarea</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background-color: #1f2937; padding: 24px 40px; text-align: center;">
                <p style="color: #9ca3af; font-size: 12px; margin: 0;">Mensaje automático del sistema QEB.</p>
                <p style="color: #6b7280; font-size: 11px; margin: 8px 0 0 0;">© ${new Date().getFullYear()} QEB OOH Management</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  await transporter.sendMail({
    from: `"QEB Sistema" <${process.env.SMTP_USER}>`,
    to: destinatarioEmail,
    subject: `🔔 ${titulo}`,
    html: htmlBody,
  });
}

export default {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion,
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion
};
