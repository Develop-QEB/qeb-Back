import { apiGet, apiPost } from './api';
import type { UsuarioMcp } from './auth';
import { ErrorDeUso, dia, entero, hoyCdmx, normalizar, numero, sumarDias, tablaCatorcenas, texto } from './tools';
import { ROLES_CREAR_SOLICITUD } from '../utils/permissions';

/**
 * Herramientas SOLO de QEBooh (no se exponen en el conector externo /mcp) para
 * ayudar a armar una solicitud nueva.
 *
 * QEBooh nunca crea la solicitud. preparar_solicitud valida lo recopilado y deja
 * una "acción" que el chat del front convierte en el botón "Abrir solicitud
 * prellenada": ese botón escribe el borrador del formulario (mismo formato que su
 * guardado automático) y lo abre en el paso de circuitos. El usuario agrega los
 * circuitos y crea la solicitud con el botón de siempre, así que tarifas, plazas,
 * autorizaciones y validaciones las sigue haciendo el formulario.
 */

type Fila = Record<string, any>;

/** Prellenado de "Nueva solicitud". Lo consume front-qeb/src/lib/solicitudPrefill.ts. */
export interface PrefillSolicitud {
  /** Fila de la tabla cliente tal cual (el front la convierte con el mismo mapeo del formulario). */
  cliente: Fila;
  asignados: { id: number; nombre: string; area: string; puesto: string }[];
  nombreCampania: string;
  descripcion: string;
  notas: string;
  yearInicio: number;
  catorcenaInicio: number;
  yearFin: number;
  catorcenaFin: number;
}

/**
 * Orden para llenar el "circuito en captura" del formulario abierto. Lo consume
 * CreateSolicitudModal: selecciona el artículo con su propia lógica (tarifa, plaza,
 * tipo, formato) y pone el resto. El usuario revisa y da "Agregar".
 */
export interface OrdenCircuito {
  articulo: string;
  articuloBf?: string;
  anioInicio?: number;
  catorcenaInicio?: number;
  anioFin?: number;
  catorcenaFin?: number;
  renta?: number;
  bonificacion?: number;
  nse?: string[];
  tarifaPublica?: number;
  /** Para el texto del botón. */
  descripcion?: string;
}

export type AccionChat =
  | { tipo: 'prefill_solicitud'; datos: PrefillSolicitud }
  | { tipo: 'llenar_circuito'; datos: OrdenCircuito };

export interface ContextoChat {
  usuario: UsuarioMcp;
  /** Acciones que el front debe ofrecer como botones junto a la respuesta. */
  acciones: AccionChat[];
  /** El usuario tiene abierto el formulario de solicitud (el front manda su estado). */
  formularioAbierto: boolean;
}

/** Deja una sola acción de cada tipo por respuesta: gana la última. */
function ponerAccion(ctx: ContextoChat, accion: AccionChat): void {
  ctx.acciones = [...ctx.acciones.filter(a => a.tipo !== accion.tipo), accion];
}

export interface HerramientaChat {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  ejecutar(args: Record<string, unknown>, ctx: ContextoChat): Promise<unknown>;
}

const puedeCrear = (rol: string) => ROLES_CREAR_SOLICITUD.has(String(rol || '').trim());

function exigirPermisoCrear(usuario: UsuarioMcp): void {
  if (!puedeCrear(usuario.rol)) {
    throw new ErrorDeUso(
      `Tu rol (${usuario.rol}) no puede crear solicitudes en QEB. Las crean asesores y gerentes comerciales; pídeselo a tu asesor.`,
    );
  }
}

const esAeropuerto = (c: Fila) =>
  String(c.sap_database || '').toUpperCase() === 'UDC' || String(c.card_code || '').trim().toUpperCase().startsWith('UDC');

// ---------------------------------------------------------------------------
// buscar_cliente
// ---------------------------------------------------------------------------

const resumenCliente = (c: Fila) => ({
  cliente_id: c.id,
  cuic: c.CUIC,
  cliente: texto(c.T0_U_Cliente),
  razon_social: texto(c.T0_U_RazonSocial),
  marca: texto(c.T2_U_Marca),
  producto: texto(c.T2_U_Producto),
  categoria: texto(c.T2_U_Categoria),
  agencia: texto(c.T0_U_Agencia),
  asesor: texto(c.ASESOR_U_Asesor || c.T0_U_Asesor),
  unidad_negocio: texto(c.T1_U_UnidadNegocio),
  base_sap: texto(c.sap_database),
  aeropuerto: esAeropuerto(c) || undefined,
});

