import { query } from '../db.js';
import { env } from '../env.js';
import { mapaPresupuesto } from './presupuesto.service.js';
import { MESES_ES, type FiltrosResumen, type Kpi, type ResumenVentas } from '../types.js';

/**
 * Agregaciones del Resumen de Ventas desde la vista QEB `V_APS_Globales` (SOLO SELECT).
 * "aps" = venta real (Monto Total). Definición de venta configurable con VENTA_DEF.
 *
 * SUPUESTOS (ajustables contra el Power BI de IMU):
 *  - Mes/Catorcena: se toman de la columna `Mes` / `Periodo` (mes en que corre el periodo).
 *  - Semana: ISO−1 (convención IMU) sobre la fecha de venta `Fecha`.
 *  - Año anterior: sale de la misma vista filtrando `Año`=anio−1 (hoy solo hay 2026 → 0).
 */

const HIST_N_SEM = 8; // ventana de ventasPorSemana: últimas N semanas con ventas

/** null/'' -> sin filtro. 'Trade' -> 'TRADE'. */
function baseSql(base: FiltrosResumen['base']): string | null {
  if (!base) return null;
  return base.toUpperCase();
}

/** Construye el WHERE común (año + filtros). Devuelve fragmento SQL y params. */
const CO = 'COLLATE utf8mb4_unicode_ci'; // las columnas de V_APS son utf8mb4_bin → forzar colación al comparar/IN/LIKE.

function where(anio: number, f: FiltrosResumen, opts: { conMes?: boolean } = {}) {
  const cond: string[] = ['`Año` = :anio'];
  const params: Record<string, unknown> = { anio };
  // BASE: multi (CIMU/Trade/UDC) si viene `bases`; si no, el single `base`.
  if (f.bases?.length) {
    cond.push(`UPPER(\`BASE\`) IN (${f.bases.map((_, i) => `:base${i}`).join(',')})`);
    f.bases.forEach((x, i) => { params[`base${i}`] = x.toUpperCase(); });
  } else {
    const b = baseSql(f.base);
    if (b) { cond.push('UPPER(`BASE`) = :base'); params.base = b; }
  }
  // Tipo de artículo (RT/BF/IN/IM/CT).
  if (f.tipos?.length) {
    cond.push(`\`Tipo\` ${CO} IN (${f.tipos.map((_, i) => `:tipo${i}`).join(',')})`);
    f.tipos.forEach((x, i) => { params[`tipo${i}`] = x.toUpperCase(); });
  }
  // Tradicional / Digital (columna `Tipo Digital`).
  if (f.digital?.length) {
    cond.push(`\`Tipo Digital\` ${CO} IN (${f.digital.map((_, i) => `:dig${i}`).join(',')})`);
    f.digital.forEach((x, i) => { params[`dig${i}`] = x; });
  }
  // Mueble/formato por palabra clave sobre Dscription (PARABUS/COLUMNA/MACRO…).
  if (f.muebles?.length) {
    cond.push(`(${f.muebles.map((_, i) => `\`Dscription\` ${CO} LIKE :mue${i}`).join(' OR ')})`);
    f.muebles.forEach((x, i) => { params[`mue${i}`] = `%${x}%`; });
  }
  if (f.asesor) { cond.push('`U_Asesor` = :asesor'); params.asesor = f.asesor; }
  // "Cliente" en el negocio = MARCA (APPLE, AEROMEXICO, SEARS…), no la razón social.
  if (f.cliente) { cond.push('`U_Marca` = :cliente'); params.cliente = f.cliente; }
  if (opts.conMes && f.mes) { cond.push('`Mes` = :mes'); params.mes = f.mes; }
  if (env.ventaDef === 'VENTA') cond.push("`U_dscTAsig` = 'Venta'");
  return { sql: cond.join(' AND '), params };
}

const MONTO = 'SUM(`Monto Total`)';
// Mes de la catorcena por su PUNTO MEDIO (inicio + 7 días), no por su fecha de inicio.
// La columna `Mes` usa la fecha de inicio → una catorcena que cruza meses (p.ej.
// 29-sep→12-oct) cae en el mes equivocado. QEB la cuenta por donde caen más días.
const MES_EXPR = 'COALESCE(MONTH(DATE_ADD(`Fecha Ini Periodo`, INTERVAL 7 DAY)), `Mes`)';

async function ventasPorMes(anio: number, f: FiltrosResumen): Promise<Map<number, number>> {
  const w = where(anio, f);
  const rows = await query<{ mes: number; monto: string }>(
    `SELECT ${MES_EXPR} mes, ${MONTO} monto FROM V_APS_Globales WHERE ${w.sql} GROUP BY mes`,
    w.params
  );
  return new Map(rows.filter((r) => r.mes != null).map((r) => [Number(r.mes), Number(r.monto)]));
}

async function ventasPorCatorcenaMap(anio: number, f: FiltrosResumen): Promise<Map<number, number>> {
  const w = where(anio, f);
  const rows = await query<{ catorcena: number; monto: string }>(
    `SELECT CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(\`Periodo\`,' ',-1),'-',1) AS UNSIGNED) catorcena,
            ${MONTO} monto
       FROM V_APS_Globales
      WHERE ${w.sql} AND \`Periodo\` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %'
      GROUP BY catorcena`,
    w.params
  );
  return new Map(rows.filter((r) => r.catorcena).map((r) => [Number(r.catorcena), Number(r.monto)]));
}

