import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';

// Plazas principales - todo lo demás es "OTRAS"
const PLAZAS_PRINCIPALES = ['CIUDAD DE MEXICO', 'GUADALAJARA', 'MONTERREY'];

// Formatos que requieren autorización
const FORMATOS_CON_CRITERIOS = ['PARABUS', 'COLUMNA'];

export interface CaraData {
  ciudad?: string | null;
  formato?: string;
  tipo?: string | null;
  caras: number;
  bonificacion?: number | null;
  costo: number;
  tarifa_publica?: number;
}

export interface EstadoAutorizacionResult {
  estado: 'aprobado' | 'pendiente_dcm' | 'pendiente_dg';
  motivo?: string;
  tarifa_efectiva?: number;
  total_caras?: number;
}

/**
 * Normaliza el nombre de la plaza para buscar en criterios
 */
function normalizarPlaza(ciudad: string | null | undefined): string {
  if (!ciudad) return 'OTRAS';
  const ciudadUpper = ciudad.toUpperCase().trim();

  // Verificar si es una plaza principal
  for (const plaza of PLAZAS_PRINCIPALES) {
    if (ciudadUpper.includes(plaza) || plaza.includes(ciudadUpper)) {
      return plaza;
    }
  }

  // Casos especiales
  if (ciudadUpper.includes('CDMX') || ciudadUpper.includes('MEXICO')) {
    return 'CIUDAD DE MEXICO';
  }
  if (ciudadUpper.includes('GDL')) {
    return 'GUADALAJARA';
  }
  if (ciudadUpper.includes('MTY')) {
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
 */
export async function calcularEstadoAutorizacion(cara: CaraData): Promise<EstadoAutorizacionResult> {
  // Calcular tarifa efectiva y total caras
  const totalCaras = cara.caras + (Number(cara.bonificacion) || 0);
  const tarifaEfectiva = totalCaras > 0 ? cara.costo / totalCaras : 0;

  // Normalizar datos para búsqueda
  const formatoNormalizado = normalizarFormato(cara.formato);

  // Si el formato no tiene criterios definidos, aprobar automáticamente
  if (!formatoNormalizado) {
    return {
      estado: 'aprobado',
      motivo: 'Formato sin criterios de autorización',
      tarifa_efectiva: tarifaEfectiva,
      total_caras: totalCaras
    };
  }

  const plazaNormalizada = normalizarPlaza(cara.ciudad);
  const tipoNormalizado = normalizarTipo(cara.tipo);

  // Buscar criterio en la base de datos
  const criterio = await prisma.criterios_autorizacion.findFirst({
    where: {
      formato: formatoNormalizado,
      tipo: tipoNormalizado,
      plaza: plazaNormalizada,
      activo: true
    }
  });

  // Si no hay criterio definido, aprobar automáticamente
  if (!criterio) {
    return {
      estado: 'aprobado',
      motivo: 'Sin criterio de autorización configurado',
      tarifa_efectiva: tarifaEfectiva,
      total_caras: totalCaras
    };
  }

  // Evaluar por TARIFA EFECTIVA
  let estadoPorTarifa: 'aprobado' | 'pendiente_dcm' | 'pendiente_dg' = 'aprobado';
  let motivoTarifa = '';

  const tarifaMaxDg = criterio.tarifa_max_dg ? Number(criterio.tarifa_max_dg) : null;
  const tarifaMinDcm = criterio.tarifa_min_dcm ? Number(criterio.tarifa_min_dcm) : null;
  const tarifaMaxDcm = criterio.tarifa_max_dcm ? Number(criterio.tarifa_max_dcm) : null;

  if (tarifaMaxDg !== null && tarifaEfectiva <= tarifaMaxDg) {
    estadoPorTarifa = 'pendiente_dg';
    motivoTarifa = `Tarifa efectiva $${tarifaEfectiva.toFixed(2)} <= $${tarifaMaxDg} (límite DG)`;
  } else if (tarifaMinDcm !== null && tarifaMaxDcm !== null &&
             tarifaEfectiva >= tarifaMinDcm && tarifaEfectiva <= tarifaMaxDcm) {
    estadoPorTarifa = 'pendiente_dcm';
    motivoTarifa = `Tarifa efectiva $${tarifaEfectiva.toFixed(2)} en rango DCM ($${tarifaMinDcm}-$${tarifaMaxDcm})`;
  }

  // Evaluar por NÚMERO DE CARAS
  let estadoPorCaras: 'aprobado' | 'pendiente_dcm' | 'pendiente_dg' = 'aprobado';
  let motivoCaras = '';

  const carasMaxDg = criterio.caras_max_dg;
  const carasMinDcm = criterio.caras_min_dcm;
  const carasMaxDcm = criterio.caras_max_dcm;

  if (carasMaxDg !== null && totalCaras <= carasMaxDg) {
    estadoPorCaras = 'pendiente_dg';
    motivoCaras = `Total caras ${totalCaras} <= ${carasMaxDg} (límite DG)`;
  } else if (carasMinDcm !== null && carasMaxDcm !== null &&
             totalCaras >= carasMinDcm && totalCaras <= carasMaxDcm) {
    estadoPorCaras = 'pendiente_dcm';
    motivoCaras = `Total caras ${totalCaras} en rango DCM (${carasMinDcm}-${carasMaxDcm})`;
  }

  // Determinar estado final (el más restrictivo gana)
  // DG es más restrictivo que DCM
  let estadoFinal: 'aprobado' | 'pendiente_dcm' | 'pendiente_dg' = 'aprobado';
  let motivoFinal = '';

  if (estadoPorTarifa === 'pendiente_dg' || estadoPorCaras === 'pendiente_dg') {
    estadoFinal = 'pendiente_dg';
    motivoFinal = [motivoTarifa, motivoCaras].filter(Boolean).join('; ');
  } else if (estadoPorTarifa === 'pendiente_dcm' || estadoPorCaras === 'pendiente_dcm') {
    estadoFinal = 'pendiente_dcm';
    motivoFinal = [motivoTarifa, motivoCaras].filter(Boolean).join('; ');
  }

  return {
    estado: estadoFinal,
    motivo: motivoFinal || undefined,
    tarifa_efectiva: tarifaEfectiva,
    total_caras: totalCaras
  };
}

/**
 * Verifica si una solicitud tiene caras pendientes de autorización
 */
export async function verificarCarasPendientes(idquote: string): Promise<{
  tienePendientes: boolean;
  pendientesDg: number[];
  pendientesDcm: number[];
}> {
  console.log('[verificarCarasPendientes] Buscando caras con idquote:', idquote);

  const caras = await prisma.solicitudCaras.findMany({
    where: { idquote },
    select: { id: true, estado_autorizacion: true }
  });

  console.log('[verificarCarasPendientes] Caras encontradas:', caras);

  const pendientesDg = caras
    .filter(c => c.estado_autorizacion === 'pendiente_dg')
    .map(c => c.id);

  const pendientesDcm = caras
    .filter(c => c.estado_autorizacion === 'pendiente_dcm')
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
    select: { id: true, nombre: true }
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

  const fechaFin = new Date();
  fechaFin.setDate(fechaFin.getDate() + 7); // 7 días para aprobar

  // Crear tarea para DG si hay pendientes
  if (pendientesDg.length > 0 && usuariosDg.length > 0) {
    // El responsable es el primer usuario DG
    const dgPrincipal = usuariosDg[0];
    const tareaDg = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DG',
        titulo: `Autorización requerida - Solicitud #${solicitudId}`,
        descripcion: `Se requiere autorización de Dirección General para ${pendientesDg.length} cara(s) de la solicitud #${solicitudId}`,
        estatus: 'Pendiente',
        id_responsable: dgPrincipal.id,
        responsable: dgPrincipal.nombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        id_asignado: usuariosDg.map(u => u.id).join(','),
        asignado: usuariosDg.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDg.id,
      tipo: 'Autorización DG',
      solicitudId
    });
  }

  // Crear tarea para DCM si hay pendientes
  if (pendientesDcm.length > 0 && usuariosDcm.length > 0) {
    // El responsable es el primer usuario DCM
    const dcmPrincipal = usuariosDcm[0];
    const tareaDcm = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DCM',
        titulo: `Autorización requerida - Solicitud #${solicitudId}`,
        descripcion: `Se requiere autorización de Dirección Comercial para ${pendientesDcm.length} cara(s) de la solicitud #${solicitudId}`,
        estatus: 'Pendiente',
        id_responsable: dcmPrincipal.id,
        responsable: dcmPrincipal.nombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        id_asignado: usuariosDcm.map(u => u.id).join(','),
        asignado: usuariosDcm.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDcm.id,
      tipo: 'Autorización DCM',
      solicitudId
    });
  }
}