const buscarCliente: HerramientaChat = {
  name: 'buscar_cliente',
  description:
    'Busca clientes de QEB por nombre comercial, razón social, marca o CUIC, para armar una solicitud. Un mismo cliente suele tener ' +
    'varios registros (uno por marca/producto o por base SAP): cada uno tiene su propio cliente_id. Si hay más de uno que encaje, ' +
    'muéstralos y pregunta cuál es; nunca elijas por el usuario.',
  inputSchema: {
    type: 'object',
    properties: { busqueda: { type: 'string', description: 'Nombre, razón social, marca o CUIC. P. ej. "Sephora".' } },
    required: ['busqueda'],
    additionalProperties: false,
  },
  async ejecutar(args, { usuario }) {
    const busqueda = texto(args.busqueda, 80);
    if (!busqueda || busqueda.length < 2) throw new ErrorDeUso('Escribe al menos 2 letras del cliente.');
    const r = await apiGet<{ data: Fila[] }>(usuario, '/clientes/full', { search: busqueda });
    const filas = r.data || [];
    return {
      total: filas.length,
      clientes: filas.slice(0, 20).map(resumenCliente),
      nota: filas.length > 20 ? `Hay ${filas.length} coincidencias; se muestran 20. Pide más detalle (marca, producto o CUIC).` : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// usuarios_asignables
// ---------------------------------------------------------------------------

/** Usuarios que el formulario deja asignar a este usuario (su equipo; todos si es admin). */
async function asignables(usuario: UsuarioMcp): Promise<Fila[]> {
  const r = await apiGet<{ data: Fila[] }>(usuario, '/solicitudes/users', { filterByTeam: true });
  return r.data || [];
}

const usuariosAsignables: HerramientaChat = {
  name: 'usuarios_asignables',
  description:
    'Lista las personas que el usuario puede asignar a una solicitud (las de su equipo de trabajo). El usuario que crea la solicitud ' +
    'queda asignado siempre; esta lista es para agregar a otros.',
  inputSchema: {
    type: 'object',
    properties: { busqueda: { type: 'string', description: 'Opcional: parte del nombre, área o puesto.' } },
    additionalProperties: false,
  },
  async ejecutar(args, { usuario }) {
    const q = normalizar(String(args.busqueda || ''));
    const todos = await asignables(usuario);
    const filtrados = q ? todos.filter(u => normalizar(`${u.nombre} ${u.area} ${u.puesto}`).includes(q)) : todos;
    return {
      total: filtrados.length,
      usuarios: filtrados.slice(0, 40).map(u => ({ id: u.id, nombre: texto(u.nombre), area: texto(u.area), puesto: texto(u.puesto) })),
      nota: filtrados.length > 40 ? 'Hay más; filtra por nombre.' : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// buscar_articulo (catálogo de SAP)
// ---------------------------------------------------------------------------

// Primero SAP_API_URL (la que usa el back para clientes); si no responde, la pública
// que usa el formulario del front (VITE_SAP_URL por defecto).
const SAP_URLS = [...new Set([process.env.SAP_API_URL, 'https://sap.qeb.mx'].filter(Boolean).map(u => String(u).replace(/\/+$/, '')))];
let articulosCache: { filas: Fila[]; hasta: number } | null = null;
let articulosEnCurso: Promise<Fila[]> | null = null;

async function descargarArticulos(): Promise<Fila[]> {
  let ultimo: unknown;
  for (const base of SAP_URLS) {
    try {
      const resp = await fetch(`${base}/articulos`, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`SAP (${base}) respondió ${resp.status}`);
      const json: any = await resp.json();
      return (json?.value || json || []).filter((a: Fila) => a?.ItemCode);
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

/** Catálogo de artículos de SAP (1.4 MB): 10 min en memoria y una sola descarga a la vez. */
async function catalogoArticulos(): Promise<Fila[]> {
  if (articulosCache && articulosCache.hasta > Date.now()) return articulosCache.filas;
  if (!articulosEnCurso) {
    articulosEnCurso = descargarArticulos()
      .then(filas => {
        articulosCache = { filas, hasta: Date.now() + 10 * 60 * 1000 };
        return filas;
      })
      .finally(() => { articulosEnCurso = null; });
  }
  try {
    return await articulosEnCurso;
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    console.warn(`[QEBooh] catálogo SAP no disponible: ${err.name} ${err.message} ${err.cause?.code || ''}`);
    if (articulosCache) return articulosCache.filas; // vencido, pero mejor que nada
    throw new ErrorDeUso('No pude consultar el catálogo de artículos de SAP en este momento. Intenta de nuevo en un minuto.');
  }
}

function clasificar(code: string): string {
  const c = code.toUpperCase();
  if (c.startsWith('RT')) return 'renta';
  if (c.startsWith('BF') || (c.startsWith('CF') && !/^CF-\d/.test(c))) return 'bonificación';
  if (c.startsWith('CT')) return 'cortesía';
  if (c.startsWith('IM')) return 'impresión';
  if (c.startsWith('IN')) return 'intercambio';
  return 'otro';
}

const buscarArticulo: HerramientaChat = {
  name: 'buscar_articulo',
  description:
    'Busca artículos del catálogo de SAP (los que se eligen en "Artículo SAP" al agregar un circuito) por código o descripción: ' +
    'formato, plaza o tipo, p. ej. "parabus cdmx", "digital monterrey", "RT-P1". Devuelve código, descripción, tipo de artículo y ' +
    'tarifa pública. Úsala para recomendar qué artículo elegir; el usuario lo selecciona en el formulario y este calcula el resto.',
  inputSchema: {
    type: 'object',
    properties: {
      busqueda: { type: 'string', description: 'Palabras a buscar en código o descripción. Todas deben aparecer.' },
      incluir_bonificacion: { type: 'boolean', description: 'Incluir artículos de bonificación (BF/CF). Por defecto no.' },
    },
    required: ['busqueda'],
    additionalProperties: false,
  },
  async ejecutar(args) {
    // Cada palabra acepta sus variantes: el catálogo escribe "CDMX", "DF" o "MEXICO" según el artículo.
    const variantes: Record<string, string[]> = {
      cdmx: ['cdmx', 'mexico'], df: ['cdmx', 'mexico'], mexico: ['cdmx', 'mexico'],
      gdl: ['gdl', 'guadalajara'], guadalajara: ['gdl', 'guadalajara'],
      mty: ['mty', 'monterrey'], monterrey: ['mty', 'monterrey'],
      parabuses: ['parabus'],
    };
    const palabras = String(args.busqueda || '')
      .split(/\s+/)
      .map(p => normalizar(p))
      .filter(p => p.length >= 2)
      .map(p => variantes[p] || [p]);
    if (palabras.length === 0) throw new ErrorDeUso('Indica qué buscar, p. ej. "parabus guadalajara".');
    const conBonif = args.incluir_bonificacion === true;
    const todos = await catalogoArticulos();
    const hallados = todos.filter(a => {
      const tipo = clasificar(a.ItemCode);
      if (!conBonif && tipo === 'bonificación') return false;
      const hay = normalizar(`${a.ItemCode} ${a.ItemName}`);
      return palabras.every(opciones => opciones.some(p => hay.includes(p)));
    });
    // Renta primero: es lo que se busca casi siempre; cortesías e impresiones al final.
    const orden = ['renta', 'otro', 'intercambio', 'bonificación', 'impresión', 'cortesía'];
    hallados.sort((a, b) => orden.indexOf(clasificar(a.ItemCode)) - orden.indexOf(clasificar(b.ItemCode)) || String(a.ItemCode).localeCompare(String(b.ItemCode)));
    return {
      total: hallados.length,
      articulos: hallados.slice(0, 15).map(a => ({
        codigo: a.ItemCode,
        descripcion: texto(a.ItemName, 120),
        tipo_articulo: clasificar(a.ItemCode),
        digital: a.ItemCode.toUpperCase().includes('DIG') || undefined,
        tarifa_publica: numero(a.U_IMU_PublicPrice) || undefined,
      })),
      nota:
        (hallados.length > 15 ? `Hay ${hallados.length}; se muestran 15. Afina la búsqueda. ` : '') +
        'Algunos artículos digitales no están habilitados en el formulario; si no aparece al buscarlo ahí, no está disponible.',
    };
  },
};

// ---------------------------------------------------------------------------
// evaluar_circuito (¿pedirá autorización DG/DCM?)
// ---------------------------------------------------------------------------

const evaluarCircuito: HerramientaChat = {
  name: 'evaluar_circuito',
  description:
    'Calcula si un circuito requerirá autorización de Dirección (DG y/o DCM) según tarifa, caras y plaza, con la misma regla que usa ' +
    'el formulario al agregarlo. No guarda nada. Úsala cuando el usuario pregunte si un circuito irá a autorización.',
  inputSchema: {
    type: 'object',
    properties: {
      articulo: { type: 'string', description: 'Código del artículo SAP.' },
      formato: { type: 'string', description: 'Formato, p. ej. PARABUS.' },
      tipo: { type: 'string', enum: ['Tradicional', 'Digital'] },
      plaza: { type: 'string', description: 'Plaza o estado del circuito.' },
      ciudades: { type: 'string', description: 'Opcional: ciudades separadas por coma.' },
      caras: { type: 'integer', minimum: 0, description: 'Caras de renta.' },
      bonificacion: { type: 'integer', minimum: 0, description: 'Caras bonificadas (0 si no hay).' },
      tarifa_publica: { type: 'number', minimum: 0, description: 'Tarifa por cara.' },
      base_sap: { type: 'string', description: 'Opcional: base SAP del cliente (CIMU, TRADE...).' },
    },
    required: ['formato', 'caras', 'tarifa_publica'],
    additionalProperties: false,
  },
  async ejecutar(args, { usuario }) {
    const caras = entero(args.caras, 'caras', 0, 100000) ?? 0;
    const bonificacion = entero(args.bonificacion, 'bonificacion', 0, 100000) ?? 0;
    const tarifa = Number(args.tarifa_publica) || 0;
    const r = await apiPost<{ data: Fila }>(usuario, '/solicitudes/evaluar-autorizacion', {
      articulo: texto(args.articulo, 60) || null,
      formato: texto(args.formato, 120),
      tipo: args.tipo || null,
      estado: texto(args.plaza, 80) || null,
      ciudad: texto(args.ciudades, 400) || null,
      caras,
      bonificacion,
      costo: Math.round(tarifa * caras * 100) / 100,
      tarifa_publica: tarifa,
      sap_database: texto(args.base_sap, 20) || null,
    });
    const d = r.data || {};
    return {
      importe: Math.round(tarifa * caras * 100) / 100,
      autorizacion_dg: d.autorizacion_dg,
      autorizacion_dcm: d.autorizacion_dcm,
      requiere_autorizacion: [d.autorizacion_dg, d.autorizacion_dcm].some(x => x && x !== 'aprobado'),
      detalle: d.motivo || d.razon || d.detalle || undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// preparar_solicitud
// ---------------------------------------------------------------------------

const prepararSolicitud: HerramientaChat = {
  name: 'preparar_solicitud',
  description:
    'Prepara una solicitud nueva PRELLENADA con cliente, asignados, campaña y periodo en catorcenas. NO crea la solicitud: valida los ' +
    'datos y hace aparecer bajo tu respuesta el botón "Abrir solicitud prellenada", que abre el formulario en el paso de circuitos. ' +
    'Ahí el usuario agrega los circuitos y crea la solicitud. Llámala solo cuando tengas TODOS los datos confirmados por el usuario: ' +
    'cliente_id (de buscar_cliente), nombre de campaña, catorcena y año de inicio y fin, Descripción Tráfico y Notas Dirección. ' +
    'Los periodos mensuales y los clientes de aeropuerto (UDC) no se pueden prellenar.',
  inputSchema: {
    type: 'object',
    properties: {
      cliente_id: { type: 'integer', minimum: 1, description: 'cliente_id elegido de buscar_cliente.' },
      nombre_campania: { type: 'string', description: 'Nombre de la campaña.' },
      anio_inicio: { type: 'integer' },
      catorcena_inicio: { type: 'integer', minimum: 1, maximum: 26 },
      anio_fin: { type: 'integer', description: 'Si se omite, igual a anio_inicio.' },
      catorcena_fin: { type: 'integer', minimum: 1, maximum: 26, description: 'Si se omite, igual a catorcena_inicio.' },
      descripcion: { type: 'string', description: 'Campo "Descripción Tráfico" (obligatorio): indicaciones para Tráfico.' },
      notas: { type: 'string', description: 'Campo "Notas Dirección" (obligatorio): contexto para Dirección.' },
      asignados_ids: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Opcional: ids de usuarios_asignables a agregar. El usuario actual se asigna siempre.',
      },
    },
    required: ['cliente_id', 'nombre_campania', 'anio_inicio', 'catorcena_inicio', 'descripcion', 'notas'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const { usuario } = ctx;
    exigirPermisoCrear(usuario);

    // --- campaña ---
    const nombre = String(args.nombre_campania || '').trim();
    const descripcion = String(args.descripcion || '').trim();
    const notas = String(args.notas || '').trim();
    if (!nombre) throw new ErrorDeUso('Falta el nombre de la campaña.');
    if (nombre.length > 200) throw new ErrorDeUso('El nombre de la campaña es demasiado largo (máximo 200 caracteres).');
    if (!descripcion) throw new ErrorDeUso('Falta la Descripción Tráfico; es obligatoria en el formulario.');
    if (!notas) throw new ErrorDeUso('Faltan las Notas Dirección; son obligatorias en el formulario.');
    if (descripcion.length > 2000 || notas.length > 2000) throw new ErrorDeUso('Descripción y notas deben tener máximo 2000 caracteres.');

    // --- periodo ---
    const yearInicio = entero(args.anio_inicio, 'anio_inicio', 2020, 2100) as number;
    const catorcenaInicio = entero(args.catorcena_inicio, 'catorcena_inicio', 1, 26) as number;
    const yearFin = entero(args.anio_fin, 'anio_fin', 2020, 2100) ?? yearInicio;
    const catorcenaFin = entero(args.catorcena_fin, 'catorcena_fin', 1, 26) ?? catorcenaInicio;
    if (yearInicio === undefined || catorcenaInicio === undefined) throw new ErrorDeUso('Falta la catorcena y el año de inicio.');
    if (yearFin * 100 + catorcenaFin < yearInicio * 100 + catorcenaInicio) {
      throw new ErrorDeUso('La catorcena de fin no puede ser anterior a la de inicio.');
    }
    const cats = await tablaCatorcenas(usuario);
    const buscarCat = (a: number, n: number) => cats.find(c => Number(c.a_o) === a && Number(c.numero_catorcena) === n);
    const ini = buscarCat(yearInicio, catorcenaInicio);
    const fin = buscarCat(yearFin, catorcenaFin);
    if (!ini || !fin) {
      throw new ErrorDeUso(`No existe en QEB la catorcena ${!ini ? `${catorcenaInicio}/${yearInicio}` : `${catorcenaFin}/${yearFin}`}.`);
    }
    // Las fechas de la tabla están corridas +1 día: la vigente es la que contiene "mañana".
    const manana = sumarDias(hoyCdmx(), 1);
    const yaPaso = dia(fin.fecha_fin) < manana;
    const empezoYa = dia(ini.fecha_inicio) <= manana;

    // --- cliente ---
    let cliente: Fila;
    try {
      cliente = (await apiGet<{ data: Fila }>(usuario, `/clientes/${entero(args.cliente_id, 'cliente_id', 1, 2_000_000_000)}`)).data;
    } catch {
      throw new ErrorDeUso('No existe ese cliente_id. Búscalo de nuevo con buscar_cliente.');
    }
    if (!cliente?.id) throw new ErrorDeUso('No existe ese cliente_id. Búscalo de nuevo con buscar_cliente.');
    if (esAeropuerto(cliente)) {
      throw new ErrorDeUso('Es un cliente de aeropuerto (UDC): usa periodos mensuales y no se puede prellenar. Créala directo en el formulario.');
    }

    // --- asignados (el usuario actual siempre, como hace el formulario) ---
    const equipo = await asignables(usuario);
    const yo = equipo.find(u => Number(u.id) === usuario.id);
    const asignados = [{ id: usuario.id, nombre: usuario.nombre, area: String(yo?.area || ''), puesto: String(yo?.puesto || '') }];
    const pedidos = Array.isArray(args.asignados_ids) ? [...new Set(args.asignados_ids.map(Number))] : [];
    const desconocidos: number[] = [];
    for (const id of pedidos) {
      if (id === usuario.id) continue;
      const u = equipo.find(x => Number(x.id) === id);
      if (!u) desconocidos.push(id);
      else asignados.push({ id: u.id, nombre: String(u.nombre), area: String(u.area || ''), puesto: String(u.puesto || '') });
    }
    if (desconocidos.length) {
      throw new ErrorDeUso(`No puedes asignar a los usuarios ${desconocidos.join(', ')}: no están en tu equipo. Usa usuarios_asignables.`);
    }

    const datos: PrefillSolicitud = {
      cliente,
      asignados,
      nombreCampania: nombre,
      descripcion,
      notas,
      yearInicio,
      catorcenaInicio,
      yearFin,
      catorcenaFin,
    };
    ponerAccion(ctx, { tipo: 'prefill_solicitud', datos });

    return {
      listo: true,
      instruccion:
        'Dile al usuario que dé clic en el botón "Abrir solicitud prellenada" que aparece debajo de tu respuesta. El formulario se abre en el ' +
        'paso de circuitos; ahí debe agregar al menos un circuito y luego crear la solicitud. Ofrécele ayuda con los circuitos.',
      resumen: {
        cliente: resumenCliente(cliente),
        campania: nombre,
        periodo: `Cat ${catorcenaInicio}/${yearInicio}` + (yearFin !== yearInicio || catorcenaFin !== catorcenaInicio ? ` a Cat ${catorcenaFin}/${yearFin}` : ''),
        asignados: asignados.map(a => a.nombre),
      },
      advertencia: yaPaso
        ? 'Ese periodo ya terminó. Confírmalo con el usuario antes de que la cree.'
        : empezoYa
          ? 'Ese periodo ya empezó o empieza mañana; el inventario puede estar comprometido.'
          : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// opciones_inventario (formatos, tipos y NSE que existen en una plaza)
// ---------------------------------------------------------------------------

const CDMX_AM = 'Ciudad de México / AM';
let filtrosCache: { datos: Fila; hasta: number } | null = null;

async function filtrosInventario(usuario: UsuarioMcp): Promise<Fila> {
  if (filtrosCache && filtrosCache.hasta > Date.now()) return filtrosCache.datos;
  const r = await apiGet<{ data: Fila }>(usuario, '/solicitudes/inventario-filters');
  filtrosCache = { datos: r.data || {}, hasta: Date.now() + 10 * 60 * 1000 };
  return filtrosCache.datos;
}

/** Plaza como la muestra el formulario → sus estados y ciudades. */
async function resolverPlaza(usuario: UsuarioMcp, pedida: string): Promise<{ plaza: string; estados: string[]; ciudades: string[] }> {
  const n = normalizar(pedida);
  if (['cdmx', 'df', 'cdmxam', 'ciudaddemexico', 'ciudaddemexicoam', 'mexico'].includes(n)) {
    return { plaza: CDMX_AM, estados: ['Ciudad de México', 'Estado de México'], ciudades: [] };
  }
  const f = await filtrosInventario(usuario);
  const plazas: Fila[] = Array.isArray(f.plazas) ? f.plazas : [];
  const alias: Record<string, string> = { gdl: 'guadalajara', mty: 'monterrey', edomex: 'estadodemexico' };
  const buscada = alias[n] || n;
  const p = plazas.find(x => normalizar(x.plaza) === buscada) || plazas.find(x => normalizar(x.plaza).includes(buscada) && buscada.length >= 3);
  if (!p) {
    throw new ErrorDeUso(`No existe la plaza "${pedida}". Plazas: ${CDMX_AM}, ${plazas.map(x => x.plaza).join(', ')}.`);
  }
  return { plaza: p.plaza, estados: p.estados || [], ciudades: p.ciudades || [] };
}

const opcionesInventario: HerramientaChat = {
  name: 'opciones_inventario',
  description:
    'Dice qué formatos, tipos (Tradicional/Digital) y niveles socioeconómicos (NSE) existen en el inventario de una plaza, y sus ciudades. ' +
    'Úsala antes de proponer el NSE o el formato de un circuito, para ofrecer solo opciones que existen ahí.',
  inputSchema: {
    type: 'object',
    properties: { plaza: { type: 'string', description: 'Plaza, p. ej. "CDMX", "Guadalajara", "Monterrey".' } },
    required: ['plaza'],
    additionalProperties: false,
  },
  async ejecutar(args, { usuario }) {
    const pl = await resolverPlaza(usuario, String(args.plaza || ''));
    // OJO: el endpoint lee "estado" (singular, separado por comas).
    const r = await apiGet<{ data: Fila }>(usuario, '/solicitudes/inventario-options', { estado: pl.estados.join(',') });
    const d = r.data || {};
    return { plaza: pl.plaza, ciudades: pl.ciudades, formatos: d.formatos || [], tipos: d.tipos || [], nse: d.nse || [] };
  },
};

// ---------------------------------------------------------------------------
// llenar_circuito
// ---------------------------------------------------------------------------

const llenarCircuito: HerramientaChat = {
  name: 'llenar_circuito',
  description:
    'Llena el circuito en captura del formulario de solicitud ABIERTO. Hace aparecer bajo tu respuesta un botón; al darle clic, el ' +
    'formulario selecciona el artículo con su propia lógica (tarifa, plaza, tipo, formato, ciudades) y pone periodo, caras, bonificación ' +
    'y NSE. El usuario revisa y da "Agregar". Solo el artículo es obligatorio: con solo él funciona como "usar este artículo". ' +
    'Para varias catorcenas da inicio y fin (el formulario usa modo masivo y crea un circuito por catorcena). ' +
    'Si hay bonificación hace falta el artículo de bonificación (BF); si no lo das, se usa el BF equivalente al artículo cuando existe.',
  inputSchema: {
    type: 'object',
    properties: {
      articulo: { type: 'string', description: 'Código del artículo SAP de renta (de buscar_articulo).' },
      catorcena_inicio: { type: 'integer', minimum: 1, maximum: 26 },
      anio_inicio: { type: 'integer' },
      catorcena_fin: { type: 'integer', minimum: 1, maximum: 26, description: 'Para un rango de catorcenas. Omitir si es una sola.' },
      anio_fin: { type: 'integer' },
      caras: { type: 'integer', minimum: 0, description: 'Caras de renta por catorcena.' },
      bonificacion: { type: 'integer', minimum: 0, description: 'Caras bonificadas por catorcena (no más que las de renta).' },
      articulo_bf: { type: 'string', description: 'Código del artículo de bonificación (BF/CF), si hay bonificación.' },
      nse: { type: 'array', items: { type: 'string' }, description: 'NSE exactamente como los da opciones_inventario.' },
      tarifa_publica: { type: 'number', minimum: 0, description: 'Solo si el usuario quiere una tarifa distinta a la del artículo.' },
    },
    required: ['articulo'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    if (!ctx.formularioAbierto) {
      throw new ErrorDeUso('El usuario no tiene abierto el formulario de solicitud. Primero debe abrirlo (o prepara la solicitud con preparar_solicitud).');
    }
    const catalogo = await catalogoArticulos();
    const codigo = String(args.articulo || '').trim().toUpperCase();
    const art = catalogo.find(a => String(a.ItemCode).toUpperCase() === codigo);
    if (!art) throw new ErrorDeUso(`No existe el artículo ${codigo}. Búscalo con buscar_articulo.`);
    const tipoArt = clasificar(art.ItemCode);
    if (tipoArt === 'bonificación') throw new ErrorDeUso(`${art.ItemCode} es de bonificación; va en articulo_bf, no como artículo principal.`);

    const caras = entero(args.caras, 'caras', 0, 100000);
    const bonificacion = entero(args.bonificacion, 'bonificacion', 0, 100000);
    if (tipoArt === 'renta' && caras !== undefined && bonificacion !== undefined && bonificacion > 0 && caras === 0) {
      throw new ErrorDeUso('No puede haber bonificación sin caras de renta.');
    }
    if (tipoArt === 'renta' && caras !== undefined && bonificacion !== undefined && bonificacion > caras) {
      throw new ErrorDeUso('La bonificación no puede ser mayor que las caras de renta.');
    }

    // Artículo de bonificación: el indicado, o el equivalente BF-<resto del código> si existe.
    let articuloBf: string | undefined;
    let bfAutomatico = false;
    if ((bonificacion || 0) > 0 && tipoArt !== 'cortesía') {
      const pedido = String(args.articulo_bf || '').trim().toUpperCase();
      if (pedido) {
        const bf = catalogo.find(a => String(a.ItemCode).toUpperCase() === pedido);
        if (!bf || clasificar(bf.ItemCode) !== 'bonificación') throw new ErrorDeUso(`${pedido} no es un artículo de bonificación (BF/CF).`);
        articuloBf = bf.ItemCode;
      } else {
        const candidato = `BF-${art.ItemCode.split('-').slice(1).join('-')}`.toUpperCase();
        const bf = catalogo.find(a => String(a.ItemCode).toUpperCase() === candidato);
        if (!bf) {
          throw new ErrorDeUso(`Falta el artículo de bonificación y no hay un ${candidato}. Búscalo con buscar_articulo (incluir_bonificacion: true) y pregúntale al usuario.`);
        }
        articuloBf = bf.ItemCode;
        bfAutomatico = true;
      }
    }

    // Periodo
    const cIni = entero(args.catorcena_inicio, 'catorcena_inicio', 1, 26);
    const aIni = entero(args.anio_inicio, 'anio_inicio', 2020, 2100);
    const cFin = entero(args.catorcena_fin, 'catorcena_fin', 1, 26);
    const aFin = entero(args.anio_fin, 'anio_fin', 2020, 2100);
    if ((cIni === undefined) !== (aIni === undefined)) throw new ErrorDeUso('Da la catorcena y el año de inicio juntos.');
    if (cFin !== undefined && cIni === undefined) throw new ErrorDeUso('catorcena_fin requiere catorcena_inicio.');
    if (cIni !== undefined && aIni !== undefined && cFin !== undefined) {
      const finTotal = (aFin ?? aIni) * 100 + cFin;
      if (finTotal < aIni * 100 + cIni) throw new ErrorDeUso('La catorcena de fin no puede ser anterior a la de inicio.');
    }

    const nse = Array.isArray(args.nse) ? args.nse.map(x => String(x).trim()).filter(Boolean).slice(0, 10) : undefined;
    const tarifa = args.tarifa_publica !== undefined ? Number(args.tarifa_publica) : undefined;
    if (tarifa !== undefined && (!Number.isFinite(tarifa) || tarifa < 0)) throw new ErrorDeUso('tarifa_publica inválida.');

    const datos: OrdenCircuito = {
      articulo: art.ItemCode,
      articuloBf,
      catorcenaInicio: cIni,
      anioInicio: aIni,
      catorcenaFin: cFin,
      anioFin: cFin !== undefined ? (aFin ?? aIni) : undefined,
      renta: caras,
      bonificacion,
      nse: nse && nse.length ? nse : undefined,
      tarifaPublica: tarifa,
      descripcion: [
        art.ItemCode,
        caras !== undefined ? `${caras} caras` : '',
        bonificacion ? `+${bonificacion} bonif.` : '',
        cIni !== undefined ? `Cat ${cIni}${cFin !== undefined && (cFin !== cIni || (aFin ?? aIni) !== aIni) ? `-${cFin}` : ''}/${aFin ?? aIni}` : '',
      ].filter(Boolean).join(' · '),
    };
    ponerAccion(ctx, { tipo: 'llenar_circuito', datos });

    return {
      listo: true,
      instruccion:
        'Dile que dé clic en el botón que aparece debajo de tu respuesta para llenar el circuito en el formulario, que revise los campos ' +
        'y dé "Agregar". Lo que no se llenó (p. ej. NSE o periodo) lo completa ahí.',
      articulo: { codigo: art.ItemCode, descripcion: texto(art.ItemName, 120), tipo_articulo: tipoArt, tarifa_publica: numero(art.U_IMU_PublicPrice) },
      articulo_bf: articuloBf,
      aviso: bfAutomatico ? `Se usará ${articuloBf} como artículo de bonificación; menciónaselo al usuario.` : undefined,
      sin_llenar: [
        cIni === undefined ? 'periodo' : '',
        caras === undefined && tipoArt !== 'cortesía' ? 'caras' : '',
        !nse || !nse.length ? 'NSE' : '',
      ].filter(Boolean),
    };
  },
};

export const herramientasSolicitud: HerramientaChat[] = [
  buscarCliente, usuariosAsignables, buscarArticulo, evaluarCircuito, prepararSolicitud, opcionesInventario, llenarCircuito,
];