/**
 * Mapa catorcena -> mes (1–12) al que pertenece, según la columna `Mes` de la
 * vista. Si una catorcena aparece en más de un mes (empalme), gana el mes con
 * más renglones. Esto es lo que permite "iluminar lo relacionado" en el front:
 * un mes agrupa varias catorcenas y viceversa.
 */
async function catorcenaMesMap(anio: number, f: FiltrosResumen): Promise<Map<number, number>> {
  const w = where(anio, f);
  const rows = await query<{ catorcena: number; mes: number; n: number }>(
    `SELECT CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(\`Periodo\`,' ',-1),'-',1) AS UNSIGNED) catorcena,
            ${MES_EXPR} mes, COUNT(*) n
       FROM V_APS_Globales
      WHERE ${w.sql} AND \`Periodo\` COLLATE utf8mb4_unicode_ci LIKE 'CATORCENA %' AND \`Mes\` IS NOT NULL
      GROUP BY catorcena, mes`,
    w.params
  );
  const best = new Map<number, { mes: number; n: number }>();
  for (const r of rows) {
    const c = Number(r.catorcena);
    const mes = Number(r.mes);
    if (!c || !mes) continue;
    const prev = best.get(c);
    if (!prev || Number(r.n) > prev.n) best.set(c, { mes, n: Number(r.n) });
  }
  return new Map([...best].map(([c, v]) => [c, v.mes]));
}

/**
 * ventasPorSemana = venta real (Monto Total APS) agrupada por semana ISO-8601 de
 * la columna `Fecha`, tomando las últimas HIST_N_SEM semanas CON ventas del año.
 * Mide lo MISMO que el resto del tablero (Monto Total), a diferencia de la versión
 * anterior que sumaba la inversión de "pase a ventas" del pipeline (otra métrica).
 * `WEEK(Fecha, 3)` = ISO-8601 (semana inicia lunes; la semana 1 contiene el primer
 * jueves). Respeta todos los filtros (base, asesor, cliente) vía `where`.
 */
async function ventasPorSemanaAPS(anio: number, f: FiltrosResumen) {
  const w = where(anio, f);
  const rows = await query<{ semana: number; monto: string }>(
    `SELECT WEEK(\`Fecha\`, 3) semana, ${MONTO} monto
       FROM V_APS_Globales
      WHERE ${w.sql} AND \`Fecha\` IS NOT NULL
      GROUP BY WEEK(\`Fecha\`, 3)
      ORDER BY semana`,
    w.params
  );
  return rows
    .filter((r) => r.semana != null)
    .map((r) => ({
      semana: Number(r.semana),
      anio,
      etiqueta: `Semana ${Number(r.semana)}-${anio}`,
      monto: Number(r.monto),
    }))
    .slice(-HIST_N_SEM);
}

