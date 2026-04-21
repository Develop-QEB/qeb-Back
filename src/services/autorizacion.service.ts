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

export interface CaraData {
  ciudad?: string | null;
  estado?: string | null;  // Estado para determinar la plaza
  formato?: string;
  tipo?: string | null;
  caras: number;
  bonificacion?: number | null;
  costo: number;
  tarifa_publica?: number;
  articulo?: string | null;
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
 * Normaliza el formato para buscar en criterios_autorizacion.
 * Los formatos compuestos (Bajo Puente X, MI MACRO X) se pasan tal cual
 * para buscar el criterio específico primero.
 */
function normalizarFormato(formato: string | null | undefined): string | null {
  if (!formato) return null;
  const f = formato.trim();
  const fUpper = f.toUpperCase();

  // Bajo Puente - pasar tal cual (puede ser "Bajo Puente Gran Terraza", "Bajo Puente Colorines Bloque 1", etc.)
  if (fUpper.startsWith('BAJO PUENTE')) return f;

  // MI MACRO - pasar tal cual (puede ser "MI MACRO Vidrio Int", "MI MACRO Parabus", etc.)
  if (fUpper.startsWith('MI MACRO')) return f;

  // Puente Peatonal
  if (fUpper.includes('PUENTE PEATONAL')) return 'Puente Peatonal';

  // TOTEM
  if (fUpper === 'TOTEM' || fUpper.includes('TOTEM')) return 'TOTEM';

  // Kiosco (sub-tipos como DANUBIO, Sena resuelven a Kiosco via mueble lookup)
  if (fUpper === 'KIOSCO' || fUpper.includes('KIOSCO')) return 'Kiosco';

  // Carteleras Digitales
  if (fUpper.includes('CARTELERA')) return 'CARTELERAS DIGITALES';

  // Formatos estándar PB y Columna
  if (fUpper.includes('PARABUS')) return 'PARABUS';
  if (fUpper.includes('COLUMNA')) return 'COLUMNA';
  if (fUpper.includes('BOLERO')) return 'Bolero';

  return null; // Se intentará lookup por mueble en calcularEstadoAutorizacion
}

/**
 * Para formatos compuestos, retorna la versión genérica para fallback.
 * Ej: "Bajo Puente Gran Terraza" → "Bajo Puente"
 *     "MI MACRO Vidrio Int" → "MI MACRO"
 */
function getFormatoGenerico(formato: string): string | null {
  const fUpper = formato.toUpperCase();
  if (fUpper.startsWith('BAJO PUENTE') && formato !== 'Bajo Puente') return 'Bajo Puente';
  if (fUpper.startsWith('MI MACRO') && formato !== 'MI MACRO') return 'MI MACRO';
  return null;
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
export async function calcularEstadoAutorizacion(cara: CaraData, userId?: number): Promise<EstadoAutorizacionResult> {
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

  // Artículos de bonificación (BF/CF): siempre auto-aprobados, son la fila par de RT/CF
  if (cara.articulo) {
    const artUpperBf = cara.articulo.toUpperCase();
    if (artUpperBf.startsWith('BF') || artUpperBf.startsWith('CF')) {
      return { autorizacion_dg: 'aprobado', autorizacion_dcm: 'aprobado' };
    }
  }

  // Artículos de impresión (IM): si tarifa es 0, requiere DCM; si no, aprobado
  if (cara.articulo && cara.articulo.toUpperCase().startsWith('IM')) {
    if ((cara.tarifa_publica || 0) <= 0) {
      return {
        autorizacion_dg: 'aprobado',
        autorizacion_dcm: 'pendiente',
        motivo_dcm: 'Artículo de Impresión con tarifa $0 requiere autorización DCM',
      };
    }
    return {
      autorizacion_dg: 'aprobado',
      autorizacion_dcm: 'aprobado',
    };
  }

  // Artículos de ejecución especial (ESP/ES-): misma lógica que impresión
  if (cara.articulo) {
    const artUpper2 = cara.articulo.toUpperCase();
    if (artUpper2.startsWith('ESP') || artUpper2.startsWith('ES-')) {
      if ((cara.tarifa_publica || 0) <= 0) {
        return {
          autorizacion_dg: 'aprobado',
          autorizacion_dcm: 'pendiente',
          motivo_dcm: 'Artículo de Ejecución Especial con tarifa $0 requiere autorización DCM',
        };
      }
      return {
        autorizacion_dg: 'aprobado',
        autorizacion_dcm: 'aprobado',
      };
    }
  }

  // Cortesías (CT) e Intercambio (IN) siempre requieren autorización DCM
  console.log('[calcularEstadoAutorizacion] articulo recibido:', JSON.stringify(cara.articulo), 'userId:', userId);
  if (cara.articulo) {
    const artUpper = cara.articulo.toUpperCase();
    if (artUpper.startsWith('CT') || artUpper.startsWith('IN')) {
      // Usuarios autorizados pueden crear cortesías sin autorización DCM
      const CORREOS_CORTESIA_AUTO = [
        'lflores@imu.com.mx',
        'kbasurto@imu.com.mx',
        'test_1057690@fake.com',
        'test_1057689@fake.com',
      ];
      if (artUpper.startsWith('CT') && userId) {
        const usuario = await prisma.usuario.findUnique({ where: { id: userId }, select: { correo_electronico: true } });
        if (usuario?.correo_electronico && CORREOS_CORTESIA_AUTO.includes(usuario.correo_electronico.toLowerCase())) {
          return {
            autorizacion_dg: 'aprobado',
            autorizacion_dcm: 'aprobado',
          };
        }
      }
      return {
        autorizacion_dg: 'aprobado',
        autorizacion_dcm: 'pendiente',
        motivo_dcm: `Artículo ${artUpper.startsWith('CT') ? 'Cortesía' : 'Intercambio'} requiere autorización DCM`,
      };
    }
  }

  // Calcular tarifa efectiva y total caras
  const totalCaras = cara.caras + (Number(cara.bonificacion) || 0);
  const tarifaEfectiva = totalCaras > 0 ? cara.costo / totalCaras : 0;

  // Caras impares requieren autorización DCM (excepto Kiosco)
  const isKiosco = (cara.formato || '').toUpperCase().includes('KIOSK') || (cara.formato || '').toUpperCase().includes('KIOSCO');
  const oddCarasNeedsDcm = !isKiosco && totalCaras > 0 && totalCaras % 2 !== 0;

  console.log('[calcularEstadoAutorizacion] Valores calculados:', {
    totalCaras,
    tarifaEfectiva
  });

  // Normalizar datos para búsqueda
  let formatoNormalizado = normalizarFormato(cara.formato);

  // Si no hay match directo por tipo_de_mueble, buscar la categoría (mueble) en inventarios
  if (!formatoNormalizado && cara.formato) {
    try {
      const inv = await prisma.inventarios.findFirst({
        where: { tipo_de_mueble: cara.formato },
        select: { mueble: true }
      });
      if (inv?.mueble) {
        formatoNormalizado = inv.mueble;
        console.log('[calcularEstadoAutorizacion] Formato resuelto via mueble:', formatoNormalizado);
      }
    } catch (err) {
      console.error('[calcularEstadoAutorizacion] Error lookup mueble:', err);
    }
  }

  // Para "Bolero", verificar si en esa ciudad es realmente un Bajo Puente o Puente Peatonal
  if (formatoNormalizado === 'Bolero' && cara.ciudad) {
    try {
      const invEspecifico = await prisma.inventarios.findFirst({
        where: {
          tipo_de_mueble: cara.formato,
          municipio: cara.ciudad,
          mueble: { notIn: ['Bolero'] }
        },
        select: { mueble: true }
      });
      if (invEspecifico?.mueble) {
        console.log('[calcularEstadoAutorizacion] Bolero reclasificado a:', invEspecifico.mueble);
        formatoNormalizado = invEspecifico.mueble;
      }
    } catch (err) {
      console.error('[calcularEstadoAutorizacion] Error reclasificacion Bolero:', err);
    }
  }

  // Si no se pudo resolver el formato, aprobar automáticamente
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

  // Buscar criterio: primero plaza específica, luego fallback a "TODAS"
  let criterio = await prisma.criterios_autorizacion.findFirst({
    where: {
      formato: formatoNormalizado,
      tipo: tipoNormalizado,
      plaza: plazaNormalizada,
      activo: true
    }
  });

  if (!criterio) {
    criterio = await prisma.criterios_autorizacion.findFirst({
      where: {
        formato: formatoNormalizado,
        tipo: tipoNormalizado,
        plaza: 'TODAS',
        activo: true
      }
    });
  }

  // Fallback: si no encontró criterio específico, intentar con formato genérico y misma plaza
  if (!criterio && formatoNormalizado) {
    const formatoGenerico = getFormatoGenerico(formatoNormalizado);
    if (formatoGenerico) {
      console.log('[calcularEstadoAutorizacion] Fallback a formato genérico:', formatoGenerico);
      criterio = await prisma.criterios_autorizacion.findFirst({
        where: {
          formato: formatoGenerico,
          tipo: tipoNormalizado,
          plaza: plazaNormalizada,
          activo: true
        }
      });
    }
  }

  console.log('[calcularEstadoAutorizacion] Criterio encontrado:', criterio);

  // Si no hay criterio definido, aprobar automáticamente (salvo caras impares)
  if (!criterio) {
    console.log('[calcularEstadoAutorizacion] No hay criterio, aprobando automáticamente');
    return {
      autorizacion_dg: 'aprobado',
      autorizacion_dcm: oddCarasNeedsDcm ? 'pendiente' : 'aprobado',
      motivo_dcm: oddCarasNeedsDcm ? 'Número impar de caras requiere autorización DCM' : undefined,
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

  // Caras impares → OR en DCM
  if (oddCarasNeedsDcm) {
    requiereDcm = true;
    motivoDcm = (motivoDcm ? motivoDcm + '; ' : '') + 'Número impar de caras requiere autorización DCM';
  }

  // Si ambos requieren autorización, DG tiene preferencia y DCM se auto-aprueba
  if (requiereDg && requiereDcm) {
    console.log('[calcularEstadoAutorizacion] Mixta DG+DCM detectada → preferencia DG, DCM auto-aprobado');
    requiereDcm = false;
    motivoDcm = '';
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
  pendientesDcm: number[],
  origen: 'solicitud' | 'propuesta' | 'campana' = 'solicitud',
  campaniaId?: number
): Promise<void> {
  console.log('[crearTareasAutorizacion] Iniciando con:', {
    solicitudId,
    propuestaId,
    pendientesDg,
    pendientesDcm,
    origen,
    campaniaId
  });

  // Determinar etiqueta e ID para título/descripción según origen
  const etiquetaOrigen = origen === 'campana' ? 'Campaña' : origen === 'propuesta' ? 'Propuesta' : 'Solicitud';
  const idOrigen = origen === 'campana' ? campaniaId : origen === 'propuesta' ? propuestaId : solicitudId;

  // Obtener usuarios DG y DCM (buscar por puesto, role o area con múltiples variantes)
  const usuariosDg = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { puesto: { contains: 'DG' } },
        { puesto: { contains: 'Director General' } },
        { user_role: { contains: 'Director General' } },
        { area: { contains: 'Dirección General' } },
        { area: { contains: 'Direccion General' } },
      ],
    },
    select: { id: true, nombre: true, correo_electronico: true }
  });

  const usuariosDcm = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { puesto: 'DCM' },
        { puesto: 'Director Comercial' },
        { puesto: 'Dirección Comercial' },
        { puesto: 'Direccion Comercial' },
        { user_role: 'Director Comercial' },
        { user_role: 'Dirección Comercial' },
        { area: 'Dirección Comercial' },
        { area: 'Direccion Comercial' },
      ],
    },
    select: { id: true, nombre: true, correo_electronico: true }
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

  // DG contamina: si hay al menos 1 DG pendiente, TODO pasa a DG
  if (pendientesDg.length > 0 && pendientesDcm.length > 0) {
    console.log('[crearTareasAutorizacion] Mixta DG+DCM → todo va a DG');
    pendientesDg.push(...pendientesDcm.filter(id => !pendientesDg.includes(id)));
    // Actualizar en BD: por propuesta o por solicitud
    if (propuestaId) {
      await prisma.solicitudCaras.updateMany({
        where: { idquote: propuestaId.toString(), autorizacion_dcm: 'pendiente' },
        data: { autorizacion_dg: 'pendiente', autorizacion_dcm: 'aprobado' },
      });
    } else {
      await prisma.solicitudCaras.updateMany({
        where: { id: { in: pendientesDcm.map(Number).filter(n => !isNaN(n)) }, autorizacion_dcm: 'pendiente' },
        data: { autorizacion_dg: 'pendiente', autorizacion_dcm: 'aprobado' },
      });
    }
    pendientesDcm.length = 0;
  }

  // Guardar snapshot de caras para historial (antes/después en ediciones)
  const allCaraIds = [...new Set([...pendientesDg, ...pendientesDcm])];
  if (allCaraIds.length > 0) {
    const carasSnapshot = await prisma.solicitudCaras.findMany({
      where: { id: { in: allCaraIds.map(Number).filter(n => !isNaN(n)) } },
      select: {
        id: true, articulo: true, ciudad: true, formato: true, tipo: true,
        caras: true, bonificacion: true, costo: true, tarifa_publica: true,
        caras_flujo: true, caras_contraflujo: true,
        autorizacion_dg: true, autorizacion_dcm: true,
      },
    });
    const refId = origen === 'campana' ? (campaniaId || solicitudId) : (propuestaId || solicitudId);
    await prisma.historial.create({
      data: {
        tipo: `autorizacion_${origen}`,
        ref_id: refId,
        accion: 'Solicitud de autorización',
        detalles: JSON.stringify({
          origen,
          solicitudId,
          propuestaId,
          campaniaId: campaniaId || null,
          pendientesDg: pendientesDg.length,
          pendientesDcm: pendientesDcm.length,
          caras: carasSnapshot,
        }),
      },
    });
  }

  // Crear tarea para DG si hay pendientes y no existe ya una tarea
  if (pendientesDg.length > 0 && usuariosDg.length > 0 && !existeTareaDg) {
    const tareaDg = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DG',
        titulo: `Autorización requerida - ${etiquetaOrigen} #${idOrigen}`,
        descripcion: `Se requiere autorización de Dirección General para ${pendientesDg.length} circuito(s) de la ${etiquetaOrigen} #${idOrigen}`,
        estatus: 'Pendiente',
        id_responsable: responsableId,
        responsable: responsableNombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        campania_id: campaniaId || null,
        contenido: origen,
        id_asignado: usuariosDg.map(u => u.id).join(','),
        asignado: usuariosDg.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación y tarea creada via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDg.id,
      tipo: 'Autorización DG',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: tareaDg.id,
      tipo: 'Autorización DG',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });

    // Correos a directores se envían en resumen diario (9am y 4pm) vía enviarResumenAutorizacionesPendientes()
  }

  // Crear tarea para DCM si hay pendientes y no existe ya una tarea
  if (pendientesDcm.length > 0 && usuariosDcm.length > 0 && !existeTareaDcm) {
    const tareaDcm = await prisma.tareas.create({
      data: {
        tipo: 'Autorización DCM',
        titulo: `Autorización requerida - ${etiquetaOrigen} #${idOrigen}`,
        descripcion: `Se requiere autorización de Dirección Comercial para ${pendientesDcm.length} circuito(s) de la ${etiquetaOrigen} #${idOrigen}`,
        estatus: 'Pendiente',
        id_responsable: responsableId,
        responsable: responsableNombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: propuestaId?.toString() || null,
        campania_id: campaniaId || null,
        contenido: origen,
        id_asignado: usuariosDcm.map(u => u.id).join(','),
        asignado: usuariosDcm.map(u => u.nombre).join(', '),
        fecha_fin: fechaFin
      }
    });

    // Emitir notificación y tarea creada via WebSocket
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: tareaDcm.id,
      tipo: 'Autorización DCM',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: tareaDcm.id,
      tipo: 'Autorización DCM',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });

    // Correos a directores se envían en resumen diario (9am y 4pm) vía enviarResumenAutorizacionesPendientes()
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

      // Si DG acaba de aprobar y quedan pendientes DCM, crear tarea DCM
      if (tipoAutorizacion === 'dg' && pendientesDcm.length > 0) {
        console.log('[aprobarCaras] DG aprobó, creando tarea DCM para', pendientesDcm.length, 'circuito(s)');
        const prop = await prisma.propuesta.findFirst({
          where: { id: parseInt(propuestaId) },
          select: { solicitud_id: true }
        });
        if (prop) {
          await crearTareasAutorizacion(
            prop.solicitud_id,
            parseInt(propuestaId),
            aprobadorId,
            aprobadorNombre,
            [],
            pendientesDcm,
            'propuesta'
          );
        }
      }
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
          descripcion: `${result.count} circuito(s) de tu solicitud han sido aprobados por ${tipoLabel} (${aprobadorNombre}).`,
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
        id_propuesta: idquote,
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

