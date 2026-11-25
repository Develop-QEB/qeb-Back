import { apiGet } from './api';
import type { UsuarioMcp } from './auth';
import { hasFullVisibility } from '../utils/permissions';

/**
 * Herramientas del MCP. Fase 1: solo lectura.
 *
 * Reglas para agregar una herramienta:
 *  - Pensarla por intención del usuario, no por endpoint.
 *  - Devolver solo los campos útiles en un chat, nunca el JSON crudo de la API.
 *  - Fijar aquí el tope de resultados; no confiar en el que pida el modelo.
 *  - La descripción es lo que el modelo lee para decidir: escribirla con cuidado.
 */

export interface HerramientaMcp {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  ejecutar(args: Record<string, unknown>, usuario: UsuarioMcp): Promise<unknown>;
}

interface FilaCatorcena {
  a_o: number;
  numero_catorcena: number;
  fecha_inicio: string;
  fecha_fin: string;
}

const dia = (iso: string) => String(iso).slice(0, 10);

/** Suma días a una fecha 'YYYY-MM-DD'. */
function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Fecha de hoy en CDMX ('YYYY-MM-DD'), sin depender de la zona horaria del servidor. */
const hoyCdmx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

/**
 * La tabla `catorcenas` guarda las fechas corridas +1 día respecto a la operación real
 * (la catorcena inicia en lunes, la tabla guarda el martes). Por eso:
 *  - la vigente es la que contiene MAÑANA en términos de la tabla
 *    (misma regla que dashboard.controller.getFilterOptions), y
 *  - las fechas reales son las de la tabla menos un día.
 */
const describir = (c: FilaCatorcena) => ({
  catorcena: c.numero_catorcena,
  anio: c.a_o,
  inicia: sumarDias(dia(c.fecha_inicio), -1),
  termina: sumarDias(dia(c.fecha_fin), -1),
});

const catorcenaActual: HerramientaMcp = {
  name: 'catorcena_actual',
  title: 'Catorcena actual',
  description:
    'Devuelve la catorcena vigente hoy en QEB (número, año y fechas reales de lunes a domingo) y la siguiente. ' +
    'Una catorcena es un periodo de 14 días; el año tiene 26. Úsala siempre que el usuario diga "esta catorcena", ' +
    '"la catorcena actual", "la siguiente catorcena" o pregunte en qué catorcena estamos, antes de filtrar por periodo.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async ejecutar(_args, usuario) {
    const r = await apiGet<{ data: FilaCatorcena[] }>(usuario, '/solicitudes/catorcenas');
    const filas = [...(r.data || [])].sort((a, b) => dia(a.fecha_inicio).localeCompare(dia(b.fecha_inicio)));
    const hoy = hoyCdmx();
    const ref = sumarDias(hoy, 1);
    const i = filas.findIndex(c => dia(c.fecha_inicio) <= ref && dia(c.fecha_fin) >= ref);
    if (i === -1) return { hoy, actual: null, nota: 'No hay una catorcena registrada para la fecha de hoy.' };
    return {
      hoy,
      actual: describir(filas[i]),
      siguiente: filas[i + 1] ? describir(filas[i + 1]) : null,
    };
  },
};

// ---------------------------------------------------------------------------
// Búsquedas en Solicitudes / Propuestas / Campañas
// ---------------------------------------------------------------------------

const POR_PAGINA = 25;
const ESTATUS_TTL_MS = 10 * 60 * 1000;

type Modulo = 'solicitudes' | 'propuestas' | 'campanas';
type Fila = Record<string, any>;

/** Error por un argumento mal dado; su mensaje se le muestra al modelo para que corrija. */
class ErrorDeUso extends Error {}

const texto = (v: unknown, max = 160): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const numero = (v: unknown): number | undefined => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? undefined : Math.round(n * 100) / 100;
};
const cat = (n: unknown, anio: unknown) => (n && anio ? `Cat ${n}/${anio}` : undefined);

/** Periodo legible. En catorcenal se dan las catorcenas (las fechas de la BD están corridas +1 día). */
function periodo(tipo: unknown, ini: string | undefined, fin: string | undefined, fIni: unknown, fFin: unknown) {
  if (tipo === 'mensual') {
    const a = fIni ? dia(String(fIni)) : undefined;
    const b = fFin ? dia(String(fFin)) : undefined;
    return a && b ? `${a} a ${b} (mensual)` : undefined;
  }
  if (!ini) return undefined;
  return !fin || fin === ini ? ini : `${ini} a ${fin}`;
}

/** Circuitos pendientes de autorización, solo si hay alguno. */
function autorizacion(r: unknown) {
  const a = (r || {}) as Record<string, number>;
  const out: Record<string, number> = {};
  if (a.pend_dg) out.pendientes_dg = a.pend_dg;
  if (a.pend_dcm) out.pendientes_dcm = a.pend_dcm;
  if (a.correccion) out.en_correccion = a.correccion;
  if (a.rechazado) out.rechazados = a.rechazado;
  return Object.keys(out).length ? out : undefined;
}

