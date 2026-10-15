import { query } from '../db';
import { getBiConfig } from '../config';
import { normalizaAsesor } from '../lib/asesores';
import { normalizaPlaza } from '../lib/plazas';
import type {
  CampaniaDetalle, Ciclo, ConteoMonto, ConteoNombre, ConteoPeriodo, Dimension,
  Embudo, EtapaEmbudo, FiltrosReporte, OpcionesReporte, Periodo,
} from '../types';

const toISO = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// Mes de la catorcena por su FECHA DE FIN (QEB cuenta la catorcena que cruza meses en el
// mes donde TERMINA). Validado vs QEB: Jun=103M, Sep=97M. Sin fecha de periodo, cae a `Mes`.
const MES_FIN = 'COALESCE(MONTH(`Fecha Fin Periodo`), `Mes`)';

const filtroVacio = (anio: number): FiltrosReporte => ({ anio, mes: null, plaza: null, formato: null, mueble: null, cliente: null, asesor: null });

// Limpia el nombre del mueble: quita "RENTA/BONIFICACIÓN DE ESPACIOS ".
const limpiaMueble = (v: string) => String(v).replace(/^(RENTA|BONIFICACI[OÓ]N) DE ESPACIOS\s*/i, '').trim() || String(v);

// Grupo "Formato" del tablero: buckets de mueble → patrón LIKE.
// Gran Formato = Mi Macro. Un mueble combinado (p.ej. "PARABUS, COLUMNA") cae en ambos.
const MUEBLE_LIKE: Record<string, string> = { PARABUS: '%PARABUS%', COLUMNA: '%COLUMNA%', MACRO: '%MACRO%' };

/**
 * Dado un nombre de asesor CANÓNICO (normalizado), regresa los valores crudos de
 * la columna indicada que normalizan a él. Permite filtrar por asesor aunque la
 * BD guarde muchas variantes (MAYÚS/acentos/sufijos/apellidos).
 */
async function variantesAsesor(canonico: string, sql: string): Promise<string[]> {
  const objetivo = normalizaAsesor(canonico); // normaliza también el parámetro (unicode descompuesto/casing)
  const rows = await query<{ a: string | null }>(sql);
  return [...new Set(rows.map((r) => r.a).filter((a): a is string => !!a && normalizaAsesor(a) === objetivo))];
}

// Versión multi-asesor: una sola consulta, regresa los crudos que normalizan a CUALQUIERA de los canónicos.
async function variantesAsesores(canonicos: string[], sql: string): Promise<string[]> {
  const objetivos = new Set(canonicos.map((c) => normalizaAsesor(c)));
  const rows = await query<{ a: string | null }>(sql);
  return [...new Set(rows.map((r) => r.a).filter((a): a is string => !!a && objetivos.has(normalizaAsesor(a))))];
}

// Combina un array (plural) + un valor único (singular) en una lista deduplicada y limpia.
const multi = (arr?: string[], single?: string | null): string[] =>
  [...new Set([...(arr ?? []), ...(single ? [single] : [])].map((x) => String(x).trim()).filter(Boolean))];