/**
 * Envía un resumen diario a los directores (DG y DCM) con las tareas de autorización pendientes.
 * Se invoca desde un scheduler (9am y 4pm hora CDMX). Si no hay pendientes no envía nada.
 * Cada director recibe únicamente el conteo correspondiente a su rol.
 */
export async function enviarResumenAutorizacionesPendientes(): Promise<void> {
  const [pendientesDg, pendientesDcm] = await Promise.all([
    prisma.tareas.count({
      where: { tipo: 'Autorización DG', estatus: 'Pendiente' }
    }),
    prisma.tareas.count({
      where: { tipo: 'Autorización DCM', estatus: 'Pendiente' }
    })
  ]);

  if (pendientesDg === 0 && pendientesDcm === 0) {
    console.log('[ResumenAutorizaciones] Sin tareas pendientes, no se envía correo');
    return;
  }

  const [usuariosDg, usuariosDcm] = await Promise.all([
    prisma.usuario.findMany({
      where: {
        deleted_at: null,
        OR: [
          { puesto: { contains: 'DG' } },
          { puesto: { contains: 'Director General' } },
          { user_role: { contains: 'Director General' } },
          { area: { contains: 'Dirección General' } },
          { area: { contains: 'Direccion General' } },
        ],
      },
      select: { id: true, nombre: true, correo_electronico: true }
    }),
    prisma.usuario.findMany({
      where: {
        deleted_at: null,
        OR: [
          { puesto: 'DCM' },
          { puesto: 'Director Comercial' },
          { puesto: 'Dirección Comercial' },
          { puesto: 'Direccion Comercial' },
          { user_role: 'Director Comercial' },
          { user_role: 'Dirección Comercial' },
          { area: 'Dirección Comercial' },
          { area: 'Direccion Comercial' },
        ],
      },
      select: { id: true, nombre: true, correo_electronico: true }
    })
  ]);

  const envios: Promise<void>[] = [];

  if (pendientesDg > 0) {
    for (const u of usuariosDg) {
      if (!u.correo_electronico) continue;
      envios.push(
        enviarCorreoResumenAutorizacion(u.correo_electronico, u.nombre, 'DG', pendientesDg)
          .catch(err => console.error(`[ResumenAutorizaciones] Error enviando a ${u.correo_electronico}:`, err))
      );
    }
  }

  if (pendientesDcm > 0) {
    for (const u of usuariosDcm) {
      if (!u.correo_electronico) continue;
      envios.push(
        enviarCorreoResumenAutorizacion(u.correo_electronico, u.nombre, 'DCM', pendientesDcm)
          .catch(err => console.error(`[ResumenAutorizaciones] Error enviando a ${u.correo_electronico}:`, err))
      );
    }
  }

  await Promise.all(envios);
  console.log(`[ResumenAutorizaciones] Enviados ${envios.length} correos (DG=${pendientesDg}, DCM=${pendientesDcm})`);
}

