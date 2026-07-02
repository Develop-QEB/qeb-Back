import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import { correoPermitido } from '../utils/correoPrefs';
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

  // Artículos de impresión (IM): NUNCA van a autorización (siempre auto-aprobados,
  // incluso con tarifa $0). Petición de Mario: las impresiones no se mandan a autorización.
  if (cara.articulo && cara.articulo.toUpperCase().startsWith('IM')) {
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

  // Caras impares requieren autorización DCM (excepto Kiosco y Digital/Circuitos)
  const isKiosco = (cara.formato || '').toUpperCase().includes('KIOSK') || (cara.formato || '').toUpperCase().includes('KIOSCO');
  const isDigital = (cara.tipo || '').toLowerCase() === 'digital'
    || (cara.formato || '').toUpperCase() === 'MIXTO'
    || /^(RT|BF|CT|CF)-DIG-\d+-[A-Z]+$/i.test(cara.articulo || '');
  const oddCarasNeedsDcm = !isKiosco && !isDigital && totalCaras > 0 && totalCaras % 2 !== 0;

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

  // Evaluar tarifa y caras POR SEPARADO contra rangos DG/DCM
  const tarifaMaxDg = criterio.tarifa_max_dg ? Number(criterio.tarifa_max_dg) : null;
  const carasMaxDg = criterio.caras_max_dg;
  const tarifaMinDcm = criterio.tarifa_min_dcm ? Number(criterio.tarifa_min_dcm) : null;
  const tarifaMaxDcm = criterio.tarifa_max_dcm ? Number(criterio.tarifa_max_dcm) : null;
  const carasMinDcm = criterio.caras_min_dcm;
  const carasMaxDcm = criterio.caras_max_dcm;

  // Resultado por campo: 'dg', 'dcm', o null (no matchea ningún rango)
  let tarifaResult: 'dg' | 'dcm' | null = null;
  if (tarifaMaxDg !== null && tarifaEfectiva <= tarifaMaxDg) {
    tarifaResult = 'dg';
  } else if (tarifaMinDcm !== null && tarifaMaxDcm !== null &&
      tarifaEfectiva >= tarifaMinDcm && tarifaEfectiva <= tarifaMaxDcm) {
    tarifaResult = 'dcm';
  }

  let carasResult: 'dg' | 'dcm' | null = null;
  if (carasMaxDg !== null && totalCaras <= carasMaxDg) {
    carasResult = 'dg';
  } else if (carasMinDcm !== null && carasMaxDcm !== null &&
      totalCaras >= carasMinDcm && totalCaras <= carasMaxDcm) {
    carasResult = 'dcm';
  }

  console.log('[calcularEstadoAutorizacion] Evaluación independiente:', {
    tarifaEfectiva, totalCaras,
    tarifaMaxDg, tarifaMinDcm, tarifaMaxDcm,
    carasMaxDg, carasMinDcm, carasMaxDcm,
    tarifaResult, carasResult
  });

  // Combinar resultados:
  // - Ambos coinciden → ese resultado
  // - No coinciden (uno DG, otro DCM) → DG
  // - Solo uno matchea → ese resultado
  // - Ninguno matchea → Filtro 2 (par/impar)
  let requiereDg = false;
  let requiereDcm = false;
  let motivoDg = '';
  let motivoDcm = '';

  if (tarifaResult || carasResult) {
    if (tarifaResult === 'dg' && carasResult === 'dg') {
      requiereDg = true;
      motivoDg = `Tarifa $${tarifaEfectiva.toFixed(2)} <= $${tarifaMaxDg}; Caras ${totalCaras} <= ${carasMaxDg}`;
    } else if (tarifaResult === 'dcm' && carasResult === 'dcm') {
      requiereDcm = true;
      motivoDcm = `Tarifa $${tarifaEfectiva.toFixed(2)} en rango DCM; Caras ${totalCaras} en rango DCM`;
    } else if ((tarifaResult === 'dg' && carasResult === 'dcm') || (tarifaResult === 'dcm' && carasResult === 'dg')) {
      // No coinciden → DG por default
      requiereDg = true;
      motivoDg = `Tarifa→${tarifaResult}, Caras→${carasResult} (no coinciden → DG)`;
    } else if (tarifaResult && !carasResult) {
      if (tarifaResult === 'dg') { requiereDg = true; motivoDg = `Tarifa $${tarifaEfectiva.toFixed(2)} <= $${tarifaMaxDg}`; }
      else { requiereDcm = true; motivoDcm = `Tarifa $${tarifaEfectiva.toFixed(2)} en rango DCM ($${tarifaMinDcm}-$${tarifaMaxDcm})`; }
    } else if (carasResult && !tarifaResult) {
      if (carasResult === 'dg') { requiereDg = true; motivoDg = `Caras ${totalCaras} <= ${carasMaxDg}`; }
      else { requiereDcm = true; motivoDcm = `Caras ${totalCaras} en rango DCM (${carasMinDcm}-${carasMaxDcm})`; }
    }

    const resultado = {
      autorizacion_dg: requiereDg ? 'pendiente' : 'aprobado',
      autorizacion_dcm: requiereDcm ? 'pendiente' : 'aprobado',
      motivo_dg: motivoDg || undefined,
      motivo_dcm: motivoDcm || undefined,
      tarifa_efectiva: tarifaEfectiva,
      total_caras: totalCaras
    };
    console.log('[calcularEstadoAutorizacion] Resultado final (Filtro 1):', resultado);
    return resultado as EstadoAutorizacionResult;
  }

  // Filtro 2: criterio existe pero no matcheó rangos → revisar par/impar
  const resultado = {
    autorizacion_dg: 'aprobado',
    autorizacion_dcm: oddCarasNeedsDcm ? 'pendiente' : 'aprobado',
    motivo_dcm: oddCarasNeedsDcm ? 'Número impar de caras requiere autorización DCM' : undefined,
    tarifa_efectiva: tarifaEfectiva,
    total_caras: totalCaras
  };

  console.log('[calcularEstadoAutorizacion] Resultado final (Filtro 2 - par/impar):', resultado);

  return resultado as EstadoAutorizacionResult;
}

