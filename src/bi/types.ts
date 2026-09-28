/**
 * Contrato de datos del BI. DEBE coincidir con bi-front/src/types/bi.ts.
 * Si cambias algo aquí, refléjalo en el front (o viceversa).
 */
export type BaseDatos = 'CIMU' | 'Trade' | 'UDC';

export interface FiltrosResumen {
  base: BaseDatos | null;
  /** Bases seleccionadas (multi). Vacío/undefined = todas. Sustituye a `base`. */
  bases?: string[];
  /** Tipo de artículo (columna `Tipo`): RT/BF/IN/IM/CT. Vacío = todos. */
  tipos?: string[];
  /** Palabras clave de mueble/formato sobre `Dscription` (PARABUS/COLUMNA/MACRO…). Vacío = todos. */
  muebles?: string[];
  /** `Tipo Digital`: Tradicional/Digital/Bonificacion. Vacío = todos. */
  digital?: string[];
  /** Nombre del asesor comercial (columna `U_Asesor`); null = todos */
  asesor: string | null;
  /** Nombre del cliente (columna `U_Cliente`); null = todos */
  cliente: string | null;
  anio: number;
  mes: number | null;
}

export interface VentaVsPpto {
  mes: number;
  etiqueta: string;
  ppto: number;
  aps: number;
}

export interface VentaSemana {
  semana: number;
  anio: number;
  etiqueta: string;
  monto: number;
}

export interface VentaCatorcena {
  catorcena: number;
  /** Mes (1–12) al que pertenece la catorcena, derivado de la columna `Mes`. */
  mes: number;
  etiqueta: string;
  aps: number;
  anioAnterior: number;
}

export interface VentaMensualComparada {
  mes: number;
  etiqueta: string;
  aps: number;
  anioAnterior: number;
}

export interface Kpi {
  id: string;
  titulo: string;
  valor: number;
  objetivo: number;
  tendencia: number[];
}

export interface ResumenVentas {
  actualizadoEn: string;
  promedioVentaSemanal: number;
  kpis: Kpi[];
  ventasVsPpto: VentaVsPpto[];
  ventasPorSemana: VentaSemana[];
  ventasPorCatorcena: VentaCatorcena[];
  ventasMensuales: VentaMensualComparada[];
}

/** Fila editable de presupuesto (la "meta" que pone IMU). */
export interface PresupuestoMes {
  anio: number;
  mes: number;
  /** null = aplica a todas las bases (meta global del mes) */
  base: BaseDatos | null;
  monto: number;
}

export const MESES_ES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

// ---------------- Historial de acciones ----------------

export type CategoriaAccion =
  | 'eliminacion'
  | 'autorizacion'
  | 'rechazo'
  | 'cambio_estado'
  | 'asignacion'
  | 'creacion'
  | 'post_sap'
  | 'otro';

/** Un evento del historial ya normalizado y legible. */
export interface EventoHistorial {
  id: number;
  fecha: string; // ISO
  tipo: string; // Campaña, Propuesta, autorizacion_aprobacion, ...
  accion: string;
  categoria: CategoriaAccion;
  usuario: string | null; // quién lo hizo
  refId: number | null;
  campania: string | null; // nombre de campaña si aplica
  /** Impacto en caras: negativo si quitó, positivo si agregó/aprobó, 0 si n/a. */
  caras: number;
  /** Delta en $ si el detalle lo trae (tarifa/inversión); si no, null. */
  monto: number | null;
  estadoAntes: string | null;
  estadoDespues: string | null;
  /** Caras antes/después, agregadas sobre TODAS las caras editadas (ediciones de campaña/propuesta). null si el detalle no las trae. */
  carasAntes: number | null;
  carasDespues: number | null;
  /** Inversión (costo) antes/después, agregada sobre todas las caras editadas. null si no aplica. */
  invAntes: number | null;
  invDespues: number | null;
  descripcion: string; // texto legible
  /** Tipo de edición legible: Eliminar circuito / Alza de caras / Edición de tarifa / Cambio de periodo / … */
  tipoEdicion?: string;
  // ids de las caras editadas (solicitudCaras.id) — permiten atribución exacta.
  caraIds?: number[];
  // Códigos de circuito tocados (p.ej. RT-P1-COB-MX, IM-...). Del detalle.
  articulos?: string[];
  // Unidad de la cantidad: 'impresiones' si el/los artículo(s) son de impresión (IM-), si no 'caras'.
  unidad?: 'caras' | 'impresiones';
  // Formato/mueble (PARABUS/COLUMNA…) y periodo del circuito, tomados del detalle (para eliminación).
  formatoDetalle?: string | null;
  periodoDetalle?: string | null;
  // Tarifa PÚBLICA (precio unitario) antes/después — distinta del costo/inversión.
  tarifaAntes?: number | null;
  tarifaDespues?: number | null;
  // Flags de qué cambió realmente (para los chips y el filtro "Movimiento").
  cambioCaras?: boolean;
  cambioTarifa?: boolean;
  // Eliminación ejecutada vía autorización (queda atribuida al gerente que autorizó).
  viaAutorizacion?: boolean;
  // Atributos EXACTOS de las caras editadas (solo en /reportes/impacto, filtros del jefe).
  cliente?: string | null;
  asesor?: string | null;
  marca?: string | null;
  status?: string | null;
  plazas?: string[];
  formatos?: string[];
  muebles?: string[];
  /** Base (sap_database de la solicitud): CIMU / TRADE / UDC. */
  base?: string | null;
  /** Alguna cara editada ya tiene APS asignado (posteado). */
  tieneAps?: boolean;
}