async function enviarCorreoResumenAutorizacion(
  destinatarioEmail: string,
  destinatarioNombre: string,
  rol: 'DG' | 'DCM',
  cantidad: number
): Promise<void> {
  const rolLabel = rol === 'DG' ? 'Dirección General' : 'Dirección Comercial';
  const plural = cantidad === 1 ? 'tarea pendiente' : 'tareas pendientes';
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
                <h2 style="color: #1f2937; margin: 0 0 8px 0; font-size: 22px; font-weight: 600;">Resumen de autorizaciones pendientes</h2>
                <p style="color: #6b7280; margin: 0 0 20px 0; font-size: 15px; line-height: 1.5;">
                  Hola <strong style="color: #374151;">${destinatarioNombre}</strong>, tienes autorizaciones pendientes de revisión.
                </p>
                <div style="background-color: #f5f3ff; border-left: 4px solid #8b5cf6; padding: 18px 20px; border-radius: 0 8px 8px 0; margin: 0 0 24px 0;">
                  <p style="color: #6b7280; margin: 0 0 6px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${rolLabel}</p>
                  <p style="color: #1f2937; margin: 0; font-size: 28px; font-weight: 700;">${cantidad} <span style="font-size:15px; font-weight:500; color:#6b7280;">${plural}</span></p>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="https://app.qeb.mx/tareas" style="display: inline-block; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: #ffffff; padding: 14px 40px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; box-shadow: 0 4px 14px rgba(139, 92, 246, 0.4);">Ver Tareas</a>
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
    subject: `🔔 Resumen ${rol}: ${cantidad} ${plural} de autorización`,
    html: htmlBody,
  });
}

export default {
  calcularEstadoAutorizacion,
  verificarCarasPendientes,
  crearTareasAutorizacion,
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion,
  enviarResumenAutorizacionesPendientes
};
