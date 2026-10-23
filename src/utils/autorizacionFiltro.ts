import prisma from './prisma';

// Filtro por AUTORIZACIÓN DE CIRCUITOS en los listados de Solicitudes,
// Propuestas y Campañas (oct-2026).
//
// La autorización vive POR CIRCUITO (solicitudCaras.autorizacion_dg /
// autorizacion_dcm), no por registro. Para que el listado la pueda filtrar y
// ordenar, cada entidad se evalúa por los circuitos de SU propuesta (idquote):
//
//   aprobado    → dg='aprobado' Y dcm='aprobado'
//   pend_dg     → dg='pendiente'
//   pend_dcm    → dcm='pendiente'
//   correccion  → dg='correccion' O dcm='correccion'
//   rechazado   → dg='rechazado' O dcm='rechazado'
//
// Un registro "tiene" el estatus si AL MENOS UN circuito lo cumple. Si el
// listado trae filtro de Periodo (catorcena/año), solo cuentan los circuitos
// que solapan ese periodo; sin periodo, cuentan todos. Mismo criterio en el
// filtro (EXISTS), en el resumen por fila (badges / filtro avanzado en
// cliente) y en los KPIs.
//
// Las FECHAS de cambio de autorización (para el orden "Último cambio") salen
// de la tabla historial: tipos autorizacion_solicitud_* (se mandó a DG/DCM o
// se devolvió a corrección), autorizacion_aprobacion y autorizacion_rechazo.

export type AutorizacionFiltroKey = 'aprobado' | 'pend_dg' | 'pend_dcm' | 'correccion' | 'rechazado';

export const AUTORIZACION_FILTRO_KEYS: AutorizacionFiltroKey[] = ['aprobado', 'pend_dg', 'pend_dcm', 'correccion', 'rechazado'];

// Prefijo con el que el front manda un estatus de autorización en el filtro
// de Historial (`estatusValor=auth:pend_dg`) para distinguirlo del estatus
// de la entidad ('Aprobada', 'Pase a ventas', ...).
export const AUTORIZACION_HISTORIAL_PREFIX = 'auth:';

function esKey(v: string): v is AutorizacionFiltroKey {
  return (AUTORIZACION_FILTRO_KEYS as string[]).includes(v);
}