/**
 * Aprueba las caras pendientes de un tipo específico
 */
export async function aprobarCaras(
  idquote: string,
  tipoAutorizacion: 'dg' | 'dcm',
  aprobadorId: number,
  aprobadorNombre: string
): Promise<{ carasAprobadas: number }> {
  const estadoPendiente = tipoAutorizacion === 'dg' ? 'pendiente_dg' : 'pendiente_dcm';

  // Actualizar caras pendientes a aprobado
  const result = await prisma.solicitudCaras.updateMany({
    where: {
      idquote,
      estado_autorizacion: estadoPendiente
    },
    data: {
      estado_autorizacion: 'aprobado'
    }
  });

  // Verificar si quedan pendientes
  const { tienePendientes } = await verificarCarasPendientes(idquote);

  // Si ya no hay pendientes, marcar las tareas de autorización como atendidas
  if (!tienePendientes) {
    // Extraer el ID de solicitud del idquote (formato: "SOL-123" o similar)
    const solicitudId = idquote.replace(/\D/g, '');

    await prisma.tareas.updateMany({
      where: {
        id_solicitud: solicitudId,
        tipo: { contains: 'Autorización' },
        estatus: 'Pendiente'
      },
      data: {
        estatus: 'Atendido'
      }
    });
  } else {
    // Marcar solo la tarea del tipo específico como atendida
    const solicitudId = idquote.replace(/\D/g, '');
    const tipoTarea = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';

    await prisma.tareas.updateMany({
      where: {
        id_solicitud: solicitudId,
        tipo: tipoTarea,
        estatus: 'Pendiente'
      },
      data: {
        estatus: 'Atendido'
      }
    });
  }

  return { carasAprobadas: result.count };
}

