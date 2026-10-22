// Estado de POST a SAP a nivel CIRCUITO (fila de solicitudCaras): cuántos
// circuitos ya se postearon y cuántos faltan, con su monto. Lo comparten el
// dashboard (/dashboard/posteo-stats, sobre todas las campañas activas con
// filtros de inventario) y el módulo de campañas (/campanas/stats, sobre el
// universo exacto de campañas que muestra el listado).
//
// Definiciones (misma regla de "posted" que CampanaDetailPage y el reporte
// de catorcena en campanas.controller, pero por circuito):
//   - Circuito posteado: posted_to_sap = 1 (marca manual de campaña
//     completa), o todos los APS del circuito (reservas.APS de sus reservas)
//     están en posted_aps. Circuito sin APS asignados cuenta como PENDIENTE.
//   - Monto: solicitudCaras.costo (misma fuente que la inversión del listado
//     de campañas), prorrateado por días de solape cuando hay periodo activo.
//
// Universo de campañas: por default `status != 'inactiva'` (las 'inactiva'
// son propuestas no aprobadas — no aplican a POST). Si se pasa `campaniaIds`,
// se usa EXACTAMENTE esa lista (el caller ya aplicó sus filtros).
//
// Periodo (fi/ff): se exige solape con la campaña y con el circuito, y el
// monto se prorratea por los días que el circuito solapa con el rango —
// misma fórmula que `inversion_filtrada` del listado de campañas.
//
// Filtros de inventario (solo dashboard): la plaza vive en `inventarios`,
// dos saltos abajo del circuito (sc -> reservas -> inventarios), y un
// circuito puede tener caras en varias plazas. Por eso el MONTO se prorratea
// por caras (6 de 10 caras en GDL -> 0.6 del costo), así la suma de todas las
// plazas cuadra con el total sin filtro. El CONTEO no se parte: el circuito
// cuenta entero en cada plaza que toca. Un circuito sin reservas vivas queda
// fuera en cuanto hay algún filtro de inventario activo.

import prisma from '../utils/prisma';

export type PosteoBucket = { count: number; monto: number };
export type PosteoStats = {
  pendientes: PosteoBucket;
  posteadas: PosteoBucket;
  total: PosteoBucket;
};

export type InventarioFiltro = {
  estados?: string[];
  ciudades?: string[];
  formatos?: string[];
  nses?: string[];
  tipos?: string[];
};

export type ComputePosteoOpts = {
  /** Rango de fechas (null = sin periodo, costo completo del circuito). */
  fi?: Date | null;
  ff?: Date | null;
  /** Universo exacto de campañas. Lista vacía => resultado en ceros. */
  campaniaIds?: number[];
  inventarioFiltro?: InventarioFiltro;
};

const EMPTY: PosteoStats = {
  pendientes: { count: 0, monto: 0 },
  posteadas: { count: 0, monto: 0 },
  total: { count: 0, monto: 0 },
};