export async function getResumenVentas(f: FiltrosResumen): Promise<ResumenVentas> {
  const anio = f.anio;
  const anioPrev = anio - 1;

  const [mesAct, mesPrev, catAct, catPrev, catMes, ppto] = await Promise.all([
    ventasPorMes(anio, f),
    ventasPorMes(anioPrev, f),
    ventasPorCatorcenaMap(anio, f),
    ventasPorCatorcenaMap(anioPrev, f),
    catorcenaMesMap(anio, f),
    mapaPresupuesto(anio, f.base),
  ]);

  // --- ventas mensuales (vs año anterior) ---
  const ventasMensuales = MESES_ES.map((etiqueta, i) => {
    const mes = i + 1;
    return { mes, etiqueta, aps: mesAct.get(mes) ?? 0, anioAnterior: mesPrev.get(mes) ?? 0 };
  });

  // --- ventas vs presupuesto ---
  const ventasVsPpto = MESES_ES.map((etiqueta, i) => {
    const mes = i + 1;
    return { mes, etiqueta, ppto: ppto.get(mes) ?? 0, aps: mesAct.get(mes) ?? 0 };
  });

  // --- ventas por catorcena (vs año anterior) ---
  const catorcenas = [...new Set([...catAct.keys(), ...catPrev.keys()])].sort((a, b) => a - b);
  const ventasPorCatorcena = catorcenas.map((catorcena) => ({
    catorcena,
    mes: catMes.get(catorcena) ?? 0,
    etiqueta: `CATORCENA ${String(catorcena).padStart(2, '0')}`,
    aps: catAct.get(catorcena) ?? 0,
    anioAnterior: catPrev.get(catorcena) ?? 0,
  }));

  // --- ventas por semana = Monto Total APS por semana ISO ---
  const ventasPorSemana = await ventasPorSemanaAPS(anio, f);

  // --- KPIs ---
  const totAps = [...mesAct.values()].reduce((a, b) => a + b, 0);
  const totPrev = [...mesPrev.values()].reduce((a, b) => a + b, 0);
  const totPpto = [...ppto.values()].reduce((a, b) => a + b, 0);
  const mesRef = f.mes ?? (mesAct.size ? Math.max(...mesAct.keys()) : new Date().getMonth() + 1);
  const apsMes = mesAct.get(mesRef) ?? 0;
  const pptoMes = ppto.get(mesRef) ?? 0;
  const apsMesPrev = mesPrev.get(mesRef) ?? 0;

  const kpis: Kpi[] = [
    { id: 'acum-vs-ppto', titulo: 'Ventas Acum vs PPTO', valor: totAps, objetivo: totPpto, tendencia: ventasMensuales.map((m) => m.aps) },
    { id: 'mensual-vs-ppto', titulo: 'Ventas Mensual vs PPTO', valor: apsMes, objetivo: pptoMes, tendencia: ventasPorSemana.map((s) => s.monto) },
    { id: 'acum-vs-anio-ant', titulo: 'Ventas Acum vs Año Ant', valor: totAps, objetivo: totPrev, tendencia: ventasMensuales.map((m) => m.anioAnterior) },
    { id: 'mensual-vs-anio-ant', titulo: 'Ventas Mensual vs Año Ant', valor: apsMes, objetivo: apsMesPrev, tendencia: ventasMensuales.map((m) => m.anioAnterior) },
  ];

  const promedioVentaSemanal = ventasPorSemana.length
    ? ventasPorSemana.reduce((a, s) => a + s.monto, 0) / ventasPorSemana.length
    : 0;

  return {
    actualizadoEn: new Date().toISOString().slice(0, 10),
    promedioVentaSemanal,
    kpis,
    ventasVsPpto,
    ventasPorSemana,
    ventasPorCatorcena,
    ventasMensuales,
  };
}

/** Lista de asesores distintos (para el filtro del front). Columna `U_Asesor`. */
export async function getAsesores(): Promise<string[]> {
  const rows = await query<{ a: string }>(
    "SELECT DISTINCT `U_Asesor` a FROM V_APS_Globales WHERE `U_Asesor` IS NOT NULL AND `U_Asesor` <> '' AND `U_Asesor` <> '0' ORDER BY `U_Asesor`"
  );
  return rows.map((r) => r.a);
}

/**
 * Lista de "clientes" para el filtro. En este negocio (medios/publicidad) el
 * cliente que se busca es la MARCA (APPLE, AEROMEXICO, SEARS…), columna `U_Marca`,
 * no la razón social (`U_Cliente`).
 */
export async function getClientes(): Promise<string[]> {
  const rows = await query<{ c: string }>(
    "SELECT DISTINCT `U_Marca` c FROM V_APS_Globales WHERE `U_Marca` IS NOT NULL AND `U_Marca` <> '' AND `U_Marca` <> '0' ORDER BY `U_Marca`"
  );
  return rows.map((r) => r.c);
}

/** Años con datos (para el filtro). */
export async function getAnios(): Promise<number[]> {
  const rows = await query<{ a: number }>('SELECT DISTINCT `Año` a FROM V_APS_Globales WHERE `Año` IS NOT NULL ORDER BY `Año` DESC');
  return rows.map((r) => Number(r.a));
}
