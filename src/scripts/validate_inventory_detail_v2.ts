// Compara byte-a-byte la respuesta de computeInventoryDetailSql (nueva, con
// ROW_NUMBER + paginacion en DB) contra computeInventoryDetailLegacy (findMany
// completo + slice en JS) para un set de casos representativos.
//
// Refuerzos aplicados sobre la version inicial:
// (1) Fixtures descubiertos de la DB: usamos valores reales de estado, plaza,
//     tipo, mueble, NSE y una catorcena que si tiene reservas — no hardcodeamos
//     'CDMX' o '2026-04' que pueden devolver vacio y dar OK falso.
// (2) Caso especifico de tie-break: buscamos un inventario con >=2 reservas del
//     MISMO estatus activo. Si legacy y SQL desempatan distinto, el diff lo
//     muestra en los campos de enrichment (cliente_nombre, APS, propuesta_id...).
// (3) Validacion de universo completo: para 2 filtros (sin filtro y ?estatus=Vendido)
//     pedimos limit=100000 en una sola call y comparamos el set entero, no muestras
//     paginadas.
//
// Nota conocida (fuera de scope de este PR): ni legacy ni SQL filtran
// estatus='Inactivo' del inventario, cuando getStats si lo hace. Es una
// inconsistencia preexistente. Se preserva aca; se arregla en el follow-up.
//
// Correr: npx ts-node src/scripts/validate_inventory_detail_v2.ts
// (Usa la DB que apunta .env — normalmente DEV/PRUEBAS Hostinger.)
import { DashboardController, InventoryDetailParams, InventoryDetailResult } from '../controllers/dashboard.controller';
import prisma from '../utils/prisma';

const ctrl = new DashboardController();

type TestCase = {
  name: string;
  params: Partial<InventoryDetailParams>;
  meta?: Record<string, unknown>;
};

const base: InventoryDetailParams = {
  estados: [], ciudades: [], formatos: [], nses: [], tipos: [],
  catorcena_id: undefined, fecha_inicio: undefined, fecha_fin: undefined,
  estatusFiltro: undefined,
  pageNum: 1, limitNum: 50, skip: 0, wantCoords: false,
};
const withPage = (p: Partial<InventoryDetailParams>): InventoryDetailParams => {
  const merged = { ...base, ...p };
  merged.skip = (merged.pageNum - 1) * merged.limitNum;
  return merged;
};

type Fixtures = {
  estados: string[];         // top 3 estados con inventarios
  plazas: string[];          // top 3 plazas
  tipos: string[];           // valores existentes de tradicional_digital
  muebles: string[];         // top 3 muebles
  catorcenaId: number | null;      // catorcena con mayor cantidad de reservas activas
  catorcenaLabel: string;    // descripcion humana para el log
  tieBreakInvId: number | null;    // inventario con >=2 reservas del mismo estatus
  tieBreakEstatus: string | null;
  tieBreakPlaza: string | null;
  tieBreakCount: number;
};

async function discoverFixtures(): Promise<Fixtures> {
  const topOf = async (col: string): Promise<string[]> => {
    const rows: Array<{ v: string; c: bigint }> = await prisma.$queryRawUnsafe(
      `SELECT ${col} AS v, COUNT(*) AS c FROM inventarios WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY c DESC LIMIT 3`,
    );
    return rows.map(r => r.v).filter(Boolean);
  };

  const [estados, plazas, tipos, muebles] = await Promise.all([
    topOf('estado'),
    topOf('plaza'),
    topOf('tradicional_digital'),
    topOf('mueble'),
  ]);

  const catorcenas: Array<{ id: number; fi: Date; ff: Date; ano: number; num: number; cnt: bigint }> = await prisma.$queryRawUnsafe(`
    SELECT c.id, c.fecha_inicio AS fi, c.fecha_fin AS ff, c.año AS ano, c.numero_catorcena AS num, COUNT(r.id) AS cnt
    FROM catorcenas c
    LEFT JOIN reservas r ON r.calendario_id = c.id AND r.deleted_at IS NULL
    GROUP BY c.id
    HAVING cnt > 0
    ORDER BY cnt DESC
    LIMIT 1
  `);
  const cat = catorcenas[0];

  const ties: Array<{ inventario_id: number; estatus: string; cnt: bigint; plaza: string | null }> = await prisma.$queryRawUnsafe(`
    SELECT ei.inventario_id, rsv.estatus, COUNT(*) AS cnt, i.plaza
    FROM reservas rsv
    INNER JOIN espacio_inventario ei ON ei.id = rsv.inventario_id
    INNER JOIN inventarios i ON i.id = ei.inventario_id
    WHERE rsv.deleted_at IS NULL
    GROUP BY ei.inventario_id, rsv.estatus, i.plaza
    HAVING cnt >= 2
    ORDER BY cnt DESC, ei.inventario_id ASC
    LIMIT 1
  `);
  const tie = ties[0];

  return {
    estados,
    plazas,
    tipos,
    muebles,
    catorcenaId: cat ? Number(cat.id) : null,
    catorcenaLabel: cat ? `Cat ${cat.num}/${cat.ano} (${Number(cat.cnt)} reservas)` : '(ninguna con reservas)',
    tieBreakInvId: tie ? Number(tie.inventario_id) : null,
    tieBreakEstatus: tie?.estatus ?? null,
    tieBreakPlaza: tie?.plaza ?? null,
    tieBreakCount: tie ? Number(tie.cnt) : 0,
  };
}