/** Campos que se devuelven al chat por módulo (la API trae muchos más, pensados para la pantalla). */
const RECORTE: Record<Modulo, (f: Fila) => Fila> = {
  solicitudes: f => ({
    id: f.id,
    estatus: f.status,
    campana: texto(f.nombre_campania),
    cliente: texto(f.razon_social),
    marca: texto(f.marca_nombre),
    producto: texto(f.producto_nombre),
    asesor: texto(f.asesor),
    agencia: texto(f.agencia),
    creada_por: texto(f.nombre_usuario),
    asignados: texto(f.asignado),
    fecha_creacion: f.fecha ? dia(f.fecha) : undefined,
    periodo: periodo(f.tipo_periodo, cat(f.catorcena_inicio, f.anio_inicio), cat(f.catorcena_fin, f.anio_fin), f.periodo_fecha_inicio, f.periodo_fecha_fin),
    formatos: texto(f.formatos),
    presupuesto: numero(f.presupuesto),
    autorizacion: autorizacion(f.autorizacion_resumen),
  }),
  propuestas: f => ({
    id: f.id,
    estatus: f.status,
    campana: texto(f.campana_nombre),
    cliente: texto(f.nombre_comercial),
    marca: texto(f.marca_nombre || f.marca),
    producto: texto(f.producto),
    asesor: texto(f.asesor),
    agencia: texto(f.agencia),
    creada_por: texto(f.creador_nombre),
    asignados: texto(f.asignado),
    periodo: periodo(f.tipo_periodo, cat(f.catorcena_inicio, f.anio_inicio), cat(f.catorcena_fin, f.anio_fin), f.fecha_inicio, f.fecha_fin),
    formatos: texto(f.formatos),
    caras: numero(f.caras_esperadas_total),
    precio: numero(f.precio),
    autorizacion: autorizacion(f.autorizacion_resumen),
    ultima_actualizacion: f.updated_at ? dia(f.updated_at) : undefined,
  }),
  campanas: f => ({
    id: f.id,
    estatus: f.status,
    campana: texto(f.nombre),
    cliente: texto(f.cliente_nombre),
    razon_social: texto(f.cliente_razon_social),
    marca: texto(f.T2_U_Marca),
    producto: texto(f.T2_U_Producto),
    asesor: texto(f.T0_U_Asesor),
    agencia: texto(f.T0_U_Agencia),
    unidad_negocio: texto(f.T1_U_UnidadNegocio),
    creada_por: texto(f.creador_nombre),
    periodo: periodo(f.tipo_periodo, cat(f.catorcena_inicio_num, f.catorcena_inicio_anio), cat(f.catorcena_fin_num, f.catorcena_fin_anio), f.fecha_inicio, f.fecha_fin),
    formatos: texto(f.formatos),
    caras: numero(f.total_caras),
    bonificacion: numero(f.bonificacion) || undefined,
    circuitos: numero(f.circuitos),
    inversion: numero(f.inversion),
    tiene_aps: Boolean(f.has_aps),
    autorizacion: autorizacion(f.autorizacion_resumen),
  }),
};

// ---- estatus: se aceptan nombres aproximados y se resuelven contra los reales ----

const normalizar = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const estatusCache = new Map<string, { lista: string[]; hasta: number }>();

/** Estatus que existen hoy en el módulo para este usuario (de /stats), 10 min en memoria. */
async function estatusReales(usuario: UsuarioMcp, modulo: Modulo): Promise<string[]> {
  const k = `${usuario.id}:${modulo}`;
  const c = estatusCache.get(k);
  if (c && c.hasta > Date.now()) return c.lista;
  const r = await apiGet<{ data: { byStatus?: Record<string, number> } }>(usuario, `/${modulo}/stats`);
  const lista = Object.keys(r.data?.byStatus || {});
  estatusCache.set(k, { lista, hasta: Date.now() + ESTATUS_TTL_MS });
  return lista;
}

/**
 * El mismo estatus se escribe distinto según el módulo ("Ajuste Cto-Cliente" en propuestas,
 * "Ajuste CTO Cliente" en campañas), así que no se le exige al modelo el nombre exacto.
 */
async function resolverEstatus(usuario: UsuarioMcp, modulo: Modulo, pedidos: unknown): Promise<string[]> {
  const lista = (Array.isArray(pedidos) ? pedidos : pedidos ? [pedidos] : []).map(p => String(p).trim()).filter(Boolean);
  if (lista.length === 0) return [];
  const reales = await estatusReales(usuario, modulo);
  const out = new Set<string>();
  for (const p of lista) {
    const n = normalizar(p);
    const exactos = reales.filter(r => normalizar(r) === n);
    const hallados = exactos.length
      ? exactos
      : reales.filter(r => n.length >= 3 && (normalizar(r).includes(n) || n.includes(normalizar(r))));
    if (hallados.length === 0) {
      throw new ErrorDeUso(`No hay ${NOMBRE[modulo]} con estatus "${p}". Estatus con registros: ${reales.join(', ') || 'ninguno'}.`);
    }
    hallados.forEach(h => out.add(h));
  }
  return [...out];
}

// ---- periodo ----