/**
 * Regla "Direcciones Aprobadas": si una cara YA estaba aprobada por DG y DCM y
 * la edición INCREMENTA (o deja igual) el costo —o lo BAJA hasta un máximo del
 * 3% de la TARIFA PÚBLICA— se conserva la aprobación, sin nueva autorización.
 *
 * Regla del jefe (jun 2026): una baja de tarifa de hasta 3% NO se manda; a partir
 * de 3.1% (> 3%) sí. El 3% es sobre la tarifa pública. La tolerancia aplica SOLO
 * a la tarifa; si bajan las CARAS, sí re-autoriza (sin cambio).
 *
 * Se aplica en los 3 niveles (solicitud / propuesta / campaña) DESPUÉS de
 * `calcularEstadoAutorizacion`, usando los valores efectivos nuevos vs los que
 * tenía la cara antes de editar.
 */
export function conservarAprobacionSiIncrementa(
  estado: EstadoAutorizacionResult,
  prev: { autorizacion_dg?: string | null; autorizacion_dcm?: string | null; costo?: number | null; caras?: number | null },
  nuevo: { costo: number; caras: number; tarifa_publica?: number | null }
): EstadoAutorizacionResult {
  const yaAprobada = prev.autorizacion_dg === 'aprobado' && prev.autorizacion_dcm === 'aprobado';
  if (!yaAprobada) return estado;
  // Tolerancia: baja de costo de hasta 3% de la tarifa pública se conserva
  // (incrementos también: baja <= 0). Sin tarifa_publica → umbral 0 = cualquier
  // baja re-autoriza (comportamiento previo).
  const umbral = 0.03 * Number(nuevo.tarifa_publica ?? 0);
  const bajaCosto = Number(prev.costo ?? 0) - Number(nuevo.costo);
  const noBajaCosto = bajaCosto <= umbral + 0.005; // epsilon de centavos
  const noBajaCaras = Number(nuevo.caras) >= Number(prev.caras ?? 0);
  if (noBajaCosto && noBajaCaras) {
    console.log(`[conservarAprobacionSiIncrementa] Ya aprobada; baja costo ${bajaCosto.toFixed(2)} <= 3% tarifa (${umbral.toFixed(2)}) y caras no bajan → se conserva aprobación`);
    return { ...estado, autorizacion_dg: 'aprobado', autorizacion_dcm: 'aprobado', motivo_dg: undefined, motivo_dcm: undefined };
  }
  return estado;
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
 * Igual que verificarCarasPendientes pero buscando autorizaciones en estado
 * 'rechazado'. Si CUALQUIER cara está rechazada por DG o por DCM, el llamador
 * debe bloquear el avance del flujo (atender solicitud / aprobar propuesta).
 */
export async function verificarCarasRechazadas(idquote: string): Promise<{
  tieneRechazadas: boolean;
  rechazadasDg: number[];
  rechazadasDcm: number[];
}> {
  const caras = await prisma.solicitudCaras.findMany({
    where: { idquote },
    select: { id: true, autorizacion_dg: true, autorizacion_dcm: true }
  });

  const rechazadasDg = caras
    .filter(c => c.autorizacion_dg === 'rechazado')
    .map(c => c.id);

  const rechazadasDcm = caras
    .filter(c => c.autorizacion_dcm === 'rechazado')
    .map(c => c.id);

  return {
    tieneRechazadas: rechazadasDg.length > 0 || rechazadasDcm.length > 0,
    rechazadasDg,
    rechazadasDcm
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

  // Determinar etiqueta e ID para título/descripción.
  // Mario pidió que SIEMPRE se use el id de la campaña asociada (no el id
  // de la propuesta/solicitud), porque hay 74 propuestas desalineadas donde
  // propuesta.id != campania.id (offset +10) — el usuario ve un id que no
  // coincide con la campaña. Si no hay campaña aún (solicitud sin atender),
  // fallback al comportamiento anterior.
  let campaniaIdResuelto: number | null = campaniaId ?? null;
  if (!campaniaIdResuelto && propuestaId) {
    const cot = await prisma.cotizacion.findFirst({
      where: { id_propuesta: propuestaId },
      select: { id: true },
    });
    if (cot) {
      const cm = await prisma.campania.findFirst({
        where: { cotizacion_id: cot.id },
        select: { id: true },
        orderBy: { id: 'desc' },
      });
      if (cm) campaniaIdResuelto = cm.id;
    }
  }
  const etiquetaOrigen = campaniaIdResuelto != null
    ? 'Campaña'
    : (origen === 'propuesta' ? 'Propuesta' : 'Solicitud');
  const idOrigen = campaniaIdResuelto != null
    ? campaniaIdResuelto
    : (origen === 'campana' ? campaniaId : origen === 'propuesta' ? propuestaId : solicitudId);

  // Obtener usuarios DG: solo por puesto/user_role exactos. Antes existian
  // matches por area ('Dirección General') que arrastraban a 'Director General
  // Adjunto' y 'Director Desarrollo de Nuevos Negocios' (mismo area pero
  // puesto distinto). Esos roles NO deben recibir tareas DG porque tampoco
  // pueden aprobarlas/rechazarlas (el aprobador en notificaciones.controller
  // exige puesto === 'Director General').
  const usuariosDg = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      OR: [
        { puesto: 'DG' },
        { puesto: 'Director General' },
        { puesto: 'Dirección General' },
        { puesto: 'Direccion General' },
        { user_role: 'Director General' },
      ],
    },
    select: { id: true, nombre: true, correo_electronico: true }
  });

  const usuariosDcm = await prisma.usuario.findMany({
    where: {
      deleted_at: null,
      // El rol 'Gerente Comercial' tiene los mismos permisos de visualización
      // que 'Director Comercial' pero NO debe recibir tareas de autorización
      // DCM. Lo excluimos aquí explícitamente para que el match por área no
      // lo barra (si su area está como 'Dirección Comercial').
      NOT: { user_role: 'Gerente Comercial' },
      OR: [
        { puesto: 'DCM' },
        { puesto: 'Director Comercial' },
        { puesto: 'Dirección Comercial' },
        { puesto: 'Direccion Comercial' },
        { user_role: 'Director Comercial' },
        { user_role: 'Dirección Comercial' },
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

  // Guard de duplicados: mira id_solicitud, id_propuesta Y campania_id (OR).
  // Cubre tareas creadas con cualquier origen para evitar duplicar si el
  // mismo registro ya tiene una tarea Autorización abierta en otro nivel.
  const tareasExistentes = await prisma.tareas.findMany({
    where: {
      OR: [
        { id_solicitud: solicitudId.toString() },
        ...(propuestaId ? [{ id_propuesta: propuestaId.toString() }] : []),
        ...(campaniaId ? [{ campania_id: campaniaId }] : []),
      ],
      tipo: { contains: 'Autorización' },
      estatus: { notIn: ['Atendido', 'Cancelado', 'Rechazado'] },
    },
    select: { tipo: true }
  });

  const existeTareaDg = tareasExistentes.some(t => t.tipo === 'Autorización DG');
  const existeTareaDcm = tareasExistentes.some(t => t.tipo === 'Autorización DCM');

  // Pre-calcular escalación DG+DCM → DG ANTES de la transacción
  const carasEscaladasDcmADg: number[] = [];
  if (pendientesDg.length > 0 && pendientesDcm.length > 0) {
    console.log('[crearTareasAutorizacion] Mixta DG+DCM → todo va a DG');
    carasEscaladasDcmADg.push(...pendientesDcm);
    pendientesDg.push(...pendientesDcm.filter(id => !pendientesDg.includes(id)));
    pendientesDcm.length = 0;
  }

  // === TRANSACCIÓN ATÓMICA ===
  // Todo el side-effect (updateMany de escalación, historial, snapshot, tareas)
  // va dentro de una sola transacción para evitar estados parciales como el caso
  // de la solicitud 80737: historial escrito pero tarea no creada por un parpadeo
  // de red intermedio. Si algo falla, NADA se persiste.
  const result = await prisma.$transaction(async (tx) => {
    // 1. Si hubo escalación DG+DCM, aplicar UPDATE de caras
    if (carasEscaladasDcmADg.length > 0) {
      if (propuestaId) {
        await tx.solicitudCaras.updateMany({
          where: { idquote: propuestaId.toString(), autorizacion_dcm: 'pendiente' },
          data: { autorizacion_dg: 'pendiente', autorizacion_dcm: 'aprobado' },
        });
      } else {
        await tx.solicitudCaras.updateMany({
          where: { id: { in: carasEscaladasDcmADg.map(Number).filter(n => !isNaN(n)) }, autorizacion_dcm: 'pendiente' },
          data: { autorizacion_dg: 'pendiente', autorizacion_dcm: 'aprobado' },
        });
      }

      // Historial de escalación
      const refIdEscalacion = origen === 'campana' ? (campaniaId || solicitudId) : (propuestaId || solicitudId);
      await tx.historial.create({
        data: {
          tipo: `autorizacion_solicitud_${origen}`,
          ref_id: refIdEscalacion,
          accion: `${carasEscaladasDcmADg.length} circuito(s) DCM escalado(s) a DG por mezcla DG+DCM`,
          detalles: JSON.stringify({
            usuario: responsableNombre,
            origen,
            solicitudId,
            propuestaId,
            campaniaId: campaniaId || null,
            motivo: 'mezcla_dg_dcm',
            carasEscaladasIds: carasEscaladasDcmADg,
          }),
        },
      });
    }

    // 2. Snapshot de caras + historial de solicitud de autorización
    const allCaraIds = [...new Set([...pendientesDg, ...pendientesDcm])];
    if (allCaraIds.length > 0) {
      const carasSnapshot = await tx.solicitudCaras.findMany({
        where: { id: { in: allCaraIds.map(Number).filter(n => !isNaN(n)) } },
        select: {
          id: true, articulo: true, ciudad: true, formato: true, tipo: true,
          caras: true, bonificacion: true, costo: true, tarifa_publica: true,
          caras_flujo: true, caras_contraflujo: true,
          autorizacion_dg: true, autorizacion_dcm: true,
        },
      });
      const refId = origen === 'campana' ? (campaniaId || solicitudId) : (propuestaId || solicitudId);
      const dirLabel = pendientesDg.length > 0 ? 'DG' : 'DCM';
      const totalCircuitos = pendientesDg.length + pendientesDcm.length;
      await tx.historial.create({
        data: {
          tipo: `autorizacion_solicitud_${origen}`,
          ref_id: refId,
          accion: `${responsableNombre} solicitó autorización ${dirLabel} — ${totalCircuitos} circuito(s)`,
          detalles: JSON.stringify({
            usuario: responsableNombre,
            origen,
            solicitudId,
            propuestaId,
            campaniaId: campaniaId || null,
            direccion: dirLabel,
            pendientesDg: pendientesDg.length,
            pendientesDcm: pendientesDcm.length,
            caras: carasSnapshot,
          }),
        },
      });
    }

    // 3. Tarea DG
    let tareaDgId: number | null = null;
    if (pendientesDg.length > 0 && usuariosDg.length > 0 && !existeTareaDg) {
      const tareaDg = await tx.tareas.create({
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
      tareaDgId = tareaDg.id;
    }

    // 4. Tarea DCM
    let tareaDcmId: number | null = null;
    if (pendientesDcm.length > 0 && usuariosDcm.length > 0 && !existeTareaDcm) {
      const tareaDcm = await tx.tareas.create({
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
      tareaDcmId = tareaDcm.id;
    }

    return { tareaDgId, tareaDcmId };
  }, { timeout: 30000 });

  // === EMITIR SOCKETS DESPUÉS DEL COMMIT ===
  // Solo notificamos si el INSERT realmente persistió (tx exitosa).
  if (result.tareaDgId) {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: result.tareaDgId,
      tipo: 'Autorización DG',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: result.tareaDgId,
      tipo: 'Autorización DG',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });
  }
  if (result.tareaDcmId) {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: result.tareaDcmId,
      tipo: 'Autorización DCM',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
    });
    emitToAll(SOCKET_EVENTS.TAREA_CREADA, {
      tareaId: result.tareaDcmId,
      tipo: 'Autorización DCM',
      origen,
      solicitudId,
      propuestaId,
      campaniaId: campaniaId || null
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

  // Buscar solicitud_id para limpiar tareas tanto por propuesta como por solicitud
  const propParaSolicitud = await prisma.propuesta.findFirst({
    where: { id: parseInt(propuestaId) },
    select: { solicitud_id: true }
  });
  const solicitudIdStr = propParaSolicitud?.solicitud_id?.toString();

  // Condición OR: tareas de esta propuesta O tareas de la solicitud origen
  const tareaWhereBase = {
    OR: [
      { id_propuesta: propuestaId },
      ...(solicitudIdStr ? [{ id_solicitud: solicitudIdStr, id_propuesta: null }] : []),
    ],
    estatus: 'Pendiente' as const,
  };

  // Si ya no hay pendientes de ningún tipo, marcar TODAS las tareas de autorización como atendidas
  if (!tienePendientes) {
    await prisma.tareas.updateMany({
      where: { ...tareaWhereBase, tipo: { contains: 'Autorización' } },
      data: { estatus: 'Atendido' }
    });
  } else {
    // Marcar solo la tarea del tipo específico como atendida SI ya no hay pendientes de ese tipo
    const tipoTarea = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';
    const pendientesDelTipo = tipoAutorizacion === 'dg' ? pendientesDg : pendientesDcm;

    // Solo marcar como atendida si ya no hay más pendientes de este tipo
    if (pendientesDelTipo.length === 0) {
      await prisma.tareas.updateMany({
        where: { ...tareaWhereBase, tipo: tipoTarea },
        data: { estatus: 'Atendido' }
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

  // Crear notificación de aprobación solo si se aprobaron caras
  if (result.count === 0) {
    return { carasAprobadas: 0 };
  }

  const propuesta = await prisma.propuesta.findFirst({
    where: { id: parseInt(propuestaId) },
    select: { solicitud_id: true }
  });

  if (propuesta) {
    // Buscar la tarea de autorización original para saber quién la solicitó y el origen
    const tipoTareaAuth = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';
    const tareaOriginal = await prisma.tareas.findFirst({
      where: {
        id_propuesta: propuestaId,
        tipo: tipoTareaAuth,
      },
      orderBy: { created_at: 'desc' },
      select: { id_responsable: true, responsable: true, contenido: true, campania_id: true }
    });

    // Fallback al creador de la solicitud
    const solicitud = await prisma.solicitud.findUnique({
      where: { id: propuesta.solicitud_id },
      select: { usuario_id: true, nombre_usuario: true }
    });

    const destinatarioId = solicitud?.usuario_id;
    const destinatarioNombre = solicitud?.nombre_usuario || '';
    const origen = tareaOriginal?.contenido || 'solicitud';
    const etiquetaOrigen = origen === 'campana' ? 'Campaña' : origen === 'propuesta' ? 'Propuesta' : 'Solicitud';
    const idOrigen = origen === 'campana' ? (tareaOriginal?.campania_id || propuesta.solicitud_id)
      : origen === 'propuesta' ? propuestaId
      : propuesta.solicitud_id;

    if (destinatarioId) {
      const tipoLabel = tipoAutorizacion === 'dg' ? 'Dirección General' : 'Dirección Comercial';
      const notifAprobacion = await prisma.tareas.create({
        data: {
          tipo: `Aprobación ${tipoAutorizacion.toUpperCase()}`,
          titulo: `${etiquetaOrigen} #${idOrigen} - Aprobación ${tipoAutorizacion.toUpperCase()}`,
          descripcion: `${result.count} circuito(s) de tu ${etiquetaOrigen.toLowerCase()} han sido aprobados por ${tipoLabel} (${aprobadorNombre}).`,
          estatus: 'Pendiente',
          id_responsable: destinatarioId,
          responsable: destinatarioNombre,
          id_solicitud: propuesta.solicitud_id.toString(),
          id_propuesta: propuestaId,
          campania_id: tareaOriginal?.campania_id || null,
          contenido: origen,
          id_asignado: destinatarioId.toString(),
          asignado: destinatarioNombre,
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

  // Marcar solo la tarea del tipo específico como rechazada
  const tipoTarea = tipoAutorizacion === 'dg' ? 'Autorización DG' : 'Autorización DCM';
  await prisma.tareas.updateMany({
    where: {
      OR: [
        { id_propuesta: idquote },
        { id_solicitud: solicitudId.toString() },
      ],
      tipo: tipoTarea,
      estatus: 'Pendiente'
    },
    data: {
      estatus: 'Rechazado'
    }
  });

  // Crear notificación para quien solicitó la autorización (no necesariamente el creador de la solicitud)
  const tipoLabel = tipoAutorizacion === 'dg' ? 'Dirección General' : 'Dirección Comercial';

  // Buscar la tarea de autorización original para saber quién la solicitó y el origen
  const tareaOriginal = await prisma.tareas.findFirst({
    where: {
      id_solicitud: solicitudId.toString(),
      tipo: tipoTarea,
    },
    orderBy: { created_at: 'desc' },
    select: { id_responsable: true, responsable: true, contenido: true, id_propuesta: true, campania_id: true }
  });

  // Fallback al creador de la solicitud si no se encuentra la tarea original
  const solicitud = await prisma.solicitud.findUnique({
    where: { id: solicitudId },
    select: { usuario_id: true, nombre_usuario: true }
  });

  const destinatarioId = solicitud?.usuario_id;
  const destinatarioNombre = solicitud?.nombre_usuario || '';

  if (destinatarioId) {
    const origen = tareaOriginal?.contenido || 'solicitud';
    const etiquetaOrigen = origen === 'campana' ? 'Campaña' : origen === 'propuesta' ? 'Propuesta' : 'Solicitud';
    const idOrigen = origen === 'campana' ? (tareaOriginal?.campania_id || solicitudId)
      : origen === 'propuesta' ? (tareaOriginal?.id_propuesta || idquote)
      : solicitudId;

    const notifRechazo = await prisma.tareas.create({
      data: {
        tipo: `Rechazo ${tipoAutorizacion.toUpperCase()}`,
        titulo: `${etiquetaOrigen} #${idOrigen} - Rechazo ${tipoAutorizacion.toUpperCase()}`,
        descripcion: `Tu ${etiquetaOrigen.toLowerCase()} ha sido rechazada por ${tipoLabel} (${rechazadorNombre}). Motivo: ${comentario}. Haz clic para editar y corregir las caras.`,
        estatus: 'Pendiente',
        id_responsable: destinatarioId,
        responsable: destinatarioNombre,
        id_solicitud: solicitudId.toString(),
        id_propuesta: idquote,
        campania_id: tareaOriginal?.campania_id || null,
        contenido: origen,
        id_asignado: destinatarioId.toString(),
        asignado: destinatarioNombre,
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
        // Solo puesto/user_role exactos. Quitamos area para no arrastrar
        // a Director General Adjunto / Desarrollo Nuevos Negocios que
        // comparten el area pero no el puesto.
        OR: [
          { puesto: 'DG' },
          { puesto: 'Director General' },
          { puesto: 'Dirección General' },
          { puesto: 'Direccion General' },
          { user_role: 'Director General' },
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
        ],
      },
      select: { id: true, nombre: true, correo_electronico: true }
    })
  ]);

  const envios: Promise<void>[] = [];

  if (pendientesDg > 0) {
    for (const u of usuariosDg) {
      if (!u.correo_electronico) continue;
      if (!(await correoPermitido(u.id, 'tarea', 'Autorización DG'))) continue;
      envios.push(
        enviarCorreoResumenAutorizacion(u.correo_electronico, u.nombre, 'DG', pendientesDg)
          .catch(err => console.error(`[ResumenAutorizaciones] Error enviando a ${u.correo_electronico}:`, err))
      );
    }
  }

  if (pendientesDcm > 0) {
    for (const u of usuariosDcm) {
      if (!u.correo_electronico) continue;
      if (!(await correoPermitido(u.id, 'tarea', 'Autorización DCM'))) continue;
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
  verificarCarasRechazadas,
  crearTareasAutorizacion,
  aprobarCaras,
  rechazarSolicitud,
  obtenerResumenAutorizacion,
  enviarResumenAutorizacionesPendientes,
  depurarTareasAutorizacionResueltas
};

/**
 * Depura tareas de autorización que siguen como Pendiente/Activo
 * pero cuyas caras ya fueron todas resueltas (aprobadas o rechazadas).
 */
export async function depurarTareasAutorizacionResueltas(): Promise<number> {
  const tareasAbiertas = await prisma.tareas.findMany({
    where: {
      tipo: { contains: 'Autorización' },
      estatus: { notIn: ['Atendido', 'Cancelado', 'Rechazado'] },
    },
    select: { id: true, tipo: true, id_propuesta: true, id_solicitud: true },
  });

  let finalizadas = 0;

  // Deduplicar: agrupar por (id_propuesta + tipo) y quedarse solo con la más reciente
  const gruposPorPropuesta = new Map<string, typeof tareasAbiertas>();
  for (const tarea of tareasAbiertas) {
    const key = `${tarea.id_propuesta || tarea.id_solicitud}::${tarea.tipo}`;
    if (!gruposPorPropuesta.has(key)) gruposPorPropuesta.set(key, []);
    gruposPorPropuesta.get(key)!.push(tarea);
  }
  const duplicadasIds: number[] = [];
  for (const grupo of gruposPorPropuesta.values()) {
    if (grupo.length <= 1) continue;
    grupo.sort((a, b) => b.id - a.id);
    for (let i = 1; i < grupo.length; i++) duplicadasIds.push(grupo[i].id);
  }
  if (duplicadasIds.length > 0) {
    await prisma.tareas.updateMany({
      where: { id: { in: duplicadasIds } },
      data: { estatus: 'Atendido' },
    });
    finalizadas += duplicadasIds.length;
    console.log(`[DepurarAutorizaciones] ${duplicadasIds.length} tareas duplicadas finalizadas`);
  }

  // Ahora revisar las restantes (no duplicadas) por caras resueltas
  const tareasRestantes = tareasAbiertas.filter(t => !duplicadasIds.includes(t.id));

  for (const tarea of tareasRestantes) {
    let idquote = tarea.id_propuesta;

    if (!idquote && tarea.id_solicitud) {
      const prop = await prisma.propuesta.findFirst({
        where: { solicitud_id: parseInt(tarea.id_solicitud) },
        select: { id: true },
        orderBy: { id: 'desc' },
      });
      if (prop) idquote = String(prop.id);
    }

    if (!idquote) {
      await prisma.tareas.update({ where: { id: tarea.id }, data: { estatus: 'Atendido' } });
      finalizadas++;
      continue;
    }

    const caras = await prisma.solicitudCaras.findMany({
      where: { idquote },
      select: { autorizacion_dg: true, autorizacion_dcm: true },
    });

    if (caras.length === 0) {
      await prisma.tareas.update({ where: { id: tarea.id }, data: { estatus: 'Atendido' } });
      finalizadas++;
      continue;
    }

    const esDG = tarea.tipo?.includes('DG');
    const campo = esDG ? 'autorizacion_dg' : 'autorizacion_dcm';
    const tienePendientes = caras.some(c => (c as any)[campo] === 'pendiente');

    if (!tienePendientes) {
      await prisma.tareas.update({ where: { id: tarea.id }, data: { estatus: 'Atendido' } });
      finalizadas++;
    }
  }

  // === REPARAR HUÉRFANOS ===
  // Caras pendientes DG/DCM cuyo dueño (solicitud/propuesta/campaña) no tiene
  // tarea Autorización abierta. Cubre el caso del 80737: la creación original
  // de la tarea reventó a mitad y nadie se enteró. Esto la genera por nosotros.
  let huerfanosReparados = 0;
  try {
    const groups: Array<{ idquote: string; pdg: any; pdcm: any }> = await prisma.$queryRawUnsafe(`
      SELECT idquote,
             SUM(CASE WHEN autorizacion_dg = 'pendiente' THEN 1 ELSE 0 END) AS pdg,
             SUM(CASE WHEN autorizacion_dcm = 'pendiente' THEN 1 ELSE 0 END) AS pdcm
      FROM solicitudCaras
      WHERE idquote IS NOT NULL
        AND (autorizacion_dg = 'pendiente' OR autorizacion_dcm = 'pendiente')
      GROUP BY idquote
    `);

    for (const g of groups) {
      const idNum = parseInt(g.idquote);
      if (isNaN(idNum)) continue;
      const pdg = Number(g.pdg);
      const pdcm = Number(g.pdcm);
      if (pdg === 0 && pdcm === 0) continue;

      // Resolver nivel: ¿propuesta activa? ¿solicitud directa?
      let solicitudIdH: number | null = null;
      let propuestaIdH: number | null = null;
      let campaniaIdH: number | null = null;

      const prop = await prisma.propuesta.findFirst({
        where: { id: idNum, deleted_at: null },
        select: { id: true, solicitud_id: true },
      });

      if (prop) {
        propuestaIdH = prop.id;
        solicitudIdH = prop.solicitud_id;
        const camp: any[] = await prisma.$queryRawUnsafe(`
          SELECT cm.id FROM cotizacion ct
          JOIN campania cm ON cm.cotizacion_id = ct.id
          WHERE ct.id_propuesta = ${idNum}
          LIMIT 1
        `);
        if (camp[0]) campaniaIdH = Number(camp[0].id);
      } else {
        const sol = await prisma.solicitud.findFirst({
          where: { id: idNum, deleted_at: null },
          select: { id: true },
        });
        if (sol) solicitudIdH = sol.id;
      }

      if (!solicitudIdH && !propuestaIdH && !campaniaIdH) continue;

      // ¿Ya existe tarea Autorización abierta apuntando a este registro?
      const existeTarea = await prisma.tareas.findFirst({
        where: {
          tipo: { contains: 'Autorización' },
          estatus: { notIn: ['Atendido', 'Cancelado', 'Rechazado'] },
          OR: [
            ...(solicitudIdH ? [{ id_solicitud: solicitudIdH.toString() }] : []),
            ...(propuestaIdH ? [{ id_propuesta: propuestaIdH.toString() }] : []),
            ...(campaniaIdH ? [{ campania_id: campaniaIdH }] : []),
          ],
        },
        select: { id: true },
      });
      if (existeTarea) continue;

      // Huérfano confirmado: reparar
      const pendientes: any[] = await prisma.$queryRawUnsafe(`
        SELECT id, autorizacion_dg, autorizacion_dcm FROM solicitudCaras
        WHERE idquote = '${idNum}'
          AND (autorizacion_dg = 'pendiente' OR autorizacion_dcm = 'pendiente')
      `);
      const pendDg = pendientes.filter(c => c.autorizacion_dg === 'pendiente').map(c => Number(c.id));
      const pendDcm = pendientes.filter(c => c.autorizacion_dcm === 'pendiente').map(c => Number(c.id));

      const origenH: 'solicitud' | 'propuesta' | 'campana' = campaniaIdH ? 'campana' : propuestaIdH ? 'propuesta' : 'solicitud';

      // Resolver creador real desde la solicitud (fallback Sistema=1)
      let responsableIdH = 1;
      let responsableNombreH = 'Sistema (reparación automática)';
      if (solicitudIdH) {
        const sol = await prisma.solicitud.findUnique({
          where: { id: solicitudIdH },
          select: { usuario_id: true, nombre_usuario: true },
        });
        if (sol?.usuario_id) {
          responsableIdH = sol.usuario_id;
          responsableNombreH = sol.nombre_usuario || responsableNombreH;
        }
      }

      try {
        console.warn(`[DepurarAutorizaciones] Huérfano detectado idquote=${idNum} pdg=${pdg} pdcm=${pdcm} origen=${origenH}; reparando...`);
        await crearTareasAutorizacion(
          solicitudIdH!,
          propuestaIdH,
          responsableIdH,
          responsableNombreH,
          pendDg,
          pendDcm,
          origenH,
          campaniaIdH || undefined,
        );
        huerfanosReparados++;
      } catch (err) {
        console.error(`[DepurarAutorizaciones] Error reparando huérfano idquote=${idNum}:`, err);
      }
    }
  } catch (err) {
    console.error('[DepurarAutorizaciones] Error en deteccion de huérfanos:', err);
  }

  console.log(`[DepurarAutorizaciones] ${finalizadas} de ${tareasAbiertas.length} tareas finalizadas; ${huerfanosReparados} huérfanos reparados`);
  return finalizadas;
}