/**
 * Rechaza toda la solicitud
 */
export async function rechazarSolicitud(
  idquote: string,
  solicitudId: number,
  rechazadorId: number,
  rechazadorNombre: string,
  comentario: string
): Promise<void> {
  // Marcar todas las caras como rechazadas
  await prisma.solicitudCaras.updateMany({
    where: { idquote },
    data: { estado_autorizacion: 'rechazado' }
  });

  // Marcar la solicitud como rechazada
  await prisma.solicitud.update({
    where: { id: solicitudId },
    data: { status: 'Rechazada' }
  });

  // Marcar todas las tareas de autorización como atendidas
  await prisma.tareas.updateMany({
    where: {
      id_solicitud: solicitudId.toString(),
      tipo: { contains: 'Autorización' },
      estatus: 'Pendiente'
    },
    data: {
      estatus: 'Atendido'
    }
  });

  // Crear notificación para el creador de la solicitud
  const solicitud = await prisma.solicitud.findUnique({
    where: { id: solicitudId },
    select: { usuario_id: true, nombre_usuario: true }
  });

  if (solicitud?.usuario_id) {
    const notifRechazo = await prisma.tareas.create({
      data: {
        tipo: 'Rechazo Autorización',
        titulo: `Solicitud #${solicitudId} Rechazada - Requiere edición`,
        descripcion: `Tu solicitud ha sido rechazada por ${rechazadorNombre}. Motivo: ${comentario}. Haz clic para editar la solicitud y corregir las caras.`,
        estatus: 'Pendiente',
        id_responsable: solicitud.usuario_id,
        responsable: solicitud.nombre_usuario || '',
        id_solicitud: solicitudId.toString(),
        id_asignado: solicitud.usuario_id.toString(),
        asignado: solicitud.nombre_usuario || '',
        referencia_tipo: 'solicitud',
        referencia_id: solicitudId
      }
    });

    // Emitir notificación via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: notifRechazo.id,
      tipo: 'Rechazo Autorización',
      solicitudId
    });
  }
}

/**
 * Obtiene el resumen de autorización de una solicitud
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
    select: { estado_autorizacion: true }
  });

  const conteo = {
    totalCaras: caras.length,
    aprobadas: caras.filter(c => c.estado_autorizacion === 'aprobado').length,
    pendientesDg: caras.filter(c => c.estado_autorizacion === 'pendiente_dg').length,
    pendientesDcm: caras.filter(c => c.estado_autorizacion === 'pendiente_dcm').length,
    rechazadas: caras.filter(c => c.estado_autorizacion === 'rechazado').length,
    puedeContinuar: false
  };

  conteo.puedeContinuar = conteo.pendientesDg === 0 && conteo.pendientesDcm === 0 && conteo.rechazadas === 0;

  return conteo;
}

export default {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion,
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion
};