export interface FiltrosHistorial {
  categoria: CategoriaAccion | null;
  campaniaId: number | null;
  usuario: string | null;
  tipo: string | null;
  /** true = solo eventos que mueven caras (impacto ≠ 0). */
  soloImpacto: boolean;
  desde: string | null; // ISO
  hasta: string | null; // ISO
  limit: number;
}

export interface PuntoActividad {
  fecha: string; // YYYY-MM-DD
  eventos: number;
  carasAgregadas: number;
  carasQuitadas: number;
  neto: number;
}

export interface ConteoNombre {
  /** id de la campaña (solo en topCampanias); permite filtrar por servidor. */
  id?: number;
  nombre: string;
  valor: number;
  eventos: number;
}

/** Detalle de una propuesta/campaña + su línea de tiempo completa. */
export interface ContextoHistorial {
  refId: number;
  campania: string | null;
  cliente: string | null;
  asesor: string | null;
  marca: string | null;
  status: string | null;
  descripcion: string | null;
  inversion: number | null;
  eventos: EventoHistorial[];
}

export interface ResumenHistorial {
  actualizadoEn: string;
  desde: string;
  hasta: string;
  totalEventos: number;
  carasAgregadas: number;
  carasQuitadas: number;
  netoCaras: number;
  autorizaciones: { total: number; dg: number; dcm: number; rechazos: number; carasAprobadas: number };
  porDia: PuntoActividad[];
  porCategoria: ConteoNombre[];
  topUsuarios: ConteoNombre[]; // por # de acciones
  topQuitadores: ConteoNombre[]; // por caras quitadas
  topCampanias: ConteoNombre[]; // por # de acciones
  variacionPorUsuario: VariacionUsuario[]; // alzas/bajas/neto de caras por persona
}

/** Variación de caras de una persona: aprobó (alzas) vs quitó (bajas). */
export interface VariacionUsuario {
  nombre: string;
  alzas: number;
  bajas: number;
  neto: number;
}

// ---------------- Embudo de conversión ----------------

export interface EtapaEmbudo {
  nombre: string;
  valor: number;
  /** % respecto a la primera etapa */
  pct: number;
}

export interface Embudo {
  etapas: EtapaEmbudo[];
  solicitud: ConteoNombre[];
  propuesta: ConteoNombre[];
  campania: ConteoNombre[];
  totales: { solicitudes: number; propuestas: number; campanias: number };
}

/** Monto/caras agrupados por una dimensión (plaza, asesor, cliente, mueble…). */
export interface ConteoMonto {
  nombre: string;
  monto: number;
  caras: number;
  n: number;
}

export type Dimension = 'plaza' | 'digital' | 'asesor' | 'cliente' | 'mueble' | 'categoria' | 'marca' | 'producto';

/** Filtros compartidos de los reportes (barra de la tab Embudo). */
export interface FiltrosReporte {
  anio: number;
  mes: number | null;      // 1–12; null = todos
  plaza: string | null;    // U_dscSitio (V_APS)
  formato: string | null;  // Tipo Digital
  mueble: string | null;   // Dscription (limpio)
  cliente: string | null;  // U_Cliente / razon_social
  asesor: string | null;   // nombre canónico (normalizado)
  // Multi-selección de período (para V_APS: venta real del período). Vacío = todos.
  meses?: number[];        // 1–12
  catorcenas?: number[];   // número de catorcena
  semanas?: number[];      // semana ISO
}

/** Opciones para los dropdowns de la barra de filtros. */
export interface OpcionesReporte {
  plaza: string[];
  formato: string[];
  mueble: string[];
  cliente: string[];
  asesor: string[];
}

export type Periodo = 'mes' | 'catorcena' | 'semana';

/** Ventas reales agregadas por período (para el avance de objetivos). */
export interface ConteoPeriodo {
  periodo: number;
  monto: number;
  caras: number;
}

/** Ciclo de venta: tiempos entre transiciones de estatus. */
export interface Ciclo {
  etapas: { de: string; a: string; dias: number }[];
  cicloTotalDias: number;
  conversionGlobalPct: number;
  total: number;
}

/** Fila de "Detalle de campañas". */
export interface CampaniaDetalle {
  id: number;
  nombre: string;
  status: string | null;
  totalCaras: number;
  /** Inversión de la campaña (propuesta.inversion). */
  monto: number;
  fechaInicio: string | null;
  fechaFin: string | null;
  /** Fecha de creación (propuesta.fecha; campania no tiene columna propia). */
  fechaCreacion: string | null;
  cliente: string | null;
  asesor: string | null;
}

/** Impacto en inversión (ediciones con delta de $). */
export interface PuntoImpacto {
  monto: number;
  caras: number;
  campania: string | null;
  usuario: string | null;
  fecha: string;
}
export interface Impacto {
  total: number;
  promedio: number;
  count: number;
  mayor: EventoHistorial | null;
  puntos: PuntoImpacto[];
  ediciones: EventoHistorial[];
}