function buildCases(fx: Fixtures): TestCase[] {
  const cases: TestCase[] = [];

  // (1) Sin filtros: distintas paginas
  cases.push({ name: 'sin filtros - page 1',           params: {} });
  cases.push({ name: 'sin filtros - page 2',           params: { pageNum: 2 } });
  cases.push({ name: 'sin filtros - page 10',          params: { pageNum: 10 } });
  cases.push({ name: 'sin filtros - limit 100',        params: { limitNum: 100 } });
  cases.push({ name: 'sin filtros - includeCoords',    params: { wantCoords: true } });

  // (2) Filtros por estatus (mapeo especial para Reservado/Vendido)
  cases.push({ name: 'estatus=Vendido',                params: { estatusFiltro: 'Vendido' } });
  cases.push({ name: 'estatus=Vendido + includeCoords', params: { estatusFiltro: 'Vendido', wantCoords: true } });
  cases.push({ name: 'estatus=Reservado',              params: { estatusFiltro: 'Reservado' } });
  cases.push({ name: 'estatus=Disponible',             params: { estatusFiltro: 'Disponible' } });
  cases.push({ name: 'estatus=Bloqueado',              params: { estatusFiltro: 'Bloqueado' } });
  cases.push({ name: 'estatus=Inexistente (0 filas)',  params: { estatusFiltro: 'ValorSinExistir' } });

  // (3) Filtros de columna con valores reales descubiertos
  if (fx.estados[0]) cases.push({ name: `estado=${fx.estados[0]}`, params: { estados: [fx.estados[0]] } });
  if (fx.estados[0]) cases.push({ name: `estado=${fx.estados[0]} + estatus=Vendido`, params: { estados: [fx.estados[0]], estatusFiltro: 'Vendido' } });
  if (fx.plazas[0])  cases.push({ name: `plaza=${fx.plazas[0]}`, params: { ciudades: [fx.plazas[0]] } });
  if (fx.estados.length >= 2) cases.push({ name: `multi estado (${fx.estados.slice(0,3).join(',')})`, params: { estados: fx.estados.slice(0, 3) } });
  for (const t of fx.tipos.slice(0, 2)) cases.push({ name: `tipo=${t}`, params: { tipos: [t] } });
  if (fx.muebles[0]) cases.push({ name: `mueble=${fx.muebles[0]}`, params: { formatos: [fx.muebles[0]] } });
  if (fx.estados[0] && fx.plazas[0] && fx.tipos[0]) {
    cases.push({ name: `combo estado+plaza+tipo (todos reales)`, params: { estados: [fx.estados[0]], ciudades: [fx.plazas[0]], tipos: [fx.tipos[0]] } });
  }

  // (4) Filtros de fecha con una catorcena real (que sabemos que tiene reservas)
  if (fx.catorcenaId) {
    cases.push({ name: `catorcena_id=${fx.catorcenaId} ${fx.catorcenaLabel}`,       params: { catorcena_id: String(fx.catorcenaId) } });
    cases.push({ name: `catorcena_id=${fx.catorcenaId} + estatus=Vendido`,          params: { catorcena_id: String(fx.catorcenaId), estatusFiltro: 'Vendido' } });
    cases.push({ name: `catorcena_id=${fx.catorcenaId} + includeCoords`,            params: { catorcena_id: String(fx.catorcenaId), wantCoords: true } });
  }

  // (5) Bordes de paginacion
  cases.push({ name: 'limitNum=1 - page 1',            params: { limitNum: 1 } });
  cases.push({ name: 'limitNum=1 - page 100',          params: { limitNum: 1, pageNum: 100 } });
  cases.push({ name: 'limitNum=500 - page 1',          params: { limitNum: 500 } });

  // (6) Tie-break: pedimos la plaza del inventario con reservas empatadas para
  //     obligar a que aparezca en el set. Si legacy y SQL desempatan distinto
  //     va a fallar el diff sobre los campos de enrichment (cliente_nombre, APS...).
  if (fx.tieBreakInvId && fx.tieBreakPlaza) {
    cases.push({
      name: `tie-break: inv ${fx.tieBreakInvId} (${fx.tieBreakCount} reservas ${fx.tieBreakEstatus}, plaza ${fx.tieBreakPlaza})`,
      params: { ciudades: [fx.tieBreakPlaza] },
      meta: { tieBreakInvId: fx.tieBreakInvId },
    });
  } else {
    console.log('  (advertencia: no se encontraron inventarios con reservas empatadas — caso tie-break omitido)');
  }

  return cases;
}