/** `?autorizacion=pend_dg,rechazado` → ['pend_dg','rechazado']. Ignora valores desconocidos. */
export function parseAutorizacionFiltro(raw: unknown): AutorizacionFiltroKey[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const partes = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
  const out: AutorizacionFiltroKey[] = [];
  for (const p of partes) {
    const k = p.trim().toLowerCase();
    if (esKey(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/** `estatusValor` del filtro de Historial: devuelve la clave si viene con prefijo `auth:`. */
export function parseEstatusValorAutorizacion(estatusValor: string | undefined | null): AutorizacionFiltroKey | null {
  if (!estatusValor || !estatusValor.startsWith(AUTORIZACION_HISTORIAL_PREFIX)) return null;
  const k = estatusValor.slice(AUTORIZACION_HISTORIAL_PREFIX.length).trim().toLowerCase();
  return esKey(k) ? k : null;
}

/** `?status=Atendido,Pase a ventas` → ['Atendido','Pase a ventas'] (el chip Status es multiselect). */
export function parseStatusLista(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const partes = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
  const out: string[] = [];
  for (const p of partes) {
    const s = p.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Combina el filtro de estatus de la entidad con el de autorización de
 * circuitos. El chip Status es una sola lista multiselect, así que entre sus
 * valores aplica OR: `(col IN (...) OR EXISTS circuitos con autorización)`.
 * Sin estatus devuelve solo el EXISTS; sin EXISTS devuelve solo el IN.
 */
export function sqlStatusOAutorizacion(
  statusCol: string,
  statusLista: string[],
  existe: { sql: string; params: unknown[] },
): { sql: string; params: unknown[] } {
  if (statusLista.length === 0) return existe;
  const inSql = `${statusCol} IN (${statusLista.map(() => '?').join(',')})`;
  if (!existe.sql) return { sql: inSql, params: [...statusLista] };
  return { sql: `(${inSql} OR ${existe.sql})`, params: [...statusLista, ...existe.params] };
}

export interface PeriodoFiltro {
  inicio: Date | string;
  fin: Date | string;
}

/** Rango de fechas del filtro de Periodo del listado (catorcena → fechas; solo año → 1 ene / 31 dic). */
export function periodoDesdeFiltro(
  catorcenaRango: { inicio: Date; fin: Date } | null | undefined,
  yearInicio?: string | number | null,
  yearFin?: string | number | null,
): PeriodoFiltro | null {
  if (catorcenaRango) return { inicio: catorcenaRango.inicio, fin: catorcenaRango.fin };
  const yi = yearInicio ? Number(yearInicio) : null;
  const yf = yearFin ? Number(yearFin) : yi;
  if (!yi || !yf) return null;
  return { inicio: `${yi}-01-01`, fin: `${yf}-12-31` };
}

function condicionCara(keys: AutorizacionFiltroKey[], alias: string): string {
  const dg = `${alias}.autorizacion_dg`;
  const dcm = `${alias}.autorizacion_dcm`;
  const partes = keys.map((k) => {
    switch (k) {
      case 'aprobado': return `(COALESCE(${dg}, 'aprobado') = 'aprobado' AND COALESCE(${dcm}, 'aprobado') = 'aprobado')`;
      case 'pend_dg': return `${dg} = 'pendiente'`;
      case 'pend_dcm': return `${dcm} = 'pendiente'`;
      case 'correccion': return `(${dg} = 'correccion' OR ${dcm} = 'correccion')`;
      case 'rechazado': return `(${dg} = 'rechazado' OR ${dcm} = 'rechazado')`;
    }
  });
  return `(${partes.join(' OR ')})`;
}

/**
 * EXISTS sobre solicitudCaras para una propuesta. `propuestaIdExpr` es la
 * expresión SQL con el id de propuesta (ej. `pr.id`, `ct.id_propuesta`).
 * Devuelve '' si no hay claves (sin filtro).
 */
export function sqlExisteCaraConAutorizacion(
  keys: AutorizacionFiltroKey[],
  propuestaIdExpr: string,
  periodo?: PeriodoFiltro | null,
): { sql: string; params: unknown[] } {
  if (keys.length === 0) return { sql: '', params: [] };
  const params: unknown[] = [];
  let sql = `EXISTS (
    SELECT 1 FROM solicitudCaras sc_au
    WHERE sc_au.idquote = CAST(${propuestaIdExpr} AS CHAR) COLLATE utf8mb4_unicode_ci
      AND ${condicionCara(keys, 'sc_au')}`;
  if (periodo) {
    sql += ` AND sc_au.inicio_periodo <= ? AND sc_au.fin_periodo >= ?`;
    params.push(periodo.fin, periodo.inicio);
  }
  sql += `)`;
  return { sql, params };
}

export interface AutorizacionResumen {
  total: number;
  aprobado: number;
  pend_dg: number;
  pend_dcm: number;
  correccion: number;
  rechazado: number;
}

/**
 * Conteo de circuitos por estatus de autorización, por propuesta. Una sola
 * query agrupada para toda la página. Con `periodo`, solo circuitos que
 * solapan el rango (mismo criterio que el EXISTS del filtro).
 */
export async function resumenAutorizacionPorPropuesta(
  propuestaIds: number[],
  periodo?: PeriodoFiltro | null,
): Promise<Map<number, AutorizacionResumen>> {
  const map = new Map<number, AutorizacionResumen>();
  const ids = Array.from(new Set(propuestaIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return map;
  const params: unknown[] = [];
  let periodoSql = '';
  if (periodo) {
    periodoSql = ` AND sc.inicio_periodo <= ? AND sc.fin_periodo >= ?`;
    params.push(periodo.fin, periodo.inicio);
  }
  const rows = await prisma.$queryRawUnsafe<Array<{
    propuesta_id: string; total: bigint; aprobado: bigint; pend_dg: bigint; pend_dcm: bigint; correccion: bigint; rechazado: bigint;
  }>>(`
    SELECT sc.idquote AS propuesta_id,
           COUNT(*) AS total,
           SUM(CASE WHEN ${condicionCara(['aprobado'], 'sc')} THEN 1 ELSE 0 END) AS aprobado,
           SUM(CASE WHEN ${condicionCara(['pend_dg'], 'sc')} THEN 1 ELSE 0 END) AS pend_dg,
           SUM(CASE WHEN ${condicionCara(['pend_dcm'], 'sc')} THEN 1 ELSE 0 END) AS pend_dcm,
           SUM(CASE WHEN ${condicionCara(['correccion'], 'sc')} THEN 1 ELSE 0 END) AS correccion,
           SUM(CASE WHEN ${condicionCara(['rechazado'], 'sc')} THEN 1 ELSE 0 END) AS rechazado
    FROM solicitudCaras sc
    WHERE sc.idquote IN (${ids.map(() => '?').join(',')})${periodoSql}
    GROUP BY sc.idquote
  `, ...ids.map((i) => String(i)), ...params);
  for (const r of rows) {
    const id = parseInt(String(r.propuesta_id), 10);
    if (isNaN(id)) continue;
    map.set(id, {
      total: Number(r.total),
      aprobado: Number(r.aprobado),
      pend_dg: Number(r.pend_dg),
      pend_dcm: Number(r.pend_dcm),
      correccion: Number(r.correccion),
      rechazado: Number(r.rechazado),
    });
  }
  return map;
}

// ── Historial de autorización ───────────────────────────────────────────────

// Tipos de historial que representan un CAMBIO de estatus de autorización.
// (autorizacion_cambio_* y autorizacion_nueva_cara_* son ediciones de datos,
// no cambios de autorización, y quedan fuera.)
const TIPOS_HISTORIAL_AUT = [
  'autorizacion_aprobacion',
  'autorizacion_rechazo',
  'autorizacion_solicitud_solicitud',
  'autorizacion_solicitud_propuesta',
  'autorizacion_solicitud_campana',
];
const TIPOS_HISTORIAL_AUT_SQL = TIPOS_HISTORIAL_AUT.map((t) => `'${t}'`).join(',');

// Clasifica una fila de historial (alias `h`) en la clave de autorización a
// la que pasaron los circuitos. Las acciones las escribe autorizacion.service:
//   "… solicitó autorización DG — N circuito(s)"          → pend_dg
//   "… solicitó autorización DCM — N circuito(s)"         → pend_dcm
//   "N circuito(s) DCM escalado(s) a DG por mezcla …"     → pend_dg
//   "… aprobó filtro y envió a Dirección General"          → pend_dg
//   "… aprobó filtro y envió a Dirección Comercial"        → pend_dcm
//   "… devolvió para corrección …"                         → correccion
//   tipo autorizacion_aprobacion                           → aprobado
//   tipo autorizacion_rechazo                              → rechazado
// El COLLATE explícito evita el error 1267 (mezcla de collations entre la de
// la conexión, que toman los literales del CASE, y la de las columnas) al
// agrupar/comparar la clave.
const SQL_CLAVE_AUT = `(CASE
  WHEN h.tipo = 'autorizacion_aprobacion' THEN 'aprobado'
  WHEN h.tipo = 'autorizacion_rechazo' THEN 'rechazado'
  WHEN h.accion LIKE '%correcci%' THEN 'correccion'
  WHEN h.accion LIKE '%escalado%' THEN 'pend_dg'
  WHEN h.accion LIKE '%autorizaci%n DCM%' OR h.accion LIKE '%Direcci%n Comercial%' THEN 'pend_dcm'
  ELSE 'pend_dg'
END) COLLATE utf8mb4_unicode_ci`;

// Join historial ↔ propuesta. El ref_id de las filas de autorización es el id
// de la PROPUESTA (origen solicitud/propuesta, aprobaciones y rechazos) o el id
// de la CAMPAÑA (origen campana). Se resuelve con la cadena
// propuesta → cotizacion → campania.
const SQL_JOIN_HIST_PROPUESTA = `
  FROM propuesta pr_h
  LEFT JOIN cotizacion ct_h ON ct_h.id_propuesta = pr_h.id
  LEFT JOIN campania cm_h ON cm_h.cotizacion_id = ct_h.id
  INNER JOIN historial h ON h.tipo IN (${TIPOS_HISTORIAL_AUT_SQL}) AND (
    (h.tipo <> 'autorizacion_solicitud_campana' AND h.ref_id = pr_h.id)
    OR (h.tipo = 'autorizacion_solicitud_campana' AND h.ref_id = cm_h.id)
  )`;

/**
 * Subquery `SELECT DISTINCT pr_h.id …` con las propuestas cuyos circuitos
 * CAMBIARON a la autorización `key` en el rango. Para usar como
 * `pr.id IN (<sql>)` / `ct.id_propuesta IN (<sql>)`.
 */
export function sqlPropuestasConCambioAutorizacion(
  key: AutorizacionFiltroKey,
  desde?: string | null,
  hasta?: string | null,
): { sql: string; params: unknown[] } {
  // La clave va como literal (no como parámetro): comparar el CASE con un `?`
  // mezcla collations (CASE toma la de la conexión, el parámetro otra) y MySQL
  // tira 1267. `key` viene de la whitelist AUTORIZACION_FILTRO_KEYS, sin riesgo.
  const params: unknown[] = [];
  let sql = `SELECT DISTINCT pr_h.id ${SQL_JOIN_HIST_PROPUESTA} WHERE pr_h.deleted_at IS NULL AND ${SQL_CLAVE_AUT} = '${key}'`;
  if (desde) { sql += ` AND h.fecha_hora >= ?`; params.push(new Date(desde)); }
  if (hasta) { sql += ` AND h.fecha_hora <= ?`; params.push(`${hasta} 23:59:59`); }
  return { sql, params };
}

export type CambiosFechas = Record<string, string>;

/**
 * Última fecha en que los circuitos de cada propuesta pasaron a cada estatus
 * de autorización. Claves `auth:<key>` → ISO.
 */
export async function cambiosAutorizacionPorPropuesta(propuestaIds: number[]): Promise<Map<number, CambiosFechas>> {
  const map = new Map<number, CambiosFechas>();
  const ids = Array.from(new Set(propuestaIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return map;
  const rows = await prisma.$queryRawUnsafe<Array<{ propuesta_id: number; clave: string; fecha: Date | string }>>(`
    SELECT pr_h.id AS propuesta_id, ${SQL_CLAVE_AUT} AS clave, MAX(h.fecha_hora) AS fecha
    ${SQL_JOIN_HIST_PROPUESTA}
    WHERE pr_h.id IN (${ids.map(() => '?').join(',')})
    GROUP BY pr_h.id, clave
  `, ...ids);
  for (const r of rows) {
    const id = Number(r.propuesta_id);
    const fecha = toIso(r.fecha);
    if (!fecha) continue;
    const cur = map.get(id) || {};
    cur[`${AUTORIZACION_HISTORIAL_PREFIX}${r.clave}`] = fecha;
    map.set(id, cur);
  }
  return map;
}

/**
 * Última fecha en que cada registro CAMBIÓ a cada estatus de entidad
 * (historial accion='Cambio de estado', detalles con "despues":"X").
 * Claves `estatus:<X>` → ISO. `refIds` son los ref_id tal como los escribe
 * cada módulo (Solicitud → id solicitud; Propuesta → id propuesta; Campaña →
 * id propuesta o id campaña según la versión del back que lo escribió).
 */
export async function cambiosEstatusPorRef(
  tipo: 'Solicitud' | 'Propuesta' | 'Campaña',
  refIds: number[],
): Promise<Map<number, CambiosFechas>> {
  const map = new Map<number, CambiosFechas>();
  const ids = Array.from(new Set(refIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return map;
  const rows = await prisma.$queryRawUnsafe<Array<{ ref_id: number; fecha_hora: Date | string; detalles: string | null }>>(`
    SELECT ref_id, fecha_hora, detalles
    FROM historial
    WHERE tipo = ? AND accion = 'Cambio de estado' AND ref_id IN (${ids.map(() => '?').join(',')})
  `, tipo, ...ids);
  const re = /"despues"\s*:\s*"([^"]*)"/;
  for (const r of rows) {
    const m = r.detalles ? re.exec(r.detalles) : null;
    const despues = m?.[1]?.trim();
    const fecha = toIso(r.fecha_hora);
    if (!despues || !fecha) continue;
    const id = Number(r.ref_id);
    const cur = map.get(id) || {};
    const k = `estatus:${despues}`;
    if (!cur[k] || cur[k] < fecha) cur[k] = fecha;
    map.set(id, cur);
  }
  return map;
}

/** Une varios mapas de cambios (misma clave → la fecha más reciente). */
export function unirCambios(...fuentes: Array<CambiosFechas | undefined | null>): CambiosFechas {
  const out: CambiosFechas = {};
  for (const f of fuentes) {
    if (!f) continue;
    for (const [k, v] of Object.entries(f)) {
      if (!out[k] || out[k] < v) out[k] = v;
    }
  }
  return out;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