function entero(v: unknown, nombre: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ErrorDeUso(`${nombre} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

function filtroPeriodo(args: Record<string, unknown>): { params: Record<string, number>; descripcion?: string } {
  const c1 = entero(args.catorcena, 'catorcena', 1, 26);
  const a1 = entero(args.anio, 'anio', 2015, 2100);
  const c2 = entero(args.catorcena_fin, 'catorcena_fin', 1, 26);
  const a2 = entero(args.anio_fin, 'anio_fin', 2015, 2100);
  if (c1 === undefined && c2 !== undefined) throw new ErrorDeUso('catorcena_fin requiere catorcena.');
  if (c1 !== undefined && a1 === undefined) {
    throw new ErrorDeUso('Indica también el anio de la catorcena (usa catorcena_actual si el usuario dijo "esta catorcena").');
  }
  if (a1 === undefined) return { params: {} };
  const anioFin = a2 ?? a1;
  if (c1 === undefined) {
    return { params: { yearInicio: a1, yearFin: anioFin }, descripcion: a1 === anioFin ? `año ${a1}` : `${a1} a ${anioFin}` };
  }
  const catFin = c2 ?? c1;
  const ini = `Cat ${c1}/${a1}`;
  const fin = `Cat ${catFin}/${anioFin}`;
  return {
    params: { yearInicio: a1, yearFin: anioFin, catorcenaInicio: c1, catorcenaFin: catFin },
    descripcion: ini === fin ? ini : `${ini} a ${fin}`,
  };
}

const PROPS_PERIODO = {
  catorcena: { type: 'integer', minimum: 1, maximum: 26, description: 'Número de catorcena (1 a 26). Requiere anio.' },
  anio: { type: 'integer', description: 'Año, p. ej. 2026. Si va solo, filtra todo el año.' },
  catorcena_fin: { type: 'integer', minimum: 1, maximum: 26, description: 'Para un rango: última catorcena. Si se omite, es la misma que catorcena.' },
  anio_fin: { type: 'integer', description: 'Para un rango que cruza de año: año de catorcena_fin.' },
};

const NOMBRE: Record<Modulo, string> = { solicitudes: 'solicitudes', propuestas: 'propuestas', campanas: 'campañas' };

function crearBusqueda(modulo: Modulo, name: string, title: string, description: string): HerramientaMcp {
  return {
    name,
    title,
    description:
      `${description} Devuelve hasta ${POR_PAGINA} por página, solo de lo que el usuario puede ver en QEB. ` +
      'El estatus se puede dar con nombre aproximado (p. ej. "ajuste cto"). Todos los filtros son opcionales y se combinan.',
    inputSchema: {
      type: 'object',
      properties: {
        estatus: { type: 'array', items: { type: 'string' }, description: 'Uno o varios estatus. Si se omite, no filtra por estatus.' },
        busqueda: { type: 'string', description: 'Texto a buscar: cliente, marca, nombre de campaña, asesor, o un ID numérico.' },
        ...PROPS_PERIODO,
        pagina: { type: 'integer', minimum: 1, description: 'Página de resultados (1 por defecto).' },
      },
      additionalProperties: false,
    },
    async ejecutar(args, usuario) {
      const pagina = entero(args.pagina, 'pagina', 1, 10000) ?? 1;
      const estatus = await resolverEstatus(usuario, modulo, args.estatus);
      const per = filtroPeriodo(args);
      const busqueda = texto(args.busqueda, 100);
      const r = await apiGet<{ data: Fila[]; pagination?: { total: number; totalPages: number } }>(usuario, `/${modulo}`, {
        page: pagina,
        limit: POR_PAGINA,
        status: estatus.length ? estatus.join(',') : undefined,
        search: busqueda,
        ...per.params,
      });
      const filas = (r.data || []).slice(0, POR_PAGINA);
      const paginas = r.pagination?.totalPages ?? 1;
      return {
        total: r.pagination?.total ?? filas.length,
        pagina,
        paginas,
        filtros: { estatus: estatus.length ? estatus : 'todos', periodo: per.descripcion || 'todos', busqueda },
        // En campañas, con filtro de periodo la API suma solo los circuitos de ese periodo.
        aviso: modulo === 'campanas' && per.descripcion
          ? `La "inversion" de cada campaña corresponde solo a ${per.descripcion}, no al total de la campaña (para el total usa detalle_campana).`
          : undefined,
        [NOMBRE[modulo]]: filas.map(RECORTE[modulo]),
        nota: paginas > pagina ? `Hay más resultados: pide la página ${pagina + 1} o afina los filtros.` : undefined,
      };
    },
  };
}

const buscarSolicitudes = crearBusqueda(
  'solicitudes',
  'buscar_solicitudes',
  'Buscar solicitudes',
  'Busca solicitudes en QEB. Una solicitud es la petición comercial inicial de un asesor para un cliente; al atenderse da origen a una propuesta.',
);
const buscarPropuestas = crearBusqueda(
  'propuestas',
  'buscar_propuestas',
  'Buscar propuestas',
  'Busca propuestas en QEB. Una propuesta es la cotización con circuitos e inventario que se trabaja con el cliente antes de volverse campaña ' +
    '(estatus habituales: Abierto, Ajuste Cto-Cliente, Ajuste Comercial, Ajuste Inventario, Pase a ventas, Atendido, Aprobada).',
);
const buscarCampanas = crearBusqueda(
  'campanas',
  'buscar_campanas',
  'Buscar campañas',
  'Busca campañas en QEB. Una campaña es la propuesta ya vendida, con inventario reservado y seguimiento de artes e instalación ' +
    '(estatus habituales: Aprobada, Por iniciar, Inicializada, finalizada, Ajuste CTO Cliente, Cancelada).',
);

const resumenPorEstatus: HerramientaMcp = {
  name: 'resumen_por_estatus',
  title: 'Resumen por estatus',
  description:
    'Cuenta cuántas solicitudes, propuestas o campañas hay en cada estatus, opcionalmente dentro de un periodo. ' +
    'Úsala para preguntas de "cuántas hay" o "cómo vamos" antes de listar; es más ligera que una búsqueda.',
  inputSchema: {
    type: 'object',
    properties: {
      modulo: { type: 'string', enum: ['solicitudes', 'propuestas', 'campanas'], description: 'Qué contar.' },
      ...PROPS_PERIODO,
    },
    required: ['modulo'],
    additionalProperties: false,
  },
  async ejecutar(args, usuario) {
    const modulo = String(args.modulo) as Modulo;
    if (!RECORTE[modulo]) throw new ErrorDeUso('modulo debe ser solicitudes, propuestas o campanas.');
    const per = filtroPeriodo(args);
    const r = await apiGet<{ data: { total?: number; byStatus?: Record<string, number> } }>(usuario, `/${modulo}/stats`, per.params);
    return { modulo: NOMBRE[modulo], periodo: per.descripcion || 'todos', total: r.data?.total, por_estatus: r.data?.byStatus || {} };
  },
};

// ---------------------------------------------------------------------------
// Detalle de una propuesta / campaña con sus circuitos
// ---------------------------------------------------------------------------

const MAX_CIRCUITOS = 60;

let catorcenasCache: { filas: FilaCatorcena[]; hasta: number } | null = null;

/** Tabla de catorcenas (chica y casi inmutable): 10 min en memoria, compartida entre usuarios. */
async function tablaCatorcenas(usuario: UsuarioMcp): Promise<FilaCatorcena[]> {
  if (catorcenasCache && catorcenasCache.hasta > Date.now()) return catorcenasCache.filas;
  const r = await apiGet<{ data: FilaCatorcena[] }>(usuario, '/solicitudes/catorcenas');
  catorcenasCache = { filas: r.data || [], hasta: Date.now() + ESTATUS_TTL_MS };
  return catorcenasCache.filas;
}

/**
 * Trae el registro SOLO si el usuario lo ve en el listado del módulo.
 *
 * Importante: GET /campanas/:id, /propuestas/:id y sus /caras NO validan visibilidad
 * (cualquier usuario autenticado obtiene cualquier id). El listado sí la aplica, así que
 * el detalle se autoriza contra el listado antes de pedir nada por id.
 */
async function filaVisible(usuario: UsuarioMcp, modulo: Modulo, id: number): Promise<Fila> {
  const r = await apiGet<{ data: Fila[] }>(usuario, `/${modulo}`, { search: id, limit: POR_PAGINA, page: 1 });
  const fila = (r.data || []).find(f => Number(f.id) === id);
  if (!fila) throw new ErrorDeUso(`No existe ese registro en ${NOMBRE[modulo]} con ID ${id}, o no tienes acceso a él.`);
  return fila;
}

async function circuitosDe(usuario: UsuarioMcp, modulo: 'propuestas' | 'campanas', id: number, tipoPeriodo: unknown) {
  const [r, cats] = await Promise.all([
    apiGet<{ data: Fila[] }>(usuario, `/${modulo}/${id}/caras`),
    tablaCatorcenas(usuario),
  ]);
  return resumirCircuitos(r.data || [], cats, tipoPeriodo);
}

function resumirCircuitos(caras: Fila[], cats: FilaCatorcena[], tipoPeriodo: unknown) {
  const etiqueta = (c: Fila): string => {
    const ini = c.inicio_periodo ? dia(c.inicio_periodo) : '';
    const fin = c.fin_periodo ? dia(c.fin_periodo) : '';
    if (!ini) return 'sin periodo';
    if (tipoPeriodo === 'mensual') return `${ini} a ${fin}`;
    const a = cats.find(x => dia(x.fecha_inicio) <= ini && dia(x.fecha_fin) >= ini);
    const b = cats.find(x => dia(x.fecha_inicio) <= fin && dia(x.fecha_fin) >= fin);
    if (!a) return `${ini} a ${fin}`;
    const la = `Cat ${a.numero_catorcena}/${a.a_o}`;
    const lb = b ? `Cat ${b.numero_catorcena}/${b.a_o}` : la;
    return la === lb ? la : `${la} a ${lb}`;
  };

  const porPeriodo: Record<string, { circuitos: number; caras_renta: number; caras_bonificadas: number; importe: number }> = {};
  const totales = { circuitos: caras.length, caras_renta: 0, caras_bonificadas: 0, importe: 0 };
  const lista = caras.map(c => {
    const per = etiqueta(c);
    const renta = Number(c.caras) || 0;
    const bonif = Number(c.bonificacion) || 0;
    const importe = Number(c.costo) || 0;
    const p = (porPeriodo[per] ||= { circuitos: 0, caras_renta: 0, caras_bonificadas: 0, importe: 0 });
    p.circuitos += 1; p.caras_renta += renta; p.caras_bonificadas += bonif; p.importe += importe;
    totales.caras_renta += renta; totales.caras_bonificadas += bonif; totales.importe += importe;
    const pendiente = [c.autorizacion_dg, c.autorizacion_dcm].some(a => a && a !== 'aprobado');
    return {
      articulo: c.articulo,
      formato: texto(c.formato),
      tipo: c.tipo,
      plaza: texto(c.estados),
      ciudades: texto(c.ciudad, 90),
      periodo: per,
      caras_renta: renta,
      caras_bonificadas: bonif || undefined,
      flujo: numero(c.caras_flujo),
      contraflujo: numero(c.caras_contraflujo),
      tarifa_publica: numero(c.tarifa_publica),
      importe: numero(importe),
      descuento: numero(c.descuento) || undefined,
      horario: c.hora_inicio && c.hora_fin ? `${c.hora_inicio} a ${c.hora_fin}` : undefined,
      autorizacion: pendiente ? { dg: c.autorizacion_dg, dcm: c.autorizacion_dcm } : undefined,
    };
  });
  for (const p of [totales, ...Object.values(porPeriodo)]) p.importe = Math.round(p.importe * 100) / 100;

  return {
    totales,
    por_periodo: porPeriodo,
    circuitos: lista.slice(0, MAX_CIRCUITOS),
    nota: lista.length > MAX_CIRCUITOS
      ? `Se muestran ${MAX_CIRCUITOS} de ${lista.length} circuitos; los totales y por_periodo sí incluyen todos.`
      : undefined,
  };
}

const SCHEMA_ID = (que: string) => ({
  type: 'object',
  properties: { id: { type: 'integer', minimum: 1, description: `ID de la ${que} (el que devuelven las búsquedas).` } },
  required: ['id'],
  additionalProperties: false,
});

function idDe(args: Record<string, unknown>): number {
  const id = entero(args.id, 'id', 1, 2_000_000_000);
  if (id === undefined) throw new ErrorDeUso('Falta el id.');
  return id;
}

const detalleCampana: HerramientaMcp = {
  name: 'detalle_campana',
  title: 'Detalle de campaña',
  description:
    'Abre una campaña por su ID: datos generales (cliente, marca, asesor, asignados, periodo, APS, notas) y el desglose de sus circuitos ' +
    '(artículo, formato, plaza, ciudades, catorcena, caras de renta y bonificadas, flujo/contraflujo, tarifa e importe), con totales y ' +
    'subtotales por catorcena. Úsala para preguntas sobre una campaña concreta. Si solo tienes el nombre, primero usa buscar_campanas.',
  inputSchema: SCHEMA_ID('campaña'),
  async ejecutar(args, usuario) {
    const id = idDe(args);
    const fila = await filaVisible(usuario, 'campanas', id);
    const [det, circ] = await Promise.all([
      apiGet<{ data: Fila }>(usuario, `/campanas/${id}`),
      circuitosDe(usuario, 'campanas', id, fila.tipo_periodo),
    ]);
    const d = det.data || {};
    const { inversion: _inv, caras: _c, circuitos: _n, ...general } = RECORTE.campanas(fila);
    return {
      ...general,
      asignados: texto(d.asignado, 300),
      descripcion: texto(d.descripcion, 300),
      notas: texto(d.notas, 300),
      aps: Array.isArray(d.posted_aps) && d.posted_aps.length ? d.posted_aps : undefined,
      inventario_reservado: numero(d.reservas_count),
      propuesta_id: d.propuesta_id,
      ...circ,
    };
  },
};

const detallePropuesta: HerramientaMcp = {
  name: 'detalle_propuesta',
  title: 'Detalle de propuesta',
  description:
    'Abre una propuesta por su ID: datos generales (cliente, marca, asesor, asignados, periodo, estatus, notas) y el desglose de sus circuitos ' +
    '(artículo, formato, plaza, ciudades, catorcena, caras de renta y bonificadas, tarifa, importe y autorizaciones pendientes), con totales y ' +
    'subtotales por catorcena. Úsala para preguntas sobre una propuesta concreta. Si solo tienes el nombre, primero usa buscar_propuestas.',
  inputSchema: SCHEMA_ID('propuesta'),
  async ejecutar(args, usuario) {
    const id = idDe(args);
    const fila = await filaVisible(usuario, 'propuestas', id);
    const [det, circ] = await Promise.all([
      apiGet<{ data: Fila }>(usuario, `/propuestas/${id}`),
      circuitosDe(usuario, 'propuestas', id, fila.tipo_periodo),
    ]);
    const d = det.data || {};
    const { precio: _p, caras: _c, asignados: _a, ...general } = RECORTE.propuestas(fila);
    return {
      ...general,
      asignados: texto(fila.asignado, 300),
      descripcion: texto(d.descripcion, 300),
      notas: texto(d.notas, 300),
      campania_id: fila.campania_id,
      solicitud_id: fila.solicitud_id,
      ...circ,
    };
  },
};

const detalleSolicitud: HerramientaMcp = {
  name: 'detalle_solicitud',
  title: 'Detalle de solicitud',
  description:
    'Abre una solicitud por su ID: datos generales (cliente, marca, asesor, asignados, periodo, presupuesto, estatus, notas), el desglose de ' +
    'sus circuitos (artículo, formato, plaza, catorcena, caras, tarifa, importe y autorizaciones pendientes) con totales por catorcena, ' +
    'y sus últimos comentarios. Si solo tienes el nombre, primero usa buscar_solicitudes.',
  inputSchema: SCHEMA_ID('solicitud'),
  async ejecutar(args, usuario) {
    const id = idDe(args);
    const fila = await filaVisible(usuario, 'solicitudes', id);
    const [det, cats] = await Promise.all([
      apiGet<{ data: { solicitud?: Fila; propuesta?: Fila; campania?: Fila; caras?: Fila[]; comentarios?: Fila[] } }>(usuario, `/solicitudes/${id}`),
      tablaCatorcenas(usuario),
    ]);
    const d = det.data || {};
    const comentarios = [...(d.comentarios || [])]
      .sort((a, b) => String(b.creado_en).localeCompare(String(a.creado_en)))
      .slice(0, 10)
      .map(c => ({ autor: texto(c.autor_nombre), fecha: c.creado_en ? dia(c.creado_en) : undefined, comentario: texto(c.comentario, 400) }));
    return {
      ...RECORTE.solicitudes(fila),
      asignados: texto(fila.asignado, 300),
      descripcion: texto(d.solicitud?.descripcion, 300),
      notas: texto(d.solicitud?.notas, 300),
      propuesta_id: d.propuesta?.id,
      propuesta_estatus: d.propuesta?.status,
      campania_id: d.campania?.id,
      ...resumirCircuitos(d.caras || [], cats, fila.tipo_periodo),
      comentarios: comentarios.length ? comentarios : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Gestor de artes (Tareas de Seguimiento de una campaña)
// ---------------------------------------------------------------------------

const MAX_LISTA = 50;

const contar = (filas: Fila[], clave: (f: Fila) => unknown): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const f of filas) {
    const k = String(clave(f) ?? '').trim() || 'sin dato';
    o[k] = (o[k] || 0) + 1;
  }
  return o;
};
const catDe = (f: Fila) => (f.numero_catorcena && f.anio_catorcena ? `Cat ${f.numero_catorcena}/${f.anio_catorcena}` : 'sin catorcena');

const artesCampana: HerramientaMcp = {
  name: 'artes_campana',
  title: 'Gestor de artes de una campaña',
  description:
    'Estado del gestor de artes (Tareas de Seguimiento) de una campaña: cuántos espacios tienen arte y cuántos no, cuántos artes están ' +
    'aprobados, rechazados o en revisión, cuántos están instalados, cuántos testigos hay, todo desglosado por catorcena, y las tareas de la ' +
    'campaña (tipo, estatus, responsable, fecha límite). Con listar puedes pedir el listado de espacios de un grupo (hasta ' + MAX_LISTA + '). ' +
    'Úsala para "cómo van los artes", "qué falta por subir", "qué tareas tiene pendientes" de una campaña concreta.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1, description: 'ID de la campaña.' },
      listar: {
        type: 'string',
        enum: ['sin_arte', 'con_arte', 'testigos'],
        description: 'Opcional: además del resumen, lista los espacios de ese grupo.',
      },
      catorcena: { type: 'integer', minimum: 1, maximum: 26, description: 'Opcional, con listar: solo esa catorcena. Requiere anio.' },
      anio: { type: 'integer', description: 'Año de la catorcena.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async ejecutar(args, usuario) {
    const id = idDe(args);
    const fila = await filaVisible(usuario, 'campanas', id);
    const listar = args.listar ? String(args.listar) : undefined;
    if (listar && !['sin_arte', 'con_arte', 'testigos'].includes(listar)) throw new ErrorDeUso('listar debe ser sin_arte, con_arte o testigos.');
    const c = entero(args.catorcena, 'catorcena', 1, 26);
    const a = entero(args.anio, 'anio', 2015, 2100);
    if (c !== undefined && a === undefined) throw new ErrorDeUso('Indica también el anio de la catorcena.');

    const pedir = (sufijo: string) => apiGet<{ data: Fila[] }>(usuario, `/campanas/${id}/${sufijo}`).then(r => r.data || []);
    const [conArte, sinArte, testigos, tareas] = await Promise.all([
      pedir('inventario-arte'),
      pedir('inventario-sin-arte'),
      pedir('inventario-testigos'),
      pedir('tareas'),
    ]);

    const porCatorcena: Record<string, { con_arte: number; sin_arte: number; testigos: number }> = {};
    const sumar = (filas: Fila[], k: 'con_arte' | 'sin_arte' | 'testigos') => {
      for (const f of filas) (porCatorcena[catDe(f)] ||= { con_arte: 0, sin_arte: 0, testigos: 0 })[k] += 1;
    };
    sumar(conArte, 'con_arte'); sumar(sinArte, 'sin_arte'); sumar(testigos, 'testigos');

    const grupos: Record<string, Fila[]> = { sin_arte: sinArte, con_arte: conArte, testigos };
    let listado: Fila | undefined;
    if (listar) {
      const filtradas = grupos[listar].filter(f => c === undefined || (Number(f.numero_catorcena) === c && Number(f.anio_catorcena) === a));
      listado = {
        grupo: listar,
        total: filtradas.length,
        espacios: filtradas.slice(0, MAX_LISTA).map(f => ({
          codigo: texto(f.codigo_unico_display || f.codigo_unico),
          ubicacion: texto(f.ubicacion, 80),
          plaza: texto(f.plaza),
          formato: texto(f.mueble),
          cara: texto(f.tipo_de_cara_display || f.tipo_de_cara),
          tipo: texto(f.tradicional_digital),
          catorcena: catDe(f),
          articulo: texto(f.articulo),
          aps: f.APS || undefined,
          arte: texto(f.arte_aprobado),
          instalado: f.instalado === undefined ? undefined : Boolean(Number(f.instalado)),
          motivo_rechazo: texto(f.comentario_rechazo, 200),
          fecha_testigo: f.fecha_testigo ? dia(f.fecha_testigo) : undefined,
        })),
        nota: filtradas.length > MAX_LISTA ? `Se muestran ${MAX_LISTA} de ${filtradas.length}; filtra por catorcena para ver el resto.` : undefined,
      };
    }

    const pendientes = tareas.filter(t => !/atendid|aprobad|rechaz|complet|finaliz|cancel|resuel/i.test(String(t.estatus)));
    return {
      campana: { id, nombre: texto(fila.nombre), estatus: fila.status, cliente: texto(fila.cliente_nombre), asesor: texto(fila.T0_U_Asesor) },
      artes: {
        espacios_con_arte: conArte.length,
        espacios_sin_arte: sinArte.length,
        revision_de_arte: contar(conArte, f => f.arte_aprobado),
        instalados: conArte.filter(f => Number(f.instalado)).length,
        testigos: testigos.length,
        por_catorcena: porCatorcena,
      },
      tareas: {
        total: tareas.length,
        por_tipo_y_estatus: contar(tareas, t => `${t.tipo} · ${t.estatus}`),
        pendientes: pendientes.slice(0, 30).map(t => ({
          id: t.id,
          tipo: texto(t.tipo),
          titulo: texto(t.titulo, 100),
          estatus: t.estatus,
          responsable: texto(t.responsable_nombre || t.responsable),
          asignado: texto(t.asignado, 120),
          fecha_limite: t.fecha_fin ? dia(t.fecha_fin) : undefined,
        })),
        nota: pendientes.length > 30 ? `Se muestran 30 de ${pendientes.length} tareas pendientes.` : undefined,
      },
      listado,
    };
  },
};

// ---------------------------------------------------------------------------
// Inventarios
// ---------------------------------------------------------------------------

/**
 * Roles que ven el módulo Inventarios en la app. La API de /inventarios no restringe por
 * rol (lo hace el front con canSeeInventarios en front-qeb/src/lib/permissions.ts), así
 * que el MCP replica aquí esa lista para no dar más de lo que da la app.
 * MANTENER SINCRONIZADA con el front: un rol nuevo que deba ver inventarios se agrega aquí.
 */
const ROLES_INVENTARIO = [
  'Administrador', 'DEV', 'Gerente de Trafico', 'Bi Trafico', 'Coordinador de trafico', 'Especialista de trafico',
  'Auxiliar de trafico', 'Director General Adjunto', 'Director Comercial General', 'Director de Mercadotecnia',
  'Director Desarrollo de Nuevos Negocios', 'Gerente Comercial Vía Pública', 'Gerente Comercial Plazas', 'Jefe de BI',
  'Gerente de TI', 'Especialista de TI', 'Analista de TI', 'Jefe de Mejora Continua', 'Analista de Mejora Continua',
].map(normalizar);

function exigirInventario(usuario: UsuarioMcp): void {
  if (!ROLES_INVENTARIO.includes(normalizar(usuario.rol))) {
    throw new ErrorDeUso(`Tu rol (${usuario.rol}) no tiene acceso al módulo de Inventarios en QEB.`);
  }
}

const recorteInventario = (f: Fila) => ({
  id: f.id,
  codigo: texto(f.codigo_unico),
  ubicacion: texto(f.ubicacion, 100),
  formato: texto(f.mueble),
  cara: texto(f.tipo_de_cara),
  tipo: texto(f.tradicional_digital),
  plaza: texto(f.plaza),
  municipio: texto(f.municipio),
  estado: texto(f.estado),
  nse: texto(f.nivel_socioeconomico),
  estatus: texto(f.estatus),
  circuito: texto(f.cto),
});

const buscarInventario: HerramientaMcp = {
  name: 'buscar_inventario',
  title: 'Buscar inventario',
  description:
    'Busca espacios publicitarios (caras de muebles) en el inventario de QEB por texto (código o ubicación), plaza, formato, ' +
    'tipo (Tradicional o Digital) o estatus (Disponible, Bloqueado/No Disponible, Inhabilitado, Inactivo). Devuelve hasta ' + POR_PAGINA +
    ' por página. Ojo: "Disponible" aquí es el estatus administrativo del espacio, NO si está libre u ocupado por una campaña en una catorcena. ' +
    'Para saber cuántos hay por plaza o formato usa resumen_inventario.',
  inputSchema: {
    type: 'object',
    properties: {
      busqueda: { type: 'string', description: 'Código del espacio o texto de la ubicación (calle, cruce).' },
      plaza: { type: 'string', description: 'Plaza, p. ej. CIUDAD DE MÉXICO, GUADALAJARA, MONTERREY.' },
      formato: { type: 'string', description: 'Formato o mueble, p. ej. PARABUS, COLUMNA, MUPIS, PANTALLA DIGITAL, UNIPOLAR.' },
      tipo: { type: 'string', enum: ['Tradicional', 'Digital'] },
      estatus: { type: 'string', description: 'Disponible, Bloqueado, Inhabilitado o Inactivo.' },
      pagina: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  async ejecutar(args, usuario) {
    exigirInventario(usuario);
    const pagina = entero(args.pagina, 'pagina', 1, 10000) ?? 1;
    const [plazas, formatos] = await Promise.all([catalogoInventario(usuario, 'plazas'), catalogoInventario(usuario, 'tipos')]);
    const plaza = args.plaza ? elegir(String(args.plaza), plazas, 'plaza') : undefined;
    const formato = args.formato ? elegir(String(args.formato), formatos, 'formato') : undefined;
    const estatus = args.estatus ? elegir(String(args.estatus).replace(/no disponible/i, 'Bloqueado'), ['Disponible', 'Bloqueado', 'Inhabilitado', 'Inactivo'], 'estatus') : undefined;
    const tipo = args.tipo ? elegir(String(args.tipo), ['Tradicional', 'Digital'], 'tipo') : undefined;
    const busqueda = texto(args.busqueda, 100);
    const r = await apiGet<{ data: Fila[]; pagination?: { total: number; totalPages: number } }>(usuario, '/inventarios', {
      page: pagina, limit: POR_PAGINA, search: busqueda, plaza, tipo: formato, estatus, tradicional: tipo,
    });
    const filas = (r.data || []).slice(0, POR_PAGINA);
    const paginas = r.pagination?.totalPages ?? 1;
    return {
      total: r.pagination?.total ?? filas.length,
      pagina,
      paginas,
      filtros: { busqueda, plaza, formato, tipo, estatus },
      inventario: filas.map(recorteInventario),
      nota: paginas > pagina ? `Hay más resultados: pide la página ${pagina + 1} o afina los filtros.` : undefined,
    };
  },
};

const catalogosCache = new Map<string, { lista: string[]; hasta: number }>();

/** Catálogos de plazas y formatos del inventario (10 min en memoria). */
async function catalogoInventario(usuario: UsuarioMcp, cual: 'plazas' | 'tipos'): Promise<string[]> {
  const c = catalogosCache.get(cual);
  if (c && c.hasta > Date.now()) return c.lista;
  const r = await apiGet<{ data: string[] }>(usuario, `/inventarios/${cual}`);
  const lista = (r.data || []).filter(Boolean);
  catalogosCache.set(cual, { lista, hasta: Date.now() + ESTATUS_TTL_MS });
  return lista;
}

/** Resuelve un valor aproximado ("cdmx", "guadalajara", "parabus") contra el catálogo real. */
function elegir(pedido: string, opciones: string[], nombre: string): string {
  const alias: Record<string, string> = { cdmx: 'ciudaddemexico', df: 'ciudaddemexico', gdl: 'guadalajara', mty: 'monterrey', edomex: 'estadodemexico' };
  const n = alias[normalizar(pedido)] || normalizar(pedido);
  const exactos = opciones.filter(o => normalizar(o) === n);
  const hallados = exactos.length ? exactos : opciones.filter(o => n.length >= 3 && normalizar(o).includes(n));
  if (hallados.length === 0) throw new ErrorDeUso(`No existe ${nombre} "${pedido}". Opciones: ${opciones.join(', ')}.`);
  // Con varias coincidencias se prefiere la escrita en mayúsculas (la canónica del catálogo).
  return hallados.find(h => h === h.toUpperCase()) || hallados[0];
}

const resumenInventario: HerramientaMcp = {
  name: 'resumen_inventario',
  title: 'Resumen de inventario',
  description:
    'Totales del inventario de QEB: cuántos espacios hay en total, cuántos disponibles y cuántos bloqueados, y el conteo por formato y por plaza. ' +
    'Úsala para "cuántos parabuses hay", "cuánto inventario tenemos en Guadalajara" y preguntas de volumen.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async ejecutar(_args, usuario) {
    exigirInventario(usuario);
    const r = await apiGet<{ data: Fila }>(usuario, '/inventarios/stats');
    const d = r.data || {};
    const mapa = (lista: unknown, clave: string) =>
      Object.fromEntries((Array.isArray(lista) ? lista : []).map((x: Fila) => [String(x[clave] ?? 'sin dato'), Number(x.cantidad) || 0]));
    return {
      total: d.total,
      disponibles: d.disponibles,
      bloqueados: d.bloqueados,
      por_formato: mapa(d.porTipo, 'tipo'),
      por_plaza: mapa(d.porPlaza, 'plaza'),
      nota: 'Disponibles/bloqueados es el estatus administrativo del espacio, no su ocupación por campañas.',
    };
  },
};

const detalleInventario: HerramientaMcp = {
  name: 'detalle_inventario',
  title: 'Detalle de un espacio de inventario',
  description:
    'Ficha de un espacio del inventario por su ID: código, ubicación y cruces, plaza, municipio, formato, cara, medidas, tipo, ' +
    'nivel socioeconómico, coordenadas, estatus y, si está bloqueado, el tipo y la vigencia del bloqueo. ' +
    'El ID sale de buscar_inventario.',
  inputSchema: SCHEMA_ID('cara de inventario'),
  async ejecutar(args, usuario) {
    exigirInventario(usuario);
    const id = idDe(args);
    const r = await apiGet<{ data: Fila }>(usuario, `/inventarios/${id}`);
    const f = r.data || {};
    return {
      ...recorteInventario(f),
      codigo_postal: f.cp || undefined,
      entre_calles: [f.entre_calle_1, f.entre_calle_2].filter(Boolean).join(' y ') || undefined,
      sentido: texto(f.sentido),
      orientacion: texto(f.orientacion),
      medidas_m: f.ancho && f.alto ? `${f.ancho} x ${f.alto}` : undefined,
      espacios: numero(f.total_espacios),
      isla: texto(f.isla),
      tarifa_publica: numero(f.tarifa_publica),
      coordenadas: f.latitud && f.longitud ? { lat: f.latitud, lng: f.longitud } : undefined,
      bloqueo: f.bloqueo_tipo
        ? {
            tipo: f.bloqueo_tipo,
            desde: f.bloqueo_fecha_inicio ? dia(f.bloqueo_fecha_inicio) : undefined,
            hasta: f.bloqueo_fecha_fin ? dia(f.bloqueo_fecha_fin) : undefined,
          }
        : undefined,
    };
  },
};

const miPerfil: HerramientaMcp = {
  name: 'mi_perfil',
  title: 'Mi perfil en QEB',
  description:
    'Dice con qué usuario de QEB está conectado este conector: nombre, rol, si ve todos los registros o solo aquellos en los que participa, ' +
    'y contra qué ambiente (producción o pruebas) se está consultando. Úsala cuando pregunten "quién soy", "con qué perfil estás", ' +
    '"de quién son estos datos", o para explicar por qué aparecen o no ciertos registros.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async ejecutar(_args, usuario) {
    const total = hasFullVisibility(usuario.rol);
    return {
      usuario: usuario.nombre.trim(),
      correo: usuario.email,
      rol: usuario.rol,
      visibilidad: total
        ? 'Total: ve las solicitudes, propuestas y campañas de todos los usuarios, no solo las propias.'
        : 'Limitada: solo ve las solicitudes, propuestas y campañas donde participa (como creador, asignado o por su equipo).',
      ambiente: process.env.MCP_AMBIENTE || 'no especificado',
    };
  },
};

export const herramientas: HerramientaMcp[] = [
  miPerfil,
  catorcenaActual,
  buscarSolicitudes,
  buscarPropuestas,
  buscarCampanas,
  resumenPorEstatus,
  detalleSolicitud,
  detallePropuesta,
  detalleCampana,
  artesCampana,
  buscarInventario,
  resumenInventario,
  detalleInventario,
];