// Casos "universo": pedimos limit gigante en una sola call para comparar el set
// completo, no muestras paginadas.
function buildUniverseCases(): TestCase[] {
  return [
    { name: 'UNIVERSO sin filtros (todos los ~18k)', params: { limitNum: 100000, wantCoords: true } },
    { name: 'UNIVERSO estatus=Vendido',              params: { limitNum: 100000, estatusFiltro: 'Vendido', wantCoords: true } },
  ];
}

type Diff = { path: string; legacy: unknown; sql: unknown };

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

// Normaliza byPlaza/allCoords para deep-diff. El sort del legacy solo tiene
// count desc — ante ties depende del orden de insercion. Normalizamos con
// sort estable (count desc, plaza asc) en AMBOS antes de comparar.
function normalize(r: InventoryDetailResult): InventoryDetailResult {
  const byPlaza = [...r.byPlaza].sort((a, b) => b.count - a.count || a.plaza.localeCompare(b.plaza));
  const allCoords = [...r.allCoords].sort((a, b) => a.id - b.id);
  return { ...r, byPlaza, allCoords };
}

function diff(pathPrefix: string, legacy: unknown, sql: unknown, out: Diff[], maxDepth = 8): void {
  const ls = stableStringify(legacy);
  const ss = stableStringify(sql);
  if (ls === ss) return;
  if (maxDepth <= 0) {
    out.push({ path: pathPrefix, legacy, sql });
    return;
  }

  if (Array.isArray(legacy) && Array.isArray(sql)) {
    if (legacy.length !== sql.length) {
      out.push({ path: pathPrefix + '.length', legacy: legacy.length, sql: sql.length });
      return;
    }
    for (let i = 0; i < legacy.length; i++) {
      diff(`${pathPrefix}[${i}]`, legacy[i], sql[i], out, maxDepth - 1);
    }
    return;
  }
  if (legacy && sql && typeof legacy === 'object' && typeof sql === 'object') {
    const keys = new Set([...Object.keys(legacy), ...Object.keys(sql)]);
    for (const k of keys) {
      diff(`${pathPrefix}.${k}`, (legacy as Record<string, unknown>)[k], (sql as Record<string, unknown>)[k], out, maxDepth - 1);
    }
    return;
  }
  out.push({ path: pathPrefix, legacy, sql });
}

async function runCase(tc: TestCase) {
  const params = withPage(tc.params);
  const tLegacyStart = Date.now();
  const legacy = await ctrl.computeInventoryDetailLegacy(params);
  const tLegacy = Date.now() - tLegacyStart;
  const tSqlStart = Date.now();
  const sql = await ctrl.computeInventoryDetailSql(params);
  const tSql = Date.now() - tSqlStart;

  const diffs: Diff[] = [];
  diff('items', legacy.items, sql.items, diffs);
  diff('pagination', legacy.pagination, sql.pagination, diffs);
  diff('byPlaza', normalize(legacy).byPlaza, normalize(sql).byPlaza, diffs);
  diff('allCoords', normalize(legacy).allCoords, normalize(sql).allCoords, diffs);

  return { tc, tLegacy, tSql, diffs, legacyTotal: legacy.pagination.total, sqlTotal: sql.pagination.total };
}