// ---------- Filtro para V_APS_Globales (ventas cerradas) ----------
async function vapsWhere(f: FiltrosReporte): Promise<{ where: string; params: Record<string, unknown> }> {
  const cond: string[] = ['`Año` = :anio'];
  const p: Record<string, unknown> = { anio: f.anio };
  if (f.mes) { cond.push(`${MES_FIN} = :mes`); p.mes = f.mes; }
  // Multi-selección de período (sobre la venta real del período).
  const enteros = (a?: number[]) => (a ?? []).filter((n) => Number.isFinite(n));
  const meses = enteros(f.meses), catorcenas = enteros(f.catorcenas), semanas = enteros(f.semanas);
  if (meses.length) cond.push(`${MES_FIN} IN (${meses.join(',')})`);
  if (catorcenas.length) {
    cond.push("`Periodo` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'");
    cond.push(`CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(\`Periodo\`,' ',-1),'-',1) AS UNSIGNED) IN (${catorcenas.join(',')})`);
  }
  if (semanas.length) {
    cond.push('`Fecha` IS NOT NULL');
    cond.push(`WEEK(\`Fecha\`, 3) IN (${semanas.join(',')})`);
  }
  // V_APS no tiene plaza limpia; aproximamos por municipio dentro de `Nombre de Plaza`.
  // Multi-selección: plaza/cliente/asesor aceptan varios valores (plural) o uno (singular).
  const plazas = multi(f.plazas, f.plaza);
  if (plazas.length) {
    const ors = plazas.map((pl, i) => { p[`plz${i}`] = `%${pl}%`; return `\`Nombre de Plaza\` LIKE :plz${i}`; });
    cond.push(`(${ors.join(' OR ')})`);
  }
  if (f.formato) { cond.push('`Tipo Digital` = :formato'); p.formato = f.formato; }
  if (f.mueble) { cond.push('`Dscription` LIKE :mueble'); p.mueble = `%${f.mueble}%`; }
  const clientes = multi(f.clientes, f.cliente);
  if (clientes.length) {
    const keys = clientes.map((_, i) => `:cli${i}`);
    clientes.forEach((cl, i) => { p[`cli${i}`] = cl; });
    cond.push(`\`U_Cliente\` IN (${keys.join(',')})`);
  }
  const asesores = multi(f.asesores, f.asesor);
  if (asesores.length) {
    const vars = await variantesAsesores(asesores, 'SELECT DISTINCT `U_Asesor` a FROM V_APS_Globales WHERE `U_Asesor` IS NOT NULL');
    if (!vars.length) { cond.push('1=0'); }
    else {
      const keys = vars.map((_, i) => `:av${i}`);
      vars.forEach((v, i) => { p[`av${i}`] = v; });
      cond.push(`\`U_Asesor\` IN (${keys.join(',')})`);
    }
  }
  // BASE (CIMU/TRADE/UDC).
  const bases = (f.bases ?? []).map((b) => String(b).trim().toUpperCase()).filter(Boolean);
  if (bases.length) {
    const keys = bases.map((_, i) => `:base${i}`);
    bases.forEach((b, i) => { p[`base${i}`] = b; });
    cond.push(`UPPER(\`BASE\`) IN (${keys.join(',')})`);
  }
  // Tipo de artículo (columna `Tipo`: RT/BF/IN/IM). Excluir IM = sin impresiones.
  const tipos = (f.tipos ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
  if (tipos.length) {
    const keys = tipos.map((_, i) => `:tipo${i}`);
    tipos.forEach((t, i) => { p[`tipo${i}`] = t; });
    cond.push(`\`Tipo\` COLLATE utf8mb4_unicode_ci IN (${keys.join(',')})`);
  }
  // Formato (Parabús/Columna/Gran Formato) → columna `Dscription` LIKE (OR entre buckets).
  const muebles = (f.muebles ?? []).map((m) => String(m).trim().toUpperCase()).filter((m) => MUEBLE_LIKE[m]);
  if (muebles.length) {
    const ors = muebles.map((m, i) => { p[`mue${i}`] = MUEBLE_LIKE[m]; return `\`Dscription\` LIKE :mue${i}`; });
    cond.push(`(${ors.join(' OR ')})`);
  }
  // Tradicional / Digital → columna `Tipo Digital`.
  const digital = (f.digital ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (digital.length) {
    const keys = digital.map((_, i) => `:via${i}`);
    digital.forEach((v, i) => { p[`via${i}`] = v; });
    cond.push(`\`Tipo Digital\` COLLATE utf8mb4_unicode_ci IN (${keys.join(',')})`);
  }
  // Definición de "venta" igual que la pestaña BI (resumenVentas): con BI_VENTA_DEF=VENTA
  // solo cuentan las filas confirmadas (U_dscTAsig='Venta'), excluyendo "Pendiente".
  // Así el Monto de Embudo/Variaciones cuadra con BI en vez de sumar todo el pipeline.
  if (getBiConfig().ventaDef === 'VENTA') cond.push("`U_dscTAsig` COLLATE utf8mb4_unicode_ci = 'Venta'");
  return { where: cond.join(' AND '), params: p };
}

// ---------- Filtro para el pipeline (solicitud/propuesta/campaña) ----------
// Se aplica sobre la solicitud `s`. Año/mes por s.fecha; cliente=razon_social;
// asesor por variantes; plaza/formato/mueble vía solicitudCaras (idquote = quote).
async function pipelineCond(f: FiltrosReporte, quoteExpr: string): Promise<{ cond: string[]; params: Record<string, unknown> }> {
  const cond: string[] = [];
  const p: Record<string, unknown> = {};
  cond.push('YEAR(s.fecha) = :anio'); p.anio = f.anio;
  if (f.mes) { cond.push('MONTH(s.fecha) = :mes'); p.mes = f.mes; }
  const clientes = multi(f.clientes, f.cliente);
  if (clientes.length) {
    const keys = clientes.map((_, i) => `:cli${i}`);
    clientes.forEach((cl, i) => { p[`cli${i}`] = cl; });
    cond.push(`s.razon_social IN (${keys.join(',')})`);
  }
  const asesores = multi(f.asesores, f.asesor);
  if (asesores.length) {
    const vars = await variantesAsesores(asesores, "SELECT DISTINCT asesor a FROM solicitud WHERE asesor IS NOT NULL AND asesor <> ''");
    if (!vars.length) { cond.push('1=0'); }
    else {
      const keys = vars.map((_, i) => `:sa${i}`);
      vars.forEach((v, i) => { p[`sa${i}`] = v; });
      cond.push(`s.asesor IN (${keys.join(',')})`);
    }
  }
  const scCond: string[] = [];
  const plazas = multi(f.plazas, f.plaza);
  if (plazas.length) {
    const ors = plazas.map((pl, i) => { p[`plzSc${i}`] = `%${pl}%`; return `sc.estados LIKE :plzSc${i}`; });
    scCond.push(`(${ors.join(' OR ')})`);
  }
  if (f.formato) { scCond.push('sc.tipo LIKE :formatoLike'); p.formatoLike = `%${f.formato}%`; }
  if (f.mueble) { scCond.push('sc.formato LIKE :muebleLike'); p.muebleLike = `%${f.mueble}%`; }
  // Formato (Parabús/Columna/Gran Formato) → sc.formato LIKE (OR entre buckets).
  const mueblesG = (f.muebles ?? []).map((m) => String(m).trim().toUpperCase()).filter((m) => MUEBLE_LIKE[m]);
  if (mueblesG.length) {
    const ors = mueblesG.map((m, i) => { p[`mueSc${i}`] = MUEBLE_LIKE[m]; return `sc.formato LIKE :mueSc${i}`; });
    scCond.push(`(${ors.join(' OR ')})`);
  }
  // Tradicional / Digital → sc.tipo.
  const digitalG = (f.digital ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (digitalG.length) {
    const keys = digitalG.map((_, i) => `:viaSc${i}`);
    digitalG.forEach((v, i) => { p[`viaSc${i}`] = v; });
    scCond.push(`sc.tipo IN (${keys.join(',')})`);
  }
  if (scCond.length) {
    cond.push(`EXISTS (SELECT 1 FROM solicitudCaras sc WHERE sc.idquote = ${quoteExpr} AND ${scCond.join(' AND ')})`);
  }
  return { cond, params: p };
}

/** Ciclo de venta: días promedio entre transiciones (Solicitud→Propuesta→Aprobación). */
export async function getCiclo(f: FiltrosReporte): Promise<Ciclo> {
  const { cond, params } = await pipelineCond(f, 'p.id');
  const [r] = await query<{ solProp: string | null; propAprob: string | null; total: number; aprobadas: number }>(
    `SELECT AVG(DATEDIFF(p.fecha, s.fecha)) solProp,
            AVG(DATEDIFF(ca.fecha_aprobacion, p.fecha)) propAprob,
            COUNT(*) total,
            SUM(ca.fecha_aprobacion IS NOT NULL) aprobadas
       FROM solicitud s
       JOIN propuesta p ON p.solicitud_id = s.id
       LEFT JOIN campania ca ON ca.cotizacion_id = p.id
      WHERE ${cond.join(' AND ')}`,
    params
  );
  const solProp = Math.max(0, Math.round(Number(r?.solProp) || 0));
  const propAprob = Math.max(0, Math.round((Number(r?.propAprob) || 0) * 10) / 10);
  const total = Number(r?.total) || 0;
  const aprobadas = Number(r?.aprobadas) || 0;
  return {
    etapas: [
      { de: 'Solicitud', a: 'Propuesta', dias: solProp },
      { de: 'Propuesta', a: 'Aprobación', dias: propAprob },
    ],
    cicloTotalDias: Math.round((solProp + propAprob) * 10) / 10,
    conversionGlobalPct: total ? Math.round((aprobadas / total) * 1000) / 10 : 0,
    total,
  };
}

/**
 * Tendencia del ciclo de vida por MES (para graficar cómo evoluciona). Los días se
 * leen de los CAMBIOS DE ESTATUS del `historial` (no de fechas de creación, que son
 * iguales porque solicitud/propuesta/campaña nacen juntas). Por cada propuesta:
 *   creado   = s.fecha (alta)
 *   atendido = 1er historial Propuesta "Cambio de estado" → "Atendido/a"
 *   aprobado = 1er historial Propuesta "Cambio de estado" → "Aprobado/a"
 * Se agrupa por el mes de creación. solProp = creación→atendido, propAprob =
 * atendido→aprobación (días promedio). Respeta los filtros del embudo (pipelineCond).
 */
export async function getCicloTendencia(f: FiltrosReporte): Promise<{ mes: number; solProp: number | null; propAprob: number | null; total: number | null; n: number; nAprob: number }[]> {
  const CO = 'COLLATE utf8mb4_unicode_ci';
  const { cond, params } = await pipelineCond(f, 'p.id');
  // Pre-agregamos el historial (1 pasada, GROUP BY) y la aprobación (campania.fecha_aprobacion)
  // en subconsultas derivadas — mucho más rápido que subconsultas correlacionadas por fila.
  // "Atendido" cubre formato JSON ("despues":"Atendido/a") y texto ('… a "Atendido"').
  const rows = await query<{ mes: number; solProp: string | null; propAprob: string | null; total: string | null; n: number; nAprob: number }>(
    `SELECT MONTH(s.fecha) mes,
            ROUND(AVG(DATEDIFF(h.atendido, s.fecha)), 1) solProp,
            ROUND(AVG(DATEDIFF(apr.aprobacion, h.atendido)), 1) propAprob,
            ROUND(AVG(DATEDIFF(apr.aprobacion, s.fecha)), 1) total,
            COUNT(*) n,
            SUM(apr.aprobacion IS NOT NULL) nAprob
       FROM solicitud s
       JOIN propuesta p ON p.solicitud_id = s.id
       LEFT JOIN (
         SELECT ref_id, MIN(fecha_hora) atendido FROM historial
          WHERE tipo ${CO} = 'Propuesta' AND accion ${CO} = 'Cambio de estado'
            AND (detalles ${CO} LIKE '%"despues":"Atendid%' OR detalles ${CO} LIKE '% a "Atendid%')
          GROUP BY ref_id
       ) h ON h.ref_id = p.id
       LEFT JOIN (
         SELECT cotizacion_id, MIN(fecha_aprobacion) aprobacion FROM campania
          WHERE fecha_aprobacion IS NOT NULL GROUP BY cotizacion_id
       ) apr ON apr.cotizacion_id = p.id
      WHERE ${cond.join(' AND ')}
      GROUP BY MONTH(s.fecha)`,
    params
  );
  const map = new Map(rows.map((r) => [Number(r.mes), r]));
  return Array.from({ length: 12 }, (_, i) => {
    const r = map.get(i + 1);
    const num = (v: string | null | undefined) => (v == null ? null : Number(v));
    return {
      mes: i + 1,
      solProp: r ? num(r.solProp) : null,
      propAprob: r ? num(r.propAprob) : null,
      total: r ? num(r.total) : null,
      n: r ? Number(r.n) : 0,
      nAprob: r ? Number(r.nAprob) : 0,
    };
  });
}

/** Detalle de campañas recientes (filtrado). */
export async function getCampanias(limit: number, f: FiltrosReporte): Promise<CampaniaDetalle[]> {
  const n = Math.min(Math.max(limit, 1), 200);
  const { cond, params } = await pipelineCond(f, 'p.id');
  const rows = await query<{
    id: number; nombre: string; status: string | null; total_caras: string | null; inversion: string | null;
    fecha_inicio: Date | null; fecha_fin: Date | null; fecha_creacion: Date | null; cliente: string | null; asesor: string | null;
  }>(
    `SELECT ca.id, ca.nombre, ca.status, ca.total_caras, p.inversion, ca.fecha_inicio, ca.fecha_fin,
            p.fecha AS fecha_creacion, s.razon_social cliente, s.asesor
       FROM campania ca
       JOIN propuesta p ON p.id = ca.cotizacion_id
       JOIN solicitud s ON s.id = p.solicitud_id
      WHERE ${cond.join(' AND ')}
      ORDER BY ca.id DESC
      LIMIT ${n}`,
    params
  );
  return rows.map((r) => ({
    id: Number(r.id),
    nombre: r.nombre,
    status: r.status,
    totalCaras: Number(r.total_caras) || 0,
    monto: Number(r.inversion) || 0,
    fechaInicio: toISO(r.fecha_inicio),
    fechaFin: toISO(r.fecha_fin),
    fechaCreacion: toISO(r.fecha_creacion),
    cliente: r.cliente,
    asesor: normalizaAsesor(r.asesor) ?? r.asesor,
  }));
}

/** Columna de V_APS_Globales para cada dimensión. */
const COL_DIM: Record<Dimension, string> = {
  plaza: 'U_dscSitio',
  digital: 'Tipo Digital',
  asesor: 'U_Asesor',
  cliente: 'U_Cliente',
  mueble: 'Dscription',
  categoria: 'U_Categoria',
  marca: 'U_Marca',
  producto: 'U_Producto',
};

export function dimensionValida(d: string): d is Dimension {
  return d in COL_DIM;
}

/** Distribución de monto/caras por una dimensión, con filtros. Ranking desc. */
export async function getDistribucion(dim: Dimension, f: FiltrosReporte): Promise<ConteoMonto[]> {
  const col = COL_DIM[dim];
  const { where, params } = await vapsWhere(f);
  // El asesor trae variantes del mismo nombre → traemos más filas para fusionar sin perder cola.
  const limite = dim === 'asesor' ? 200 : 30;
  const rows = await query<{ v: string | null; monto: string; caras: string | null; n: number }>(
    `SELECT \`${col}\` v, SUM(\`Monto Total\`) monto, SUM(\`Caras\`) caras, COUNT(*) n
       FROM V_APS_Globales
      WHERE ${where} AND \`${col}\` IS NOT NULL
      GROUP BY \`${col}\`
      ORDER BY monto DESC
      LIMIT ${limite}`,
    params
  );
  const base = rows
    .filter((r) => r.v != null && String(r.v).trim() && Number(r.monto) > 0)
    .map((r) => ({
      nombre: dim === 'mueble' ? limpiaMueble(String(r.v)) : String(r.v).trim(),
      monto: Number(r.monto),
      caras: Number(r.caras) || 0,
      n: Number(r.n),
    }));

  if (dim !== 'asesor') return base;

  const merged = new Map<string, ConteoMonto>();
  for (const r of base) {
    const nombre = normalizaAsesor(r.nombre) ?? r.nombre;
    const ex = merged.get(nombre) ?? { nombre, monto: 0, caras: 0, n: 0 };
    ex.monto += r.monto; ex.caras += r.caras; ex.n += r.n;
    merged.set(nombre, ex);
  }
  return [...merged.values()].sort((a, b) => b.monto - a.monto).slice(0, 30);
}

async function conteoStatus(tabla: 'solicitud' | 'propuesta' | 'campania', f: FiltrosReporte): Promise<ConteoNombre[]> {
  // Todas las etapas se anclan a la solicitud `s` (mismos filtros para el embudo completo).
  const join =
    tabla === 'solicitud' ? 'FROM solicitud s'
    : tabla === 'propuesta' ? 'FROM propuesta t JOIN solicitud s ON s.id = t.solicitud_id'
    : 'FROM campania t JOIN propuesta p ON p.id = t.cotizacion_id JOIN solicitud s ON s.id = p.solicitud_id';
  const quoteExpr = tabla === 'solicitud' ? 's.id' : tabla === 'propuesta' ? 't.id' : 'p.id';
  const statusCol = tabla === 'solicitud' ? 's.status' : 't.status';
  const { cond, params } = await pipelineCond(f, quoteExpr);
  const rows = await query<{ status: string | null; n: number }>(
    `SELECT ${statusCol} status, COUNT(*) n ${join} WHERE ${cond.join(' AND ')} GROUP BY ${statusCol} ORDER BY n DESC`,
    params
  );
  return rows
    .filter((r) => r.status)
    .map((r) => ({ nombre: String(r.status), valor: Number(r.n), eventos: Number(r.n) }));
}

const suma = (c: ConteoNombre[]) => c.reduce((a, b) => a + b.valor, 0);
const de = (c: ConteoNombre[], ...nombres: string[]) =>
  c.filter((x) => nombres.includes(x.nombre)).reduce((a, b) => a + b.valor, 0);

/** Ventas reales por período (mes 1–12 / catorcena / semana ISO), con filtros. */
export async function getVentasPeriodo(periodo: Periodo, f: FiltrosReporte): Promise<ConteoPeriodo[]> {
  const { where, params } = await vapsWhere(f);
  const cond = [where];
  let expr: string;
  if (periodo === 'mes') {
    // La catorcena que cruza meses (p.ej. Cat 20 = 29-sep → 12-oct) la cuenta QEB en el
    // mes donde TERMINA (octubre), no en el de inicio (que usa la columna `Mes`).
    // Validado vs QEB: Jun=103M, Sep=97M. Sin fecha de periodo, cae a `Mes`.
    expr = MES_FIN;
  } else if (periodo === 'catorcena') {
    expr = "CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(`Periodo`,' ',-1),'-',1) AS UNSIGNED)";
    cond.push("`Periodo` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'");
  } else {
    expr = 'WEEK(`Fecha`, 3)';
    cond.push('`Fecha` IS NOT NULL');
  }
  const rows = await query<{ periodo: number | null; monto: string; caras: string | null }>(
    `SELECT periodo, SUM(monto) monto, SUM(caras) caras
       FROM (
         SELECT ${expr} periodo, \`Monto Total\` monto, \`Caras\` caras
           FROM V_APS_Globales
          WHERE ${cond.join(' AND ')}
       ) t
      WHERE periodo IS NOT NULL
      GROUP BY periodo
      ORDER BY periodo`,
    params
  );
  return rows
    .filter((r) => r.periodo != null)
    .map((r) => ({ periodo: Number(r.periodo), monto: Number(r.monto) || 0, caras: Number(r.caras) || 0 }));
}

/** Calendario de catorcenas del año (desde V_APS: Periodo + Fecha Ini/Fin Periodo). */
export async function getCatorcenas(anio: number): Promise<{ catorcena: number; ini: string | null; fin: string | null; etiqueta: string }[]> {
  const rows = await query<{ p: string; ini: Date | string | null; fin: Date | string | null }>(
    `SELECT DISTINCT \`Periodo\` p, \`Fecha Ini Periodo\` ini, \`Fecha Fin Periodo\` fin
       FROM V_APS_Globales
      WHERE \`Año\` = :anio AND \`Periodo\` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'`,
    { anio }
  );
  const map = new Map<number, { ini: string | null; fin: string | null }>();
  for (const r of rows) {
    const m = /(\d+)/.exec(String(r.p));
    if (!m) continue;
    const cat = Number(m[1]);
    if (!map.has(cat)) map.set(cat, { ini: toISO(r.ini), fin: toISO(r.fin) });
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([catorcena, v]) => ({ catorcena, ini: v.ini, fin: v.fin, etiqueta: `Cat ${catorcena}` }));
}

/** Venta real total (SUM Monto Total de V_APS) según el alcance filtrado. */
export async function getVentaTotal(f: FiltrosReporte): Promise<number> {
  const { where, params } = await vapsWhere(f);
  const [r] = await query<{ total: string | null }>(
    `SELECT SUM(\`Monto Total\`) total FROM V_APS_Globales WHERE ${where}`,
    params
  );
  return Number(r?.total) || 0;
}

/**
 * Promedios de tarifa desde el PIPELINE (solicitudCaras) para tener el descuento
 * REAL: tiene tanto `tarifa_publica` (precio de lista) como `costo` (lo cobrado).
 *  - publica  = SUM(tarifa_publica × caras) / SUM(caras)   (precio de lista prom.)
 *  - efectiva = SUM(costo) / SUM(caras)                    (lo cobrado por cara)
 *  - descuentoPct = (publica − efectiva) / publica
 * Filtros: año/mes/cliente/asesor sobre solicitud; plaza/formato/mueble sobre sc.
 */
export async function getTarifas(f: FiltrosReporte): Promise<{ efectiva: number; publica: number; descuentoPct: number; caras: number; monto: number }> {
  const cond: string[] = ['YEAR(s.fecha) = :anio', 'sc.caras > 0'];
  const p: Record<string, unknown> = { anio: f.anio };
  if (f.mes) { cond.push('MONTH(s.fecha) = :mes'); p.mes = f.mes; }
  const clientesT = multi(f.clientes, f.cliente);
  if (clientesT.length) { const keys = clientesT.map((_, i) => `:cliT${i}`); clientesT.forEach((cl, i) => { p[`cliT${i}`] = cl; }); cond.push(`s.razon_social IN (${keys.join(',')})`); }
  const asesoresT = multi(f.asesores, f.asesor);
  if (asesoresT.length) {
    const vars = await variantesAsesores(asesoresT, "SELECT DISTINCT asesor a FROM solicitud WHERE asesor IS NOT NULL AND asesor <> ''");
    if (!vars.length) cond.push('1=0');
    else { const keys = vars.map((_, i) => `:ta${i}`); vars.forEach((v, i) => { p[`ta${i}`] = v; }); cond.push(`s.asesor IN (${keys.join(',')})`); }
  }
  const plazasT = multi(f.plazas, f.plaza);
  if (plazasT.length) { const ors = plazasT.map((pl, i) => { p[`plzT${i}`] = `%${pl}%`; return `sc.estados LIKE :plzT${i}`; }); cond.push(`(${ors.join(' OR ')})`); }
  if (f.formato) { cond.push('sc.tipo LIKE :formato'); p.formato = `%${f.formato}%`; }
  if (f.mueble) { cond.push('sc.formato LIKE :mueble'); p.mueble = `%${f.mueble}%`; }
  const [r] = await query<{ costo: string | null; caras: string | null; tpub: string | null }>(
    `SELECT SUM(sc.costo) costo, SUM(sc.caras) caras, SUM(sc.tarifa_publica * sc.caras) tpub
       FROM solicitud s
       JOIN propuesta p2 ON p2.solicitud_id = s.id
       JOIN solicitudCaras sc ON sc.idquote = p2.id
      WHERE ${cond.join(' AND ')}`,
    p
  );
  const monto = Number(r?.costo) || 0;
  const caras = Number(r?.caras) || 0;
  const tpub = Number(r?.tpub) || 0;
  const efectiva = caras ? monto / caras : 0;
  const publica = caras ? tpub / caras : 0;
  const descuentoPct = publica ? ((publica - efectiva) / publica) * 100 : 0;
  return { efectiva, publica, descuentoPct, caras, monto };
}

export async function getEmbudo(f: FiltrosReporte): Promise<Embudo> {
  const [sol, prop, camp] = await Promise.all([
    conteoStatus('solicitud', f),
    conteoStatus('propuesta', f),
    conteoStatus('campania', f),
  ]);

  const totalSol = suma(sol);
  const base = totalSol || 1;
  const etapa = (nombre: string, valor: number): EtapaEmbudo => ({
    nombre,
    valor,
    pct: Math.round((valor / base) * 1000) / 10,
  });

  const etapas: EtapaEmbudo[] = [
    etapa('Solicitudes', totalSol),
    etapa('Atendidas', de(sol, 'Atendida', 'Aprobada')),
    etapa('Propuestas aprobadas', de(prop, 'Aprobada', 'Liberada', 'Pase a ventas')),
    etapa('Campañas activas', de(camp, 'Aprobada', 'Por iniciar', 'finalizada')),
    etapa('Finalizadas', de(camp, 'finalizada')),
  ];

  return {
    etapas,
    solicitud: sol,
    propuesta: prop,
    campania: camp,
    totales: { solicitudes: totalSol, propuestas: suma(prop), campanias: suma(camp) },
  };
}

/**
 * Valores distintos para los dropdowns. Plaza/formato/mueble LIMPIOS vienen del
 * pipeline (solicitudCaras) — V_APS no los tiene limpios. Cliente/asesor de V_APS.
 */
export async function getOpciones(anio: number): Promise<OpcionesReporte> {
  const distinctVaps = async (col: string) => {
    const rows = await query<{ v: string | null }>(
      `SELECT DISTINCT \`${col}\` v FROM V_APS_Globales WHERE \`Año\` = :anio AND \`${col}\` IS NOT NULL`,
      { anio }
    );
    return rows.map((r) => String(r.v).trim()).filter(Boolean);
  };
  const [scRows, cliente, asesorRaw] = await Promise.all([
    query<{ estados: string | null; tipo: string | null; formato: string | null }>('SELECT DISTINCT estados, tipo, formato FROM solicitudCaras'),
    distinctVaps('U_Cliente'),
    distinctVaps('U_Asesor'),
  ]);
  const plazaSet = new Set<string>(), formatoSet = new Set<string>(), muebleSet = new Set<string>();
  for (const r of scRows) {
    normalizaPlaza(r.estados).forEach((x) => plazaSet.add(x));
    if (r.tipo && r.tipo.trim()) formatoSet.add(r.tipo.trim());
    String(r.formato ?? '').split(',').map((x) => limpiaMueble(x.trim())).filter(Boolean).forEach((m) => muebleSet.add(m));
  }
  const uniqSort = (a: Iterable<string>) => [...new Set(a)].sort((x, y) => x.localeCompare(y));
  return {
    plaza: uniqSort(plazaSet),
    formato: uniqSort(formatoSet),
    mueble: uniqSort(muebleSet),
    cliente: uniqSort(cliente),
    asesor: uniqSort(asesorRaw.map((a) => normalizaAsesor(a)).filter((a): a is string => !!a)),
  };
}

export { filtroVacio };