export async function computePosteoStats(opts: ComputePosteoOpts): Promise<PosteoStats> {
  const fi = opts.fi ?? null;
  const ff = opts.ff ?? null;
  const periodoActivo = !!(fi && ff);

  if (opts.campaniaIds && opts.campaniaIds.length === 0) return EMPTY;

  // Clausula de universo de campañas: lista explícita o "activas".
  const idsClause = opts.campaniaIds
    ? `AND c.id IN (${opts.campaniaIds.map(() => '?').join(',')})`
    : `AND c.status != 'inactiva'`;
  const idsParams: number[] = opts.campaniaIds ?? [];

  // Solape de periodo: la campaña se toca con el rango si empieza antes de
  // que el rango termine y termina después de que el rango empiece.
  const periodoClause = periodoActivo ? 'AND c.fecha_inicio <= ? AND c.fecha_fin >= ?' : '';
  const periodoParams = periodoActivo ? [ff, fi] : [];

  // Circuitos de las campañas del universo, con monto prorrateado por los
  // días que solapan con el rango. Sin periodo, el costo completo.
  const circuitosSql = periodoActivo
    ? `
      SELECT c.id AS campania_id, sc.id AS sc_id,
             sc.costo
             * (DATEDIFF(LEAST(sc.fin_periodo, ?), GREATEST(sc.inicio_periodo, ?)) + 1)
             / (DATEDIFF(sc.fin_periodo, sc.inicio_periodo) + 1) AS monto
      FROM campania c
      INNER JOIN cotizacion cot ON cot.id = c.cotizacion_id
      INNER JOIN solicitudCaras sc
        ON sc.idquote = CAST(cot.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      WHERE 1=1
        ${idsClause}
        AND c.fecha_inicio <= ? AND c.fecha_fin >= ?
        AND sc.inicio_periodo <= ? AND sc.fin_periodo >= ?
      `
    : `
      SELECT c.id AS campania_id, sc.id AS sc_id, sc.costo AS monto
      FROM campania c
      INNER JOIN cotizacion cot ON cot.id = c.cotizacion_id
      INNER JOIN solicitudCaras sc
        ON sc.idquote = CAST(cot.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      WHERE 1=1
        ${idsClause}
      `;
  const circuitosParams = periodoActivo
    ? [ff, fi, ...idsParams, ff, fi, ff, fi]
    : [...idsParams];

  type CircuitoRow = { campania_id: number; sc_id: number; monto: number };
  type ApsRow = { sc_id: number; aps: number };
  const [circuitos, apsRows, campRows, postedApsRows] = await Promise.all([
    prisma.$queryRawUnsafe<CircuitoRow[]>(circuitosSql, ...circuitosParams),
    // APS de cada circuito (reservas.APS de sus reservas). Contra esto se
    // compara posted_aps para saber si el circuito ya se posteó.
    prisma.$queryRawUnsafe<ApsRow[]>(
      `
      SELECT sc.id AS sc_id, rsv.APS AS aps
      FROM campania c
      INNER JOIN cotizacion cot ON cot.id = c.cotizacion_id
      INNER JOIN solicitudCaras sc
        ON sc.idquote = CAST(cot.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
      WHERE rsv.deleted_at IS NULL
        AND rsv.APS IS NOT NULL
        ${idsClause}
        ${periodoClause}
      GROUP BY sc.id, rsv.APS
      `,
      ...idsParams,
      ...periodoParams,
    ),
    // posted_to_sap por campaña (columna estable, sin catch).
    prisma.$queryRawUnsafe<{ id: number; posted_to_sap: number | null }[]>(
      `SELECT c.id AS id, c.posted_to_sap AS posted_to_sap
       FROM campania c
       WHERE 1=1
         ${idsClause}
         ${periodoClause}`,
      ...idsParams,
      ...periodoParams,
    ),
    // posted_aps en query aparte con catch: la columna puede no existir
    // en producción (mismo patrón que campanas.controller).
    prisma.$queryRawUnsafe<{ id: number; posted_aps: string | null }[]>(
      `SELECT c.id AS id, c.posted_aps AS posted_aps
       FROM campania c
       WHERE 1=1
         ${idsClause}
         ${periodoClause}`,
      ...idsParams,
      ...periodoParams,
    ).catch(() => [] as { id: number; posted_aps: string | null }[]),
  ]);

  // Peso de cada circuito bajo los filtros de inventario: fracción de sus
  // caras vivas que cae dentro del filtro. Sin filtros, todos pesan 1.
  const f = opts.inventarioFiltro ?? {};
  const filtroParts: string[] = [];
  const filtroVals: string[] = [];
  const addIn = (col: string, values?: string[]) => {
    if (!values || values.length === 0) return;
    filtroParts.push(
      values.length === 1 ? `${col} = ?` : `${col} IN (${values.map(() => '?').join(',')})`,
    );
    filtroVals.push(...values);
  };
  addIn('i.estado', f.estados);
  addIn('i.plaza', f.ciudades);
  addIn('i.mueble', f.formatos);
  addIn('i.nivel_socioeconomico', f.nses);
  addIn('i.tradicional_digital', f.tipos);
  const filtrosActivos = filtroParts.length > 0;

  const factorByCircuito = new Map<number, number>();
  if (filtrosActivos) {
    type PesoRow = { sc_id: number; caras_total: number; caras_match: number };
    // COUNT(DISTINCT rsv.id): un mismo circuito puede colgar de varias
    // campañas por el join de idquote y sin DISTINCT se contaría doble.
    // El denominador NO excluye inventarios 'Inactivo' — la reserva existió
    // y el costo del circuito la cubre, aunque el mueble se archive después.
    const pesoRows = await prisma.$queryRawUnsafe<PesoRow[]>(
      `
      SELECT sc.id AS sc_id,
             COUNT(DISTINCT rsv.id) AS caras_total,
             COUNT(DISTINCT CASE WHEN ${filtroParts.join(' AND ')} THEN rsv.id END) AS caras_match
      FROM campania c
      INNER JOIN cotizacion cot ON cot.id = c.cotizacion_id
      INNER JOIN solicitudCaras sc
        ON sc.idquote = CAST(cot.id_propuesta AS CHAR) COLLATE utf8mb4_unicode_ci
      INNER JOIN reservas rsv ON rsv.solicitudCaras_id = sc.id
      INNER JOIN inventarios i ON i.id = rsv.inventario_id
      WHERE rsv.deleted_at IS NULL
        ${idsClause}
        ${periodoClause}
      GROUP BY sc.id
      `,
      ...filtroVals,
      ...idsParams,
      ...periodoParams,
    );
    for (const r of pesoRows) {
      const total = Number(r.caras_total) || 0;
      const match = Number(r.caras_match) || 0;
      if (total > 0 && match > 0) factorByCircuito.set(Number(r.sc_id), match / total);
    }
  }

  const apsByCircuito = new Map<number, Set<number>>();
  for (const r of apsRows) {
    const k = Number(r.sc_id);
    const aps = Number(r.aps);
    if (isNaN(aps)) continue;
    const set = apsByCircuito.get(k);
    if (set) set.add(aps); else apsByCircuito.set(k, new Set([aps]));
  }

  const postedAllByCampana = new Set<number>();
  for (const r of campRows) {
    if (r.posted_to_sap === 1) postedAllByCampana.add(Number(r.id));
  }

  const postedApsByCampana = new Map<number, Set<number>>();
  for (const r of postedApsRows) {
    if (!r.posted_aps) continue;
    try {
      const arr = JSON.parse(r.posted_aps);
      if (Array.isArray(arr)) {
        postedApsByCampana.set(
          Number(r.id),
          new Set(arr.map((a: any) => Number(a)).filter((n: number) => !isNaN(n))),
        );
      }
    } catch { /* JSON inválido — sin posted por APS */ }
  }

  let pendientesCount = 0, pendientesMonto = 0, posteadasCount = 0, posteadasMonto = 0;
  for (const r of circuitos) {
    // factor 0 = el circuito no toca el filtro (o no tiene caras vivas
    // que atribuir): no cuenta ni aporta monto.
    const factor = filtrosActivos ? (factorByCircuito.get(Number(r.sc_id)) ?? 0) : 1;
    if (factor === 0) continue;
    const monto = (Number(r.monto) || 0) * factor;
    const apsSet = apsByCircuito.get(Number(r.sc_id));
    const postedSet = postedApsByCampana.get(Number(r.campania_id));
    const postedByAps = !!apsSet && apsSet.size > 0 && !!postedSet &&
      [...apsSet].every((a) => postedSet.has(a));
    if (postedAllByCampana.has(Number(r.campania_id)) || postedByAps) {
      posteadasCount++;
      posteadasMonto += monto;
    } else {
      pendientesCount++;
      pendientesMonto += monto;
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    pendientes: { count: pendientesCount, monto: round2(pendientesMonto) },
    posteadas: { count: posteadasCount, monto: round2(posteadasMonto) },
    total: {
      count: pendientesCount + posteadasCount,
      monto: round2(pendientesMonto + posteadasMonto),
    },
  };
}