function printCaseResult(name: string, r: { tLegacy: number; tSql: number; diffs: Diff[]; legacyTotal: number; sqlTotal: number }) {
  const speedup = r.tSql > 0 ? r.tLegacy / r.tSql : 1;
  if (r.diffs.length === 0) {
    process.stdout.write(`OK  legacy=${r.tLegacy}ms sql=${r.tSql}ms  (${speedup.toFixed(1)}x)  total=${r.sqlTotal}\n`);
    return true;
  }
  process.stdout.write(`FAIL ${r.diffs.length} diffs — legacy=${r.tLegacy}ms sql=${r.tSql}ms  (legacyTotal=${r.legacyTotal} sqlTotal=${r.sqlTotal})\n`);
  for (const d of r.diffs.slice(0, 5)) {
    const l = JSON.stringify(d.legacy);
    const s = JSON.stringify(d.sql);
    console.log(`      ${d.path}: legacy=${l?.slice(0, 140)} sql=${s?.slice(0, 140)}`);
  }
  if (r.diffs.length > 5) console.log(`      ... y ${r.diffs.length - 5} mas`);
  return false;
}

async function main() {
  console.log('Validando computeInventoryDetailSql vs computeInventoryDetailLegacy\n');
  console.log('Descubriendo fixtures de la DB...');
  const fx = await discoverFixtures();
  console.log(`  estados top3: ${JSON.stringify(fx.estados)}`);
  console.log(`  plazas top3:  ${JSON.stringify(fx.plazas)}`);
  console.log(`  tipos:        ${JSON.stringify(fx.tipos)}`);
  console.log(`  muebles top3: ${JSON.stringify(fx.muebles)}`);
  console.log(`  catorcena:    ${fx.catorcenaId ? `id=${fx.catorcenaId} ${fx.catorcenaLabel}` : 'NO HAY con reservas activas'}`);
  console.log(`  tie-break:    ${fx.tieBreakInvId ? `inv=${fx.tieBreakInvId} estatus=${fx.tieBreakEstatus} count=${fx.tieBreakCount} plaza=${fx.tieBreakPlaza}` : 'NO HAY inventario con reservas empatadas'}`);
  console.log('');

  const cases = buildCases(fx);
  const universe = buildUniverseCases();
  console.log(`Corriendo ${cases.length} casos regulares + ${universe.length} casos UNIVERSO.\n`);

  let failed = 0;
  const speedups: number[] = [];

  console.log('== CASOS REGULARES ==');
  for (const tc of cases) {
    process.stdout.write(`  ${tc.name.padEnd(60)} `);
    try {
      const r = await runCase(tc);
      const speedup = r.tSql > 0 ? r.tLegacy / r.tSql : 1;
      speedups.push(speedup);
      const ok = printCaseResult(tc.name, r);
      if (!ok) failed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`ERROR ${msg}\n`);
    }
  }

  console.log('\n== CASOS UNIVERSO (limit=100000, compara TODO el set) ==');
  for (const tc of universe) {
    process.stdout.write(`  ${tc.name.padEnd(60)} `);
    try {
      const r = await runCase(tc);
      const speedup = r.tSql > 0 ? r.tLegacy / r.tSql : 1;
      speedups.push(speedup);
      const ok = printCaseResult(tc.name, r);
      if (!ok) failed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`ERROR ${msg}\n`);
    }
  }

  const totalCases = cases.length + universe.length;
  const avgSpeedup = speedups.length > 0 ? speedups.reduce((a, b) => a + b, 0) / speedups.length : 0;
  console.log(`\nResumen: ${totalCases - failed}/${totalCases} OK.  Speedup promedio: ${avgSpeedup.toFixed(1)}x`);
  if (failed > 0) {
    console.log(`\n${failed} casos con diferencias. Revisar antes de mergear.`);
    process.exit(1);
  } else {
    console.log('Todo cuadra. Deep-diff limpio.');
  }
}

main()
  .catch(e => { console.error('Error fatal:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
